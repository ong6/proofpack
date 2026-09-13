import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.js';
import { demoProject, hash, today, criterionFreshness, decisionFreshness, assess, customerProject } from '../core.js';
import { PilotLibrary } from '../library.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');
async function storeFixture(t) {
  await fs.mkdir(ROOT, { recursive: true }); const dir = await fs.mkdtemp(path.join(ROOT, 'store-')); t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const store = await new Store(dir).open(); const { project, buffers } = demoProject();
  await store.replace({ format: 'proofpack-backup', version: 1, project, attachmentData: [...buffers].map(([id, b]) => ({ id, data: b.toString('base64') })) }, 0); return { store, dir };
}
test('atomic persistence reopens full state and does not leave temporary files', async (t) => {
  const { store, dir } = await storeFixture(t); const p = store.snapshot(); p.charter.title = 'Saved charter'; await store.save(p); const reopened = await new Store(dir).open(); assert.equal(reopened.project.charter.title, 'Saved charter'); assert.equal(reopened.project.revision, 2); assert.ok(!(await fs.readdir(dir)).some((name) => name.endsWith('.tmp'))); assert.equal((await reopened.health())['attachment-demo'], 'ok');
});
test('conflicting simultaneous revisions cannot silently overwrite each other', async (t) => {
  const { store } = await storeFixture(t); const a = store.snapshot(); const b = store.snapshot(); a.charter.title = 'First'; b.charter.title = 'Second';
  const results = await Promise.allSettled([store.save(a), store.save(b)]); assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.status, 409); assert.equal(store.project.charter.title, 'First');
});
test('failed validation leaves saved state and attachment bytes intact', async (t) => {
  const { store, dir } = await storeFixture(t); const before = await fs.readFile(store.file, 'utf8'); const invalid = store.snapshot(); invalid.criteria[0].status = 'met'; invalid.criteria[0].rationale = '';
  await assert.rejects(store.save(invalid)); assert.equal(await fs.readFile(store.file, 'utf8'), before); assert.equal((await new Store(dir).open()).project.revision, 1);
});
test('attachment uploads default nowhere implicitly, validate metadata, bytes, and server ownership', async (t) => {
  const { store } = await storeFixture(t); const b = Buffer.from('local file'); const value = { revision: store.project.revision, evidenceId: 'evidence-run', name: 'local.txt', type: 'text/plain', visibility: 'internal', data: b.toString('base64') };
  await store.upload(value); const a = store.project.attachments.at(-1); assert.equal(a.visibility, 'internal'); assert.equal(a.sha256, hash(b)); assert.deepEqual(await store.readAttachment(a), b);
  const p = store.snapshot(); p.attachments.at(-1).name = 'renamed.txt'; await assert.rejects(store.save(p), /immutable/);
  const v = store.snapshot(); v.attachments.at(-1).visibility = 'customer'; await store.save(v); assert.equal(store.project.attachments.at(-1).visibility, 'customer');
});
test('missing and corrupt attachments surface health warnings and block incomplete backup', async (t) => {
  const { store } = await storeFixture(t); const a = store.project.attachments[0]; const original = await store.readAttachment(a); await fs.writeFile(store.blobPath(a.sha256), 'tampered'); assert.equal((await store.health())[a.id], 'corrupt or unsafe'); await assert.rejects(store.backup(), /corrupt|integrity/);
  await fs.writeFile(store.blobPath(a.sha256), original); await fs.unlink(store.blobPath(a.sha256)); assert.equal((await store.health())[a.id], 'missing'); await assert.rejects(store.backup(), /missing/);
});
test('attachment symlink and hash traversal are rejected', async (t) => {
  const { store, dir } = await storeFixture(t); const a = store.project.attachments[0]; const b = await store.readAttachment(a); const target = path.join(dir, 'elsewhere.txt'); await fs.writeFile(target, b); await fs.unlink(store.blobPath(a.sha256)); await fs.symlink(target, store.blobPath(a.sha256)); await assert.rejects(store.readAttachment(a), /symlink/); assert.throws(() => store.blobPath('../../outside')); assert.throws(() => store.blobPath('x'.repeat(64)));
});
test('backup restore is roundtrippable, replacement is atomic, and bad import does not replace', async (t) => {
  const { store } = await storeFixture(t); const full = await store.backup(); const next = store.snapshot(); next.charter.title = 'Changed'; await store.save(next); const restored = await store.replace(full, store.project.revision); assert.equal(restored.charter.title, full.project.charter.title); assert.equal(restored.revision, 3); const again = await store.backup(); assert.deepEqual(again.attachmentData, full.attachmentData);
  const bad = structuredClone(full); bad.attachmentData[0].data = 'YmFk'; await assert.rejects(async () => store.replace(bad, store.project.revision)); assert.equal(store.project.revision, 3);
});
test('deleting referenced records requires safe unlinking, then unused files are removed', async (t) => {
  const { store } = await storeFixture(t); const a = store.project.attachments[0]; const p = store.snapshot(); p.evidence = p.evidence.filter((e) => e.id !== a.evidenceId); await assert.rejects(store.save(p), /missing evidence/); p.attachments = []; await store.save(p); await assert.rejects(fs.stat(store.blobPath(a.sha256)), { code: 'ENOENT' }); assert.equal(store.project.criteria[0].status, 'met');
});
test('corrupt persistence is not silently replaced with an empty project', async (t) => {
  const { store, dir } = await storeFixture(t); await fs.writeFile(store.file, '{broken'); await assert.rejects(new Store(dir).open(), /existing data has not been replaced/); assert.equal(await fs.readFile(store.file, 'utf8'), '{broken');
});
test('verified backups repair corrupt existing attachment files', async (t) => {
  const { store } = await storeFixture(t); const full = await store.backup(); const a = store.project.attachments[0]; await fs.writeFile(store.blobPath(a.sha256), 'broken'); await store.replace(full, store.project.revision); assert.equal((await store.health())[a.id], 'ok'); assert.equal(hash(await store.readAttachment(a)), a.sha256);
});
test('failed atomic rename preserves the prior project and memory snapshot', async (t) => {
  const { store } = await storeFixture(t); const before = store.snapshot(); const original = store.writeAtomic.bind(store); store.writeAtomic = async () => { throw new Error('simulated disk write failure'); }; const p = store.snapshot(); p.charter.title = 'Must not commit'; await assert.rejects(store.save(p), /disk write/); assert.deepEqual(store.snapshot(), before); store.writeAtomic = original; assert.deepEqual((await new Store(store.directory).open()).snapshot(), before);
});
test('safe upload rejects path names and unknown input before touching project', async (t) => {
  const { store } = await storeFixture(t); const value = { revision: 1, evidenceId: 'evidence-run', name: '../x.txt', type: 'text/plain', visibility: 'internal', data: 'eA==' }; await assert.rejects(store.upload(value), /filename/i); value.name = 'x.txt'; value.path = '/etc/passwd'; await assert.rejects(store.upload(value), /fields/); assert.equal(store.project.revision, 1);
});

test('explicit reviews retain legacy history, invalidate changed inputs and preserve removed reviewed bytes', async (t) => {
  const { store, dir } = await storeFixture(t);
  const criterionId = store.project.criteria[0].id;
  const review = () => ({ revision: store.project.revision, criterionId, status: 'met', reviewer: 'Fixture reviewer', rationale: 'Synthetic controlled sample only', date: today() });
  assert.equal(criterionFreshness(store.project, store.project.criteria[0]), 'legacy-unverified');
  await store.review(review());
  const history = structuredClone(store.project.criteria[0].reviews);
  assert.equal(history.length, 2);
  assert.equal(history[0].snapshot, null);
  assert.equal(assess(store.project, await store.health()).met, 1);
  const originalFile = store.project.attachments[0], originalBytes = await store.readAttachment(originalFile);
  const change = store.snapshot(); change.evidence[0].summary += ' Revised measurement.'; await store.save(change);
  assert.equal(criterionFreshness(store.project, store.project.criteria[0]), 'changed');
  assert.deepEqual(store.project.criteria[0].reviews, history);
  assert.equal(assess(store.project, await store.health()).met, 0);
  await store.review(review());
  const removal = store.snapshot(); removal.attachments = []; await store.save(removal);
  assert.equal(store.project.attachmentHistory.length, 1);
  assert.equal(criterionFreshness(store.project, store.project.criteria[0]), 'changed');
  const backup = await store.backup();
  assert.deepEqual(Buffer.from(backup.attachmentData[0].data, 'base64'), originalBytes);
  const safe = customerProject(store.project);
  assert.equal(safe.attachmentHistory, undefined);
  assert.ok(!JSON.stringify(safe).includes('"snapshot"'));
  const reopened = await new Store(dir).open();
  assert.deepEqual(reopened.snapshot(), store.snapshot());
  assert.deepEqual(await reopened.readAttachment(reopened.project.attachmentHistory[0]), originalBytes);
});

test('review histories cannot be edited or removed and stale review writers cannot overwrite', async (t) => {
  const { store } = await storeFixture(t);
  const value = { revision: store.project.revision, criterionId: store.project.criteria[0].id, status: 'blocked', reviewer: 'Fixture', rationale: 'Incomplete evaluation', date: today() };
  const results = await Promise.allSettled([store.review(value), store.review(value)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  const before = store.snapshot();
  const edited = store.snapshot(); edited.criteria[0].reviews = []; await assert.rejects(store.save(edited), /immutable/);
  const removed = store.snapshot(); removed.criteria.shift();
  for (const section of ['evidence', 'risks', 'decisions']) for (const record of removed[section]) record.criterionIds = record.criterionIds.filter(id => id !== value.criterionId);
  await assert.rejects(store.save(removed), /retain history/);
  assert.deepEqual(store.snapshot(), before);
  await assert.rejects(store.review({ ...value, revision: before.revision, rationale: '' }), /non-empty/);
  assert.deepEqual(store.snapshot(), before);
});

test('proceed decisions preserve gates and history while subsequent scope edits require re-review', async (t) => {
  const { store, dir } = await storeFixture(t);
  await store.decide({ revision: store.project.revision, outcome: 'proceed', reviewer: 'Fixture sponsor', rationale: 'Synthetic record, not approval', date: today(), conditions: 'Do not expand until all gates pass', visibility: 'customer' });
  const decision = structuredClone(store.project.decisionReviews[0]);
  assert.equal(decisionFreshness(store.project, decision), 'current');
  assert.equal(assess(store.project, await store.health()).met, 0);
  const changed = store.snapshot(); changed.charter.objective += ' Changed scope.'; await store.save(changed);
  assert.equal(decisionFreshness(store.project, decision), 'changed');
  assert.deepEqual(store.project.decisionReviews[0], decision);
  const tampered = store.snapshot(); tampered.decisionReviews = []; await assert.rejects(store.save(tampered), /immutable/);
  const broken = await store.backup(); broken.project.decisionReviews[0].snapshot.charter.objective = 'Tampered';
  await assert.rejects(async () => store.replace(broken, store.project.revision), /integrity/);
  assert.deepEqual((await new Store(dir).open()).project.decisionReviews[0], decision);
});

test('pilot library migration keeps exact original metadata and attachment recovery copies', async (t) => {
  const { store, dir } = await storeFixture(t);
  const original = await fs.readFile(store.file), attachment = store.project.attachments[0], bytes = await store.readAttachment(attachment);
  const library = await new PilotLibrary(dir).open();
  assert.deepEqual(await fs.readFile(store.file), original);
  assert.deepEqual(await fs.readFile(path.join(dir, 'pre-library-v1-project.json')), original);
  assert.deepEqual(await fs.readFile(path.join(dir, 'pre-library-v1-attachments', attachment.sha256 + '.blob')), bytes);
  assert.equal(criterionFreshness(library.get().project, library.get().project.criteria[0]), 'legacy-unverified');
  const current = library.snapshot();
  const created = await library.create({ revision: current.revision, title: 'Isolated second pilot' });
  assert.equal(library.get(created.pilotId).project.criteria.length, 0);
  assert.equal(library.get(current.defaultPilotId).project.criteria.length, store.project.criteria.length);
  await library.archive(current.defaultPilotId, { revision: library.value.revision, archived: true });
  await assert.rejects(library.withPilot(current.defaultPilotId, active => active.save(active.snapshot()), true), /read-only/);
  assert.deepEqual(await library.withPilot(current.defaultPilotId, active => active.backup()), await store.backup());
  const reopened = await new PilotLibrary(dir).open();
  assert.deepEqual(reopened.snapshot(), library.snapshot());
  assert.deepEqual(await fs.readFile(path.join(dir, 'pre-library-v1-project.json')), original);
  await reopened.archive(current.defaultPilotId, { revision: reopened.value.revision, archived: false });
  await reopened.withPilot(current.defaultPilotId, active => active.save(active.snapshot()), true);
  assert.deepEqual(await fs.readFile(path.join(dir, 'pre-library-v1-project.json')), original);
});

test('pilot library conflicts, corrupt recovery copies and missing stores fail without replacements', async (t) => {
  const { store, dir } = await storeFixture(t);
  const original = await fs.readFile(store.file);
  const recovery = path.join(dir, 'pre-library-v1-project.json');
  await fs.writeFile(recovery, 'Do not overwrite this recovery copy');
  await assert.rejects(new PilotLibrary(dir).open(), /recovery copy differs/);
  assert.deepEqual(await fs.readFile(store.file), original);
  await fs.unlink(recovery);
  const library = await new PilotLibrary(dir).open();
  const value = { revision: library.value.revision, title: 'One concurrent pilot' };
  const results = await Promise.allSettled([library.create(value), library.create(value)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  await assert.rejects(library.withPilot('../outside', () => {}), /not found/);
  const child = library.value.pilots.find(p => !p.root), file = library.get(child.id).file;
  await fs.unlink(file);
  await assert.rejects(new PilotLibrary(dir).open(), { code: 'ENOENT' });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
