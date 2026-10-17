'use strict';
// Allocation engine. Works on the real signals of a revision.
//
//   applyDecisions(rawSignals, effects) -> { signals, unplaced, relax, pins }
//   allocate(signals, rules, H, relax, pins, customs) -> { placements, ciocs, findings, stats }
//
// Built-in rules (keys match the rule table):
//   ab     A and B of the same group never share a CIOC
//   group  a CIOC holds one process group only
//   spare  10% of the CHARMs on each baseplate stay free (at least 1)
//   cable  all pairs of a cable land in one CIOC, on consecutive CHARMs, in pair order
//   cap    with grouping on, each group fits in one cabinet
// Custom rules (src/rules.js): separate, exclusive, limit, together, spare.
//
// When a hard rule cannot be met the engine does not quietly break it: it returns a finding,
// which becomes a TQ, and the result is held until that TQ is decided. A decided "relax" lets
// that one cable / group / key break the rule, and the checker reports it as an accepted exception.
const R = require('./rules');

const NOGRP = '';
const relaxSet = (relax, k) => relax[k] || (relax[k] = new Set());

// ---------- decisions -> effective signals + constraints ----------
// manualPos: { tag: {cab, cioc, bp, ch} } slots the user picked; only used for tags under a "manual" decision
function applyDecisions(raw, effects, manualPos) {
  const relax = { ab: new Set(), group: new Set(), cable: new Set(), cap: new Set() };
  const pins = {};
  const excluded = new Map();
  const manualBy = new Map(); // tag -> decision that sent it to manual placement
  const overrides = [];
  const merges = {};
  for (const e of effects) {
    const x = e.effect;
    if (x.kind === 'exclude') x.tags.forEach((t) => excluded.set(t, e));
    else if (x.kind === 'override') overrides.push(x);
    else if (x.kind === 'merge') merges[x.tag] = x.keep;
    else if (x.kind === 'relax' && x.tags) x.tags.forEach((t) => relaxSet(relax, x.rule).add(t));
    else if (x.kind === 'relax') relaxSet(relax, x.rule).add(x.cable !== undefined ? x.cable : x.grp !== undefined ? x.grp : x.key);
    else if (x.kind === 'manual') x.tags.forEach((t) => manualBy.set(t, e));
    else if (x.kind === 'pin') x.pins.forEach((p) => (pins[p.tag] = { pos: p.pos, by: e }));
  }
  const rows = raw.filter((s) => s.tag).map((s) => ({ ...s }));
  for (const o of overrides) {
    const set = new Set(o.tags);
    rows.forEach((s) => { if (set.has(s.tag)) s[o.field] = o.value; });
  }
  const byTag = new Map();
  for (const s of rows) {
    if (!byTag.has(s.tag)) byTag.set(s.tag, s);
    else if (merges[s.tag] === 'last') byTag.set(s.tag, s);
  }
  const signals = [], unplaced = [], manual = {}, queue = [];
  for (const s of byTag.values()) {
    const e = excluded.get(s.tag), m = manualBy.get(s.tag);
    if (e) unplaced.push({ tag: s.tag, tq: e.id, reason: e.label });
    else if (m && manualPos && manualPos[s.tag]) { manual[s.tag] = manualPos[s.tag]; signals.push(s); }
    else if (m) { unplaced.push({ tag: s.tag, tq: m.id, reason: 'Awaiting manual placement', pending: true }); queue.push({ ...s, tq: m.id, tqTitle: m.title }); }
    else signals.push(s);
  }
  return { signals, unplaced, relax, pins, manual, queue };
}

// ---------- helpers ----------
function hier(h) {
  const g = (v, d) => Math.max(1, Math.min(1000, Math.round(+v || d)));
  return { cc: g(h && h.cc, 4), bc: g(h && h.bc, 8), pc: g(h && h.pc, 12) };
}
const builtinSpare = (H, rules) => (rules.spare ? Math.min(H.pc - 1, Math.max(1, Math.round(H.pc * 0.1))) : 0);
function spareOf(H, rules, customs) {
  let s = builtinSpare(H, rules);
  for (const c of customs || []) if (c.type === 'spare') s = Math.max(s, R.spareCount(H.pc, c.percent));
  return s;
}
const pairOrder = (a, b) => {
  const pa = Number.isFinite(a.pair) ? a.pair : 1e9, pb = Number.isFinite(b.pair) ? b.pair : 1e9;
  return pa - pb || a.tag.localeCompare(b.tag);
};
const segKey = (s) => (s === 'A' || s === 'B' ? s : '');
// what a per-unit relaxation of a custom rule is keyed by; the checker looks up (cable || tag) of a signal
const unitKey = (u) => u.cable || u.sigs[0].cable || u.sigs[0].tag;
const keyOf = (r, s) => (r.by ? String(s[r.by] ?? '').toUpperCase() : '*');

// ---------- units: cable groups, then merged for "together in one CIOC" ----------
function mkUnit(sigs, cbl, relax) {
  const grps = new Set(sigs.map((s) => s.grp || NOGRP));
  const segs = {};
  sigs.forEach((s) => {
    const k = segKey(s.seg);
    if (k) (segs[s.grp || NOGRP] = segs[s.grp || NOGRP] || new Set()).add(k);
  });
  const cables = new Set(sigs.map((s) => s.cable).filter(Boolean));
  return {
    sigs, cable: cbl, grps, segs, size: sigs.length,
    relaxAB: [...cables].some((c) => relax.ab.has(c)), relaxGroup: [...cables].some((c) => relax.group.has(c)),
    g: sigs[0].grp || NOGRP, s: segKey(sigs[0].seg), ignore: new Set(),
  };
}

function buildUnits(signals, rules, relax, ciocCap, customs) {
  let units = [];
  const findings = [], loose = [];
  if (!rules.cable) signals.forEach((s) => loose.push(s));
  else {
    const cab = new Map();
    signals.forEach((s) => {
      if (!s.cable) return loose.push(s);
      if (!cab.has(s.cable)) cab.set(s.cable, []);
      cab.get(s.cable).push(s);
    });
    for (const [cbl, rs] of cab) {
      rs.sort(pairOrder);
      if (rs.length > ciocCap) findings.push(tooBig(cbl, rs, ciocCap));
      if (relax.cable.has(cbl)) {
        const parts = new Map();
        rs.forEach((s) => {
          const k = s.grp + '|' + segKey(s.seg);
          if (!parts.has(k)) parts.set(k, []);
          parts.get(k).push(s);
        });
        for (const p of parts.values()) chunk(p, cbl);
      } else chunk(rs, cbl);
    }
  }
  loose.forEach((s) => units.push(mkUnit([s], s.cable || null, relax)));

  // "together in one CIOC": merge units that share a key (union-find over units)
  const tog = customs.filter((c) => c.type === 'together' && c.scope === 'cioc');
  if (tog.length) {
    const par = units.map((_, i) => i);
    const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    const first = new Map(), keysOf = new Map();
    units.forEach((u, i) => u.sigs.forEach((s) => tog.forEach((r) => {
      if (!r.A(s)) return;
      const v = keyOf(r, s);
      if ((relax[r.id] || new Set()).has(v)) return;
      const k = r.id + '\u0001' + v;
      if (!first.has(k)) first.set(k, i); else par[find(i)] = find(first.get(k));
    })));
    const comp = new Map();
    units.forEach((u, i) => { const r = find(i); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(u); });
    for (const [k, i] of first) { const r = find(i); if (!keysOf.has(r)) keysOf.set(r, new Set()); keysOf.get(r).add(k); }
    const out = [];
    for (const [root, us] of comp) {
      if (us.length === 1) { out.push(us[0]); continue; }
      const size = us.reduce((a, u) => a + u.size, 0);
      if (size > ciocCap) {
        for (const k of keysOf.get(root) || []) {
          const [rid, v] = k.split('\u0001');
          const r = tog.find((x) => x.id === rid);
          const tags = us.flatMap((u) => u.sigs).filter((s) => r.A(s) && keyOf(r, s) === v).map((s) => s.tag);
          findings.push({
            type: 'together-exceeds-cioc', key: `${rid}:${v}`, sev: 'block', rules: [rid],
            title: `"${r.name}" needs ${size} CHARMs in one CIOC${r.by ? ` for ${v || '(none)'}` : ''}`,
            detail: `One CIOC holds ${ciocCap} with the current spare rule.`,
            clash: `${r.name} + CIOC capacity`, tags,
            options: [
              { id: 'split', label: `Let ${r.by ? v || '(none)' : 'them'} use several CIOCs (relax for this ${r.by ? 'value' : 'set'})`, effect: { kind: 'relax', rule: rid, key: v } },
              { id: 'excl', label: 'Leave these signals unplaced until clarified', effect: { kind: 'exclude', tags } },
            ],
          });
        }
        out.push(...us);
      } else {
        us.sort((a, b) => String(a.cable || '~').localeCompare(String(b.cable || '~')) || pairOrder(a.sigs[0], b.sigs[0]));
        const m = mkUnit(us.flatMap((u) => u.sigs), null, relax);
        m.merged = true;
        out.push(m);
      }
    }
    units = out;
  }
  return { units, findings };

  function chunk(rs, cbl) {
    if (rs.length <= ciocCap) return units.push(mkUnit(rs, cbl, relax));
    for (let i = 0; i < rs.length; i += ciocCap) units.push(mkUnit(rs.slice(i, i + ciocCap), cbl, relax));
  }
}
function tooBig(cbl, rs, ciocCap) {
  return {
    type: 'cable-exceeds-cioc', key: cbl, sev: 'block', rules: ['cable'],
    title: `${cbl} does not fit in one CIOC`,
    detail: `${cbl} has ${rs.length} signals; one CIOC holds ${ciocCap} with the current spare rule. Keeping its pairs together is impossible.`,
    clash: 'Cable-together + CIOC capacity', tags: rs.map((s) => s.tag),
    options: [
      { id: 'split', label: `Split ${cbl} across CIOCs (relax cable-together for this cable)`, effect: { kind: 'relax', rule: 'cable', cable: cbl } },
      { id: 'excl', label: 'Leave the cable unplaced until clarified', effect: { kind: 'exclude', tags: rs.map((s) => s.tag) } },
    ],
  };
}

// ---------- CIOC compatibility ----------
function builtinOk(c, u, rules) {
  if (rules.group && c.grps.size) {
    const all = new Set([...c.grps, ...u.grps]);
    if (all.size > 1) {
      if (u.relaxGroup) { if (![...c.grps].every((g) => u.grps.has(g))) return false; }
      else if (!(c.mixOk && u.grps.size === 1 && c.grps.has(u.g))) return false;
    }
  }
  if (rules.ab) {
    for (const g of new Set([...Object.keys(c.segs), ...Object.keys(u.segs)])) {
      const cs = c.segs[g] || new Set(), us = u.segs[g] || new Set();
      if (new Set([...cs, ...us]).size < 2) continue;
      if (u.relaxAB) { if (![...cs].every((x) => us.has(x))) return false; }
      else if (!(c.abOk && us.size === 1 && cs.has([...us][0]))) return false;
    }
  }
  return true;
}
// counts of a unit's signals per custom rule: [a, b]
const unitCounts = (u, cr) => cr.map((r) => {
  let a = 0, b = 0;
  for (const s of u.sigs) { if (r.A && r.A(s)) a++; if (r.B && r.B(s)) b++; }
  return [a, b];
});
// does a container with counts x violate rule r?
const breaks = (r, x) => (r.type === 'limit' ? x[0] > r.max : x[0] > 0 && x[1] > 0);

// CIOC-scope custom rules; `only` restricts to one rule index (used to find the culprit)
function customCiocOk(c, u, cr, only) {
  for (let i = 0; i < cr.length; i++) {
    const r = cr[i];
    if (only !== undefined && i !== only) continue;
    if (r.scope !== 'cioc' || !['separate', 'exclusive', 'limit'].includes(r.type) || u.ignore.has(r.id)) continue;
    const x = [c.cnt[i][0] + u.cnt[i][0], c.cnt[i][1] + u.cnt[i][1]];
    if (breaks(r, x)) return false;
  }
  return true;
}
// first slot in c where u fits, honouring baseplate-scope custom rules (pads to the next baseplate)
function findStart(c, u, cr, pcEff, cap, only) {
  const bpRules = cr.map((r, i) => i).filter((i) => (only === undefined || i === only) && cr[i].scope === 'baseplate' &&
    ['separate', 'exclusive', 'limit'].includes(cr[i].type) && !u.ignore.has(cr[i].id));
  let start = c.used;
  while (start + u.size <= cap) {
    let bad = false;
    let hit = -1;
    if (c.occ.size) for (let k = u.size - 1; k >= 0; k--) if (c.occ.has(start + k)) { hit = start + k; break; }
    if (hit >= 0) { start = hit + 1; continue; }
    if (bpRules.length) {
      const seg = new Map(); // bp -> counts of u's signals landing there
      u.sigs.forEach((s, k) => {
        const bp = Math.floor((start + k) / pcEff);
        if (!seg.has(bp)) seg.set(bp, cr.map(() => [0, 0]));
        const m = seg.get(bp);
        bpRules.forEach((i) => { if (cr[i].A && cr[i].A(s)) m[i][0]++; if (cr[i].B && cr[i].B(s)) m[i][1]++; });
      });
      for (const [bp, m] of seg) {
        const ex = c.bp[bp] || cr.map(() => [0, 0]);
        if (bpRules.some((i) => breaks(cr[i], [ex[i][0] + m[i][0], ex[i][1] + m[i][1]]))) { bad = true; break; }
      }
    }
    if (!bad) return start;
    start = (Math.floor(start / pcEff) + 1) * pcEff;
  }
  return -1;
}
function put(c, u, start, cr, pcEff, exact) {
  u.sigs.forEach((s, k) => {
    const slot = start + k, bp = Math.floor(slot / pcEff);
    c.sigs.push({ s, slot });
    c.occ.add(slot);
    if (!c.bp[bp]) c.bp[bp] = cr.map(() => [0, 0]);
    cr.forEach((r, i) => { if (r.A && r.A(s)) c.bp[bp][i][0]++; if (r.B && r.B(s)) c.bp[bp][i][1]++; });
  });
  if (!exact) c.used = start + u.size;
  u.cnt.forEach((x, i) => { c.cnt[i][0] += x[0]; c.cnt[i][1] += x[1]; });
  u.grps.forEach((g) => c.grps.add(g));
  Object.entries(u.segs).forEach(([g, ss]) => ss.forEach((x) => (c.segs[g] = c.segs[g] || new Set()).add(x)));
  if (u.relaxGroup && u.grps.size > 1) c.mixOk = true;
  if (u.relaxAB && Object.values(u.segs).some((ss) => ss.size > 1)) c.abOk = true;
}

// baseplate-scope custom rules hold if u's signals go to exactly these slots?
function bpOkAt(c, u, slots, cr, pcEff) {
  const idx = cr.map((r, i) => i).filter((i) => cr[i].scope === 'baseplate' && ['separate', 'exclusive', 'limit'].includes(cr[i].type) && !u.ignore.has(cr[i].id));
  if (!idx.length) return true;
  const seg = new Map();
  u.sigs.forEach((s, k) => {
    const bp = Math.floor(slots[k] / pcEff);
    if (!seg.has(bp)) seg.set(bp, cr.map(() => [0, 0]));
    idx.forEach((i) => { if (cr[i].A && cr[i].A(s)) seg.get(bp)[i][0]++; if (cr[i].B && cr[i].B(s)) seg.get(bp)[i][1]++; });
  });
  for (const [bp, m] of seg) { const ex = c.bp[bp] || cr.map(() => [0, 0]); if (idx.some((i) => breaks(cr[i], [ex[i][0] + m[i][0], ex[i][1] + m[i][1]]))) return false; }
  return true;
}
function putSlots(c, u, slots, cr, pcEff) {
  u.sigs.forEach((s, k) => {
    const slot = slots[k], bp = Math.floor(slot / pcEff);
    c.sigs.push({ s, slot });
    c.occ.add(slot);
    if (!c.bp[bp]) c.bp[bp] = cr.map(() => [0, 0]);
    cr.forEach((r, i) => { if (r.A && r.A(s)) c.bp[bp][i][0]++; if (r.B && r.B(s)) c.bp[bp][i][1]++; });
  });
  u.cnt.forEach((x, i) => { c.cnt[i][0] += x[0]; c.cnt[i][1] += x[1]; });
  u.grps.forEach((g) => c.grps.add(g));
  Object.entries(u.segs).forEach(([g, ss]) => ss.forEach((x) => (c.segs[g] = c.segs[g] || new Set()).add(x)));
  if (u.relaxGroup && u.grps.size > 1) c.mixOk = true;
  if (u.relaxAB && Object.values(u.segs).some((ss) => ss.size > 1)) c.abOk = true;
}

// A hand-placed signal only reserves its CHARM. It does not count toward the rule checks of the
// auto-placed signals around it (so nothing reshuffles); whatever mix it causes, the checker reports
// as the engineer's accepted exception.
function putFixed(c, s, bp, ch, slot) {
  if (slot !== null) c.occ.add(slot);
  c.fixed.push({ s, bp, ch });
}

// ---------- allocate ----------
// prev: { tag: {cab, cioc, bp, ch} } from the last run with the same rules; units that can keep
// their exact slots do, so a re-allocation changes as little as possible.
function allocate(signalsIn, rules, hIn, relax, pins, customsIn, manualIn, prev) {
  rules = rules || {};
  relax = relax || { ab: new Set(), group: new Set(), cable: new Set(), cap: new Set() };
  pins = pins || {};
  const customs = customsIn || [];
  const H = hier(hIn);
  const spare = spareOf(H, rules, customs), pcEff = H.pc - spare, ciocCap = H.bc * pcEff;
  const cr = customs.filter((r) => ['separate', 'exclusive', 'limit'].includes(r.type));
  const manual = manualIn || {};
  const okPos = (m) => m && m.cab >= 0 && m.cioc >= 0 && m.cioc < H.cc && m.bp >= 0 && m.bp < H.bc && m.ch >= 0 && m.ch < H.pc;
  const fixedSigs = signalsIn.filter((s) => okPos(manual[s.tag]));
  const signals = signalsIn.filter((s) => !okPos(manual[s.tag]));
  const togCab = customs.filter((r) => r.type === 'together' && r.scope === 'cabinet');
  const { units, findings } = buildUnits(signals, rules, relax, ciocCap, customs);
  units.forEach((u) => {
    u.cnt = unitCounts(u, cr);
    cr.forEach((r) => { if ((relax[r.id] || new Set()).has(unitKey(u))) u.ignore.add(r.id); });
    u.ck = togCab.map((r) => { const s = u.sigs.find((x) => r.A(x)); return s ? keyOf(r, s) : '~'; }).join('|');
  });

  // deterministic order: group, cabinet-together key, segregation, size, cable, pair
  units.sort((a, b) => a.g.localeCompare(b.g) || a.ck.localeCompare(b.ck) || a.s.localeCompare(b.s) || (b.size - a.size) ||
    String(a.cable || '~').localeCompare(String(b.cable || '~')) || pairOrder(a.sigs[0], b.sigs[0]));

  const ciocs = [];
  const blank = (pos) => ({ sigs: [], fixed: [], occ: new Set(), used: 0, bp: [], cnt: cr.map(() => [0, 0]), grps: new Set(), segs: {}, pos: pos ?? null });
  const newC = (pos) => { const c = blank(pos); ciocs.push(c); return c; };

  // 0. manually placed signals are fixed first; everything else is placed around them
  for (const s of fixedSigs) {
    const m = manual[s.tag], pos = m.cab * H.cc + m.cioc;
    const c = ciocs.find((x) => x.pos === pos) || newC(pos);
    putFixed(c, s, m.bp, m.ch, m.ch < pcEff ? m.bp * pcEff + m.ch : null);
  }
  const ok = (c, u) => builtinOk(c, u, rules) && customCiocOk(c, u, cr);

  // 1. pinned units go to their fixed CIOC position first
  const rest = [];
  for (const u of units) {
    const pin = u.sigs.map((s) => pins[s.tag]).find(Boolean);
    if (!pin) { rest.push(u); continue; }
    const pos = pin.pos.cab * H.cc + pin.pos.cioc;
    let c = ciocs.find((x) => x.pos === pos);
    const fresh = !c;
    if (fresh) c = blank(pos);
    const st = pin.pos.cioc < H.cc && ok(c, u) ? findStart(c, u, cr, pcEff, ciocCap) : -1;
    if (st >= 0) {
      if (fresh) ciocs.push(c);
      put(c, u, st, cr, pcEff);
      u.sigs.forEach((s) => (s._pinned = true));
    } else {
      findings.push({
        type: 'pin-unsatisfiable', key: u.sigs[0].tag, sev: 'warn',
        title: `Pin for ${u.sigs.map((s) => s.tag).slice(0, 3).join(', ')} cannot be kept`,
        detail: 'The previous CIOC is full or would now break a rule, so these signals are placed normally.',
        clash: 'Revision pin', tags: u.sigs.map((s) => s.tag),
        options: [{ id: 'ok', label: 'Place normally', effect: { kind: 'accept' } }], def: 'ok',
      });
      rest.push(u);
    }
  }

  // 1b. stability: signals keep the exact slot they had last time if it is still valid. A signal that
  //     left (manual queue, excluded) leaves its CHARM empty, so its neighbours do not slide over.
  const moved = [];
  if (prev) {
    const here = new Set(signalsIn.map((x) => x.tag));
    const prevAt = new Map(Object.entries(prev).map(([t, q]) => [`${q.cab}/${q.cioc}/${q.bp * pcEff + q.ch}`, t]));
    for (const u of rest) {
      const ps = u.sigs.map((s) => prev[s.tag]);
      const p0 = ps[0];
      const slots = ps.map((q) => q && q.bp * pcEff + q.ch);
      let ok0 = p0 && p0.cioc < H.cc && ps.every((q, k) => q && q.cab === p0.cab && q.cioc === p0.cioc && q.ch < pcEff && q.bp < H.bc && (k === 0 || slots[k] > slots[k - 1]));
      // gaps inside the unit are allowed only where a signal that is no longer here used to sit
      if (ok0) for (let x = slots[0]; ok0 && x <= slots[slots.length - 1]; x++) if (!slots.includes(x)) { const t = prevAt.get(`${p0.cab}/${p0.cioc}/${x}`); if (t && here.has(t)) ok0 = false; }
      if (!ok0) { moved.push(u); continue; }
      const pos = p0.cab * H.cc + p0.cioc;
      let c = ciocs.find((x) => x.pos === pos);
      const fresh = !c;
      if (fresh) c = blank(pos);
      if (slots.every((x) => !c.occ.has(x)) && ok(c, u) && bpOkAt(c, u, slots, cr, pcEff)) {
        if (fresh) ciocs.push(c);
        putSlots(c, u, slots, cr, pcEff);
      } else moved.push(u);
    }
  } else moved.push(...rest);

  // 2. first fit into a compatible CIOC with room, else a new one
  for (const u of moved) {
    let c = null, st = -1;
    for (const x of ciocs) {
      if (!ok(x, u)) continue;
      const s0 = findStart(x, u, cr, pcEff, ciocCap);
      if (s0 >= 0) { c = x; st = s0; break; }
    }
    if (!c) {
      c = newC(null);
      st = ok(c, u) || !builtinOk(c, u, rules) ? findStart(c, u, cr, pcEff, ciocCap) : -1;
      if (st < 0) {
        // the unit breaks a custom rule even alone in an empty CIOC: name the rule(s), raise TQs
        const tags = u.sigs.map((s) => s.tag), k = unitKey(u);
        cr.forEach((r, i) => {
          if (u.ignore.has(r.id)) return;
          const alone = !customCiocOk(c, u, cr, i) || findStart(c, u, cr, pcEff, ciocCap, i) < 0;
          if (!alone) return;
          u.ignore.add(r.id);
          if ((relax[r.id] || new Set()).has(k)) return;
          findings.push({
            type: 'unit-breaks-rule', key: `${r.id}:${k}`, sev: 'block', rules: [r.id],
            title: `${u.cable ? 'Cable ' + u.cable : tags[0]} cannot meet "${r.name}"`,
            detail: `${tags.length} signals that must stay together (${u.merged ? 'a "together" rule' : u.cable ? 'cable-together' : 'one signal'}) break this rule on their own: ${tags.slice(0, 6).join(', ')}${tags.length > 6 ? '…' : ''}.`,
            clash: `${r.name}${u.cable ? ' + Cable-together' : ''}`, tags,
            options: [
              { id: 'relax', label: `Allow it for ${u.cable || tags[0]} (relax "${r.name}" here)`, effect: { kind: 'relax', rule: r.id, key: k } },
              { id: 'excl', label: 'Leave these signals unplaced until clarified', effect: { kind: 'exclude', tags } },
            ],
          });
        });
        st = findStart(c, u, cr, pcEff, ciocCap);
        if (st < 0) st = c.used; // cannot happen once the culprits are ignored; keeps placement total
      }
    }
    put(c, u, st, cr, pcEff);
  }

  // 3. CIOCs into cabinet positions. CIOCs that must share a cabinet are linked (union-find):
  //    a group's CIOCs (grouping + cap) and the CIOCs of each "together in one cabinet" key.
  const taken = new Set(ciocs.filter((c) => c.pos != null).map((c) => c.pos));
  const free = (cab) => { const r = []; for (let i = 0; i < H.cc; i++) if (!taken.has(cab * H.cc + i)) r.push(cab * H.cc + i); return r; };
  const take = (p, c) => { c.pos = p; taken.add(p); };
  const open = ciocs.filter((c) => c.pos == null);
  const par = open.map((_, i) => i);
  const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
  const keyCiocs = new Map(); // link key -> {label, rule, value, set of indexes}
  const link = (k, i, meta) => { if (!keyCiocs.has(k)) keyCiocs.set(k, { ...meta, ix: new Set() }); keyCiocs.get(k).ix.add(i); };
  open.forEach((c, i) => {
    if (rules.group && rules.cap) { const g = [...c.grps].sort()[0]; link('cap\u0001' + g, i, { rule: 'cap', value: g, name: 'Each group fits in one cabinet' }); }
    togCab.forEach((r) => c.sigs.forEach(({ s }) => { if (r.A(s)) link(r.id + '\u0001' + keyOf(r, s), i, { rule: r.id, value: keyOf(r, s), name: r.name }); }));
  });
  for (const [k, m] of keyCiocs) {
    const ix = [...m.ix];
    if (ix.length > H.cc) {
      const tags = ix.flatMap((i) => open[i].sigs.map((x) => x.s.tag));
      if (m.rule === 'cap') {
        findings.push({
          type: 'group-exceeds-cabinet', key: m.value || 'no-group', sev: 'block', rules: ['cap'],
          title: `Group ${m.value || '"No group"'} needs ${ix.length} CIOCs, a cabinet holds ${H.cc}`,
          detail: `"Each group fits in one cabinet" cannot hold for ${m.value || 'ungrouped signals'} (${tags.length} signals).`,
          clash: 'Grouping + Cabinet capacity', tags,
          options: [
            { id: 'span', label: `Let ${m.value || 'No group'} span ${Math.ceil(ix.length / H.cc)} cabinets`, effect: { kind: 'relax', rule: 'cap', grp: m.value } },
            { id: 'excl', label: 'Leave the group unplaced until clarified', effect: { kind: 'exclude', tags } },
          ],
        });
      } else {
        const own = open.flatMap((c) => c.sigs.map((x) => x.s)).filter((s) => { const r = togCab.find((x) => x.id === m.rule); return r.A(s) && keyOf(r, s) === m.value; }).map((s) => s.tag);
        findings.push({
          type: 'together-exceeds-cabinet', key: `${m.rule}:${m.value}`, sev: 'block', rules: [m.rule],
          title: `"${m.name}" needs ${ix.length} CIOCs in one cabinet${m.value !== '*' ? ` for ${m.value || '(none)'}` : ''}`,
          detail: `A cabinet holds ${H.cc} CIOCs.`, clash: `${m.name} + Cabinet capacity`, tags: own,
          options: [
            { id: 'span', label: `Let ${m.value !== '*' ? m.value || '(none)' : 'them'} span cabinets (relax here)`, effect: { kind: 'relax', rule: m.rule, key: m.value } },
            { id: 'excl', label: 'Leave these signals unplaced until clarified', effect: { kind: 'exclude', tags: own } },
          ],
        });
      }
    }
    if ((relax[m.rule] || new Set()).has(m.value)) continue; // relaxed: does not link
    if (ix.length > H.cc) continue; // already raised; placed without the link
    for (const i of ix.slice(1)) par[find(i)] = find(ix[0]);
  }
  const comps = new Map();
  open.forEach((c, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(c); });
  for (const cs of comps.values()) {
    if (cs.length > 1 && cs.length > H.cc) {
      // several links together overflow a cabinet: let the engineer pick which one to relax
      const ks = [...keyCiocs.values()].filter((m) => !(relax[m.rule] || new Set()).has(m.value) && [...m.ix].some((i) => cs.includes(open[i])) && m.ix.size <= H.cc);
      const tags = cs.flatMap((c) => c.sigs.map((x) => x.s.tag));
      findings.push({
        type: 'cabinet-link-overflow', key: ks.map((m) => m.rule + '=' + m.value).sort().join('&').slice(0, 180), sev: 'block', rules: [...new Set(ks.map((m) => m.rule))],
        title: `Rules that keep CIOCs in one cabinet need ${cs.length} CIOCs together`,
        detail: `${ks.map((m) => `"${m.name}"${m.value !== '*' ? ' for ' + (m.value || '(none)') : ''}`).join(', ')} chain ${cs.length} CIOCs into one cabinet, which holds ${H.cc}.`,
        clash: 'Cabinet capacity', tags,
        options: ks.slice(0, 8).map((m, j) => ({ id: 'r' + j, label: `Relax "${m.name}"${m.value !== '*' ? ' for ' + (m.value || '(none)') : ''}`, effect: m.rule === 'cap' ? { kind: 'relax', rule: 'cap', grp: m.value } : { kind: 'relax', rule: m.rule, key: m.value } })),
      });
    }
    if (cs.length <= H.cc) {
      let cab = 0;
      while (free(cab).length < cs.length) cab++;
      free(cab).slice(0, cs.length).forEach((p, i) => take(p, cs[i]));
    } else {
      let p = 0;
      for (const c of cs) { while (taken.has(p)) p++; take(p, c); }
    }
  }

  // 4. placements
  const placements = [];
  ciocs.sort((a, b) => a.pos - b.pos);
  for (const c of ciocs) {
    for (const { s, bp, ch } of c.fixed) placements.push({ tag: s.tag, type: s.type, grp: s.grp, seg: s.seg, cable: s.cable, pair: s.pair, cab: Math.floor(c.pos / H.cc), cioc: c.pos % H.cc, bp, ch, pinned: false, manual: true });
    for (const { s, slot } of c.sigs) {
      placements.push({
        tag: s.tag, type: s.type, grp: s.grp, seg: s.seg, cable: s.cable, pair: s.pair,
        cab: Math.floor(c.pos / H.cc), cioc: c.pos % H.cc, bp: Math.floor(slot / pcEff), ch: slot % pcEff, pinned: !!s._pinned,
      });
      delete s._pinned;
    }
  }
  // Keeping old slots can strand a CIOC away from its group's cabinet. If a cabinet-level link that
  // fits in one cabinet ended up split, this stable layout is not valid: lay out from scratch instead.
  if (prev) {
    const split = (sel, keyFn, relaxed) => {
      const m = new Map();
      for (const x of placements) if (sel(x)) { const k = keyFn(x); if (!m.has(k)) m.set(k, { cabs: new Set(), ciocs: new Set(), fixed: false }); const e = m.get(k); e.cabs.add(x.cab); e.ciocs.add(x.cab + '/' + x.cioc); e.fixed = e.fixed || x.pinned || x.manual; }
      for (const [k, e] of m) if (e.cabs.size > 1 && !relaxed.has(k) && !e.fixed) return true; // the fresh layout raises the right TQ if it truly cannot fit
      return false;
    };
    const bad = (rules.group && rules.cap && split(() => true, (x) => x.grp || NOGRP, relax.cap)) ||
      togCab.some((r) => split((x) => r.A(x), (x) => keyOf(r, x), relax[r.id] || new Set()));
    if (bad) return allocate(signalsIn, rules, hIn, relax, pins, customsIn, manualIn, null);
  }
  const cabinets = ciocs.length ? Math.floor(ciocs[ciocs.length - 1].pos / H.cc) + 1 : 0;
  const bps = new Set(placements.map((p) => `${p.cab}/${p.cioc}/${p.bp}`)).size;
  return {
    H, spare, pcEff, placements, findings,
    ciocs: ciocs.map((c) => ({
      cab: Math.floor(c.pos / H.cc), cioc: c.pos % H.cc, n: c.sigs.length + c.fixed.length, grps: [...c.grps],
      segs: Object.fromEntries(Object.entries(c.segs).map(([g, s]) => [g, [...s]])),
    })),
    stats: { signals: placements.length, cabinets, ciocs: ciocs.length, baseplates: bps, fill: bps ? Math.round((placements.length / (bps * H.pc)) * 100) : 0 },
  };
}

// Cabinets needed with each active rule switched off ("what each rule costs").
function ruleCosts(signals, rules, H, relax, pins, customs, manual) {
  const out = {};
  for (const k of ENGINE_RULES) if (rules[k]) out[k] = allocate(signals, { ...rules, [k]: false }, H, relax, pins, customs, manual).stats.cabinets;
  for (const c of customs || []) out[c.id] = allocate(signals, rules, H, relax, pins, customs.filter((x) => x !== c), manual).stats.cabinets;
  return out;
}

const ENGINE_RULES = ['ab', 'group', 'spare', 'cable', 'cap'];
module.exports = { applyDecisions, allocate, ruleCosts, hier, spareOf, builtinSpare, ENGINE_RULES };
