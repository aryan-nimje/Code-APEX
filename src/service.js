'use strict';
const crypto = require('crypto');
const ingest = require('./ingest');
const pool = require('./pool');
const { runDetectors } = require('./detectors');
const engine = require('./engine');
const { check } = require('./checker');

// ---------- staged uploads (preview -> confirm mapping -> commit) ----------
const STAGE = new Map();
const TTL = 30 * 60 * 1000;
function stage(staged) {
  const now = Date.now();
  for (const [k, v] of STAGE) if (now - v.at > TTL) STAGE.delete(k);
  const id = crypto.randomBytes(8).toString('hex');
  STAGE.set(id, { staged, at: now });
  return id;
}

// ---------- helpers ----------
function ruleMeta(rules) {
  const m = {};
  (rules || []).forEach((r, i) => (m[r.k] = { k: r.k, n: r.n, h: !!r.h, on: !!r.on, prio: i, engine: engine.ENGINE_RULES.includes(r.k) }));
  for (const k of engine.ENGINE_RULES) if (!m[k]) m[k] = { k, n: k, h: true, on: false, prio: 99, engine: true };
  return m;
}
const onMap = (rules) => Object.fromEntries((rules || []).filter((r) => engine.ENGINE_RULES.includes(r.k)).map((r) => [r.k, !!r.on]));
const cur = (p) => p.revs[p.revs.length - 1];
const decisionsByFp = (p) => Object.fromEntries(Object.values(p.tqs).filter((t) => t.decision && t.status !== 'resolved').map((t) => [t.fp, { ...t.decision, tags: t.decision.tags || t.tags }]));

function scan(id, { rules, hw, reason }) {
  const p = pool.load(id);
  const r = cur(p);
  if (!r) return p;
  const prev = p.revs.length > 1 ? p.revs[p.revs.length - 2] : null;
  const ctx = {
    signals: r.signals, rules: onMap(rules), hw: hw || {}, rev: r.k,
    prev: prev ? prev.signals : null, prevRev: prev ? prev.k : null,
    prevPlacement: prev && prev.alloc ? prev.alloc.pos : null,
    decisions: decisionsByFp(p),
  };
  const findings = runDetectors(ctx);
  pool.reconcile(p, findings, { source: 'scan', rev: r.k, signals: r.signals, reason: reason || 'a re-scan (no longer applies)', ruleMeta: ruleMeta(rules) });
  pool.save(id);
  return p;
}

function nextKey(p) {
  for (let i = 0; i < 26; i++) { const k = String.fromCharCode(65 + i); if (!p.revs.some((r) => r.k === k)) return k; }
  return 'R' + p.revs.length;
}

function commit(id, { uploadId, mappings, include, name, rules, hw, who }) {
  const st = STAGE.get(uploadId);
  if (!st) throw new Error('Upload expired, please upload the file again');
  const { signals, sources } = ingest.build(st.staged, mappings, include);
  if (!signals.length) throw new Error('No signal rows found. Check that the Tag column is mapped and at least one sheet is included');
  const p = pool.load(id);
  const k = nextKey(p);
  p.revs.push({ k, name: name || st.staged.files.map((f) => f.name).join(', '), at: Date.now(), who: who || 'engineer', sources, signals });
  p.audit.unshift({ at: Date.now(), who: who || 'engineer', rev: k, action: 'loaded', label: `Rev ${k}: ${signals.length} rows from ${sources.length} sheet(s)` });
  STAGE.delete(uploadId);
  p.changedAt = Date.now();
  // allocator TQs belong to the previous allocation: resolved now, re-raised on the next allocate
  pool.reconcile(p, [], { source: 'allocator', rev: k, signals, reason: `Rev ${k} (re-checked on the next allocation)`, ruleMeta: ruleMeta(rules), provisional: true });
  return scan(id, { rules, hw, reason: `Rev ${k}` });
}

function dropLastRev(id, { rules, hw, who }) {
  const p = pool.load(id);
  if (p.revs.length < 2) throw new Error('The baseline cannot be removed');
  const r = p.revs.pop();
  p.changedAt = Date.now();
  p.audit.unshift({ at: Date.now(), who: who || 'engineer', rev: r.k, action: 'removed', label: `Rev ${r.k} removed` });
  return scan(id, { rules, hw, reason: `removing Rev ${r.k}` });
}

function decide(id, { fp, opt, who, comment, rules, hw }) {
  const p = pool.load(id);
  const r = cur(p);
  pool.decide(p, fp, opt, who, r ? r.k : '-', comment);
  p.changedAt = Date.now();
  pool.save(id);
  // decisions can change what revision checks see (e.g. a retired decision)
  return scan(id, { rules, hw });
}
function reopen(id, { fp, who }) {
  const p = pool.load(id);
  const r = cur(p);
  pool.reopen(p, fp, who, r ? r.k : '-');
  p.changedAt = Date.now();
  pool.save(id);
  return p;
}

// Exceptions = every decision or default that changes what the engine does, with who/when/which rev.
function exceptionsOf(effs) {
  return effs.filter((e) => e.effect.kind !== 'skip-rows').map((e) => ({
    id: e.id, fp: e.fp, title: e.title, label: e.label, kind: e.effect.kind, who: e.who, at: e.at, rev: e.rev, byDefault: e.byDefault,
  }));
}

function allocateProject(id, { h, rules, hw, who }) {
  scan(id, { rules, hw });
  const p = pool.load(id);
  const r = cur(p);
  if (!r) throw new Error('Load an IO list first');
  const on = onMap(rules), meta = ruleMeta(rules);
  // Data TQs that make placement ambiguous are decided first; the allocator only runs on settled data.
  const early = pool.blocking(p);
  if (early.length) {
    p.audit.unshift({ at: Date.now(), who: who || 'engineer', rev: r.k, action: 'allocation held', label: `${early.length} blocking TQs need a decision` });
    pool.save(id);
    return { blocked: true, blocking: early.map((t) => t.fp), pool: summary(id) };
  }
  let res, dec, effs, key = '';
  for (let i = 0; i < 3; i++) {
    effs = pool.effects(p);
    const k = JSON.stringify(effs.map((e) => [e.fp, e.label]));
    if (k === key) break;
    key = k;
    dec = engine.applyDecisions(r.signals, effs);
    res = engine.allocate(dec.signals, on, h, dec.relax, dec.pins);
    pool.reconcile(p, res.findings, { source: 'allocator', rev: r.k, signals: r.signals, reason: 'the latest allocation (no longer applies)', ruleMeta: meta, applied: new Set(effs.map((e) => e.fp)) });
  }
  const block = pool.blocking(p);
  p.audit.unshift({ at: Date.now(), who: who || 'engineer', rev: r.k, action: block.length ? 'allocation held' : 'allocated', label: block.length ? `${block.length} blocking TQs need a decision` : `${res.stats.signals} signals into ${res.stats.cabinets} cabinets` });
  if (block.length) {
    pool.save(id);
    return { blocked: true, blocking: block.map((t) => t.fp), pool: summary(id) };
  }
  const exceptionsBy = {};
  effs.forEach((e) => {
    const x = e.effect;
    if (x.kind === 'relax') { const k = `${x.rule}:${x.cable !== undefined ? x.cable : x.grp}`; exceptionsBy[k] = (exceptionsBy[k] ? exceptionsBy[k] + ', ' : '') + `${e.id} ${e.who === 'default' ? '(default)' : 'by ' + e.who}`; }
  });
  const pinAck = new Set(Object.values(p.tqs).filter((t) => t.type === 'pin-unsatisfiable' && t.status !== 'resolved').flatMap((t) => t.tags));
  const rawTags = new Set(r.signals.filter((s) => s.tag).map((s) => s.tag));
  const chk = check({ placements: res.placements, H: res.H, spare: res.spare, rules: on, rulesMeta: meta, relax: dec.relax, pins: dec.pins, pinAck, signals: dec.signals, rawTags, unplaced: dec.unplaced, exceptionsBy, hw: hw || {} });
  const costs = engine.ruleCosts(dec.signals, on, h, dec.relax, dec.pins);
  const result = {
    blocked: false, rev: r.k, at: Date.now(), who: who || 'engineer', H: res.H, spare: res.spare, stats: res.stats, ciocs: res.ciocs,
    placements: res.placements, unplaced: dec.unplaced, costs, check: chk, exceptions: exceptionsOf(effs),
  };
  r.alloc = {
    at: result.at, who: result.who, stats: res.stats, check: { violations: chk.violations, accepted: chk.accepted },
    pos: Object.fromEntries(res.placements.map((x) => [x.tag, { cab: x.cab, cioc: x.cioc }])), result,
  };
  pool.save(id);
  return { ...result, pool: summary(id) };
}

// ---------- read models ----------
const FIELDS = ['type', 'cable', 'pair', 'grp', 'seg'];
function diff(prev, curr) {
  const P = new Map(prev.filter((s) => s.tag).map((s) => [s.tag, s]));
  const C = new Map(curr.filter((s) => s.tag).map((s) => [s.tag, s]));
  const added = [], deleted = [], moved = [];
  for (const [t, s] of C) {
    const q = P.get(t);
    if (!q) added.push(t);
    else {
      const ch = FIELDS.filter((f) => String(q[f] ?? '') !== String(s[f] ?? ''));
      if (ch.length) moved.push({ tag: t, detail: ch.map((f) => `${f} ${q[f] || '-'} → ${s[f] || '-'}`).join(', ') });
    }
  }
  for (const t of P.keys()) if (!C.has(t)) deleted.push(t);
  return { added, deleted, moved };
}
function impact(prev, curr) {
  if (!prev.alloc || !curr.alloc) return null;
  let repl = 0;
  const cabs = new Set();
  for (const [t, a] of Object.entries(curr.alloc.pos)) {
    const b = prev.alloc.pos[t];
    if (!b) { cabs.add(a.cab); continue; }
    if (a.cab !== b.cab || a.cioc !== b.cioc) { repl++; cabs.add(a.cab); cabs.add(b.cab); }
  }
  for (const [t, b] of Object.entries(prev.alloc.pos)) if (!curr.alloc.pos[t]) cabs.add(b.cab);
  return { relocated: repl, cabinetsHit: cabs.size };
}

function summary(id) {
  const p = pool.load(id);
  const revs = p.revs.map((r, i) => {
    const prev = i ? p.revs[i - 1] : null;
    const d = prev ? diff(prev.signals, r.signals) : null;
    const types = {};
    const tags = new Set();
    r.signals.forEach((s) => { if (s.tag) tags.add(s.tag); types[s.type || '?'] = (types[s.type || '?'] || 0) + 1; });
    return {
      k: r.k, name: r.name, at: r.at, who: r.who, sources: r.sources, rows: r.signals.length, signals: tags.size, types,
      vs: prev ? prev.k : null,
      diff: d && { added: d.added.length, deleted: d.deleted.length, moved: d.moved.length, list: [...d.added.slice(0, 150).map((t) => ['Added', t, 'new signal']), ...d.deleted.slice(0, 150).map((t) => ['Deleted', t, 'removed']), ...d.moved.slice(0, 200).map((m) => ['Moved', m.tag, m.detail])] },
      impact: prev ? impact(prev, r) : null,
      alloc: r.alloc ? { at: r.alloc.at, stats: r.alloc.stats, check: r.alloc.check } : null,
    };
  });
  const tqs = Object.values(p.tqs).map((t) => ({
    fp: t.fp, id: t.id, type: t.type, sev: t.sev, status: t.status, title: t.title, detail: t.detail, clash: t.clash,
    count: t.count, tags: t.tags.slice(0, 40), options: t.options.map((o) => ({ id: o.id, label: o.label })), def: t.def,
    decision: t.decision && { opt: t.decision.opt, label: t.decision.label, who: t.decision.who, at: t.decision.at, rev: t.decision.rev, comment: t.decision.comment },
    softNote: t.softNote, note: t.note, resolvedBy: t.resolvedBy, firstRev: t.firstRev, lastRev: t.lastRev, source: t.source, history: t.history.length,
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { revs, tqs, exceptions: exceptionsOf(pool.effects(p)), audit: p.audit.slice(0, 200), blocking: pool.blocking(p).length, allocStale: isStale(p) };
}

function lastAllocation(id) {
  const p = pool.load(id);
  const r = cur(p);
  return r && r.alloc ? { ...r.alloc.result, stale: isStale(p) } : null;
}
const isStale = (p) => { const r = cur(p); return !r || !r.alloc || (p.changedAt || 0) > r.alloc.at; };

function exportCsv(id, pat) {
  const p = pool.load(id);
  const r = cur(p);
  if (!r || !r.alloc) throw new Error('Nothing allocated yet');
  const { placements, unplaced, H } = r.alloc.result;
  const bpName = (x) => String(pat || '{c}-CBP-{n}').replace('{c}', String(x.cab + 1).padStart(3, '0')).replace('{n}', x.cioc * H.bc + x.bp + 1);
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [['Tag', 'IO type', 'Cable', 'Pair', 'Group', 'Segregation', 'Cabinet', 'CIOC', 'Baseplate', 'CHARM', 'Status'].join(',')];
  placements.forEach((x) => lines.push([x.tag, x.type, x.cable, x.pair ?? '', x.grp, x.seg, 'MC-' + String(x.cab + 1).padStart(2, '0'), x.cioc + 1, bpName(x), x.ch + 1, x.pinned ? 'Placed (pinned)' : 'Placed'].map(q).join(',')));
  unplaced.forEach((u) => lines.push([u.tag, '', '', '', '', '', '', '', '', '', `Unplaced: ${u.tq} ${u.reason}`].map(q).join(',')));
  return { name: `allocation-rev-${r.k}.csv`, csv: lines.join('\n') };
}

module.exports = { stage, STAGE, scan, commit, dropLastRev, decide, reopen, allocateProject, lastAllocation, summary, exportCsv, ruleMeta, onMap };
