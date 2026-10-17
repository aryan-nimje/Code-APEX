'use strict';
// Fuzz test: generate projects (random size, hierarchy, rules, clean or dirty data), let a
// simulated engineer decide every TQ, allocate, and run the independent checker.
// Anything the checker reports as an unacknowledged violation is a real engine bug.
const ingest = require('./ingest');
const sample = require('./sample');
const pool = require('./pool');
const { runDetectors } = require('./detectors');
const engine = require('./engine');
const { check } = require('./checker');
const RU = require('./rules');

const HW = { AI: 1, AO: 1, DI: 1, DO: 1, DOI: 1 };
const NAMES = { ab: 'A and B never share a CIOC', group: 'Each group stays in its own CIOCs', spare: '10% spare per baseplate', cable: 'Keep cable pairs together', cap: 'Each group fits in one cabinet' };

const sel = (field, values, op) => ({ field, op: op || 'in', values });
const CUSTOM = [
  { n: 'Never mix AI and DI in one CIOC', spec: { type: 'separate', a: sel('type', ['AI']), b: sel('type', ['DI']), scope: 'cioc' } },
  { n: 'DO and DOI never share a baseplate', spec: { type: 'separate', a: sel('type', ['DO']), b: sel('type', ['DOI']), scope: 'baseplate' } },
  { n: 'Isolated DO on their own baseplates', spec: { type: 'exclusive', a: sel('type', ['DOI']), scope: 'baseplate' } },
  { n: 'AO in their own CIOCs', spec: { type: 'exclusive', a: sel('type', ['AO']), scope: 'cioc' } },
  { n: 'Max 5 DO per baseplate', spec: { type: 'limit', a: sel('type', ['DO']), max: 5, scope: 'baseplate' } },
  { n: 'Max 40 AI per CIOC', spec: { type: 'limit', a: sel('type', ['AI']), max: 40, scope: 'cioc' } },
  { n: 'Each group in one cabinet', spec: { type: 'together', by: 'grp', scope: 'cabinet' } },
  { n: 'All AO in one cabinet', spec: { type: 'together', a: sel('type', ['AO']), scope: 'cabinet' } },
  { n: 'Group G4 in one CIOC', spec: { type: 'together', a: sel('grp', ['G4']), scope: 'cioc' } },
  { n: 'Reserve 20% spare', spec: { type: 'spare', percent: 20 } },
  { n: 'FT tags away from XY tags', spec: { type: 'separate', a: sel('tag', ['FT-'], 'prefix'), b: sel('tag', ['XY-'], 'prefix'), scope: 'cioc' } },
];

function toSignals(rows) {
  return rows.map((x, i) => ({
    tag: String(x.TAG_NO || '').trim().toUpperCase(), type: ingest.canonType(x.SIG_TYPE), rawType: String(x.SIG_TYPE || ''),
    cable: String(x.CABLE_ID || '').toUpperCase(), pair: ingest.canonPair(x.PAIR), grp: String(x.PROC_GRP || '').toUpperCase(),
    seg: ingest.canonSeg(x.SEG_AB), rawSeg: String(x.SEG_AB || ''), size: +(String(x.CABLE_SIZE || '').match(/\d+/) || [0])[0] || null,
    src: { file: 'fuzz', sheet: 'S', row: i + 2 },
  }));
}

let stableKept = 0, stableTotal = 0;
function one(seed) {
  const r = sample.rng(seed);
  const rows0 = sample.clean(seed, 0.2 + r() * 1.3);
  const rows = r() < 0.5 ? sample.dirty(rows0, seed + 1) : rows0;
  const signals = toSignals(rows);
  const H = { cc: 2 + Math.floor(r() * 5), bc: 4 + Math.floor(r() * 9), pc: [8, 12, 16][Math.floor(r() * 3)] };
  const on = Object.fromEntries(engine.ENGINE_RULES.map((k) => [k, r() < 0.75]));
  const meta = Object.fromEntries(engine.ENGINE_RULES.map((k, i) => [k, { k, n: NAMES[k], h: true, on: on[k], prio: i, engine: true }]));
  // random custom rules, the kind the LLM drafter produces
  const cust = CUSTOM.filter(() => r() < 0.35).map((c, i) => ({ k: 'c' + i, n: c.n, on: 1, h: 1, spec: c.spec }));
  cust.forEach((c, i) => (meta[c.k] = { k: c.k, n: c.n, h: true, on: true, prio: 10 + i, engine: true }));
  const compiled = RU.compile(cust);
  const p = { revs: [], tqs: {}, audit: [], seq: 0 };
  pool.reconcile(p, runDetectors({ signals, rules: on, hw: HW, rev: 'A', prev: null, decisions: {} }), { source: 'scan', rev: 'A', signals, ruleMeta: meta });
  let res, dec, effs;
  for (let i = 0; i < 6; i++) {
    // simulated engineer: picks the first option of every blocking TQ
    pool.blocking(p).forEach((t) => pool.decide(p, t.fp, t.options[0].id, 'fuzz', 'A'));
    effs = pool.effects(p);
    dec = engine.applyDecisions(signals, effs);
    res = engine.allocate(dec.signals, on, H, dec.relax, dec.pins, compiled);
    pool.reconcile(p, res.findings, { source: 'allocator', rev: 'A', signals, ruleMeta: meta, applied: new Set(effs.map((e) => e.fp)) });
    if (!pool.blocking(p).length && JSON.stringify(pool.effects(p).map((e) => e.fp)) === JSON.stringify(effs.map((e) => e.fp))) break;
  }
  const exceptionsBy = {};
  effs.forEach((e) => { const x = e.effect; if (x.kind === 'relax') exceptionsBy[`${x.rule}:${x.cable !== undefined ? x.cable : x.grp !== undefined ? x.grp : x.key}`] = e.id; });
  const ckArgs = {
    placements: res.placements, H: res.H, spare: res.spare, rules: on, rulesMeta: meta, relax: dec.relax, pins: dec.pins, pinAck: new Set(),
    signals: dec.signals, rawTags: new Set(signals.filter((s) => s.tag).map((s) => s.tag)), unplaced: dec.unplaced, exceptionsBy, hw: HW,
    customs: cust.map((c) => ({ id: c.k, name: c.n, spec: c.spec })),
  };
  const chk = check(ckArgs);
  // stability: drop ~5% of signals (as if sent to manual placement) and re-allocate keeping previous slots
  const prev = Object.fromEntries(res.placements.map((x) => [x.tag, x]));
  const keep = dec.signals.filter(() => r() > 0.05), gone = dec.signals.filter((x) => !keep.includes(x));
  const res2 = engine.allocate(keep, on, H, dec.relax, dec.pins, compiled, {}, prev);
  if (!res2.findings.some((f) => f.sev === 'block')) {
    const gapAllow = {};
    gone.forEach((g) => { if (g.cable) gapAllow[g.cable] = (gapAllow[g.cable] || 0) + 1; });
    const chk2 = check({ ...ckArgs, placements: res2.placements, signals: keep, unplaced: dec.unplaced.concat(gone.map((g) => ({ tag: g.tag, tq: 'fuzz', reason: 'dropped' }))), gapAllow });
    chk.violations += chk2.violations;
    chk2.results.filter((x) => x.violations.length).forEach((x) => chk.results.push({ ...x, key: 'stable/' + x.key }));
    stableKept += res2.placements.filter((x) => prev[x.tag] && prev[x.tag].cab === x.cab && prev[x.tag].cioc === x.cioc && prev[x.tag].bp === x.bp && prev[x.tag].ch === x.ch).length;
    stableTotal += res2.placements.length;
  }
  return { seed, rules: cust.map((c) => c.n), signals: signals.length, tqs: Object.keys(p.tqs).length, violations: chk.violations, held: pool.blocking(p).length, fails: chk.results.filter((x) => x.violations.length).map((x) => x.key + ': ' + x.violations[0]) };
}

function run(n = 100, start = 1) {
  const out = { runs: 0, signals: 0, tqs: 0, violations: 0, held: 0, failures: [] };
  for (let i = 0; i < n; i++) {
    const x = one(start + i * 7919);
    out.runs++; out.signals += x.signals; out.tqs += x.tqs; out.violations += x.violations; out.held += x.held ? 1 : 0;
    if (x.violations && out.failures.length < 10) out.failures.push(x);
  }
  out.stable = stableTotal ? Math.round((stableKept / stableTotal) * 100) : null;
  return out;
}

module.exports = { run, one, toSignals };
if (require.main === module) {
  const n = +process.argv[2] || 200;
  const t = Date.now();
  const r = run(n);
  console.log(`${r.runs} projects, ${r.signals} signals, ${r.tqs} TQs, ${r.violations} violations, ${r.held} held, ${r.stable}% kept their slot on re-allocation, ${Date.now() - t} ms`);
  r.failures.forEach((f) => console.log('seed', f.seed, f.rules.join(', '), '->', f.fails.join(' | ')));
  process.exit(r.violations ? 1 : 0);
}
