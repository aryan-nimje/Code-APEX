'use strict';
// Detectors: small functions (ctx) -> findings[]. Add a new check by appending to DETECTORS.
//
// ctx = { signals, rules, hw, prev, prevRev, rev, decisions }
//   signals   raw signals of the current revision (before any decision is applied)
//   rules     { ruleKey: true/false } active rules
//   hw        hardware lookup { IO type: [charm, terminal block] }
//   prev      raw signals of the previous revision (or null)
//   decisions active decisions { fp: {effect, tags, ...} } from the TQ pool
//
// A finding:
//   { type, key, sev: 'block'|'warn', title, detail, clash, tags: [...], options: [...], def }
//   type+key -> fingerprint, e.g. "pair-claimed-twice:CBL-114/7"
//   sev 'block' stops allocation until decided; 'warn' proceeds with option `def` and stays flagged.
//   options[].effect is what the engine does if that option is chosen (see decisions.js).

const uniq = (a) => [...new Set(a)];
const by = (arr, fn) => arr.reduce((m, x) => ((m[fn(x)] = m[fn(x)] || []).push(x), m), {});
const where = (s) => `${s.src.file} / ${s.src.sheet} row ${s.src.row}`;
const few = (a, n = 6) => (a.length > n ? a.slice(0, n).join(', ') + ` and ${a.length - n} more` : a.join(', '));
const FIELDS = ['type', 'cable', 'pair', 'grp', 'seg'];
const show = (v) => (v === null || v === undefined || v === '' ? '(blank)' : String(v));

// ---------- data health ----------
function duplicateTags(ctx) {
  const out = [];
  const g = by(ctx.signals.filter((s) => s.tag), (s) => s.tag);
  for (const [tag, rows] of Object.entries(g)) {
    if (rows.length < 2) continue;
    const diff = FIELDS.filter((f) => uniq(rows.map((r) => show(r[f]))).length > 1);
    const sheets = uniq(rows.map((r) => r.src.file + '/' + r.src.sheet));
    const loc = rows.map(where).join('; ');
    if (!diff.length) {
      out.push({
        type: 'duplicate-tag', key: tag, sev: 'warn',
        title: `Duplicate tag ${tag}`,
        detail: `${tag} appears ${rows.length} times with identical values (${loc}).`,
        clash: 'Data health', tags: [tag],
        options: [
          { id: 'first', label: 'Merge, keep the first row', effect: { kind: 'merge', keep: 'first', tag } },
          { id: 'last', label: 'Merge, keep the last row', effect: { kind: 'merge', keep: 'last', tag } },
          { id: 'excl', label: 'Leave unplaced until clarified', effect: { kind: 'exclude', tags: [tag] } },
        ],
        def: 'first',
      });
    } else {
      out.push({
        type: sheets.length > 1 ? 'cross-sheet-conflict' : 'tag-conflict', key: tag, sev: 'block',
        title: sheets.length > 1 ? `${tag} differs between sheets` : `${tag} listed twice with different values`,
        detail: `${tag} appears ${rows.length} times and disagrees on ${diff.join(', ')}. ` +
          rows.map((r) => `${where(r)}: ${diff.map((f) => f + '=' + show(r[f])).join(', ')}`).join('; ') + '.',
        clash: 'Data health', tags: [tag],
        options: [
          { id: 'first', label: `Use ${where(rows[0])}`, effect: { kind: 'merge', keep: 'first', tag } },
          { id: 'last', label: `Use ${where(rows[rows.length - 1])}`, effect: { kind: 'merge', keep: 'last', tag } },
          { id: 'excl', label: 'Leave unplaced until clarified', effect: { kind: 'exclude', tags: [tag] } },
        ],
      });
    }
  }
  return out;
}

function missingTag(ctx) {
  const rows = ctx.signals.filter((s) => !s.tag);
  if (!rows.length) return [];
  return [{
    type: 'missing-tag', key: 'all', sev: 'warn',
    title: `${rows.length} row${rows.length > 1 ? 's have' : ' has'} data but no tag`,
    detail: `These rows cannot be placed without a tag: ${few(rows.map(where), 4)}.`,
    clash: 'Data health', tags: [], rows: rows.map((r) => r.i),
    options: [{ id: 'skip', label: 'Skip these rows', effect: { kind: 'skip-rows' } }],
    def: 'skip',
  }];
}

function ioTypes(ctx) {
  const out = [];
  const types = Object.keys(ctx.hw || {});
  const tagged = ctx.signals.filter((s) => s.tag);
  const missing = tagged.filter((s) => !s.type);
  if (missing.length) {
    const tags = uniq(missing.map((s) => s.tag));
    out.push({
      type: 'missing-type', key: 'all', sev: 'block',
      title: `${tags.length} signal${tags.length > 1 ? 's have' : ' has'} no IO type`,
      detail: `No CHARM can be chosen without an IO type: ${few(tags)}.`,
      clash: 'Data health', tags,
      options: [
        { id: 'excl', label: 'Leave unplaced until clarified', effect: { kind: 'exclude', tags } },
        ...types.map((t) => ({ id: 'as-' + t, label: `Treat as ${t}`, effect: { kind: 'override', field: 'type', value: t, tags } })),
      ],
    });
  }
  const unknown = by(tagged.filter((s) => s.type && !types.includes(s.type)), (s) => s.type);
  for (const [t, rows] of Object.entries(unknown)) {
    const tags = uniq(rows.map((s) => s.tag));
    out.push({
      type: 'unknown-type', key: t, sev: 'block',
      title: `IO type "${rows[0].rawType || t}" has no CHARM mapping`,
      detail: `${tags.length} signals use "${rows[0].rawType || t}", which is not in the CHARM and terminal block lookup: ${few(tags)}. Add it to the lookup, or map it to a known type.`,
      clash: 'Hardware lookup', tags,
      options: [
        ...types.map((k) => ({ id: 'as-' + k, label: `Treat as ${k}`, effect: { kind: 'override', field: 'type', value: k, tags } })),
        { id: 'excl', label: 'Leave unplaced until clarified', effect: { kind: 'exclude', tags } },
      ],
    });
  }
  return out;
}

function missingGroupSeg(ctx) {
  const out = [];
  const tagged = ctx.signals.filter((s) => s.tag);
  if (ctx.rules.group) {
    const tags = uniq(tagged.filter((s) => !s.grp).map((s) => s.tag));
    if (tags.length)
      out.push({
        type: 'missing-group', key: 'all', sev: 'warn',
        title: `${tags.length} signal${tags.length > 1 ? 's have' : ' has'} no process group`,
        detail: `The grouping rule is on but these have no group: ${few(tags)}. By default they are placed together as "No group".`,
        clash: 'Grouping', tags,
        options: [
          { id: 'nogrp', label: 'Place them together as "No group"', effect: { kind: 'accept' } },
          { id: 'excl', label: 'Leave unplaced until clarified', effect: { kind: 'exclude', tags } },
        ],
        def: 'nogrp',
      });
  }
  if (ctx.rules.ab) {
    const bad = tagged.filter((s) => s.seg && s.seg !== 'A' && s.seg !== 'B');
    const vals = by(bad, (s) => s.seg);
    for (const [v, rows] of Object.entries(vals)) {
      const tags = uniq(rows.map((s) => s.tag));
      out.push({
        type: 'bad-segregation', key: v, sev: 'block',
        title: `Segregation value "${rows[0].rawSeg}" is not A or B`,
        detail: `${tags.length} signals: ${few(tags)}.`,
        clash: 'A/B segregation', tags,
        options: [
          { id: 'a', label: 'Treat as A', effect: { kind: 'override', field: 'seg', value: 'A', tags } },
          { id: 'b', label: 'Treat as B', effect: { kind: 'override', field: 'seg', value: 'B', tags } },
          { id: 'none', label: 'Treat as not segregated', effect: { kind: 'override', field: 'seg', value: '', tags } },
          { id: 'excl', label: 'Leave unplaced until clarified', effect: { kind: 'exclude', tags } },
        ],
      });
    }
  }
  return out;
}

const TAG_RX = /^[A-Z0-9]{1,8}([-_.\/][A-Z0-9]{1,12}){1,5}$/;
function malformedTags(ctx) {
  const tags = uniq(ctx.signals.filter((s) => s.tag && !TAG_RX.test(s.tag)).map((s) => s.tag));
  if (!tags.length) return [];
  return [{
    type: 'malformed-tag', key: 'all', sev: 'warn',
    title: tags.length === 1 ? `${tags[0]} does not look like an instrument tag` : `${tags.length} tags do not look like instrument tags`,
    detail: `Expected something like FT-1042 or 10-PT-205A: ${few(tags)}.`,
    clash: 'Data health', tags,
    options: [
      { id: 'ok', label: 'Use them as they are', effect: { kind: 'accept' } },
      { id: 'excl', label: 'Leave unplaced until clarified', effect: { kind: 'exclude', tags } },
    ],
    def: 'ok',
  }];
}

// ---------- cable integrity ----------
function cableIntegrity(ctx) {
  const out = [];
  const tagged = ctx.signals.filter((s) => s.tag);
  const noCable = uniq(tagged.filter((s) => !s.cable).map((s) => s.tag));
  if (noCable.length && ctx.rules.cable)
    out.push({
      type: 'missing-cable', key: 'all', sev: 'warn',
      title: `${noCable.length} signal${noCable.length > 1 ? 's have' : ' has'} no cable`,
      detail: `They are placed one by one, not as part of a cable: ${few(noCable)}.`,
      clash: 'Cable-together', tags: noCable,
      options: [
        { id: 'single', label: 'Place them individually', effect: { kind: 'accept' } },
        { id: 'excl', label: 'Leave unplaced until clarified', effect: { kind: 'exclude', tags: noCable } },
      ],
      def: 'single',
    });

  const cables = by(tagged.filter((s) => s.cable), (s) => s.cable);
  for (const [cbl, rows] of Object.entries(cables)) {
    // same cable + pair claimed by two different tags
    const pairs = by(rows.filter((r) => Number.isFinite(r.pair)), (r) => r.pair);
    for (const [p, rs] of Object.entries(pairs)) {
      const tags = uniq(rs.map((r) => r.tag));
      if (tags.length < 2) continue;
      out.push({
        type: 'pair-claimed-twice', key: `${cbl}/${p}`, sev: 'block',
        title: `Pair ${p} of ${cbl} claimed twice`,
        detail: `${cbl} pair ${p} is used by ${tags.join(' and ')} (${rs.map(where).join('; ')}).`,
        clash: 'Cable integrity', tags,
        options: [
          ...tags.map((t) => ({ id: 'keep-' + t, label: `Keep ${t}, leave the others unplaced`, effect: { kind: 'exclude', tags: tags.filter((x) => x !== t) } })),
          { id: 'excl', label: 'Leave all unplaced until clarified', effect: { kind: 'exclude', tags } },
        ],
      });
    }
    const bad = rows.filter((r) => Number.isNaN(r.pair));
    if (bad.length)
      out.push({
        type: 'bad-pair', key: cbl, sev: 'warn',
        title: `${cbl} has unreadable pair numbers`,
        detail: `${few(uniq(bad.map((r) => r.tag)))}. They are placed after the numbered pairs.`,
        clash: 'Cable integrity', tags: uniq(bad.map((r) => r.tag)),
        options: [{ id: 'ok', label: 'Place them after the numbered pairs', effect: { kind: 'accept' } }],
        def: 'ok',
      });

    // more signals than the cable has pairs, or a pair number beyond the cable size
    const size = Math.max(0, ...rows.map((r) => r.size || 0));
    const n = uniq(rows.map((r) => r.tag)).length;
    const maxPair = Math.max(0, ...rows.map((r) => (Number.isFinite(r.pair) ? r.pair : 0)));
    if (size && (n > size || maxPair > size)) {
      const tags = uniq(rows.map((r) => r.tag));
      out.push({
        type: 'cable-overfull', key: cbl, sev: 'warn',
        title: `${cbl} has more signals than pairs`,
        detail: `${cbl} is listed as ${size} pairs but carries ${n} signals${maxPair > size ? `, highest pair number ${maxPair}` : ''}.`,
        clash: 'Cable integrity', tags,
        options: [
          { id: 'ok', label: 'Place all signals, flag the cable size', effect: { kind: 'accept' } },
          { id: 'excl', label: 'Leave the cable unplaced until clarified', effect: { kind: 'exclude', tags } },
        ],
        def: 'ok',
      });
    }

    // a cable mixing A and B (only a problem when A/B and cable-together are both on)
    const segs = uniq(rows.map((r) => r.seg).filter((s) => s === 'A' || s === 'B'));
    if (segs.length > 1 && ctx.rules.ab && ctx.rules.cable) {
      const tags = uniq(rows.map((r) => r.tag));
      out.push({
        type: 'cable-mixed-seg', key: cbl, sev: 'block', rules: ['ab', 'cable'],
        title: `${cbl} mixes Seg A and Seg B`,
        detail: `${cbl} carries ${rows.filter((r) => r.seg === 'A').length} Seg A and ${rows.filter((r) => r.seg === 'B').length} Seg B signals. "Keep cable pairs together" and "A and B never share a CIOC" cannot both hold.`,
        clash: 'A/B segregation + Cable-together', tags,
        options: [
          { id: 'split', label: `Split ${cbl} by segregation (relax cable-together for this cable)`, effect: { kind: 'relax', rule: 'cable', cable: cbl } },
          { id: 'mix', label: `Keep ${cbl} together (relax A/B for this cable)`, effect: { kind: 'relax', rule: 'ab', cable: cbl } },
          { id: 'excl', label: 'Leave the cable unplaced until clarified', effect: { kind: 'exclude', tags } },
        ],
      });
    }

    // a cable spanning process groups
    const grps = uniq(rows.map((r) => r.grp));
    if (grps.length > 1 && ctx.rules.group && ctx.rules.cable) {
      const tags = uniq(rows.map((r) => r.tag));
      out.push({
        type: 'cable-mixed-group', key: cbl, sev: 'block', rules: ['group', 'cable'],
        title: `${cbl} spans groups ${grps.map((g) => g || 'none').join(', ')}`,
        detail: `"Keep cable pairs together" and "Each group stays in its own CIOCs" cannot both hold for ${cbl}.`,
        clash: 'Grouping + Cable-together', tags,
        options: [
          { id: 'split', label: `Split ${cbl} by group (relax cable-together for this cable)`, effect: { kind: 'relax', rule: 'cable', cable: cbl } },
          { id: 'mix', label: `Keep ${cbl} together (allow its CIOC to mix groups)`, effect: { kind: 'relax', rule: 'group', cable: cbl } },
          { id: 'excl', label: 'Leave the cable unplaced until clarified', effect: { kind: 'exclude', tags } },
        ],
      });
    }
  }
  return out;
}

// ---------- revision effects ----------
function revisionEffects(ctx) {
  const out = [];
  if (!ctx.prev) return out;
  const cur = new Set(ctx.signals.map((s) => s.tag));
  const prevBy = by(ctx.prev.filter((s) => s.tag), (s) => s.tag);
  const curBy = by(ctx.signals.filter((s) => s.tag), (s) => s.tag);

  // decisions that name signals which were deleted in this revision
  for (const [fp, d] of Object.entries(ctx.decisions || {})) {
    const gone = (d.tags || []).filter((t) => prevBy[t] && !cur.has(t));
    if (!gone.length) continue;
    out.push({
      type: 'decision-orphaned', key: fp, sev: 'warn',
      title: `A decision refers to deleted signals`,
      detail: `Decision "${d.label}" on ${fp} covers ${few(gone)}, deleted in Rev ${ctx.rev}.`,
      clash: 'Revision', tags: gone,
      options: [
        { id: 'keep', label: 'Keep the decision for the remaining signals', effect: { kind: 'accept' } },
        { id: 'retire', label: 'Retire the decision', effect: { kind: 'retire', fp } },
      ],
      def: 'keep',
    });
  }

  // signals that were placed in the previous allocation and moved (group, seg or cable changed)
  if (ctx.prevPlacement) {
    const moved = [];
    for (const [t, rows] of Object.entries(curBy)) {
      const p = prevBy[t] && prevBy[t][0], c = rows[0];
      if (!p || !ctx.prevPlacement[t]) continue;
      if (p.grp !== c.grp || p.seg !== c.seg || p.cable !== c.cable) moved.push(t);
    }
    if (moved.length) {
      const pins = moved.map((t) => ({ tag: t, pos: ctx.prevPlacement[t] }));
      out.push({
        type: 'moved-since-allocation', key: 'all', sev: 'warn',
        title: `${moved.length} placed signals changed group, segregation or cable`,
        detail: `Placed in Rev ${ctx.prevRev}, changed in Rev ${ctx.rev}: ${few(moved)}. By default they are placed again under the current rules.`,
        clash: 'Revision', tags: moved,
        options: [
          { id: 'replace', label: 'Place them again under the current rules', effect: { kind: 'accept' } },
          { id: 'pin', label: 'Keep each in its previous CIOC (pin)', effect: { kind: 'pin', pins } },
        ],
        def: 'replace',
      });
    }
  }
  return out;
}

const DETECTORS = [missingTag, duplicateTags, ioTypes, missingGroupSeg, malformedTags, cableIntegrity, revisionEffects];

function runDetectors(ctx) {
  ctx.signals.forEach((s, i) => (s.i = i));
  const out = [];
  for (const d of DETECTORS) {
    try {
      out.push(...d(ctx));
    } catch (e) {
      out.push({ type: 'detector-error', key: d.name, sev: 'warn', title: `Check "${d.name}" failed`, detail: e.message, clash: 'Internal', tags: [], options: [{ id: 'ok', label: 'Acknowledge', effect: { kind: 'accept' } }], def: 'ok' });
    }
  }
  return out;
}

module.exports = { DETECTORS, runDetectors, by, uniq, few };
