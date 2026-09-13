import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const temp = path.join(ROOT, '.test-tmp'); await fs.mkdir(temp, { recursive: true }); const dir = await fs.mkdtemp(path.join(temp, 'server-')); const { server, store } = await createApp({ directory: dir }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const port = server.address().port; const origin = `http://127.0.0.1:${port}`;
  const request = async (route, method = 'GET', value, headers = {}) => fetch(origin + route, { method, headers: { ...(value !== undefined ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { server, store, port, origin, request };
}
test('factory binds only loopback and supports isolated persistence', async (t) => { const { server, request } = await fixture(t); assert.equal(server.address().address, '127.0.0.1'); const r = await request('/api/project'); assert.equal(r.status, 200); assert.equal((await r.json()).project.revision, 0); });
test('CSP and browser security headers cover static app and JSON', async (t) => {
  const { request } = await fixture(t); for (const route of ['/', '/app.js', '/style.css', '/api/project']) { const r = await request(route); assert.equal(r.status, 200); assert.match(r.headers.get('content-security-policy'), /default-src 'none'/); assert.match(r.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('referrer-policy'), 'no-referrer'); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('access-control-allow-origin'), null); }
});
test('Host and Origin protection rejects DNS rebinding, missing write origin, cross-site', async (t) => {
  const { request, store, port } = await fixture(t);
  // Node fetch rewrites Host; raw HTTP is required to exercise this boundary.
  const hostStatus = await new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: '/api/project', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(hostStatus, 403);
  assert.equal((await request('/api/project', 'GET', undefined, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await request('/api/project', 'PUT', store.snapshot(), { Origin: '' })).status, 403);
  assert.equal((await request('/api/project', 'PUT', store.snapshot(), { Origin: 'null' })).status, 403);
  assert.equal((await request('/api/project', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(store.project.revision, 0);
});
test('strict JSON content type, malformed input, method and static path boundaries', async (t) => {
  const { origin, request } = await fixture(t);
  assert.equal((await fetch(origin + '/api/project', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(origin + '/api/project', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
  for (const route of ['/core.js', '/store.js', '/data/project.json', '/%2e%2e/package.json', '/api/attachments/..%2f..%2fsecret']) assert.equal((await request(route)).status, 404, route);
  assert.equal((await request('/api/project', 'DELETE', {})).status, 404);
});
test('declared oversized payload is rejected before parsing', async (t) => {
  const { port, origin } = await fixture(t);
  const code = await new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: '/api/project', method: 'PUT', headers: { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': String(9 * 1024 * 1024) } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end('{}'); }); assert.equal(code, 413);
});
test('demo, save, explicit status, customer export, backup import workflow', async (t) => {
  const { request, store } = await fixture(t);
  assert.equal((await request('/api/demo', 'POST', { revision: 0, confirm: 'REPLACE' })).status, 200);
  assert.equal((await request('/api/export/backup')).status, 400); const backup = await (await request('/api/export/backup?confirm=internal')).json(); assert.equal(backup.project.attachments.length, 1); assert.equal(backup.attachmentData.length, 1);
  const htmlResponse = await request('/api/export/handover'); assert.match(htmlResponse.headers.get('content-disposition'), /attachment/); const html = await htmlResponse.text(); assert.ok(html.includes('FICTIONAL DEMONSTRATION')); assert.ok(!html.includes('Internal support estimate')); assert.ok(!html.includes('Internal delivery margin check')); assert.ok(html.includes('data:application/octet-stream;base64,'));
  const manifest = await (await request('/api/export/manifest')).json(); assert.equal(manifest.format, 'proofpack-customer-manifest'); assert.equal(manifest.charter.internalNotes, undefined);
  const p = store.snapshot(); p.criteria[1].status = 'met'; assert.equal((await request('/api/project', 'PUT', p)).status, 400);
  assert.equal((await request('/api/reset', 'POST', { revision: 1, confirm: 'REPLACE' })).status, 200); assert.equal(store.project.criteria.length, 0);
  assert.equal((await request('/api/import', 'POST', { revision: 2, backup })).status, 200); assert.equal(store.project.criteria.length, backup.project.criteria.length);
  const file = await request('/api/attachments/attachment-demo'); assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'application/octet-stream'); assert.match(file.headers.get('content-disposition'), /attachment/); assert.match(file.headers.get('content-security-policy'), /sandbox/); assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), backup.attachmentData[0].data);
});
test('malformed import preserves active workspace and files', async (t) => { const { request, store } = await fixture(t); await request('/api/demo', 'POST', { revision: 0, confirm: 'REPLACE' }); const before = store.snapshot(); assert.equal((await request('/api/import', 'POST', { revision: 1, backup: { format: 'wrong' } })).status, 400); assert.deepEqual(store.snapshot(), before); assert.equal((await request('/api/attachments/attachment-demo')).status, 200); });
test('CLI help works through real and symlinked absolute paths without writing data', async () => { const run = promisify(execFile); const result = await run(process.execPath, ['~/Sideproject/proofpack/server.js', '--help']); assert.match(result.stdout, /127\.0\.0\.1:4313/); assert.match(result.stdout, /npm test/); await assert.rejects(run(process.execPath, [path.join(ROOT, 'server.js'), '--unknown'])); });
