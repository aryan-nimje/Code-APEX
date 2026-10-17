'use strict';
// Generates realistic IO list workbooks so the whole pipeline (parse -> map -> detect -> allocate)
// runs on real files. Used by "Use sample project", the fuzz test and `npm run samples`.
const XLSX = require('xlsx');

// Seeded PRNG so a given seed always produces the same project.
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PRE = { AI: 'FT', AO: 'FY', DI: 'XS', DO: 'XV', DOI: 'XY' };

// Signal mix per group: [group, seg, type, count]
const MIX = [
  ['G1', 'A', 'AI', 130], ['G1', 'B', 'AI', 120], ['G2', '', 'DI', 170], ['G3', '', 'DO', 70],
  ['G3', '', 'DOI', 26], ['G4', '', 'AO', 48], ['', '', 'DI', 80],
];
const SIZES = [24, 12, 6, 2];

// Clean signal list: every signal on a cable, cables never mix group or segregation.
function clean(seed = 1, scale = 1) {
  const r = rng(seed);
  const rows = [];
  let n = 1000, c = 100;
  for (const [g, s, t, cnt0] of MIX) {
    let left = Math.max(1, Math.round(cnt0 * scale));
    while (left > 0) {
      const size = SIZES[Math.floor(r() * SIZES.length)];
      const use = Math.min(left, size - (size >= 12 ? 2 : 0)); // keep 2 spare pairs on big cables
      c += 1;
      for (let p = 1; p <= use; p++) {
        n += 1;
        rows.push({ TAG_NO: `${PRE[t]}-${n}`, SIG_TYPE: t, CABLE_ID: `CBL-${c}`, CABLE_SIZE: size + 'P', PAIR: p, PROC_GRP: g, SEG_AB: s });
      }
      left -= use;
    }
  }
  return rows;
}

// Dirty copy: the problems engineers actually hit, one or a few of each.
function dirty(rows, seed = 2) {
  const r = rng(seed);
  const d = rows.map((x) => ({ ...x }));
  const pick = () => d[Math.floor(r() * d.length)];
  d.push({ ...d[5] });                                        // duplicate tag, identical
  const a = d.find((x) => x.SIG_TYPE === 'AI' && x.PAIR === 3), b = d.find((x) => x.SIG_TYPE === 'DI' && x.PAIR === 5);
  if (a && b) { b.CABLE_ID = a.CABLE_ID; b.PAIR = 3; b.PROC_GRP = a.PROC_GRP; b.SEG_AB = a.SEG_AB; } // pair claimed twice
  [pick(), pick(), pick()].forEach((x) => (x.SIG_TYPE = ''));  // missing IO type
  const u = pick(); u.SIG_TYPE = 'PULSE';                      // IO type with no CHARM
  const ab = d.find((x) => x.SEG_AB === 'A' && x.PAIR === 1);
  if (ab) d.filter((x) => x.CABLE_ID === ab.CABLE_ID && x.PAIR > 4).forEach((x) => (x.SEG_AB = 'B')); // mixed A/B cable
  const big = d.find((x) => x.CABLE_SIZE === '12P' && x.PAIR === 1);
  if (big) for (let i = 0; i < 4; i++) d.push({ ...big, TAG_NO: `TT-${8000 + i}`, PAIR: 11 + i });  // more signals than pairs
  pick().PROC_GRP = '';                                       // missing group on a grouped row
  pick().TAG_NO = 'spare 7';                                  // malformed tag
  return d;
}

// Next revision: deletes, adds, moves, and fixes some data problems (their TQs close themselves).
function revise(rows, seed = 3) {
  const r = rng(seed);
  const d = rows.filter(() => r() > 0.03).map((x) => ({ ...x }));
  d.forEach((x) => { if (!x.SIG_TYPE) x.SIG_TYPE = x.TAG_NO.startsWith('FT') ? 'AI' : 'DI'; }); // missing types fixed
  d.filter((x) => x.PROC_GRP === 'G2').slice(0, 6).forEach((x) => (x.PROC_GRP = 'G4'));          // moved group
  const c = 900 + Math.floor(r() * 50);
  for (let p = 1; p <= 10; p++) d.push({ TAG_NO: `FT-${9000 + c + p}`, SIG_TYPE: 'AI', CABLE_ID: `CBL-${c}`, CABLE_SIZE: '12P', PAIR: p, PROC_GRP: 'G1', SEG_AB: 'A' });
  return d;
}

// Rows -> workbook buffer. split=true puts the list on two area sheets plus a notes sheet,
// and makes one tag disagree between the sheets (cross-sheet conflict).
function workbook(rows, { split = false, title = 'IO MDB' } = {}) {
  const wb = XLSX.utils.book_new();
  const sheet = (rs) => {
    const ws = XLSX.utils.aoa_to_sheet([[title], ['Generated sample'], []]);
    XLSX.utils.sheet_add_json(ws, rs, { origin: 'A4' });
    return ws;
  };
  if (!split) XLSX.utils.book_append_sheet(wb, sheet(rows), 'IO List');
  else {
    const h = Math.floor(rows.length / 2);
    const a = rows.slice(0, h), b = rows.slice(h).map((x) => ({ ...x }));
    if (a.length > 10) b.push({ ...a[10], PROC_GRP: a[10].PROC_GRP === 'G2' ? 'G3' : 'G2' });
    XLSX.utils.book_append_sheet(wb, sheet(a), 'Area 1');
    XLSX.utils.book_append_sheet(wb, sheet(b), 'Area 2');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes'], ['Rev history kept by the customer']]), 'Notes');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function sampleFiles(kind, seed = 7) {
  const base = dirty(clean(seed), seed + 1);
  if (kind === 'rev') return [{ name: 'IO_MDB_RevB.xlsx', b64: workbook(revise(base, seed + 2), { split: true, title: 'IO MDB Rev B' }).toString('base64') }];
  return [{ name: 'IO_MDB_RevA.xlsx', b64: workbook(base, { split: true, title: 'IO MDB Rev A' }).toString('base64') }];
}

module.exports = { clean, dirty, revise, workbook, sampleFiles, rng };
