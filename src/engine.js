'use strict';
// Allocation engine. Works on the real signals of a revision.
//
//   applyDecisions(rawSignals, effects) -> { signals, unplaced, relax, pins }
//   allocate(signals, rules, H, relax, pins) -> { placements, ciocs, findings, stats }
//
// Rule semantics (keys match the rule table):
//   ab     A and B of the same group never share a CIOC
//   group  a CIOC holds one process group only
//   spare  10% of the CHARMs on each baseplate stay free (at least 1)
//   cable  all pairs of a cable land in one CIOC, on consecutive CHARMs, in pair order
//   cap    with grouping on, each group fits in one cabinet (at most "CIOCs per cabinet")
// When a hard rule cannot be met the engine does not quietly break it: it returns a finding,
// which becomes a TQ, and the result is held until that TQ is decided.

const NOGRP = '';

// ---------- decisions -> effective signals + constraints ----------
function applyDecisions(raw, effects) {
  const relax = { ab: new Set(), group: new Set(), cable: new Set(), cap: new Set() };
  const pins = {};
  const excluded = new Map(); // tag -> effect record
  const overrides = [];
  const merges = {};
  for (const e of effects) {
    const x = e.effect;
    if (x.kind === 'exclude') x.tags.forEach((t) => excluded.set(t, e));
    else if (x.kind === 'override') overrides.push(x);
    else if (x.kind === 'merge') merges[x.tag] = x.keep;
    else if (x.kind === 'relax') relax[x.rule].add(x.cable !== undefined ? x.cable : x.grp);
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
  const signals = [], unplaced = [];
  for (const s of byTag.values()) {
    const e = excluded.get(s.tag);
    if (e) unplaced.push({ tag: s.tag, tq: e.id, reason: e.label });
    else signals.push(s);
  }
  return { signals, unplaced, relax, pins };
}

// ---------- allocator ----------
function hier(h) {
  const g = (v, d) => Math.max(1, Math.min(1000, Math.round(+v || d)));
  return { cc: g(h && h.cc, 4), bc: g(h && h.bc, 8), pc: g(h && h.pc, 12) };
}
const spareOf = (H, rules) => (rules.spare ? Math.min(H.pc - 1, Math.max(1, Math.round(H.pc * 0.1))) : 0);
const pairOrder = (a, b) => {
  const pa = Number.isFinite(a.pair) ? a.pair : 1e9, pb = Number.isFinite(b.pair) ? b.pair : 1e9;
  return pa - pb || a.tag.localeCompare(b.tag);
};
const segKey = (s) => (s === 'A' || s === 'B' ? s : '');

function buildUnits(signals, rules, relax, ciocCap) {
  const units = [], findings = [], loose = [];
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
      if (rs.length > ciocCap) findings.push(tooBig(cbl, rs));
      if (relax.cable.has(cbl)) {
        // split by group and segregation; each part is still kept together
        const parts = new Map();
        rs.forEach((s) => {
          const k = s.grp + '|' + segKey(s.seg);
          if (!parts.has(k)) parts.set(k, []);
          parts.get(k).push(s);
        });
        for (const p of parts.values()) chunk(p, cbl, p.length <= ciocCap);
      } else chunk(rs, cbl, rs.length <= ciocCap);
    }
  }
  loose.forEach((s) => units.push(mk([s], s.cable || null)));
  return { units, findings };

  function tooBig(cbl, rs) {
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
  function chunk(rs, cbl, whole) {
    if (whole) return units.push(mk(rs, cbl));
    for (let i = 0; i < rs.length; i += ciocCap) units.push(mk(rs.slice(i, i + ciocCap), cbl));
  }
  function mk(sigs, cbl) {
    const grps = new Set(sigs.map((s) => s.grp || NOGRP));
    const segs = {};
    sigs.forEach((s) => {
      const k = segKey(s.seg);
      if (k) (segs[s.grp || NOGRP] = segs[s.grp || NOGRP] || new Set()).add(k);
    });
    return {
      sigs, cable: cbl, grps, segs, size: sigs.length,
      relaxAB: !!cbl && relax.ab.has(cbl), relaxGroup: !!cbl && relax.group.has(cbl),
      g: sigs[0].grp || NOGRP, s: segKey(sigs[0].seg),
    };
  }
}

// Can unit u go into CIOC c under the active rules?
function compatible(c, u, rules) {
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
function put(c, u) {
  u.sigs.forEach((s) => c.sigs.push(s));
  u.grps.forEach((g) => c.grps.add(g));
  Object.entries(u.segs).forEach(([g, ss]) => ss.forEach((x) => (c.segs[g] = c.segs[g] || new Set()).add(x)));
  if (u.relaxGroup && u.grps.size > 1) c.mixOk = true;
  if (u.relaxAB && Object.values(u.segs).some((ss) => ss.size > 1)) c.abOk = true;
}

function allocate(signals, rules, hIn, relax, pins) {
  rules = rules || {};
  relax = relax || { ab: new Set(), group: new Set(), cable: new Set(), cap: new Set() };
  pins = pins || {};
  const H = hier(hIn);
  const spare = spareOf(H, rules), pcEff = H.pc - spare, ciocCap = H.bc * pcEff;
  const { units, findings } = buildUnits(signals, rules, relax, ciocCap);

  // deterministic order: group, segregation, cable, pair -> related signals sit together
  units.sort((a, b) => a.g.localeCompare(b.g) || a.s.localeCompare(b.s) || (b.size - a.size) ||
    String(a.cable || '~').localeCompare(String(b.cable || '~')) || pairOrder(a.sigs[0], b.sigs[0]));

  const ciocs = []; // virtual CIOCs; position assigned in step 3 (or fixed by a pin)
  const newC = (pos) => { const c = { sigs: [], grps: new Set(), segs: {}, pos: pos ?? null }; ciocs.push(c); return c; };
  const fits = (c, u) => c.sigs.length + u.size <= ciocCap;

  // 1. pinned units go to their fixed CIOC position first
  const rest = [];
  for (const u of units) {
    const pin = u.sigs.map((s) => pins[s.tag]).find(Boolean);
    if (!pin) { rest.push(u); continue; }
    const pos = pin.pos.cab * H.cc + pin.pos.cioc;
    let c = ciocs.find((x) => x.pos === pos);
    if (pin.pos.cioc < H.cc && (!c || (compatible(c, u, rules) && fits(c, u)))) {
      c = c || newC(pos);
      put(c, u);
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
  // 2. first fit into a compatible CIOC with room, else open a new one
  for (const u of rest) {
    let c = ciocs.find((x) => x.pos == null && fits(x, u) && compatible(x, u, rules)) ||
            ciocs.find((x) => x.pos != null && fits(x, u) && compatible(x, u, rules));
    if (!c) c = newC(null);
    put(c, u);
  }

  // 3. CIOCs into cabinet positions. With grouping + cap, a group's CIOCs share one cabinet.
  const taken = new Set(ciocs.filter((c) => c.pos != null).map((c) => c.pos));
  const free = (cab) => { const r = []; for (let i = 0; i < H.cc; i++) if (!taken.has(cab * H.cc + i)) r.push(cab * H.cc + i); return r; };
  const take = (p, c) => { c.pos = p; taken.add(p); };
  const blocks = new Map();
  ciocs.filter((c) => c.pos == null).forEach((c) => {
    const g = rules.group ? [...c.grps].sort()[0] : '*';
    if (!blocks.has(g)) blocks.set(g, []);
    blocks.get(g).push(c);
  });
  for (const [g, cs] of blocks) {
    const oneCab = rules.group && rules.cap && !relax.cap.has(g);
    if (rules.group && rules.cap && cs.length > H.cc) {
      const tags = cs.flatMap((c) => c.sigs.map((s) => s.tag));
      findings.push({
        type: 'group-exceeds-cabinet', key: g || 'no-group', sev: 'block', rules: ['cap'],
        title: `Group ${g || '"No group"'} needs ${cs.length} CIOCs, a cabinet holds ${H.cc}`,
        detail: `"Each group fits in one cabinet" cannot hold for ${g || 'ungrouped signals'} (${tags.length} signals).`,
        clash: 'Grouping + Cabinet capacity', tags,
        options: [
          { id: 'span', label: `Let ${g || 'No group'} span ${Math.ceil(cs.length / H.cc)} cabinets`, effect: { kind: 'relax', rule: 'cap', grp: g } },
          { id: 'excl', label: 'Leave the group unplaced until clarified', effect: { kind: 'exclude', tags } },
        ],
      });
    }
    if (oneCab && cs.length <= H.cc) {
      let cab = 0;
      while (free(cab).length < cs.length) cab++;
      free(cab).slice(0, cs.length).forEach((p, i) => take(p, cs[i]));
    } else {
      let p = 0;
      for (const c of cs) { while (taken.has(p)) p++; take(p, c); }
    }
  }

  // 4. CHARM positions inside each CIOC (consecutive, spare CHARMs left at the end of each baseplate)
  const placements = [];
  ciocs.sort((a, b) => a.pos - b.pos);
  for (const c of ciocs) {
    c.sigs.forEach((s, k) => {
      placements.push({
        tag: s.tag, type: s.type, grp: s.grp, seg: s.seg, cable: s.cable, pair: s.pair,
        cab: Math.floor(c.pos / H.cc), cioc: c.pos % H.cc, bp: Math.floor(k / pcEff), ch: k % pcEff, pinned: !!s._pinned,
      });
      delete s._pinned;
    });
  }
  const cabinets = ciocs.length ? Math.floor(ciocs[ciocs.length - 1].pos / H.cc) + 1 : 0;
  const bps = ciocs.reduce((a, c) => a + Math.ceil(c.sigs.length / pcEff), 0);
  return {
    H, spare, pcEff, placements, findings,
    ciocs: ciocs.map((c) => ({
      cab: Math.floor(c.pos / H.cc), cioc: c.pos % H.cc, n: c.sigs.length, grps: [...c.grps],
      segs: Object.fromEntries(Object.entries(c.segs).map(([g, s]) => [g, [...s]])),
    })),
    stats: { signals: placements.length, cabinets, ciocs: ciocs.length, baseplates: bps, fill: bps ? Math.round((placements.length / (bps * H.pc)) * 100) : 0 },
  };
}

// Cabinets needed with each active engine rule switched off ("what each rule costs").
function ruleCosts(signals, rules, H, relax, pins) {
  const out = {};
  for (const k of ['ab', 'group', 'spare', 'cable', 'cap']) {
    if (!rules[k]) continue;
    out[k] = allocate(signals, { ...rules, [k]: false }, H, relax, pins).stats.cabinets;
  }
  return out;
}

module.exports = { applyDecisions, allocate, ruleCosts, hier, spareOf, ENGINE_RULES: ['ab', 'group', 'spare', 'cable', 'cap'] };
