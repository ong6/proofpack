import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PilotLibrary } from './library.js';
import { LIMITS, ValidationError, assess, manifest, demoProject, emptyProject, coverage, decisionFreshness } from './core.js';
import { fielddeckDeck } from './fielddeck.js';
import { renderHandover } from './handover.js';
import { withLock } from './agent/workspace.mjs';
import { ProofpackService } from './service.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'";
const EXPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
async function body(request, max = LIMITS.request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) throw new ValidationError('Content-Type must be application/json.', 415);
  if (Number(request.headers['content-length']) > max) { request.resume(); throw new ValidationError('Request exceeds the allowed size.', 413); }
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > max) throw new ValidationError('Request exceeds the allowed size.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ValidationError('Malformed JSON request.'); }
}
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }
function download(response, name, type, data) { response.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` }); response.end(data); }
export async function createApp({ directory = path.join(ROOT, 'data'), workspace } = {}) {
  if (workspace) directory = workspace;
  let library = await withLock(directory, () => new PilotLibrary(directory).open(), { create: true });
  const store = new Proxy({}, { get: (_, key) => { const current = library.get(); const value = current[key]; return typeof value === 'function' ? value.bind(current) : value; } });
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', CSP); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Frame-Options', 'SAMEORIGIN'); response.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const port = server.address()?.port; const authority = `${HOST}:${port}`; const origin = `http://${authority}`;
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) throw new ValidationError('Loopback connections only.', 403);
      if (request.headers.host !== authority) throw new ValidationError(`Host rejected. Open ${origin}.`, 403);
      if (request.headers.origin && request.headers.origin !== origin) throw new ValidationError('Origin rejected.', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new ValidationError('Cross-site requests are not allowed.', 403);
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) throw new ValidationError('Writes require the exact local Origin header.', 403);
      if (!request.url.startsWith('/') || request.url.startsWith('//')) throw new ValidationError('Invalid request target.');
      await withLock(directory, async () => {
      const service = await new ProofpackService(directory).open(); library = service.library;
      const url = new URL(request.url, origin); const route = url.pathname;
      const pilot = url.searchParams.has('pilot') ? url.searchParams.get('pilot') : library.value.defaultPilotId;
      const scoped = (action, write = false) => library.withPilot(pilot, action, write);
      if (request.method === 'GET' && route === '/api/library') return json(response, 200, { library: library.snapshot(), limits: LIMITS });
      if (request.method === 'POST' && route === '/api/pilots') return json(response, 201, await library.create(await body(request, 4096)));
      if (request.method === 'PATCH' && route.startsWith('/api/pilots/')) return json(response, 200, await library.archive(route.slice('/api/pilots/'.length), await body(request, 4096)));
      if (request.method === 'GET' && route === '/api/project') {
        const value = await scoped(async (active) => { const project = active.snapshot(); const health = await active.health(project); return { project, health, readiness: assess(project, health), coverage: coverage(project, health), decisionReviews: (project.decisionReviews || []).map((d) => ({ ...d, freshness: decisionFreshness(project, d) })) }; });
        return json(response, 200, value);
      }
      if (request.method === 'PUT' && route === '/api/project') { const value = await body(request, 8 * 1024 * 1024); return json(response, 200, { project: await service.save(pilot, value) }); }
      if (request.method === 'POST' && route === '/api/attachments') { const value = await body(request, 12 * 1024 * 1024); return json(response, 201, { project: await service.upload(pilot, value) }); }
      if (request.method === 'POST' && ['/api/reviews', '/api/decisions'].includes(route)) { const value = await body(request, 32 * 1024); return json(response, 201, { project: await scoped((active) => route === '/api/reviews' ? active.review(value) : active.decide(value), true) }); }
      if (request.method === 'POST' && route === '/api/import') {
        const value = await body(request); if (!value || Object.keys(value).sort().join(',') !== 'backup,revision') throw new ValidationError('Import requires backup and revision.');
        return json(response, 200, { project: await scoped((active) => active.replace(value.backup, value.revision), true) });
      }
      if (request.method === 'POST' && ['/api/demo', '/api/reset'].includes(route)) {
        const value = await body(request, 1024); if (!value || Object.keys(value).sort().join(',') !== 'confirm,revision' || value.confirm !== 'REPLACE') throw new ValidationError('Replacement confirmation is required.');
        const demo = route === '/api/demo' ? demoProject() : { project: emptyProject(), buffers: new Map() };
        const backup = { format: 'proofpack-backup', version: 1, project: demo.project, attachmentData: [...demo.buffers].map(([id, buffer]) => ({ id, data: buffer.toString('base64') })) };
        return json(response, 200, { project: await scoped((active) => active.replace(backup, value.revision), true) });
      }
      if (request.method === 'GET' && route === '/api/export/backup') {
        if (url.searchParams.get('confirm') !== 'internal') throw new ValidationError('Full backup contains internal records and attachment bytes. Explicit confirmation is required.');
        return download(response, 'proofpack-full-private-backup.json', 'application/json; charset=utf-8', JSON.stringify(await scoped((active) => active.backup()), null, 2));
      }
      if (request.method === 'GET' && ['/api/export/manifest', '/api/export/fielddeck'].includes(route)) {
        const result = await scoped(async (active) => { const project = active.snapshot(); const health = await active.health(project); return route.endsWith('fielddeck') ? fielddeckDeck(project, health) : manifest(project, health); });
        return download(response, route.endsWith('fielddeck') ? 'proofpack-customer-readout.fielddeck.json' : 'proofpack-customer-evidence-manifest.json', 'application/json; charset=utf-8', JSON.stringify(result, null, 2));
      }
      if (request.method === 'GET' && ['/api/export/handover', '/handover'].includes(route)) {
        const html = await scoped((active) => active.serial(() => renderHandover(active.snapshot(), active))); response.setHeader('Content-Security-Policy', EXPORT_CSP);
        if (route === '/api/export/handover') return download(response, 'proofpack-customer-handover.html', 'text/html; charset=utf-8', html);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(html);
      }
      if (request.method === 'GET' && route.startsWith('/api/attachments/')) {
        const key = route.slice('/api/attachments/'.length);
        const { meta, buffer } = await scoped(async (active) => { const meta = active.project.attachments.find((a) => a.id === key); if (!meta) throw new ValidationError('Attachment not found.', 404); return { meta, buffer: await active.readAttachment(meta) }; });
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length, 'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(meta.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`, 'Content-Security-Policy': "default-src 'none'; sandbox" }); return response.end(buffer);
      }
      if (request.method === 'GET' && STATIC.has(route)) {
        const [filename, type] = STATIC.get(route); const content = await fs.readFile(path.join(ROOT, 'public', filename)); response.writeHead(200, { 'Content-Type': type }); return response.end(content);
      }
      if (request.method === 'GET' && route === '/favicon.ico') { response.writeHead(204); return response.end(); }
      throw new ValidationError('Not found.', 404);
    }); } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : 'Local operation failed. No success is assumed; check the server terminal and retry.' }); else response.end();
      if (!error.status) console.error(error);
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxHeadersCount = 60;
  return { server, store };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Proofpack — local pilot evidence & handover workspace\n\nUsage: npm start\n       npm start -- --help\n       npm test\n\nOpen http://127.0.0.1:4313 (not localhost). Node 23 or newer; pinned local runtime dependencies.\nData stays in ./data beside server.js. No remote services or telemetry.\nUse in-app Help for import/export, attachment limits, redaction, and recovery.\nOnly one server process may use this data directory at a time.\nStop with Ctrl+C.'); return;
  }
  if (args.length) throw new Error('Unknown option. Run npm start -- --help.');
  const directory = path.join(ROOT, 'data'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Data directory must not be a symlink.');
  const lockPath = path.join(directory, 'server.lock'); let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Proofpack data is locked by another process. Stop the running server. If it crashed, confirm no Proofpack process is running, then remove data/server.lock and restart.'); throw error;
  }
  await lock.writeFile(String(process.pid));
  let cleaned = false;
  const cleanup = async () => { if (cleaned) return; cleaned = true; await lock.close(); await fs.unlink(lockPath).catch(() => {}); };
  try {
    const { server } = await createApp({ directory });
    server.on('error', async (error) => { console.error(`Proofpack could not listen: ${error.message}`); await cleanup(); process.exitCode = 1; });
    const stop = () => server.close(async () => { await cleanup(); process.exit(0); });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    server.listen(4313, HOST, () => console.log('Proofpack is ready at http://127.0.0.1:4313\nLocal data: ' + directory + '\nPress Ctrl+C to stop.'));
  } catch (error) { await cleanup(); throw error; }
}
if (process.argv[1] && await fs.realpath(path.resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
