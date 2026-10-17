'use strict';
// Reads uploaded IO list workbooks on the server and turns them into one record per signal.
//
// Flow: preview(files) -> sheets + detected header row + suggested column map
//       build(staged, mappings, include) -> signals[] with source {file, sheet, row}
//
// Sheets that share the same header set share one mapping ("signature"), so a workbook with
// ten identical area sheets needs one confirmation, while a sheet with different headers gets
// its own mapping.
const XLSX = require('xlsx');
const crypto = require('crypto');

// Fields the engine understands. `req` = must be mapped for a sheet to be used.
const FIELDS = [
  { f: 'tag', label: 'Tag', req: true },
  { f: 'type', label: 'IO type' },
  { f: 'cable', label: 'Cable' },
  { f: 'pair', label: 'Pair' },
  { f: 'grp', label: 'Group' },
  { f: 'seg', label: 'Segregation (A/B)' },
  { f: 'size', label: 'Cable size (pairs)' },
];

// Header patterns, strongest first. Scored, not first-match, so "CABLE_SIZE" goes to size, not cable.
const PAT = {
  tag: [[/^(tag|tag_?no|tag_?number|tagname|tag_?id|instrument_?tag|signal_?tag|loop_?tag)$/, 10], [/tag/, 6], [/^(signal|instrument|loop)(_?name|_?id)?$/, 4]],
  type: [[/^(io_?type|sig(nal)?_?type|channel_?type|charm_?type|type)$/, 10], [/(io|sig|signal).*type|type/, 6]],
  cable: [[/^(cable|cable_?(id|no|number|tag|ref)|multi_?cable|mc_?cable)$/, 10], [/cable|cbl/, 5]],
  pair: [[/^(pair|pair_?(no|number)|core|core_?(no|number)|pr)$/, 10], [/pair|core/, 5]],
  grp: [[/^(group|grp|proc(ess)?_?(grp|group)|plant_?(area|unit)|unit|area)$/, 10], [/group|grp|unit|area/, 5]],
  seg: [[/^(seg|seg_?ab|segregation|redundancy|train|ab|a_b|side)$/, 10], [/seg|train|redund/, 6]],
  size: [[/^(cable_?size|pairs?_?(count|qty|size)|no_?of_?pairs|cable_?pairs|size)$/, 10], [/size|pairs_?count|cores/, 5]],
};
const norm = (h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// IO type spellings seen in real MDBs -> canonical codes used by the hardware lookup.
const TYPE_ALIAS = [
  [/^(ai|analog_?in(put)?|analogue_?in(put)?|a_?i|4_?20_?ma_?in)$/, 'AI'],
  [/^(ao|analog_?out(put)?|analogue_?out(put)?|a_?o)$/, 'AO'],
  [/^(di|digital_?in(put)?|discrete_?in(put)?|d_?i|bi)$/, 'DI'],
  [/^(doi|do_?iso(lated)?|do_?i|isolated_?do|do_?fused|do_?iso_?fuse)$/, 'DOI'],
  [/^(do|digital_?out(put)?|discrete_?out(put)?|d_?o|bo)$/, 'DO'],
];
function canonType(v) {
  const s = norm(v);
  if (!s) return '';
  for (const [rx, t] of TYPE_ALIAS) if (rx.test(s)) return t;
  return String(v).trim().toUpperCase();
}
function canonSeg(v) {
  const s = String(v ?? '').trim().toUpperCase().replace(/^(SEG(REGATION)?|TRAIN|SIDE)[\s_-]*/, '');
  if (!s || s === '-' || s === 'N/A' || s === 'NA' || s === 'NONE') return '';
  if (s === 'A' || s === '1') return 'A';
  if (s === 'B' || s === '2') return 'B';
  return s; // anything else is kept raw and flagged by the health scan
}
function canonPair(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/\d+/);
  return m ? +m[0] : NaN;
}
function canonSize(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/\d+/);
  return m ? +m[0] : null;
}
const txt = (v) => String(v ?? '').trim();

// Pick the header row: the row in the first 20 with the most cells matching known patterns.
function findHeader(aoa) {
  let best = -1, score = -1;
  for (let i = 0; i < Math.min(25, aoa.length); i++) {
    const row = aoa[i] || [];
    const filled = row.filter((c) => txt(c)).length;
    if (filled < 2) continue;
    let s = 0;
    row.forEach((c) => {
      const h = norm(c);
      if (h && Object.values(PAT).some((ps) => ps.some(([rx]) => rx.test(h)))) s += 2;
    });
    s += filled * 0.1;
    if (s > score) { score = s; best = i; }
  }
  return best;
}

// Score every header for every field and assign greedily, best score first.
function suggest(headers, sampleRows) {
  const cand = [];
  headers.forEach((h, col) => {
    const n = norm(h);
    if (!n) return;
    for (const [f, ps] of Object.entries(PAT)) {
      let s = 0;
      for (const [rx, w] of ps) if (rx.test(n)) s = Math.max(s, w);
      if (s) cand.push({ f, col, s });
    }
  });
  // Content sniffing: a column whose values look like IO types is probably the type column.
  headers.forEach((h, col) => {
    const vals = sampleRows.map((r) => r[col]).filter((v) => txt(v));
    if (vals.length >= 3 && vals.filter((v) => /^(AI|AO|DI|DO|DOI)$/.test(canonType(v))).length / vals.length > 0.7)
      cand.push({ f: 'type', col, s: 8 });
  });
  cand.sort((a, b) => b.s - a.s);
  const map = {}, conf = {}, used = new Set();
  for (const c of cand) {
    if (map[c.f] !== undefined || used.has(c.col)) continue;
    map[c.f] = headers[c.col];
    conf[c.f] = c.s >= 8 ? 'high' : 'low';
    used.add(c.col);
  }
  return { map, conf };
}

const signature = (headers) =>
  crypto.createHash('sha1').update(headers.map(norm).filter(Boolean).sort().join('|')).digest('hex').slice(0, 10);

// Parse one uploaded file (base64) into sheets with headers and data rows (arrays).
function readFile(name, b64) {
  const buf = Buffer.from(b64, 'base64');
  const isCsv = /\.(csv|tsv|txt)$/i.test(name);
  const wb = isCsv
    ? XLSX.read(buf.toString('utf8'), { type: 'string', raw: true })
    : XLSX.read(buf, { type: 'buffer', cellDates: false });
  return wb.SheetNames.map((sn) => {
    const ws = wb.Sheets[sn];
    // keep blank rows so indexes map to real spreadsheet row numbers (TQs cite them)
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: true });
    const r0 = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
    const hi = findHeader(aoa);
    if (hi < 0) return { name: sn, headerRow: null, headers: [], rows: [], nums: [], skip: 'No header row found' };
    const headers = (aoa[hi] || []).map((h, i) => txt(h) || `Column ${i + 1}`);
    const rows = [], nums = [];
    for (let i = hi + 1; i < aoa.length; i++) if ((aoa[i] || []).some((c) => txt(c))) { rows.push(aoa[i]); nums.push(r0 + i + 1); }
    return { name: sn, headerRow: r0 + hi + 1, headers, rows, nums };
  });
}

// Preview for the mapping confirmation step.
function preview(files) {
  const staged = { files: [] };
  const sigs = {};
  for (const fl of files) {
    let sheets;
    try {
      sheets = readFile(fl.name, fl.b64);
    } catch (e) {
      staged.files.push({ name: fl.name, error: 'Could not read this file: ' + e.message, sheets: [] });
      continue;
    }
    sheets.forEach((sh) => {
      if (!sh.headers.length) return;
      sh.sig = signature(sh.headers);
      if (!sigs[sh.sig]) {
        const sg = suggest(sh.headers, sh.rows.slice(0, 50));
        sigs[sh.sig] = { sig: sh.sig, headers: sh.headers, map: sg.map, conf: sg.conf, sheets: [] };
      }
      sigs[sh.sig].sheets.push(fl.name + ' / ' + sh.name);
      // A sheet with no tag column is probably notes / legend: excluded by default.
      sh.include = !!sigs[sh.sig].map.tag && sh.rows.length > 0;
    });
    staged.files.push({ name: fl.name, sheets });
  }
  staged.sigs = sigs;
  return staged;
}

// What the client sees: no raw rows, only a small sample.
function describe(staged) {
  return {
    fields: FIELDS,
    files: staged.files.map((f) => ({
      name: f.name,
      error: f.error,
      sheets: f.sheets.map((s) => ({
        name: s.name, headerRow: s.headerRow, rows: s.rows.length, sig: s.sig, include: s.include, skip: s.skip,
      })),
    })),
    mappings: Object.values(staged.sigs).map((m) => ({
      sig: m.sig, headers: m.headers, map: m.map, conf: m.conf, sheets: m.sheets,
      sample: firstSheet(staged, m.sig).rows.slice(0, 3).map((r) => m.headers.map((_, i) => txt(r[i]))),
    })),
  };
}
function firstSheet(staged, sig) {
  for (const f of staged.files) for (const s of f.sheets) if (s.sig === sig) return s;
  return { rows: [] };
}

// Apply the confirmed mappings. include: {"file/sheet": bool}. Returns signals in source order.
function build(staged, mappings, include) {
  const out = [];
  const used = [];
  for (const f of staged.files) {
    for (const s of f.sheets) {
      if (!s.sig) continue;
      const key = f.name + '/' + s.name;
      const inc = include && key in include ? !!include[key] : s.include;
      if (!inc) continue;
      const m = (mappings && mappings[s.sig]) || staged.sigs[s.sig].map;
      if (!m || !m.tag) continue;
      const col = {};
      Object.entries(m).forEach(([fld, h]) => {
        const i = s.headers.indexOf(h);
        if (i >= 0) col[fld] = i;
      });
      used.push({ file: f.name, sheet: s.name, rows: s.rows.length, map: m });
      s.rows.forEach((r, ri) => {
        const g = (fld) => (col[fld] === undefined ? '' : r[col[fld]]);
        const tag = txt(g('tag')).toUpperCase();
        // A row with no tag and nothing else useful is a blank/total row; with data it is a TQ.
        const rawType = txt(g('type'));
        if (!tag && !rawType && !txt(g('cable'))) return;
        out.push({
          tag,
          type: canonType(rawType),
          rawType,
          cable: txt(g('cable')).toUpperCase(),
          pair: canonPair(g('pair')),
          grp: txt(g('grp')).toUpperCase(),
          seg: canonSeg(g('seg')),
          rawSeg: txt(g('seg')),
          size: canonSize(g('size')),
          src: { file: f.name, sheet: s.name, row: s.nums[ri] },
        });
      });
    }
  }
  return { signals: out, sources: used };
}

module.exports = { FIELDS, preview, describe, build, canonType, canonSeg, canonPair, suggest, findHeader };
