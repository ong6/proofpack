import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { id, hash, emptyProject, validateProject, validateBackup, safeId, ValidationError, LIMITS, decodeAttachment, validateFilename, allAttachments, canonical, createCriterionReview, createDecisionReview } from './core.js';

export class Store {
  constructor(directory) { this.directory = path.resolve(directory); this.blobs = path.join(this.directory, 'attachments'); this.file = path.join(this.directory, 'project.json'); this.queue = Promise.resolve(); }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('Data directory must not be a symlink.');
    await fs.mkdir(this.blobs, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.blobs)).isSymbolicLink()) throw new Error('Attachment directory must not be a symlink.');
    try {
      const handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { this.project = validateProject(JSON.parse(await handle.readFile('utf8'))); } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot open saved project; existing data has not been replaced. ${error.message}`);
      this.project = emptyProject(); await this.writeAtomic(this.project);
    }
    return this;
  }
  serial(action) { const task = this.queue.then(action); this.queue = task.catch(() => {}); return task; }
  snapshot() { return structuredClone(this.project); }
  blobPath(sha256) {
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new ValidationError('Unsafe attachment hash.');
    return path.join(this.blobs, `${sha256}.blob`);
  }
  async writeAtomic(project) {
    const tmp = path.join(this.directory, `.project-${id()}.tmp`);
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600); await handle.writeFile(JSON.stringify(project, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(tmp, this.file);
      // Rename is the commit point. Directory fsync is best-effort on filesystems that do not support it.
      try { const dir = await fs.open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch {}
    } finally { if (handle) await handle.close(); await fs.unlink(tmp).catch(() => {}); }
  }
  expectRevision(revision) { if (!Number.isSafeInteger(revision) || revision !== this.project.revision) throw new ValidationError('This workspace changed in another tab. Reload before saving; your draft has not been applied.', 409); }
  async putBuffer(meta, buffer) {
    if (buffer.length !== meta.size || hash(buffer) !== meta.sha256) throw new ValidationError('Attachment integrity mismatch.');
    const destination = this.blobPath(meta.sha256);
    try {
      const handle = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = await handle.stat(); if (stat.isFile() && stat.size === meta.size && hash(await handle.readFile()) === meta.sha256) return; } finally { await handle.close(); }
      // A verified backup/upload may atomically repair a corrupt blob without trusting its old contents.
    } catch (error) { if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error; }
    const tmp = path.join(this.blobs, `.upload-${id()}.tmp`); let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600); await handle.writeFile(buffer); await handle.sync(); await handle.close(); handle = null; await fs.rename(tmp, destination);
      try { const dir = await fs.open(this.blobs, 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch {}
    } finally { if (handle) await handle.close(); await fs.unlink(tmp).catch(() => {}); }
  }
  async collectUnused() {
    const used = new Set(allAttachments(this.project).map((a) => `${a.sha256}.blob`));
    for (const name of await fs.readdir(this.blobs)) if (/^[a-f0-9]{64}\.blob$/.test(name) && !used.has(name)) await fs.unlink(path.join(this.blobs, name));
  }
  async commit(project, buffers = new Map()) {
    const next = validateProject({ ...project, revision: this.project.revision + 1 });
    for (const a of allAttachments(next)) if (buffers.has(a.id)) await this.putBuffer(a, buffers.get(a.id));
    await this.writeAtomic(next); this.project = next;
    // Never report a failed save after the atomic rename has committed.
    await this.collectUnused().catch(() => {});
    return this.snapshot();
  }
  save(value) {
    return this.serial(async () => {
      const next = validateProject(value); this.expectRevision(next.revision);
      // Attachment metadata is server-owned. It can only be removed here, never fabricated or reassigned.
      for (const a of next.attachments) {
        const previous = this.project.attachments.find((entry) => entry.id === a.id);
        if (!previous || Object.keys(previous).some((key) => key !== 'visibility' && a[key] !== previous[key])) throw new ValidationError('Attachment metadata is immutable; use upload to add attachments.');
      }
      for (const section of ['decisionReviews', 'attachmentHistory']) if (canonical(next[section] || []) !== canonical(this.project[section] || [])) throw new ValidationError('Review and attachment history are immutable; use explicit review actions.');
      for (const c of next.criteria) {
        const previous = this.project.criteria.find((entry) => entry.id === c.id);
        if (!previous) { if (c.status !== 'unassessed' || c.reviews?.length) throw new ValidationError('New criteria must be unassessed; use the explicit review action.'); continue; }
        for (const key of ['status', 'reviewer', 'rationale', 'reviewedAt', 'reviews']) if (canonical(c[key] ?? null) !== canonical(previous[key] ?? null)) throw new ValidationError('Assessment fields are immutable; use the explicit review action.');
      }
      if (this.project.criteria.some((c) => c.reviews?.length && !next.criteria.some((entry) => entry.id === c.id))) throw new ValidationError('Reviewed criteria retain history. Keep the criterion or restore a full pilot backup instead.');
      const referenced = new Set();
      for (const review of [...this.project.criteria.flatMap((c) => c.reviews || []), ...(this.project.decisionReviews || [])]) for (const a of review.snapshot?.attachments || []) referenced.add(a.id);
      const removed = this.project.attachments.filter((a) => !next.attachments.some((entry) => entry.id === a.id) && referenced.has(a.id));
      if (removed.length) next.attachmentHistory = [...(next.attachmentHistory || []), ...removed];
      return this.commit(next);
    });
  }
  review(value) { return this.serial(async () => { this.expectRevision(value?.revision); return this.commit(createCriterionReview(this.project, value)); }); }
  decide(value) { return this.serial(async () => { this.expectRevision(value?.revision); return this.commit(createDecisionReview(this.project, value)); }); }
  upload(value) {
    return this.serial(async () => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'data,evidenceId,name,revision,type,visibility') throw new ValidationError('Invalid attachment upload fields.');
      this.expectRevision(value.revision); if (!safeId(value.evidenceId) || !this.project.evidence.some((e) => e.id === value.evidenceId)) throw new ValidationError('Choose an existing evidence record.'); validateFilename(value.name);
      const buffer = decodeAttachment(value.data);
      const meta = { id: id(), evidenceId: value.evidenceId, name: value.name, type: value.type || 'application/octet-stream', size: buffer.length, sha256: hash(buffer), createdAt: new Date().toISOString(), visibility: value.visibility };
      const next = this.snapshot(); next.attachments.push(meta); validateProject(next); return this.commit(next, new Map([[meta.id, buffer]]));
    });
  }
  replace(backup, revision) {
    const validated = validateBackup(backup);
    return this.serial(async () => { this.expectRevision(revision); return this.commit(validated.project, validated.buffers); });
  }
  async readAttachment(meta) {
    let handle;
    try {
      handle = await fs.open(this.blobPath(meta.sha256), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat(); if (!stat.isFile() || stat.size !== meta.size || stat.size > LIMITS.attachment) throw new ValidationError('Attachment is corrupt or has an unexpected size.', 409);
      const buffer = await handle.readFile(); if (hash(buffer) !== meta.sha256) throw new ValidationError('Attachment SHA-256 integrity check failed.', 409); return buffer;
    } catch (error) {
      if (error.code === 'ENOENT') throw new ValidationError('Attachment file is missing. Restore a full backup or remove the attachment metadata.', 409);
      if (error.code === 'ELOOP') throw new ValidationError('Attachment file is unsafe (symlink).', 409);
      throw error;
    } finally { if (handle) await handle.close(); }
  }
  async health(project = this.project) {
    const result = {};
    for (const a of project.attachments) {
      try { await this.readAttachment(a); result[a.id] = 'ok'; } catch (error) { result[a.id] = error.message.includes('missing') ? 'missing' : 'corrupt or unsafe'; }
    }
    return result;
  }
  backup() {
    return this.serial(async () => {
      const project = this.snapshot(); const attachmentData = [];
      for (const a of allAttachments(project)) attachmentData.push({ id: a.id, data: (await this.readAttachment(a)).toString('base64') });
      return { format: 'proofpack-backup', version: 1, project, attachmentData };
    });
  }
}
