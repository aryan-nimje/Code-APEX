'use strict';
// User-added rules: generic TQ options, manual placement, code rules, the checker on all of it.
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const assert = require('assert');
const svc = require('../src/service');
const ingest = require('../src/ingest');
const sample = require('../src/sample');
const { defaults } = require('../src/config');

const sel = (field, values) => ({ field, op: 'in', values });
// impossible with cable-together: DO cables have up to 22 pairs on consecutive CHARMs
const limitDO = { k: 'u1', n: 'Max 5 DO per baseplate', d: 'test', h: 1, on: 1, spec: { type: 'limit', a: sel('type', ['DO']), max: 5, scope: 'baseplate' } };
// a generated-code rule: AI may not sit on the last CHARM of a baseplate
const codeAI = { k: 'u2', n: 'No AI on CHARM 11', d: 'test', h: 1, on: 1, summary: 'Flags AI on CHARM 11', code: "function check(placements, H) { return placements.filter(p => p.type === 'AI' && p.ch === 10).map(p => ({ tags: [p.tag], message: 'AI on CHARM 11' })); }" };
const rules = defaults.rules.concat(limitDO, codeAI);
const ctx = { rules, hw: defaults.hw, h: defaults.h, who: 'test' };
const S = () => svc.summary('u');
const decideAll = (opt) => S().tqs.filter((t) => t.sev === 'block' && (t.status === 'open' || t.status === 'review'))
  .forEach((t) => svc.decide('u', { fp: t.fp, opt: t.custom ? opt : t.options[0].id, ...ctx }));

(async () => {
  svc.commit('u', { uploadId: svc.stage(ingest.preview(sample.sampleFiles('base'))), ...ctx });
  decideAll('manual');
  let a = await svc.allocateProject('u', ctx);
  assert.ok(a.blocked, 'user-rule TQs hold the allocation');
  const userTqs = S().tqs.filter((t) => t.custom && t.status === 'open');
  assert.ok(userTqs.length, 'user-rule TQs raised');
  assert.deepStrictEqual(userTqs[0].options.map((o) => o.id), ['manual', 'accept', 'excl', 'soft', 'off'], 'generic options, manual first');
  assert.ok(userTqs.some((t) => t.type === 'code-rule') || userTqs.some((t) => t.custom === 'u1'), 'raised by schema and/or code rules');
  for (let i = 0; i < 4 && a.blocked; i++) { decideAll('manual'); a = await svc.allocateProject('u', ctx); }
  assert.ok(!a.blocked, 'allocates once decided');
  assert.ok(a.manualQueue.length > 0, 'signals wait in the manual queue');
  assert.strictEqual(a.check.violations, 0, 'no unacknowledged violations');
  assert.ok(a.unplaced.some((u) => u.pending), 'queue shows in unplaced as pending');

  // place one queued signal on a free CHARM that breaks nothing, one that breaks a rule
  const q = a.manualQueue[0];
  const used = new Set(a.placements.map((p) => `${p.cab}/${p.cioc}/${p.bp}/${p.ch}`));
  const freeSlot = () => { for (let c = 0; c < 9; c++) for (let i = 0; i < a.H.cc; i++) for (let b = 0; b < a.H.bc; b++) for (let ch = 0; ch < a.H.pc - a.spare; ch++) if (!used.has(`${c}/${i}/${b}/${ch}`)) return { cab: c, cioc: i, bp: b, ch }; };
  const slot = freeSlot();
  const chk = await svc.manualCheck('u', { tag: q.tag, pos: slot, ...ctx });
  assert.ok(chk.ok && Array.isArray(chk.breaks), 'manual check answers');
  const taken = a.placements[0];
  const bad = await svc.manualCheck('u', { tag: q.tag, pos: taken, ...ctx });
  assert.ok(!bad.ok, 'occupied CHARM refused');
  a = await svc.manualPlace('u', { tag: q.tag, pos: slot, ...ctx });
  const placed = a.placements.find((p) => p.tag === q.tag);
  assert.ok(placed && placed.manual && placed.cab === slot.cab && placed.cioc === slot.cioc && placed.bp === slot.bp && placed.ch === slot.ch, 'signal sits exactly where the user put it');
  assert.ok(!a.manualQueue.some((x) => x.tag === q.tag) && a.manualPlaced.some((x) => x.tag === q.tag), 'moved from queue to placed');
  assert.strictEqual(a.check.violations, 0, 'checker re-verified after manual placement');
  assert.strictEqual(new Set(a.placements.map((p) => `${p.cab}/${p.cioc}/${p.bp}/${p.ch}`)).size, a.placements.length, 'no CHARM used twice');
  a = await svc.manualRemove('u', { tag: q.tag, ...ctx });
  assert.ok(a.manualQueue.some((x) => x.tag === q.tag), 'removed placement returns to the queue');

  // "turn the rule off" option carries an action the UI applies to the rule table
  const t = S().tqs.find((x) => x.custom);
  assert.ok(t.options.find((o) => o.id === 'off').act === 'off' && t.options.find((o) => o.id === 'soft').act === 'soft', 'off / soft actions exposed');
  console.log('user rule tests passed', JSON.stringify({ queue: a.manualQueue.length, tqs: S().tqs.filter((x) => x.custom).length }));
})().catch((e) => { console.error(e); process.exit(1); });
