'use strict';
// TQ lifecycle through the service layer: raise, decide, gate, allocator TQs, revisions.
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const assert = require('assert');
const svc = require('../src/service');
const ingest = require('../src/ingest');
const sample = require('../src/sample');
const { defaults } = require('../src/config');

const ctx = { rules: defaults.rules, hw: defaults.hw, h: { cc: 2, bc: 8, pc: 12 }, who: 'test' };
const load = (kind) => svc.commit('t1', { uploadId: svc.stage(ingest.preview(sample.sampleFiles(kind))), ...ctx });
const tq = (fp) => svc.summary('t1').tqs.find((t) => t.fp === fp);
const decideAll = () => svc.summary('t1').tqs.filter((t) => t.sev === 'block' && (t.status === 'open' || t.status === 'review'))
  .forEach((t) => svc.decide('t1', { fp: t.fp, opt: t.options[0].id, ...ctx }));

(async () => {
load('base');
let a = await svc.allocateProject('t1', ctx);
assert.ok(a.blocked, 'held while data TQs are open');
decideAll();
a = await svc.allocateProject('t1', ctx);
assert.ok(a.blocked && a.blocking.some((f) => f.startsWith('group-exceeds-cabinet')), 'allocator raises group-exceeds-cabinet with 2 CIOCs per cabinet');
const fp = a.blocking.find((f) => f.startsWith('group-exceeds-cabinet'));
svc.summary('t1').tqs.filter((t) => a.blocking.includes(t.fp)).forEach((t) => svc.decide('t1', { fp: t.fp, opt: 'span', ...ctx }));
a = await svc.allocateProject('t1', ctx);
assert.ok(!a.blocked, 'allocates once decided');
assert.strictEqual(a.check.violations, 0, 'checker: 0 violations');
assert.ok(a.check.results.find((r) => r.key === 'cap').accepted.length, 'group span shows as accepted exception');
assert.strictEqual(tq(fp).status, 'decided', 'allocator TQ stays decided (no oscillation)');
a = await svc.allocateProject('t1', ctx);
assert.strictEqual(tq(fp).status, 'decided', 'still decided on re-allocate');

const before = tq('missing-type:all').status;
load('rev');
assert.strictEqual(tq('missing-type:all').status, 'resolved', `fixed data resolves its TQ (was ${before})`);
assert.ok(svc.summary('t1').tqs.some((t) => t.type === 'moved-since-allocation'), 'revision raises moved-since-allocation');
decideAll();
a = await svc.allocateProject('t1', ctx);
if (a.blocked) { svc.summary('t1').tqs.filter((t) => a.blocking.includes(t.fp)).forEach((t) => svc.decide('t1', { fp: t.fp, opt: t.options[0].id, ...ctx })); a = await svc.allocateProject('t1', ctx); }
assert.ok(!a.blocked && a.check.violations === 0, 'Rev B allocates with 0 violations');
assert.ok(['decided', 'review'].includes(tq(fp).status), 'span decision carried into Rev B: ' + tq(fp).status);
const imp = svc.summary('t1').revs[1].impact;
assert.ok(imp && imp.cabinetsHit >= 0, 'placement impact computed');
console.log('lifecycle tests passed', JSON.stringify(imp));
})().catch((e) => { console.error(e); process.exit(1); });
