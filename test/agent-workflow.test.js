import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { product } from '../agent/product.mjs';
import { createApp } from '../server.js';
test('agent evidence and proposals never become approval; attachments, exports and UI preserve boundaries', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'proofpack-workflow-')); t.after(() => rm(workspace, { recursive: true, force: true })); const o = { workspace }; await product.init(o); const call = async (name, input = {}) => (await product.execute(name, input, o)).data;
  const pilotId = (await call('pilot.list')).defaultPilotId; const revision = async () => (await call('pilot.get', { pilotId })).project.revision;
  await call('record.edit', { pilotId, revision: await revision(), section: 'criteria', action: 'add', recordId: 'criterion-test', record: { name: 'Fictional coverage', metric: 'coverage', baseline: 'unknown', threshold: 'review required', owner: 'Test owner', targetDate: '2027-01-01', visibility: 'customer' } });
  await call('record.edit', { pilotId, revision: await revision(), section: 'evidence', action: 'add', recordId: 'evidence-test', record: { name: 'Fictional evidence', summary: 'Synthetic fixture only', source: 'integration test', owner: 'Test owner', collectedAt: new Date().toISOString().slice(0, 10), staleAfterDays: 30, criterionIds: ['criterion-test'], visibility: 'customer' } });
  await writeFile(path.join(workspace, 'fixture.txt'), 'Synthetic attachment, no customer data.');
  await call('attachment.add', { pilotId, revision: await revision(), evidenceId: 'evidence-test', file: 'fixture.txt', name: 'fixture.txt' });
  await symlink('/etc/passwd', path.join(workspace, 'outside.txt')); await assert.rejects(call('attachment.add', { pilotId, revision: await revision(), evidenceId: 'evidence-test', file: 'outside.txt', name: 'outside.txt' }), /Symlinks/);
  await call('review.propose', { pilotId, revision: await revision(), criterionId: 'criterion-test', outcome: 'met', rationale: 'PRIVATE_AGENT_PROPOSAL_SENTINEL', actor: 'test-agent' });
  assert.equal((await call('pilot.check', { pilotId })).readiness.met, 0); assert.equal((await call('pilot.get', { pilotId })).project.criteria[0].status, 'unassessed');
  for (const format of ['manifest', 'handover', 'deckforge']) { const exported = await call('pilot.export', { pilotId, format }); const text = Buffer.from(exported.artifact.base64, 'base64').toString(); assert.ok(!text.includes('PRIVATE_AGENT_PROPOSAL_SENTINEL')); assert.ok(!text.includes('fixture.txt')); }
  const input = { pilotId, revision: await revision(), criterionId: 'criterion-test', status: 'met', reviewer: 'Test human', rationale: 'Test record only', date: new Date().toISOString().slice(0, 10), confirmHumanReview: true };
  await assert.rejects(product.execute('review.record', input, { ...o, transport: 'mcp' }), /human review UI/);
  const { server } = await createApp({ workspace }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); }); const web = await (await fetch(`http://127.0.0.1:${server.address().port}/api/project?pilot=${pilotId}`)).json(); assert.equal(web.project.proposals.length, 1); assert.equal(web.readiness.met, 0);
  await call('record.edit', { pilotId, revision: await revision(), section: 'evidence', action: 'update', recordId: 'evidence-test', record: { summary: 'Changed synthetic evidence' } }); assert.equal((await call('review.proposals', { pilotId })).items[0].freshness, 'changed');
});
