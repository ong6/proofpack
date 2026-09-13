import { createHash, randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({ attachment: 8 * 1024 * 1024, total: 40 * 1024 * 1024, records: 500, attachments: 100, metadata: 4 * 1024 * 1024, request: 64 * 1024 * 1024, pilots: 24, reviews: 100 });
export const today = () => new Date().toISOString().slice(0, 10);
export const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
export const id = () => randomUUID();
export class ValidationError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const fail = (message) => { throw new ValidationError(message); };
const obj = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}: unexpected field ${key}.`);
  for (const key of keys) if (!(key in value)) fail(`${label}: missing field ${key}.`);
};
const text = (value, label, max = 4000, required = false) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) fail(`${label} must be ${required ? 'non-empty ' : ''}text (up to ${max} characters).`);
};
const choice = (value, choices, label) => { if (!choices.includes(value)) fail(`${label} must be one of: ${choices.join(', ')}.`); };
const date = (value, label, optional = false) => {
  if (optional && value === '') return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(`${label} must be a valid YYYY-MM-DD date.`);
};
const timestamp = (value, label) => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} must be an ISO timestamp.`); };
export const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const identifier = (value) => { if (!safeId(value)) fail('Invalid record ID.'); };
const vis = (value) => choice(value, ['internal', 'customer'], 'Visibility');
const array = (value, label, max = LIMITS.records) => { if (!Array.isArray(value) || value.length > max) fail(`${label} must be a list of at most ${max} entries.`); };
const stringFields = (record, fields, required = []) => fields.forEach((field) => text(record[field], field, field === 'name' || field === 'owner' || field === 'reviewer' ? 200 : 4000, required.includes(field)));
export function validateProject(project) {
  obj(project, ['schemaVersion', 'revision', 'charter', 'criteria', 'evidence', 'risks', 'decisions', 'checklist', 'attachments', ...['decisionReviews', 'attachmentHistory', 'proposals'].filter((key) => key in (project || {}))], 'Project');
  if (project.schemaVersion !== 1) fail('Unsupported project schema version.');
  if (!Number.isSafeInteger(project.revision) || project.revision < 0) fail('Invalid project revision.');
  obj(project.charter, ['customer', 'title', 'objective', 'owners', 'startDate', 'endDate', 'internalNotes', 'demo'], 'Charter');
  stringFields(project.charter, ['customer', 'title', 'objective', 'owners', 'internalNotes']);
  if (typeof project.charter.demo !== 'boolean') fail('Demo must be a boolean.');
  date(project.charter.startDate, 'Start date', true); date(project.charter.endDate, 'End date', true);
  if (project.charter.startDate && project.charter.endDate && project.charter.startDate > project.charter.endDate) fail('End date cannot precede start date.');
  const ids = new Set();
  for (const section of ['criteria', 'evidence', 'risks', 'decisions', 'checklist', 'attachments']) {
    array(project[section], section, section === 'attachments' ? LIMITS.attachments : LIMITS.records);
    for (const record of project[section]) {
      if (!record || typeof record !== 'object') fail(`Invalid ${section} record.`);
      identifier(record.id); if (ids.has(record.id)) fail('Record IDs must be unique across the project.'); ids.add(record.id); vis(record.visibility);
    }
  }
  const criterionIds = new Set(project.criteria.map((c) => c.id));
  const links = (record) => {
    array(record.criterionIds, 'Criterion links');
    if (new Set(record.criterionIds).size !== record.criterionIds.length) fail('Duplicate criterion link.');
    if (record.criterionIds.some((key) => !criterionIds.has(key))) fail('A record links to a missing criterion. Remove links before deleting criteria.');
  };
  for (const c of project.criteria) {
    obj(c, ['id', 'name', 'metric', 'baseline', 'threshold', 'targetDate', 'owner', 'status', 'reviewer', 'rationale', 'reviewedAt', 'visibility', ...('reviews' in c ? ['reviews'] : [])], 'Criterion');
    if (c.reviews) {
      array(c.reviews, 'Criterion review history', LIMITS.reviews);
      for (const review of c.reviews) validateReview(review, false);
      const latest = c.reviews.at(-1);
      if (latest && (c.status !== latest.status || c.reviewer !== latest.reviewer || c.rationale !== latest.rationale || c.reviewedAt !== latest.date)) fail('Criterion assessment must match its latest explicit review.');
    }
    stringFields(c, ['name', 'metric', 'baseline', 'threshold', 'owner', 'reviewer', 'rationale'], ['name', 'metric', 'baseline', 'threshold', 'owner']);
    date(c.targetDate, 'Criterion target date'); choice(c.status, ['unassessed', 'met', 'unmet', 'blocked'], 'Criterion status'); date(c.reviewedAt, 'Review date', c.status === 'unassessed');
    if (c.status !== 'unassessed' && (!c.reviewer.trim() || !c.rationale.trim())) fail('Assessed criteria require a reviewer, rationale, and review date. Evidence alone does not establish success.');
    if (c.status === 'unassessed' && (c.reviewer || c.rationale || c.reviewedAt)) fail('Unassessed criteria must not retain a previous review.');
  }
  for (const e of project.evidence) {
    obj(e, ['id', 'name', 'summary', 'source', 'owner', 'collectedAt', 'staleAfterDays', 'criterionIds', 'visibility'], 'Evidence');
    stringFields(e, ['name', 'summary', 'source', 'owner'], ['name', 'summary', 'owner']); date(e.collectedAt, 'Evidence collected date');
    if (!Number.isInteger(e.staleAfterDays) || e.staleAfterDays < 1 || e.staleAfterDays > 3650) fail('Stale-after days must be between 1 and 3650.'); links(e);
  }
  for (const r of project.risks) {
    obj(r, ['id', 'name', 'detail', 'owner', 'severity', 'status', 'mitigation', 'criterionIds', 'visibility'], 'Risk');
    stringFields(r, ['name', 'detail', 'owner', 'mitigation'], ['name', 'owner']); choice(r.severity, ['low', 'medium', 'high'], 'Risk severity'); choice(r.status, ['open', 'mitigated', 'accepted', 'closed'], 'Risk status'); links(r);
  }
  for (const d of project.decisions) {
    obj(d, ['id', 'name', 'detail', 'owner', 'date', 'criterionIds', 'visibility'], 'Decision'); stringFields(d, ['name', 'detail', 'owner'], ['name', 'detail', 'owner']); date(d.date, 'Decision date'); links(d);
  }
  for (const c of project.checklist) {
    obj(c, ['id', 'name', 'detail', 'owner', 'dueDate', 'done', 'visibility'], 'Checklist item'); stringFields(c, ['name', 'detail', 'owner'], ['name', 'owner']); date(c.dueDate, 'Checklist due date'); if (typeof c.done !== 'boolean') fail('Checklist done must be boolean.');
  }
  if (project.proposals) { array(project.proposals, 'Agent proposals', LIMITS.reviews); const proposalIds = new Set(); for (const p of project.proposals) { obj(p, ['id', 'kind', 'criterionId', 'outcome', 'rationale', 'actor', 'actorKind', 'conditions', 'visibility', 'createdAt', 'fingerprint'], 'Agent proposal'); identifier(p.id); if (proposalIds.has(p.id)) fail('Duplicate proposal ID.'); proposalIds.add(p.id); choice(p.kind, ['criterion', 'decision'], 'Proposal kind'); choice(p.actorKind, ['agent'], 'Proposal actor kind'); choice(p.visibility, ['internal'], 'Proposal visibility'); choice(p.outcome, p.kind === 'criterion' ? ['met', 'unmet', 'blocked'] : ['proceed', 'hold', 'stop'], 'Proposal outcome'); if (p.kind === 'criterion') identifier(p.criterionId); else if (p.criterionId !== null) fail('Decision proposals do not target a criterion.'); text(p.actor, 'Actor', 200, true); text(p.rationale, 'Rationale', 4000, true); text(p.conditions, 'Conditions'); timestamp(p.createdAt, 'Proposal date'); if (!/^[a-f0-9]{64}$/.test(p.fingerprint)) fail('Invalid proposal fingerprint.'); } }
  if (project.decisionReviews) { array(project.decisionReviews, 'Decision review history', LIMITS.reviews); for (const review of project.decisionReviews) validateReview(review, true); }
  if (project.attachmentHistory) array(project.attachmentHistory, 'Historical attachments', LIMITS.attachments);
  const evidenceIds = new Set(project.evidence.map((e) => e.id)); let total = 0;
  const historicalIds = new Set();
  for (const a of allAttachments(project)) {
    if (historicalIds.has(a.id)) fail('Duplicate active or historical attachment ID.'); historicalIds.add(a.id);
    obj(a, ['id', 'evidenceId', 'name', 'type', 'size', 'sha256', 'createdAt', 'visibility'], 'Attachment'); identifier(a.evidenceId);
    if (project.attachments.includes(a) && !evidenceIds.has(a.evidenceId)) fail('An attachment references missing evidence.'); identifier(a.id); vis(a.visibility); validateFilename(a.name); text(a.type, 'Attachment type', 120, true);
    if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(a.type)) fail('Invalid attachment media type.');
    if (!Number.isInteger(a.size) || a.size < 1 || a.size > LIMITS.attachment) fail('Attachments must be between 1 byte and 8 MiB.'); total += a.size;
    if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256)) fail('Invalid attachment SHA-256.'); timestamp(a.createdAt, 'Attachment creation date');
  }
  if (total > LIMITS.total) fail('Project attachments exceed the 40 MiB total limit.');
  if (Buffer.byteLength(JSON.stringify(project)) > LIMITS.metadata) fail('Project text and metadata exceed the 4 MiB limit.');
  return structuredClone(project);
}
export function validateFilename(name) {
  text(name, 'Filename', 160, true);
  if (name === '.' || name === '..' || /[\\/<>:"|?*\u0000-\u001f\u007f]/.test(name) || name.trim() !== name || /[. ]$/.test(name)) fail('Filename must be a simple local filename, without paths or reserved characters.');
}
export function emptyProject(revision = 0) {
  return { schemaVersion: 1, revision, charter: { customer: '', title: '', objective: '', owners: '', startDate: '', endDate: '', internalNotes: '', demo: false }, criteria: [], evidence: [], risks: [], decisions: [], checklist: [], attachments: [] };
}
export const allAttachments = (project) => [...project.attachments, ...(project.attachmentHistory || [])];
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const sorted = (records) => [...records].sort((a, b) => a.id.localeCompare(b.id));
const definition = (c) => Object.fromEntries(['id', 'name', 'metric', 'baseline', 'threshold', 'targetDate', 'owner', 'visibility'].map((key) => [key, c[key]]));
export function criterionSnapshot(project, criterion) {
  const evidence = sorted(project.evidence.filter((e) => e.criterionIds.includes(criterion.id))).map((e) => ({ ...e, criterionIds: [...e.criterionIds].sort() }));
  const ids = new Set(evidence.map((e) => e.id));
  return { criterion: definition(criterion), evidence, attachments: sorted(project.attachments.filter((a) => ids.has(a.evidenceId))) };
}
export const criterionFingerprint = (project, criterion) => hash(canonical(criterionSnapshot(project, criterion)));
export function criterionFreshness(project, criterion) {
  if (criterion.status === 'unassessed') return 'unassessed';
  const review = criterion.reviews?.at(-1);
  if (!review?.fingerprint) return 'legacy-unverified';
  return review.fingerprint === criterionFingerprint(project, criterion) ? 'current' : 'changed';
}
export function pilotSnapshot(project) {
  return { charter: project.charter, criteria: sorted(project.criteria).map((c) => ({ ...definition(c), status: c.status, reviewer: c.reviewer, rationale: c.rationale, reviewedAt: c.reviewedAt, reviewedFingerprint: c.reviews?.at(-1)?.fingerprint || null })), evidence: sorted(project.evidence).map((e) => ({ ...e, criterionIds: [...e.criterionIds].sort() })), risks: sorted(project.risks).map((r) => ({ ...r, criterionIds: [...r.criterionIds].sort() })), decisions: sorted(project.decisions), checklist: sorted(project.checklist), attachments: sorted(project.attachments) };
}
export const pilotFingerprint = (project) => hash(canonical(pilotSnapshot(project)));
export const decisionFreshness = (project, decision) => decision.fingerprint === pilotFingerprint(project) ? 'current' : 'changed';
function validateReview(review, decision) {
  obj(review, ['id', ...(decision ? ['outcome', 'conditions', 'visibility'] : ['status']), 'reviewer', 'rationale', 'date', 'fingerprint', 'customerFingerprint', 'snapshot'], 'Review');
  identifier(review.id); stringFields(review, ['reviewer', 'rationale'], ['reviewer', 'rationale']); date(review.date, 'Review date');
  if (decision) { choice(review.outcome, ['proceed', 'hold', 'stop'], 'Decision outcome'); text(review.conditions, 'Conditions'); vis(review.visibility); }
  else choice(review.status, ['met', 'unmet', 'blocked'], 'Review status');
  for (const key of ['fingerprint', 'customerFingerprint']) if (review[key] !== null && (typeof review[key] !== 'string' || !/^[a-f0-9]{64}$/.test(review[key]))) fail('Invalid review fingerprint.');
  if (review.snapshot !== null && (!review.snapshot || typeof review.snapshot !== 'object' || Array.isArray(review.snapshot) || hash(canonical(review.snapshot)) !== review.fingerprint)) fail('Review snapshot integrity check failed.');
  if ((review.snapshot === null) !== (review.fingerprint === null)) fail('Review snapshot and fingerprint must be present together.');
  if (decision && !review.fingerprint) fail('Decisions require a captured snapshot.');
}
export function createCriterionReview(project, value) {
  obj(value, ['revision', 'criterionId', 'status', 'reviewer', 'rationale', 'date'], 'Criterion review request');
  const next = structuredClone(project); const criterion = next.criteria.find((c) => c.id === value.criterionId);
  if (!criterion) fail('Choose an existing criterion.');
  const safe = customerProject(project); const shared = safe.criteria.find((c) => c.id === criterion.id);
  const snapshot = criterionSnapshot(project, criterion);
  const review = { id: id(), status: value.status, reviewer: value.reviewer, rationale: value.rationale, date: value.date, fingerprint: hash(canonical(snapshot)), customerFingerprint: shared ? criterionFingerprint(safe, shared) : null, snapshot };
  validateReview(review, false);
  criterion.reviews ||= [];
  if (!criterion.reviews.length && criterion.status !== 'unassessed') criterion.reviews.push({ id: id(), status: criterion.status, reviewer: criterion.reviewer, rationale: criterion.rationale, date: criterion.reviewedAt, fingerprint: null, customerFingerprint: null, snapshot: null });
  criterion.reviews.push(review); Object.assign(criterion, { status: review.status, reviewer: review.reviewer, rationale: review.rationale, reviewedAt: review.date });
  return validateProject(next);
}
export function createDecisionReview(project, value) {
  obj(value, ['revision', 'outcome', 'rationale', 'reviewer', 'date', 'conditions', 'visibility'], 'Decision review request');
  const next = structuredClone(project); const snapshot = pilotSnapshot(project);
  const review = { id: id(), outcome: value.outcome, rationale: value.rationale, reviewer: value.reviewer, date: value.date, conditions: value.conditions, visibility: value.visibility, fingerprint: hash(canonical(snapshot)), customerFingerprint: pilotFingerprint(customerProject(project)), snapshot };
  validateReview(review, true); (next.decisionReviews ||= []).push(review); return validateProject(next);
}
export function customerProject(project) {
  const result = structuredClone(project);
  delete result.charter.internalNotes;
  delete result.attachmentHistory;
  delete result.proposals;
  const publicReview = (review) => { const { snapshot, customerFingerprint, ...safe } = review; safe.fingerprint = 'customerFingerprint' in review ? customerFingerprint : review.fingerprint; return safe; };
  result.criteria = result.criteria.filter((c) => c.visibility === 'customer').map((c) => ({ ...c, ...(c.reviews ? { reviews: c.reviews.map(publicReview) } : {}) }));
  if (result.decisionReviews) result.decisionReviews = result.decisionReviews.filter((d) => d.visibility === 'customer').map(publicReview);
  const ids = new Set(result.criteria.map((c) => c.id));
  for (const section of ['evidence', 'risks', 'decisions']) result[section] = result[section].filter((r) => r.visibility === 'customer').map((r) => ({ ...r, criterionIds: r.criterionIds.filter((key) => ids.has(key)) }));
  result.checklist = result.checklist.filter((r) => r.visibility === 'customer');
  const evidenceIds = new Set(result.evidence.map((e) => e.id));
  result.attachments = result.attachments.filter((a) => a.visibility === 'customer' && evidenceIds.has(a.evidenceId));
  return result;
}
export function assess(project, health = {}, now = today()) {
  const warnings = [];
  const warn = (kind, message, recordId = '') => warnings.push({ kind, message, recordId });
  if (!project.charter.customer || !project.charter.title || !project.charter.objective || !project.charter.owners || !project.charter.startDate || !project.charter.endDate) warn('charter', 'Complete the charter: customer, title, objective, owners, and pilot dates.');
  if (!project.criteria.length) warn('criteria', 'No success criteria defined.');
  for (const c of project.criteria) {
    const freshness = criterionFreshness(project, c);
    if (c.status !== 'met') warn('criteria', `${c.name}: ${c.status}.`, c.id);
    if (freshness === 'changed' || freshness === 'legacy-unverified') warn('review', `${c.name}: needs re-review (${freshness}); historical assessment: ${c.status}.`, c.id);
    if (!project.evidence.some((e) => e.criterionIds.includes(c.id))) warn('evidence', `${c.name}: no linked evidence in this view.`, c.id);
    if (c.targetDate < now && !isCurrentMet(project, c, health, now)) warn('date', `${c.name}: target date has passed.`, c.id);
  }
  for (const e of project.evidence) {
    const age = Math.floor((Date.parse(now) - Date.parse(e.collectedAt)) / 86400000);
    if (age > e.staleAfterDays) warn('stale', `${e.name}: evidence is stale (${age} days old).`, e.id);
    if (e.collectedAt > now) warn('date', `${e.name}: collected date is in the future.`, e.id);
    if (!e.criterionIds.length) warn('evidence', `${e.name}: not linked to a criterion in this view.`, e.id);
  }
  for (const a of project.attachments) if (health[a.id] && health[a.id] !== 'ok') warn('file', `${a.name}: attachment ${health[a.id]}.`, a.evidenceId);
  for (const r of project.risks) if (r.status === 'open' || r.status === 'accepted') warn('risk', `${r.name}: ${r.severity} ${r.status} risk.`, r.id);
  if (!project.checklist.length) warn('handover', 'No handover checklist has been defined.');
  for (const c of project.checklist) if (!c.done) warn('handover', `${c.name}: handover item is incomplete${c.dueDate < now ? ' and overdue' : ''}.`, c.id);
  for (const d of project.decisionReviews || []) if (decisionFreshness(project, d) !== 'current') warn('decision', `Recorded ${d.outcome} decision from ${d.date}: reviewed pilot snapshot is now outdated.`, d.id);
  return { ready: warnings.length === 0, met: project.criteria.filter((c) => isCurrentMet(project, c, health, now)).length, historicalMet: project.criteria.filter((c) => c.status === 'met').length, total: project.criteria.length, warnings };
}
export function isCurrentMet(project, criterion, health = {}, now = today()) {
  if (criterion.status !== 'met' || criterionFreshness(project, criterion) !== 'current') return false;
  const linked = project.evidence.filter((e) => e.criterionIds.includes(criterion.id));
  if (!linked.length || linked.some((e) => e.collectedAt > now || (Date.parse(now) - Date.parse(e.collectedAt)) / 86400000 > e.staleAfterDays)) return false;
  return project.attachments.filter((a) => linked.some((e) => e.id === a.evidenceId)).every((a) => health[a.id] === 'ok');
}
export function coverage(project, health = {}, now = today()) {
  return { criteria: project.criteria.map((c) => ({ id: c.id, name: c.name, status: c.status, freshness: criterionFreshness(project, c), currentMet: isCurrentMet(project, c, health, now), evidence: project.evidence.filter((e) => e.criterionIds.includes(c.id)).map((e) => ({ ...e, stale: e.collectedAt > now || (Date.parse(now) - Date.parse(e.collectedAt)) / 86400000 > e.staleAfterDays, attachments: project.attachments.filter((a) => a.evidenceId === e.id).map((a) => ({ ...a, integrity: health[a.id] || 'not checked' })) })), risks: project.risks.filter((r) => r.criterionIds.includes(c.id) && r.status !== 'closed') })), tasks: project.checklist.filter((c) => !c.done).map((c) => ({ ...c, overdue: c.dueDate < now })) };
}
export function manifest(project, health = {}) {
  const safe = customerProject(project);
  return { format: 'proofpack-customer-manifest', version: 1, generatedAt: new Date().toISOString(), notice: 'Customer-visible records only. Evidence does not imply success. Attachment bytes are not included.', charter: safe.charter, criteria: safe.criteria, evidence: safe.evidence, attachments: safe.attachments.map((a) => ({ ...a, integrity: health[a.id] || 'not checked' })) };
}
export function decodeAttachment(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(LIMITS.attachment / 3) * 4 || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) fail('Invalid or oversized base64 attachment.');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length < 1 || buffer.length > LIMITS.attachment || buffer.toString('base64') !== data) fail('Attachment must contain 1 byte to 8 MiB of canonical base64 data.');
  return buffer;
}
export function validateBackup(value) {
  obj(value, ['format', 'version', 'project', 'attachmentData'], 'Backup');
  if (value.format !== 'proofpack-backup' || value.version !== 1) fail('This is not a supported full Proofpack backup. Customer manifests cannot be imported.');
  const project = validateProject(value.project); array(value.attachmentData, 'Attachment data', LIMITS.attachments * 2);
  if (value.attachmentData.length !== allAttachments(project).length) fail('Backup must include data for every attachment, including reviewed history.');
  const buffers = new Map();
  for (const item of value.attachmentData) {
    obj(item, ['id', 'data'], 'Attachment data'); identifier(item.id); if (buffers.has(item.id)) fail('Duplicate attachment data.');
    const meta = allAttachments(project).find((a) => a.id === item.id); if (!meta) fail('Attachment data has no metadata.');
    const buffer = decodeAttachment(item.data); if (buffer.length !== meta.size || hash(buffer) !== meta.sha256) fail(`Attachment integrity check failed: ${meta.name}.`); buffers.set(item.id, buffer);
  }
  return { project, buffers };
}
export function demoProject() {
  const p = emptyProject();
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  p.charter = { customer: 'Alder & Finch · fictional company', title: 'A calmer path from intake to action', objective: 'Demonstrate that a fictional service team can triage inbound requests faster, without sacrificing auditability or a clear operational handover.', owners: 'Maya Chen · pilot lead\nEli Brooks · customer sponsor (fictional)', startDate: day(-18), endDate: day(12), internalNotes: 'DEMO ONLY. All organizations, people, metrics, and artifacts in this workspace are fictional. Internal planning: prepare the escalation rehearsal before sponsor review.', demo: true };
  p.criteria = [
    { id: 'criterion-triage', name: 'Bring triage below two minutes', metric: 'Median time from intake to routing', baseline: '4m 20s across 120 fictional requests', threshold: 'Under 2m 00s across at least 100 requests', targetDate: day(5), owner: 'Maya Chen', status: 'met', reviewer: 'Eli Brooks (fictional)', rationale: 'Reviewed the synthetic 120-request run: median 1m 42s. Threshold met in this demonstration, not a real customer result.', reviewedAt: day(-1), visibility: 'customer' },
    { id: 'criterion-audit', name: 'Make every route explainable', metric: 'Requests with a complete routing audit record', baseline: '72% in fictional baseline', threshold: '100% across the same 120-request set', targetDate: day(8), owner: 'Nora Vale', status: 'unassessed', reviewer: '', rationale: '', reviewedAt: '', visibility: 'customer' },
    { id: 'criterion-ops', name: 'Rehearse an independent recovery', metric: 'Customer operator completes recovery without pilot lead', baseline: 'Not rehearsed', threshold: 'One witnessed recovery within 15 minutes', targetDate: day(10), owner: 'Eli Brooks', status: 'blocked', reviewer: 'Maya Chen', rationale: 'The fictional operator access review is still pending. A runbook is not proof of a successful rehearsal.', reviewedAt: day(-1), visibility: 'customer' },
    { id: 'criterion-internal', name: 'Internal delivery margin check', metric: 'Estimated support hours per week', baseline: '8 hours', threshold: 'Under 4 hours', targetDate: day(10), owner: 'Maya Chen', status: 'unassessed', reviewer: '', rationale: '', reviewedAt: '', visibility: 'internal' }
  ];
  p.evidence = [
    { id: 'evidence-run', name: 'Synthetic routing benchmark', summary: 'DEMO DATA: 120 generated requests; median routing time 102 seconds. The attached CSV is an illustrative summary, not real customer measurements.', source: 'Fictional local test harness / run DEMO-024', owner: 'Maya Chen', collectedAt: day(-2), staleAfterDays: 14, criterionIds: ['criterion-triage', 'criterion-audit'], visibility: 'customer' },
    { id: 'evidence-audit', name: 'Audit record spot-check', summary: 'DEMO DATA: ten sample routing records include actor, timestamp, and rule explanation. Full-set review is still required; this evidence does not mark the criterion as met.', source: 'Fictional audit review session', owner: 'Nora Vale', collectedAt: day(-16), staleAfterDays: 7, criterionIds: ['criterion-audit'], visibility: 'customer' },
    { id: 'evidence-private', name: 'Internal support estimate', summary: 'Fictional planning estimate, not for customer handover. Includes delivery assumptions that have not been reviewed.', source: 'Internal demo planning', owner: 'Maya Chen', collectedAt: day(-1), staleAfterDays: 30, criterionIds: ['criterion-internal', 'criterion-ops'], visibility: 'internal' }
  ];
  p.risks = [
    { id: 'risk-access', name: 'Operator access is not approved', detail: 'The recovery rehearsal cannot run until the fictional customer operator has the right role.', owner: 'Eli Brooks', severity: 'high', status: 'open', mitigation: 'Approve a least-privilege role and schedule a witnessed rehearsal before pilot close.', criterionIds: ['criterion-ops'], visibility: 'customer' },
    { id: 'risk-scope', name: 'Support scope may expand', detail: 'Fictional internal commercial planning risk.', owner: 'Maya Chen', severity: 'medium', status: 'open', mitigation: 'Confirm support boundaries internally.', criterionIds: ['criterion-internal'], visibility: 'internal' }
  ];
  p.decisions = [{ id: 'decision-scope', name: 'Keep the first pilot to one intake queue', detail: 'Use a single fictional queue to make before-and-after comparisons repeatable. Expansion requires a separate review.', owner: 'Maya Chen / Eli Brooks', date: day(-12), criterionIds: ['criterion-triage'], visibility: 'customer' }];
  p.checklist = [
    { id: 'check-runbook', name: 'Review the operator runbook', detail: 'Fictional runbook structure reviewed: ownership, routing controls, recovery, escalation.', owner: 'Nora Vale', dueDate: day(-1), done: true, visibility: 'customer' },
    { id: 'check-recovery', name: 'Witness the recovery rehearsal', detail: 'Record operator, duration, result, and any follow-up actions. Attach evidence after the rehearsal.', owner: 'Eli Brooks', dueDate: day(10), done: false, visibility: 'customer' },
    { id: 'check-review', name: 'Sign off the final success review', detail: 'Review each criterion explicitly. Export the customer preview only after checking visibility and free text.', owner: 'Maya Chen', dueDate: day(12), done: false, visibility: 'customer' }
  ];
  const buffer = Buffer.from('dataset,requests,median_seconds,audit_review\nFICTIONAL_DEMO_ONLY,120,102,pending_full_review\n');
  p.attachments = [{ id: 'attachment-demo', evidenceId: 'evidence-run', name: 'fictional-benchmark.csv', type: 'text/csv', size: buffer.length, sha256: hash(buffer), createdAt: new Date().toISOString(), visibility: 'customer' }];
  return { project: validateProject(p), buffers: new Map([['attachment-demo', buffer]]) };
}
