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
