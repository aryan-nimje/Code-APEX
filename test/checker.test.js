'use strict';
// Tamper with a valid allocation and confirm the independent checker catches each break.
const assert = require('assert');
const sample = require('../src/sample');
const { toSignals } = require('../src/fuzz');
const engine = require('../src/engine');
const { check } = require('../src/checker');

const sig = toSignals(sample.clean(11));
const on = { ab: true, group: true, spare: true, cable: true, cap: true };
const meta = Object.fromEntries(Object.keys(on).map((k, i) => [k, { k, n: k, h: true, on: true, prio: i, engine: true }]));
const H = { cc: 4, bc: 8, pc: 12 };
const d = engine.applyDecisions(sig, []);
const res = engine.allocate(d.signals, on, H, d.relax, d.pins);
const base = () => ({ placements: res.placements.map((p) => ({ ...p })), H: res.H, spare: res.spare, rules: on, rulesMeta: meta, relax: d.relax, pins: {}, pinAck: new Set(), signals: d.signals, rawTags: new Set(sig.map((s) => s.tag)), unplaced: [], exceptionsBy: {}, hw: { AI: 1, AO: 1, DI: 1, DO: 1, DOI: 1 } });
const fails = (c) => c.results.filter((r) => r.violations.length).map((r) => r.key);

assert.strictEqual(check(base()).violations, 0, 'clean allocation must pass');

let x = base(); // put a Seg B signal into a Seg A CIOC of the same group
const a = x.placements.find((p) => p.seg === 'A'), b = x.placements.find((p) => p.seg === 'B' && p.grp === a.grp);
Object.assign(b, { cab: a.cab, cioc: a.cioc, bp: 7, ch: 0 });
assert.ok(fails(check(x)).includes('ab'), 'A/B break detected');

x = base(); // two signals on one CHARM
Object.assign(x.placements[1], { cab: x.placements[0].cab, cioc: x.placements[0].cioc, bp: x.placements[0].bp, ch: x.placements[0].ch });
assert.ok(fails(check(x)).includes('capacity'), 'shared CHARM detected');

x = base(); // drop a signal silently
x.placements.pop();
assert.ok(fails(check(x)).includes('complete'), 'missing signal detected');

x = base(); // fill a spare CHARM
const full = x.placements.find((p) => p.ch === res.H.pc - res.spare - 1); // a full baseplate
const mover = x.placements.find((p) => p.cab !== full.cab || p.cioc !== full.cioc || p.bp !== full.bp);
Object.assign(mover, { cab: full.cab, cioc: full.cioc, bp: full.bp, ch: H.pc - 1 }); // into its spare CHARM
assert.ok(fails(check(x)).includes('spare'), 'spare break detected');

x = base(); // move one pair of a cable into another CIOC
const c = x.placements.find((p) => p.cable && p.pair === 2);
const other = x.placements.find((p) => p.cioc !== c.cioc || p.cab !== c.cab);
Object.assign(c, { cab: other.cab, cioc: other.cioc, bp: 7, ch: 9 });
assert.ok(fails(check(x)).includes('cable'), 'split cable detected');

x = base(); // relaxed cable: same break is an accepted exception, not a violation
x.relax = { ...d.relax, cable: new Set([c.cable]) };
const y = base(); const c2 = y.placements.find((p) => p.tag === c.tag); Object.assign(c2, { cab: other.cab, cioc: other.cioc, bp: 7, ch: 9 });
y.relax = x.relax;
const r = check(y);
assert.ok(!fails(r).includes('cable') && r.accepted > 0, 'relaxed cable counted as accepted exception');

console.log('checker tests passed');

// ---- custom rules: the engine honours them, the checker catches a tampered result ----
{
  const RU = require('../src/rules');
  const sel = (field, values) => ({ field, op: 'in', values });
  const cust = [
    { k: 'c1', n: 'Never mix AI and DI in one CIOC', on: 1, spec: { type: 'separate', a: sel('type', ['AI']), b: sel('type', ['DI']), scope: 'cioc' } },
    { k: 'c2', n: 'Max 30 DO per CIOC', on: 1, spec: { type: 'limit', a: sel('type', ['DO']), max: 30, scope: 'cioc' } },
    { k: 'c3', n: 'Each group in one cabinet', on: 1, spec: { type: 'together', by: 'grp', scope: 'cabinet' } },
  ];
  const meta2 = { ...meta, c1: { n: 'c1' }, c2: { n: 'c2' }, c3: { n: 'c3' } };
  const res2 = engine.allocate(d.signals, on, H, d.relax, d.pins, RU.compile(cust));
  const ck = (pl) => check({ ...base(), placements: pl, H: res2.H, spare: res2.spare, rulesMeta: meta2, customs: cust.map((c) => ({ id: c.k, name: c.n, spec: c.spec })) });
  const fl = (c) => c.results.filter((r) => r.violations.length).map((r) => r.key);
  const c0 = ck(res2.placements); if (c0.violations) console.log(res2.findings.map((f) => f.type + ':' + f.key), c0.results.filter((r) => r.violations.length).map((r) => [r.key, r.violations.slice(0, 2)]));
  assert.strictEqual(res2.findings.length, 0, 'feasible custom rules raise no TQs');
  assert.strictEqual(c0.violations, 0, 'custom rules honoured by the engine');
  let pl = res2.placements.map((p) => ({ ...p }));
  const ai = pl.find((p) => p.type === 'AI'), di = pl.find((p) => p.type === 'DI' && (p.cab !== ai.cab || p.cioc !== ai.cioc));
  Object.assign(di, { cab: ai.cab, cioc: ai.cioc, bp: 7, ch: 9 });
  assert.ok(fl(ck(pl)).includes('c1'), 'AI/DI mix detected');
  pl = res2.placements.map((p) => ({ ...p }));
  const dos = pl.filter((p) => p.type === 'DO').slice(0, 31);
  dos.forEach((p, i) => Object.assign(p, { cab: 99, cioc: 0, bp: Math.floor(i / 11), ch: i % 11 }));
  assert.ok(fl(ck(pl)).includes('c2'), 'DO limit break detected');
  pl = res2.placements.map((p) => ({ ...p }));
  const g = pl.find((p) => p.grp === 'G1'); g.cab = g.cab + 5;
  assert.ok(fl(ck(pl)).includes('c3'), 'group split across cabinets detected');
  console.log('custom rule checker tests passed');
}
