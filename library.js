import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { id, LIMITS, ValidationError } from './core.js';

const pilotId = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
async function readSafe(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > LIMITS.metadata) throw new Error('Saved metadata exceeds its size limit.'); return await handle.readFile(); } finally { await handle.close(); }
}
async function atomic(file, value) {
  const tmp = file + '.' + id() + '.tmp'; let handle;
  try {
    handle = await fs.open(tmp, 'wx', 0o600); await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(tmp, file);
    try { const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch {}
  } finally { if (handle) await handle.close(); await fs.unlink(tmp).catch(() => {}); }
}
export class PilotLibrary {
  constructor(directory) { this.directory = path.resolve(directory); this.file = path.join(this.directory, 'library.json'); this.stores = new Map(); this.queue = Promise.resolve(); }
  serial(action) { const task = this.queue.then(action); this.queue = task.catch(() => {}); return task; }
  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('Data directory must not be a symlink.');
    const pilots = path.join(this.directory, 'pilots'); await fs.mkdir(pilots, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(pilots)).isSymbolicLink()) throw new Error('Pilot directory must not be a symlink.');
    let value;
    try { value = JSON.parse((await readSafe(this.file)).toString('utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot open pilot library; existing data has not been replaced. ${error.message}`);
      let legacy;
      try { legacy = await readSafe(path.join(this.directory, 'project.json')); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      const first = await new Store(this.directory).open();
      if (legacy) {
        const copy = path.join(this.directory, 'pre-library-v1-project.json');
        try { const handle = await fs.open(copy, 'wx', 0o600); try { await handle.writeFile(legacy); await handle.sync(); } finally { await handle.close(); } }
        catch (copyError) { if (copyError.code !== 'EEXIST') throw copyError; if (!(await readSafe(copy)).equals(legacy)) throw new Error('Pre-migration recovery copy differs from current metadata. Preserve both files and resolve before migration.'); }
        const recovery = path.join(this.directory, 'pre-library-v1-attachments'); await fs.mkdir(recovery, { recursive: true, mode: 0o700 });
        if ((await fs.lstat(recovery)).isSymbolicLink()) throw new Error('Migration recovery directory must not be a symlink.');
        for (const meta of first.project.attachments) {
          const buffer = await first.readAttachment(meta);
          const destination = path.join(recovery, meta.sha256 + '.blob');
          try { await fs.writeFile(destination, buffer, { flag: 'wx', mode: 0o600 }); }
          catch (copyError) { if (copyError.code !== 'EEXIST') throw copyError; const handle = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW); try { if (!(await handle.readFile()).equals(buffer)) throw new Error('Migration attachment recovery copy differs.'); } finally { await handle.close(); } }
        }
      }
      const key = id(); value = { format: 'proofpack-library', version: 1, revision: 0, defaultPilotId: key, pilots: [{ id: key, archived: false, root: true }] };
      await atomic(this.file, value); this.stores.set(key, first);
    }
    if (!value || value.format !== 'proofpack-library' || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.pilots) || !value.pilots.length || value.pilots.length > LIMITS.pilots || !pilotId(value.defaultPilotId) || new Set(value.pilots.map((p) => p.id)).size !== value.pilots.length || value.pilots.filter((p) => p.root).length !== 1 || !value.pilots.some((p) => p.id === value.defaultPilotId && p.root)) throw new Error('Invalid pilot library; existing data has not been replaced.');
    for (const record of value.pilots) {
      if (!pilotId(record.id) || typeof record.archived !== 'boolean' || typeof record.root !== 'boolean' || Object.keys(record).sort().join(',') !== 'archived,id,root') throw new Error('Invalid pilot library record.');
      if (!this.stores.has(record.id)) {
        const directory = record.root ? this.directory : path.join(pilots, record.id);
        await readSafe(path.join(directory, 'project.json'));
        this.stores.set(record.id, await new Store(directory).open());
      }
    }
    this.value = value; return this;
  }
  get(key = this.value.defaultPilotId) {
    if (!pilotId(key) || !this.stores.has(key)) throw new ValidationError('Pilot not found. Choose a pilot from the library.', 404);
    return this.stores.get(key);
  }
  snapshot() { return { version: 1, revision: this.value.revision, defaultPilotId: this.value.defaultPilotId, pilots: this.value.pilots.map((p) => { const project = this.get(p.id).project; return { id: p.id, archived: p.archived, title: project.charter.title || 'Untitled pilot', customer: project.charter.customer }; }) }; }
  expectRevision(revision) { if (revision !== this.value.revision) throw new ValidationError('The pilot library changed in another tab. Reload before changing it.', 409); }
  withPilot(key, action, write = false) {
    return this.serial(async () => {
      const store = this.get(key);
      if (write && this.value.pilots.find((p) => this.get(p.id) === store).archived) throw new ValidationError('Archived pilots are read-only. Unarchive this pilot before making changes.', 409);
      return action(store);
    });
  }
  create(value) {
    return this.serial(async () => {
      if (!value || Object.keys(value).sort().join(',') !== 'revision,title' || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200 || /[\u0000-\u001f\u007f]/.test(value.title)) throw new ValidationError('Create a pilot with a title of 1–200 characters and library revision.');
      this.expectRevision(value.revision);
      if (this.value.pilots.length >= LIMITS.pilots) throw new ValidationError('Library limit: 24 pilots including archives. Use a separate local data directory for additional engagements.');
      const key = id(); const store = await new Store(path.join(this.directory, 'pilots', key)).open(); const project = store.snapshot(); project.charter.title = value.title.trim(); await store.save(project);
      const next = { ...this.value, revision: this.value.revision + 1, pilots: [...this.value.pilots, { id: key, archived: false, root: false }] };
      await atomic(this.file, next); this.value = next; this.stores.set(key, store);
      return { pilotId: key, library: this.snapshot(), project: store.snapshot() };
    });
  }
  archive(key, value) {
    return this.serial(async () => {
      this.get(key);
      if (!value || Object.keys(value).sort().join(',') !== 'archived,revision' || typeof value.archived !== 'boolean') throw new ValidationError('Archive requires archived and library revision.');
      this.expectRevision(value.revision);
      const next = { ...this.value, revision: this.value.revision + 1, pilots: this.value.pilots.map((p) => p.id === key ? { ...p, archived: value.archived } : p) };
      await atomic(this.file, next); this.value = next; return { library: this.snapshot() };
    });
  }
}
