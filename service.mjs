import { PilotLibrary } from './library.js';
import { validateProject, id, assess, coverage, manifest, customerProject, criterionFingerprint, pilotFingerprint } from './core.js';
import { deckforgeDeck } from './deckforge.js';
import { renderHandover } from './handover.js';
import { fault, fingerprint } from './agent/workspace.mjs';
import { records } from './agent/schemas.mjs';
export class ProofpackService {
  constructor(root) { this.root = root; this.library = new PilotLibrary(root); }
  async open() { await this.library.open(); return this; }
  store(pilotId) { return this.library.get(pilotId); }
  snapshot(pilotId) { return this.store(pilotId).snapshot(); }
  async status(pilotId) { const store = this.store(pilotId), project = store.snapshot(), health = await store.health(project); return { project, health, readiness: assess(project, health), coverage: coverage(project, health) }; }
  save(pilotId, value) { return this.library.withPilot(pilotId, store => store.save(value), true); }
  upload(pilotId, value) { return this.library.withPilot(pilotId, store => store.upload(value), true); }
  review(pilotId, value) { return this.library.withPilot(pilotId, store => store.review(value), true); }
  decide(pilotId, value) { return this.library.withPilot(pilotId, store => store.decide(value), true); }
  async record({ pilotId, revision, section, action, recordId, record, dryRun = false }) {
    return this.library.withPilot(pilotId, async store => {
      store.expectRevision(revision); const next = store.snapshot();
      record = records[section].partial().parse(record);
      if (section === 'charter') { if (action !== 'update') throw fault('INVALID_INPUT', 'Charter supports update only.'); next.charter = { ...next.charter, ...record }; }
      else { const index = next[section].findIndex(r => r.id === recordId);
        if (action !== 'add' && index < 0) throw fault('NOT_FOUND', 'Record not found.', 404);
        if (action === 'add') { const defaults = { id: recordId || id(), visibility: 'internal', ...(section === 'criteria' ? { status: 'unassessed', reviewer: '', rationale: '', reviewedAt: '' } : {}), ...(['evidence', 'risks', 'decisions'].includes(section) ? { criterionIds: [] } : {}) }; next[section].push({ ...defaults, ...record, id: defaults.id }); }
        if (action === 'update') next[section][index] = { ...next[section][index], ...record, id: recordId };
        if (action === 'remove') next[section].splice(index, 1);
      }
      validateProject(next); if (dryRun) { store.validateSave(next); return { project: next, dryRun: true }; }
      return { project: await store.save(next) };
    }, true);
  }
  async propose({ pilotId, revision, criterionId, outcome, rationale, actor, conditions = '', dryRun = false }) {
    return this.library.withPilot(pilotId, async store => { store.expectRevision(revision); const project = store.snapshot(); const criterion = criterionId ? project.criteria.find(c => c.id === criterionId) : null; if (criterionId && !criterion) throw fault('NOT_FOUND', 'Criterion not found.', 404); if (criterionId && !['met', 'unmet', 'blocked'].includes(outcome)) throw fault('INVALID_INPUT', 'Criterion proposals require met, unmet or blocked.'); if (!criterionId && !['proceed', 'hold', 'stop'].includes(outcome)) throw fault('INVALID_INPUT', 'Decision proposals require proceed, hold or stop.');
      const proposal = { id: id(), kind: criterionId ? 'criterion' : 'decision', criterionId: criterionId || null, outcome, rationale, actor, actorKind: 'agent', conditions, visibility: 'internal', createdAt: new Date().toISOString(), fingerprint: criterion ? criterionFingerprint(project, criterion) : pilotFingerprint(project) };
      project.proposals ||= []; project.proposals.push(proposal); validateProject(project); if (!dryRun) await store.commit(project); return { proposal, revision: dryRun ? revision : store.project.revision, dryRun, notice: 'Agent proposal only. Does not establish a reviewed pass or human approval.' };
    }, true);
  }
  async export(pilotId, format, includePrivate) {
    const store = this.store(pilotId), p = store.snapshot(), health = await store.health(p); let value, mediaType = 'application/json';
    if (format === 'backup') { if (!includePrivate) throw fault('PRIVATE_CONFIRMATION_REQUIRED', 'Full backup includes internal records and attachment bytes.'); value = await store.backup(); }
    else if (format === 'deckforge') value = deckforgeDeck(p, health);
    else if (format === 'manifest') value = manifest(p, health);
    else { value = await renderHandover(p, store); mediaType = 'text/html'; }
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return { artifact: { filename: `proofpack-${format}.${format === 'handover' ? 'html' : 'json'}`, mediaType, bytes: bytes.length, sha256: fingerprint(bytes), base64: bytes.toString('base64') }, revision: p.revision };
  }
}
