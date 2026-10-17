'use strict';
// Writes generalisation-test workbooks to samples/: a clean file, a dirty file, and a Rev B of each.
const fs = require('fs');
const path = require('path');
const s = require('../src/sample');

const out = path.join(__dirname, '..', 'samples');
fs.mkdirSync(out, { recursive: true });
const clean = s.clean(21), dirty = s.dirty(s.clean(31), 32);
const files = {
  'clean_RevA.xlsx': s.workbook(clean, { title: 'Clean IO list Rev A' }),
  'clean_RevB.xlsx': s.workbook(s.revise(clean, 22), { title: 'Clean IO list Rev B' }),
  'dirty_RevA.xlsx': s.workbook(dirty, { split: true, title: 'Dirty IO list Rev A' }),
  'dirty_RevB.xlsx': s.workbook(s.revise(dirty, 33), { split: true, title: 'Dirty IO list Rev B' }),
};
for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(out, n), b);
console.log('wrote', Object.keys(files).map((n) => 'samples/' + n).join(', '));
