'use strict';
// Child process that runs generated rule code. Started by src/coderules.js with Node's permission
// model (no file access beyond this script, no child processes, no workers) and a memory cap.
// Inside, each rule runs in a fresh vm context that has no require, process, fetch or timers;
// data goes in and comes out as JSON strings so no host object reaches the rule code.
// This is defence in depth for a college project, not a hardened multi-tenant sandbox.
const vm = require('vm');

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const { rules, placements, H } = JSON.parse(input);
  const data = JSON.stringify({ placements, H });
  const out = rules.map((r) => {
    try {
      const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
      const src = `(function () { 'use strict'; ${r.code}\n;const d = JSON.parse(${JSON.stringify(data)});\nconst v = check(d.placements, d.H);\nreturn JSON.stringify(v); })()`;
      const res = JSON.parse(vm.runInContext(src, ctx, { timeout: 3000 }));
      if (!Array.isArray(res)) throw new Error('check() must return an array');
      const violations = res.slice(0, 500).map((v) => ({
        tags: Array.isArray(v && v.tags) ? v.tags.map(String).slice(0, 200) : [],
        message: String((v && v.message) || 'Rule broken').slice(0, 300),
      })).filter((v) => v.tags.length);
      return { id: r.id, violations };
    } catch (e) {
      return { id: r.id, error: String((e && e.message) || e).slice(0, 300) };
    }
  });
  process.stdout.write(JSON.stringify(out));
});
