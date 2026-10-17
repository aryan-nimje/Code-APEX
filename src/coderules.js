'use strict';
// Generated-code rules: for rules the schema in src/rules.js cannot express.
// The LLM writes one pure function:
//   function check(placements, H) -> [{ tags: [...], message: '...' }]   // one entry per violation
// placements: [{ tag, type, grp, seg, cable, pair, cab, cioc, bp, ch }] (0-based positions), H: { cc, bc, pc }
// It runs after allocation; signals it flags become TQs (notify + manual placement), never auto-fixed.
const { spawn } = require('child_process');
const path = require('path');

const SANDBOX = path.join(__dirname, 'sandbox.js');
// Cheap static screen; the real protection is the sandbox process and the empty vm context.
const BANNED = /\b(require|import|process|globalThis|global|Function|eval|constructor|__proto__|prototype|fetch|XMLHttpRequest|WebAssembly|setTimeout|setInterval|Atomics|SharedArrayBuffer|Proxy|Reflect)\b/;

function screen(code) {
  const c = String(code || '');
  if (!c.trim()) throw new Error('No code');
  if (c.length > 6000) throw new Error('Code is longer than 6000 characters');
  if (!/function\s+check\s*\(\s*placements\s*,\s*H\s*\)/.test(c)) throw new Error('Code must define function check(placements, H)');
  const m = c.match(BANNED);
  if (m) throw new Error(`Code uses "${m[0]}", which is not allowed`);
  return c;
}

function run(rules, placements, H, timeoutMs = 15000) {
  const ok = [];
  const out = [];
  for (const r of rules) {
    try { ok.push({ id: r.id, code: screen(r.code) }); } catch (e) { out.push({ id: r.id, error: e.message }); }
  }
  if (!ok.length) return Promise.resolve(out);
  const slim = placements.map((p) => ({ tag: p.tag, type: p.type, grp: p.grp, seg: p.seg, cable: p.cable, pair: p.pair, cab: p.cab, cioc: p.cioc, bp: p.bp, ch: p.ch }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-permission', `--allow-fs-read=${SANDBOX}`, '--max-old-space-size=256', '--no-warnings', SANDBOX], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', err = '';
    const fail = (msg) => resolve(out.concat(ok.map((r) => ({ id: r.id, error: msg }))));
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail('Rule code took too long'); }, timeoutMs);
    child.stdout.on('data', (c) => { buf += c; if (buf.length > 20e6) child.kill('SIGKILL'); });
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => { clearTimeout(timer); fail('Could not start the sandbox: ' + e.message); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(out.concat(JSON.parse(buf))); } catch (e) { fail('Rule code crashed' + (err ? ': ' + err.split('\n')[0] : '')); }
    });
    child.stdin.end(JSON.stringify({ rules: ok, placements: slim, H }));
  });
}

// Small synthetic layout used to make sure drafted code runs and returns the right shape.
function sample() {
  const t = ['AI', 'DI', 'DO', 'AO', 'DOI'], out = [];
  for (let i = 0; i < 60; i++) out.push({ tag: `${['FT', 'XS', 'XV', 'FY', 'XY'][i % 5]}-${1000 + i}`, type: t[i % 5], grp: 'G' + ((i % 3) + 1), seg: i % 7 === 0 ? 'A' : i % 7 === 1 ? 'B' : '', cable: 'CBL-' + Math.floor(i / 6), pair: (i % 6) + 1, cab: Math.floor(i / 40), cioc: Math.floor(i / 12) % 4, bp: Math.floor(i / 6) % 2, ch: i % 6 });
  return out;
}

module.exports = { run, screen, sample };
