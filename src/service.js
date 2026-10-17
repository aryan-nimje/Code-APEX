'use strict';
const crypto = require('crypto');
const ingest = require('./ingest');
const pool = require('./pool');
const { runDetectors } = require('./detectors');
const engine = require('./engine');
const { check } = require('./checker');
const RU = require('./rules');
const coderules = require('./coderules');
const llm = require('./llm');

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
  (rules || []).filter((r) => !r.draft).forEach((r, i) => (m[r.k] = { k: r.k, n: r.n, h: !!r.h, on: !!r.on, prio: i, engine: engine.ENGINE_RULES.includes(r.k) || RU.isValid(r.spec) || isCode(r), code: isCode(r) }));
  for (const k of engine.ENGINE_RULES) if (!m[k]) m[k] = { k, n: k, h: true, on: false, prio: 99, engine: true };
  return m;
}
const isCode = (r) => { if (!r || !r.code) return false; try { coderules.screen(r.code); return true; } catch (e) { return false; } };
const codeRulesOf = (rules) => (rules || []).filter((r) => r.on && !r.draft && !r.spec && isCode(r));
const customsOf = (rules) => (rules || []).filter((r) => !engine.ENGINE_RULES.includes(r.k) && r.on && !r.draft && RU.isValid(r.spec));
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

// Effects that remove a problem by themselves: a decided TQ with one of these stays decided when its
// finding disappears (the decision is why it disappeared).
const SUPPRESS = new Set(['exclude', 'relax', 'manual', 'merge', 'override', 'pin']);

// TQs from user-added rules have no rule-specific fixes; they all get the same generic options.
function generic(f, meta) {
  const rid = (f.rules || [])[0];
  if (!rid || engine.ENGINE_RULES.includes(rid) || !meta[rid]) return f;
  const name = meta[rid].n, n = f.tags.length;
  const rel = f.options.find((o) => o.effect.kind === 'relax' && o.effect.rule === rid);
  const relax = rel ? rel.effect : { kind: 'relax', rule: rid, tags: f.tags };
  f.options = [
    { id: 'manual', label: `Place ${n === 1 ? 'this signal' : `these ${n} signals`} manually`, effect: { kind: 'manual', tags: f.tags } },
    { id: 'accept', label: 'Accept the break here and log it as an exception', effect: relax },
    { id: 'excl', label: 'Leave unplaced until clarified', effect: { kind: 'exclude', tags: f.tags } },
    { id: 'soft', label: `Make "${name}" soft (accepts this break)`, effect: { ...relax, then: 'soft' } },
    { id: 'off', label: `Turn "${name}" off`, effect: { kind: 'rule-off', rule: rid } },
  ];
  f.custom = rid;
  f.def = null;
  return f;
}

// Generated-code rules: run each rule's check() on the placements; every violation becomes a TQ.
const short = (x) => crypto.createHash('sha1').update(x).digest('hex').slice(0, 8);
function codeFindings(results, codeRules, placed, manual) {
  const out = [];
  for (const cr of results) {
    const rule = codeRules.find((r) => r.k === cr.id);
    if (!rule) continue;
    if (cr.error) {
      out.push({ type: 'code-rule-error', key: cr.id, sev: 'warn', rules: [], title: `"${rule.n}" could not run`, detail: `Its generated code failed: ${cr.error}. The rule is not being checked.`, clash: rule.n, tags: [],
        options: [{ id: 'ack', label: 'Acknowledge (rule stays unchecked)', effect: { kind: 'accept' } }, { id: 'off', label: `Turn "${rule.n}" off`, effect: { kind: 'rule-off', rule: rule.k } }], def: 'ack' });
      continue;
    }
    // a break involving a hand-placed signal was the engineer's choice (seen in the preview): no TQ
    const vs = cr.violations.filter((v) => !v.tags.some((t) => manual && manual[t])).map((v) => ({ ...v, tags: [...new Set(v.tags.filter((t) => placed.has(t)))].sort() })).filter((v) => v.tags.length);
    const mk = (key, title, detail, tags) => ({ type: 'code-rule', key, sev: 'block', rules: [rule.k], title, detail, clash: rule.n, tags, options: [] });
    vs.slice(0, 30).forEach((v) => out.push(mk(`${rule.k}:${short(v.tags.join(','))}`, `${rule.n}: ${v.message}`, `Flagged by the rule's code: ${v.tags.slice(0, 8).join(', ')}${v.tags.length > 8 ? ` and ${v.tags.length - 8} more` : ''}.`, v.tags)));
    if (vs.length > 30) {
      const rest = [...new Set(vs.slice(30).flatMap((v) => v.tags))];
      out.push(mk(`${rule.k}:more`, `${rule.n}: ${vs.length - 30} more violations`, `Too many to list one by one (${rest.length} signals). Turning the rule off or making it soft may be the realistic choice.`, rest));
    }
  }
  return out;
}

function exceptionsIndex(effs) {
  const ix = {};
  effs.forEach((e) => {
    const x = e.effect;
    if (x.kind !== 'relax') return;
    const keys = x.tags ? x.tags : [x.cable !== undefined ? x.cable : x.grp !== undefined ? x.grp : x.key];
    keys.forEach((v) => { const k = `${x.rule}:${v}`; ix[k] = (ix[k] ? ix[k] + ', ' : '') + `${e.id} ${e.who === 'default' ? '(default)' : 'by ' + e.who}`; });
  });
  return ix;
}

// Runs the independent checker (and the code rules' own checks) on a set of placements.
async function evaluate(p, r, ctx, placements, dec, res, effs) {
  const { on, meta, cust, code, hw } = ctx;
  const codeRes = code.length ? await coderules.run(code.map((x) => ({ id: x.k, code: x.code })), placements, res.H) : [];
  const pinAck = new Set(Object.values(p.tqs).filter((t) => t.type === 'pin-unsatisfiable' && t.status !== 'resolved').flatMap((t) => t.tags));
  const rawTags = new Set(r.signals.filter((s) => s.tag).map((s) => s.tag));
  const chk = check({
    placements, H: res.H, spare: res.spare, rules: on, rulesMeta: meta, relax: dec.relax, pins: dec.pins, pinAck, signals: dec.signals,
    rawTags, unplaced: dec.unplaced, exceptionsBy: exceptionsIndex(effs), hw: hw || {}, customs: cust.map((x) => ({ id: x.k, name: x.n, spec: x.spec })),
    codeResults: codeRes.map((x) => ({ ...x, name: (code.find((c) => c.k === x.id) || {}).n })),
    gapAllow: gapsOf(r, dec, placements),
  });
  return { chk, codeRes };
}

// pairs per cable that are not placed (unplaced by decision, or waiting for manual placement)
function gapsOf(r, dec, placements) {
  const placed = new Set(placements.map((x) => x.tag)), cab = new Map(r.signals.map((x) => [x.tag, x.cable])), out = {};
  for (const u of dec.unplaced) { const c = cab.get(u.tag); if (c && !placed.has(u.tag)) out[c] = (out[c] || 0) + 1; }
  return out;
}

function context(rules, hw) {
  return { on: onMap(rules), meta: ruleMeta(rules), cust: customsOf(rules), code: codeRulesOf(rules), hw };
}

async function allocateProject(id, { h, rules, hw, who }) {
  scan(id, { rules, hw });
  const p = pool.load(id);
  const r = cur(p);
  if (!r) throw new Error('Load an IO list first');
  const ctx = context(rules, hw), { on, meta, cust, code } = ctx, compiled = RU.compile(cust);
  // Data TQs that make placement ambiguous are decided first; the allocator only runs on settled data.
  const early = pool.blocking(p);
  if (early.length) {
    p.audit.unshift({ at: Date.now(), who: who || 'engineer', rev: r.k, action: 'allocation held', label: `${early.length} blocking TQs need a decision` });
    pool.save(id);
    return { blocked: true, blocking: early.map((t) => t.fp), pool: summary(id) };
  }
  p.manual = p.manual || {};
  // Same revision + same rules/hierarchy/lookup as the last run: keep signals in their previous slots.
  const lkey = short(JSON.stringify([on, engine.hier(h), cust.map((x) => [x.k, x.spec, !!x.h]), code.map((x) => [x.k, x.code]), Object.keys(hw || {}).sort()]));
  let prev = r.layout && r.layout.key === lkey ? r.layout.pos : null;
  let res, dec, effs, key = '', codeRes = [];
  for (let i = 0; i < 4; i++) {
    effs = pool.effects(p);
    const k = JSON.stringify(effs.map((e) => [e.fp, e.label]));
    if (k === key) break;
    key = k;
    dec = engine.applyDecisions(r.signals, effs, p.manual);
    res = engine.allocate(dec.signals, on, h, dec.relax, dec.pins, compiled, dec.manual, prev);
    prev = Object.fromEntries(res.placements.map((x) => [x.tag, { cab: x.cab, cioc: x.cioc, bp: x.bp, ch: x.ch }]));
    codeRes = code.length ? await coderules.run(code.map((x) => ({ id: x.k, code: x.code })), res.placements, res.H) : [];
    const findings = res.findings.concat(codeFindings(codeRes, code, new Set(res.placements.map((x) => x.tag)), dec.manual)).map((f) => generic(f, meta));
    pool.reconcile(p, findings, { source: 'allocator', rev: r.k, signals: r.signals, reason: 'the latest allocation (no longer applies)', ruleMeta: meta, applied: new Set(effs.filter((e) => SUPPRESS.has(e.effect.kind)).map((e) => e.fp)) });
  }
  r.layout = { key: lkey, pos: prev };
  const block = pool.blocking(p);
  p.audit.unshift({ at: Date.now(), who: who || 'engineer', rev: r.k, action: block.length ? 'allocation held' : 'allocated', label: block.length ? `${block.length} blocking TQs need a decision` : `${res.stats.signals} signals into ${res.stats.cabinets} cabinets` });
  if (block.length) {
    pool.save(id);
    return { blocked: true, blocking: block.map((t) => t.fp), pool: summary(id) };
  }
  const { chk } = await evaluate(p, r, ctx, res.placements, dec, res, effs);
  const costs = engine.ruleCosts(dec.signals, on, h, dec.relax, dec.pins, compiled, dec.manual);
  const result = {
    blocked: false, rev: r.k, at: Date.now(), who: who || 'engineer', H: res.H, spare: res.spare, stats: res.stats, ciocs: res.ciocs,
    placements: res.placements, unplaced: dec.unplaced, costs, check: chk, exceptions: exceptionsOf(effs),
    manualQueue: dec.queue.map((s) => ({ tag: s.tag, type: s.type, grp: s.grp, seg: s.seg, cable: s.cable, pair: s.pair, tq: s.tq, tqTitle: s.tqTitle })),
    manualPlaced: Object.keys(dec.manual).map((t) => ({ tag: t, ...p.manual[t] })),
  };
  r.alloc = {
    at: result.at, who: result.who, stats: res.stats, check: { violations: chk.violations, accepted: chk.accepted },
    pos: Object.fromEntries(res.placements.map((x) => [x.tag, { cab: x.cab, cioc: x.cioc }])), result,
  };
  pool.save(id);
  return { ...result, pool: summary(id) };
}

// ---------- manual placement ----------
function slotOf(H, pos) {
  const g = (v) => Math.round(+v);
  const q = { cab: g(pos.cab), cioc: g(pos.cioc), bp: g(pos.bp), ch: g(pos.ch) };
  if (![q.cab, q.cioc, q.bp, q.ch].every(Number.isFinite) || q.cab < 0 || q.cab > 999 || q.cioc < 0 || q.cioc >= H.cc || q.bp < 0 || q.bp >= H.bc || q.ch < 0 || q.ch >= H.pc) throw new Error('That slot is outside the cabinet hierarchy');
  return q;
}
function manualSetup(id, tag) {
  const p = pool.load(id), r = cur(p);
  const res = r && r.alloc && r.alloc.result;
  if (!res) throw new Error('Allocate first');
  const inQueue = (res.manualQueue || []).find((x) => x.tag === tag), placed = (res.manualPlaced || []).find((x) => x.tag === tag);
  if (!inQueue && !placed) throw new Error(`${tag} is not waiting for manual placement`);
  return { p, r, res };
}
// What would placing `tag` at `pos` break? Compares the checker with and without the candidate.
async function manualCheck(id, { tag, pos, rules, hw }) {
  const { p, r, res } = manualSetup(id, tag);
  const q = slotOf(res.H, pos);
  const taken = res.placements.find((x) => x.tag !== tag && x.cab === q.cab && x.cioc === q.cioc && x.bp === q.bp && x.ch === q.ch);
  if (taken) return { ok: false, reason: `That CHARM is used by ${taken.tag}` };
  const ctx = context(rules, hw), effs = pool.effects(p);
  const dec = engine.applyDecisions(r.signals, effs, p.manual);
  const sig = r.signals.find((s) => s.tag === tag) || {};
  const sp = q.ch >= res.H.pc - res.spare;
  const others = res.placements.filter((x) => x.tag !== tag);
  const cand = others.concat({ tag, type: sig.type, grp: sig.grp, seg: sig.seg, cable: sig.cable, pair: sig.pair, ...q, manual: false });
  const decC = { ...dec, signals: dec.signals.concat(dec.queue.filter((s) => s.tag === tag)), unplaced: dec.unplaced.filter((u) => u.tag !== tag) };
  const decB = { ...dec, signals: dec.signals.filter((s) => s.tag !== tag), unplaced: dec.unplaced.filter((u) => u.tag !== tag).concat({ tag, tq: '-', reason: 'candidate' }) };
  const [before, after] = await Promise.all([evaluate(p, r, ctx, others, decB, res, effs), evaluate(p, r, ctx, cand, decC, res, effs)]);
  const seen = new Set(before.chk.results.flatMap((x) => x.violations.map((v) => x.key + '|' + v)));
  const breaks = after.chk.results.flatMap((x) => x.violations.filter((v) => !seen.has(x.key + '|' + v)).map((v) => ({ rule: x.name, msg: v })));
  return { ok: true, breaks, spare: sp };
}
async function manualPlace(id, { tag, pos, rules, hw, h, who }) {
  const { p, r, res } = manualSetup(id, tag);
  const q = slotOf(res.H, pos);
  const taken = res.placements.find((x) => x.tag !== tag && x.cab === q.cab && x.cioc === q.cioc && x.bp === q.bp && x.ch === q.ch);
  if (taken) throw new Error(`That CHARM is used by ${taken.tag}`);
  p.manual = p.manual || {};
  p.manual[tag] = { ...q, who: who || 'engineer', at: Date.now(), rev: r.k };
  p.changedAt = Date.now();
  p.audit.unshift({ at: Date.now(), who: who || 'engineer', rev: r.k, action: 'placed manually', label: `${tag} at MC-${String(q.cab + 1).padStart(2, '0')} CIOC ${q.cioc + 1} BP ${q.bp + 1} CHARM ${q.ch + 1}` });
  pool.save(id);
  return allocateProject(id, { h, rules, hw, who });
}
async function manualRemove(id, { tag, rules, hw, h, who }) {
  const p = pool.load(id), r = cur(p);
  if (!p.manual || !p.manual[tag]) throw new Error(`${tag} has no manual placement`);
  delete p.manual[tag];
  p.changedAt = Date.now();
  p.audit.unshift({ at: Date.now(), who: who || 'engineer', rev: r ? r.k : '-', action: 'manual placement removed', label: `${tag} back in the manual queue` });
  pool.save(id);
  return allocateProject(id, { h, rules, hw, who });
}

// ---------- LLM hint for a user-rule TQ (a pointer, never applied) ----------
async function hint(id, { fp, rules, h }) {
  const p = pool.load(id), r = cur(p);
  const t = p.tqs[fp];
  if (!t || !t.custom) throw new Error('Hints are only for TQs raised by user-added rules');
  const rule = (rules || []).find((x) => x.k === t.custom) || {};
  const sig = new Map((r ? r.signals : []).map((s) => [s.tag, s]));
  const mix = {};
  t.tags.forEach((tg) => { const s = sig.get(tg); if (s) { const k = `${s.type || '?'} in ${s.grp || 'no group'}`; mix[k] = (mix[k] || 0) + 1; } });
  const text = await llm.hint({
    h: h || { cc: 4, bc: 8, pc: 12 },
    rule: { name: rule.n || t.clash, description: rule.d || '', definition: rule.spec ? RU.explain(rule.spec) : rule.summary || '' },
    tq: { title: t.title, signals: t.tags.length, mix },
    options: t.options.map((o) => o.label),
  });
  t.hint = { text, at: Date.now() };
  pool.save(id);
  return summary(id);
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
    count: t.count, tags: t.tags.slice(0, 40), options: t.options.map((o) => ({ id: o.id, label: o.label, act: o.effect.then === 'soft' ? 'soft' : o.effect.kind === 'rule-off' ? 'off' : null, rule: o.effect.rule || null })), def: t.def, custom: t.custom || null, hint: t.hint || null,
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
  placements.forEach((x) => lines.push([x.tag, x.type, x.cable, x.pair ?? '', x.grp, x.seg, 'MC-' + String(x.cab + 1).padStart(2, '0'), x.cioc + 1, bpName(x), x.ch + 1, x.manual ? 'Placed manually' : x.pinned ? 'Placed (pinned)' : 'Placed'].map(q).join(',')));
  unplaced.forEach((u) => lines.push([u.tag, '', '', '', '', '', '', '', '', '', u.pending ? `Awaiting manual placement (${u.tq})` : `Unplaced: ${u.tq} ${u.reason}`].map(q).join(',')));
  return { name: `allocation-rev-${r.k}.csv`, csv: lines.join('\n') };
}

module.exports = { stage, STAGE, scan, commit, dropLastRev, decide, reopen, allocateProject, lastAllocation, summary, exportCsv, ruleMeta, onMap, manualCheck, manualPlace, manualRemove, hint, codeRulesOf };
