'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { defaults } = require('./src/config');
const store = require('./src/store');
const pool = require('./src/pool');
const svc = require('./src/service');
const ingest = require('./src/ingest');
const sample = require('./src/sample');
const fuzz = require('./src/fuzz');
const llm = require('./src/llm');
const coderules = require('./src/coderules');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function readJson(req, limit = 40e6) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('Upload too large (40 MB max)')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// Small router: [method, pattern, handler(req, params, body, url)]
const routes = [];
const on = (m, p, h) => routes.push([m, new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h]);
const who = (req, b) => String((b && b.who) || req.headers['x-user'] || 'engineer').slice(0, 60);
const pid = (p) => { const id = decodeURIComponent(p.id); if (!pool.SAFE.test(id)) throw new Error('bad project id'); return id; };

on('GET', '/api/bootstrap', () => ({ defaults, fields: ingest.FIELDS, projects: store.list() }));
on('GET', '/api/projects', () => store.list());
on('PUT', '/api/projects/:id', async (req, p, b) => {
  if (!b || typeof b !== 'object' || !b.st) throw new Error('invalid project');
  b.id = pid(p);
  if (b.copyOf && pool.SAFE.test(b.copyOf)) { pool.copy(b.copyOf, b.id); delete b.copyOf; }
  await store.upsert(b);
  return { ok: true };
});
on('POST', '/api/projects/:id', async (req, p, b) => routes.find((r) => r[0] === 'PUT')[2](req, p, b)); // sendBeacon
on('DELETE', '/api/projects/:id', async (req, p) => { const id = pid(p); await store.remove(id); pool.remove(id); return { ok: true }; });

// ingestion: upload -> preview with suggested mapping -> commit with confirmed mapping
on('POST', '/api/projects/:id/ingest/preview', (req, p, b) => {
  pid(p);
  if (!Array.isArray(b.files) || !b.files.length) throw new Error('No files');
  const staged = ingest.preview(b.files.map((f) => ({ name: String(f.name).slice(0, 200), b64: String(f.b64 || '') })));
  return { uploadId: svc.stage(staged), ...ingest.describe(staged) };
});
on('POST', '/api/projects/:id/sample', (req, p, b) => {
  pid(p);
  const staged = ingest.preview(sample.sampleFiles(b.kind === 'rev' ? 'rev' : 'base'));
  return { uploadId: svc.stage(staged), ...ingest.describe(staged) };
});
on('POST', '/api/projects/:id/ingest/commit', (req, p, b) => {
  const id = pid(p);
  svc.commit(id, { ...b, who: who(req, b) });
  return svc.summary(id);
});
on('DELETE', '/api/projects/:id/revs/last', (req, p, b, url) => {
  const id = pid(p);
  svc.dropLastRev(id, { who: who(req) });
  return svc.summary(id);
});

// TQ pool
on('GET', '/api/projects/:id/pool', (req, p) => svc.summary(pid(p)));
on('POST', '/api/projects/:id/scan', (req, p, b) => { const id = pid(p); svc.scan(id, b); return svc.summary(id); });
on('POST', '/api/projects/:id/tqs/decide', (req, p, b) => { const id = pid(p); svc.decide(id, { ...b, who: who(req, b) }); return svc.summary(id); });
on('POST', '/api/projects/:id/tqs/hint', async (req, p, b) => svc.hint(pid(p), b));
on('POST', '/api/projects/:id/manual/check', async (req, p, b) => svc.manualCheck(pid(p), b));
on('POST', '/api/projects/:id/manual/place', async (req, p, b) => svc.manualPlace(pid(p), { ...b, who: who(req, b) }));
on('POST', '/api/projects/:id/manual/remove', async (req, p, b) => svc.manualRemove(pid(p), { ...b, who: who(req, b) }));
on('POST', '/api/projects/:id/tqs/reopen', (req, p, b) => { const id = pid(p); svc.reopen(id, { ...b, who: who(req, b) }); return svc.summary(id); });

// allocation (held while blocking TQs are open) + independent checker
on('POST', '/api/projects/:id/allocate', (req, p, b) => svc.allocateProject(pid(p), { ...b, who: who(req, b) }));
on('GET', '/api/projects/:id/allocation', (req, p) => ({ result: svc.lastAllocation(pid(p)) }));
on('GET', '/api/projects/:id/export.csv', (req, p, b, url) => {
  const x = svc.exportCsv(pid(p), url.searchParams.get('pat'));
  return { __raw: x.csv, type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="${x.name}"` } };
});

// LLM rule drafter: name + description -> a draft rule (the user accepts or rejects it in the UI)
on('POST', '/api/rules/draft', async (req, p, b) => {
  const name = String(b.name || '').trim().slice(0, 120), description = String(b.description || '').trim().slice(0, 1000);
  if (!name && !description) throw new Error('Give the rule a name or describe what it must do');
  const ctx = { h: b.h || { cc: 4, bc: 8, pc: 12 }, types: Object.keys(b.hw || {}).slice(0, 40), groups: [], prefixes: [] };
  if (b.project && pool.SAFE.test(b.project)) {
    const pl = pool.load(b.project), r = pl.revs[pl.revs.length - 1];
    if (r) {
      ctx.groups = [...new Set(r.signals.map((s) => s.grp).filter(Boolean))].sort().slice(0, 60);
      const pf = {};
      r.signals.forEach((s) => { const m = String(s.tag).match(/^[A-Z0-9]+[-_]/); if (m) pf[m[0]] = (pf[m[0]] || 0) + 1; });
      ctx.prefixes = Object.entries(pf).sort((x, y) => y[1] - x[1]).slice(0, 25).map((x) => x[0]);
    }
  }
  const out = await llm.draft({ name, description, ctx });
  if (!out.supported) return { supported: false, reason: out.reason };
  const rule = { k: 'r' + crypto.randomBytes(4).toString('hex'), n: name || out.name, d: description || out.name, h: out.hard ? 1 : 0, on: 1, draft: 1 };
  if (out.kind === 'code') Object.assign(rule, { code: out.code, summary: out.summary });
  else rule.spec = out.spec;
  // preview: what the rule would do to the current allocation of this project
  let preview = null;
  if (b.project && pool.SAFE.test(b.project)) {
    const pl = pool.load(b.project), r = pl.revs[pl.revs.length - 1], res = r && r.alloc && r.alloc.result;
    if (res && out.kind === 'code') {
      const [x] = await coderules.run([{ id: 'p', code: out.code }], res.placements, res.H);
      preview = x.error ? `The code failed on the current allocation: ${x.error}` : `On the current allocation it flags ${new Set(x.violations.flatMap((v) => v.tags)).size} signals in ${x.violations.length} violations.`;
    }
  }
  return { supported: true, rule, explain: out.explain, preview };
});

// generalisation / fuzz testing
on('POST', '/api/fuzz', (req, p, b) => fuzz.run(Math.max(1, Math.min(500, +b.n || 100)), +b.start || 1));

async function api(req, res, url) {
  for (const [m, rx, h] of routes) {
    if (m !== req.method) continue;
    const mt = url.pathname.match(rx);
    if (!mt) continue;
    try {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
      const out = await h(req, mt.groups || {}, body, url);
      if (out && out.__raw !== undefined) return send(res, 200, out.__raw, out.type, out.headers);
      return send(res, 200, out);
    } catch (e) {
      return send(res, e.code >= 400 && e.code < 600 ? e.code : 400, { error: e.message });
    }
  }
  return send(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  serveStatic(req, res, url);
});

if (require.main === module) server.listen(PORT, () => console.log(`Signal Sudoku running on http://localhost:${PORT}`));
module.exports = server;
