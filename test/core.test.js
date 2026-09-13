import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProject, emptyProject, validateProject, validateFilename, validateBackup, decodeAttachment, customerProject, manifest, assess, hash, LIMITS } from '../core.js';
import { renderHandover } from '../handover.js';
const fixture = () => demoProject().project;
const backup = () => { const { project, buffers } = demoProject(); return { format: 'proofpack-backup', version: 1, project, attachmentData: [...buffers].map(([id, b]) => ({ id, data: b.toString('base64') })) }; };

test('empty and explicitly fictional complete sample validate', () => {
  assert.equal(validateProject(emptyProject()).revision, 0); const p = fixture(); assert.equal(validateProject(p).charter.demo, true); assert.match(p.charter.customer, /fictional/); assert.ok(p.criteria.some((c) => c.status === 'blocked')); assert.ok(p.criteria.some((c) => c.status === 'met'));
});
test('evidence presence never assesses criteria', () => {
  const p = fixture(); const c = p.criteria.find((c) => c.id === 'criterion-audit'); assert.equal(c.status, 'unassessed'); assert.ok(p.evidence.some((e) => e.criterionIds.includes(c.id))); assert.ok(assess(p).warnings.some((w) => w.recordId === c.id)); validateProject(p); assert.equal(c.status, 'unassessed');
});
test('met, unmet, and blocked each require reviewer, rationale, and date', () => {
  for (const status of ['met', 'unmet', 'blocked']) for (const missing of ['reviewer', 'rationale', 'reviewedAt']) { const p = fixture(); p.criteria[0].status = status; p.criteria[0][missing] = ''; assert.throws(() => validateProject(p)); }
});
test('unassessed cannot retain old review fields', () => { const p = fixture(); p.criteria[0].status = 'unassessed'; assert.throws(() => validateProject(p), /previous review/); });
test('criterion metric, baseline, threshold, owner, and real dates required', () => {
  for (const field of ['metric', 'baseline', 'threshold', 'owner']) { const p = fixture(); p.criteria[0][field] = ''; assert.throws(() => validateProject(p)); }
  for (const date of ['2026-02-30', 'today', '2026-13-01', null]) { const p = fixture(); p.criteria[0].targetDate = date; assert.throws(() => validateProject(p)); }
});
test('reject unknown fields, duplicate ids, invalid enum and broken criterion/evidence references', () => {
  const unknown = fixture(); unknown.path = '/tmp'; assert.throws(() => validateProject(unknown), /unexpected/);
  const duplicate = fixture(); duplicate.evidence[0].id = duplicate.criteria[0].id; assert.throws(() => validateProject(duplicate), /unique/);
  const invalid = fixture(); invalid.criteria[0].status = 'successful'; assert.throws(() => validateProject(invalid), /one of/);
  const broken = fixture(); broken.criteria = []; assert.throws(() => validateProject(broken), /missing criterion/);
  const absent = fixture(); absent.evidence = []; assert.throws(() => validateProject(absent), /missing evidence/);
});
test('readiness includes stale evidence, missing/corrupt file, risk, charter, checklist, and date warnings', () => {
  const p = fixture(); const initial = assess(p, { 'attachment-demo': 'missing' }); assert.equal(initial.ready, false);
  for (const kind of ['stale', 'file', 'risk', 'criteria', 'handover']) assert.ok(initial.warnings.some((w) => w.kind === kind), kind);
  p.charter.objective = ''; p.criteria[1].targetDate = '2020-01-01'; assert.ok(assess(p).warnings.some((w) => w.kind === 'charter')); assert.ok(assess(p).warnings.some((w) => w.kind === 'date'));
});
test('customer projection strips internal records, links, charter metadata, and internal-parent files', () => {
  const p = fixture(); p.evidence[0].criterionIds.push('criterion-internal');
  p.attachments.push({ ...p.attachments[0], id: 'secret-file', evidenceId: 'evidence-private', name: 'INTERNAL_PARENT_SECRET.csv', visibility: 'customer' });
  p.attachments.push({ ...p.attachments[0], id: 'private-file', name: 'INTERNAL_FILE_SECRET.csv', visibility: 'internal' });
  const safe = customerProject(p); const serialized = JSON.stringify(safe);
  for (const secret of ['internalNotes', 'criterion-internal', 'evidence-private', 'risk-scope', 'INTERNAL_PARENT_SECRET', 'INTERNAL_FILE_SECRET', 'Support scope may expand']) assert.ok(!serialized.includes(secret), secret);
  assert.equal(safe.attachments.length, 1); assert.equal(p.evidence[0].criterionIds.length, 3, 'projection must not mutate source');
  const m = JSON.stringify(manifest(p)); assert.ok(!m.includes('evidence-private')); assert.ok(!m.includes('INTERNAL_PARENT_SECRET')); assert.ok(!m.includes('internalNotes'));
});
test('offline customer HTML escapes all text and excludes private bytes/metadata', async () => {
  const { project: p, buffers } = demoProject(); p.charter.title = '<script>alert("bad")</script>'; p.evidence[0].name = '<img src=x onerror=alert(1)>';
  p.attachments.push({ ...p.attachments[0], id: 'private-file', name: 'INTERNAL_CONTENT.txt', visibility: 'internal' });
  const requested = []; const store = { health: async (safe) => Object.fromEntries(safe.attachments.map((a) => [a.id, 'ok'])), readAttachment: async (a) => { requested.push(a.id); return buffers.get(a.id); } };
  const html = await renderHandover(p, store); assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('INTERNAL_CONTENT')); assert.ok(!html.includes('Internal support estimate')); assert.ok(!html.includes('internalNotes')); assert.deepEqual(requested, ['attachment-demo']); assert.ok(html.includes('data:application/octet-stream;base64,')); assert.ok(html.includes('FICTIONAL DEMONSTRATION'));
});
test('safe filenames reject traversal, paths, control characters and excess length', () => {
  for (const name of ['../secret', '/etc/passwd', 'C:\\data.txt', '..', '.', 'foo\nbar', 'x\u0000.txt', 'x'.repeat(161), 'file.', ' file', 'file?']) assert.throws(() => validateFilename(name), name);
  for (const name of ['notes.csv', 'Review 2026.txt', '測試.csv']) assert.doesNotThrow(() => validateFilename(name));
});
test('attachment limit and canonical base64 validation', () => {
  assert.equal(decodeAttachment('eA==').toString(), 'x');
  for (const value of ['', '%%%%', 'eA', 'eA==\n', 'eB==', '====', null]) assert.throws(() => decodeAttachment(value));
  assert.throws(() => decodeAttachment(Buffer.alloc(LIMITS.attachment + 1).toString('base64')), /oversized|8 MiB/);
  const p = fixture(); p.attachments[0].size = LIMITS.attachment + 1; assert.throws(() => validateProject(p), /8 MiB/);
});
test('maximum-size attachment decoding is linear and accepts exactly 8 MiB', () => {
  const bytes = Buffer.alloc(LIMITS.attachment, 97); assert.deepEqual(decodeAttachment(bytes.toString('base64')), bytes);
});
test('attachment total, record count, and metadata budgets reject oversized projects', () => {
  const p = fixture(); const template = p.attachments[0]; p.attachments = Array.from({ length: 6 }, (_, i) => ({ ...template, id: `large-${i}`, size: LIMITS.attachment })); assert.throws(() => validateProject(p), /40 MiB/);
  const many = fixture(); many.decisions = Array.from({ length: 501 }, (_, i) => ({ ...many.decisions[0], id: `decision-${i}` })); assert.throws(() => validateProject(many), /500/);
  const text = fixture(); text.decisions = Array.from({ length: 500 }, (_, i) => ({ ...text.decisions[0], id: `decision-${i}`, name: 'n'.repeat(200), detail: '字'.repeat(4000) })); assert.throws(() => validateProject(text), /metadata.*4 MiB/);
});
test('full backup roundtrips all records and exact attachment bytes', () => {
  const value = backup(); const validated = validateBackup(JSON.parse(JSON.stringify(value))); assert.deepEqual(validated.project, value.project); const meta = value.project.attachments[0]; assert.equal(hash(validated.buffers.get(meta.id)), meta.sha256); assert.equal(validated.buffers.get(meta.id).length, meta.size);
});
test('strict backup import rejects malformed envelopes, unknown fields, bad digest, missing/duplicate data, paths', () => {
  for (const value of [null, [], {}, { format: 'proofpack-customer-manifest', version: 1, project: fixture(), attachmentData: [] }]) assert.throws(() => validateBackup(value));
  const unknown = backup(); unknown.filePath = '/tmp/x'; assert.throws(() => validateBackup(unknown), /unexpected/);
  const bad = backup(); bad.attachmentData[0].data = Buffer.from('tampered').toString('base64'); assert.throws(() => validateBackup(bad), /integrity/);
  const missing = backup(); missing.attachmentData = []; assert.throws(() => validateBackup(missing), /every attachment/);
  const dup = backup(); dup.attachmentData.push(dup.attachmentData[0]); assert.throws(() => validateBackup(dup));
  const path = backup(); path.project.attachments[0].name = '../private'; assert.throws(() => validateBackup(path));
});
