'use strict';
// The data pool for one project: revisions (real signals), TQs, decisions and the audit log.
// Stored as data/pool/<projectId>.json. Swap for a database (or S3) later; only load/save touch disk.
//
// TQ lifecycle
//   open      raised, no decision yet (warnings proceed with their default option)
//   decided   a decision is in force and feeds the engine
//   review    decided, but the affected signals changed since; blocking TQs must be re-confirmed
//   resolved  the problem no longer exists (fixed by a revision, or no longer applies to the rules)
// A resolved TQ that comes back reopens. If its signals are exactly as they were when it was
// decided, the earlier decision is restored instead of asking again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pool');
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const fileOf = (id) => {
  if (!SAFE.test(id)) throw new Error('bad project id');
  return path.join(DIR, id + '.json');
};
const empty = () => ({ revs: [], tqs: {}, audit: [], seq: 0 });
const cache = new Map();

function load(id) {
  if (cache.has(id)) return cache.get(id);
  let p;
  try {
    p = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch (e) {
    p = empty();
  }
  cache.set(id, p);
  return p;
}
function save(id) {
  fs.mkdirSync(DIR, { recursive: true });
  const f = fileOf(id), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache.get(id) || empty()));
  fs.renameSync(tmp, f);
}
function remove(id) {
  cache.delete(id);
  try { fs.unlinkSync(fileOf(id)); } catch (e) { /* not there */ }
}
function copy(from, to) {
  const src = load(from);
  cache.set(to, JSON.parse(JSON.stringify(src)));
  save(to);
}

const fpOf = (f) => `${f.type}:${f.key}`;
// Signature of the data a TQ is about: changes when any affected signal changes.
function sigOf(f, signals) {
  const tags = new Set(f.tags || []);
  const rows = signals
    .filter((s) => tags.has(s.tag) || (f.rows && f.rows.includes(s.i)))
    .map((s) => [s.tag, s.type, s.cable, s.pair, s.grp, s.seg, s.size].join('|'))
    .sort();
  return crypto.createHash('sha1').update(f.type + '#' + rows.join('\n')).digest('hex').slice(0, 12);
}

// Soft rules: a clash involving a soft rule becomes a warning whose default relaxes the
// lowest-priority soft rule involved ("Continue anyway").
function applyStrength(f, ruleMeta) {
  if (!f.rules || !f.rules.length) return f;
  const soft = f.rules.filter((k) => ruleMeta[k] && !ruleMeta[k].h).sort((a, b) => ruleMeta[b].prio - ruleMeta[a].prio);
  if (!soft.length) return f;
  const opt = f.options.find((o) => o.effect.kind === 'relax' && o.effect.rule === soft[0]);
  if (opt) { f.sev = 'warn'; f.def = opt.id; f.softNote = `Soft rule, so the default relaxes "${ruleMeta[soft[0]].n}"`; }
  return f;
}

// Merge a fresh set of findings from one source ('scan' or 'allocator') into the pool.
// provisional: resolve for now, but if it comes back keep the earlier decision (flagged if the data changed).
// applied:     fps whose decision the engine applied in this run; a decided TQ that is unseen only because
//              its own decision removed the problem (e.g. excluded signals) stays decided.
function reconcile(pool, findings, { source, rev, signals, reason, ruleMeta, provisional, applied }) {
  const seen = new Set();
  const now = Date.now();
  for (const f0 of findings) {
    const f = applyStrength({ ...f0 }, ruleMeta || {});
    const fp = fpOf(f);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const sig = sigOf(f, signals);
    let t = pool.tqs[fp];
    if (!t) {
      pool.seq += 1;
      t = pool.tqs[fp] = { fp, id: 'TQ-' + String(pool.seq).padStart(3, '0'), status: 'open', firstRev: rev, decision: null, history: [], raisedAt: now };
      pool.audit.unshift({ at: now, who: 'system', rev, fp, id: t.id, action: 'raised', label: f.title });
    }
    Object.assign(t, {
      type: f.type, key: f.key, sev: f.sev, title: f.title, detail: f.detail, clash: f.clash,
      tags: f.tags || [], count: (f.tags || []).length || (f.rows || []).length, options: f.options, def: f.def || null,
      softNote: f.softNote || null, source, sig, lastRev: rev,
    });
    if (t.status === 'resolved') {
      if (t.provisional && t.lastDecision && t.lastDecision.sig !== sig) {
        t.status = 'review'; t.decision = t.lastDecision; t.lastDecision = null;
        t.note = `Raised again in Rev ${rev} and its signals changed. Check the earlier decision still holds.`;
      } else if (t.lastDecision && t.lastDecision.sig === sig) {
        t.status = 'decided'; t.decision = t.lastDecision; t.lastDecision = null;
        t.note = `Came back in Rev ${rev} with the same signals; earlier decision restored.`;
      } else {
        t.status = 'open'; t.decision = null;
        t.note = `Reopened in Rev ${rev}: the problem is back.`;
      }
      t.resolvedBy = null; t.provisional = false;
      pool.audit.unshift({ at: now, who: 'system', rev, fp, id: t.id, action: { open: 'reopened', review: 'flagged for review' }[t.status] || 'restored', label: t.note });
    } else if (t.status === 'decided' && t.decision && t.decision.sig !== sig) {
      t.status = 'review';
      t.note = `Signals changed in Rev ${rev} after this was decided. Check the decision still holds.`;
      pool.audit.unshift({ at: now, who: 'system', rev, fp, id: t.id, action: 'flagged for review', label: t.note });
    } else if (t.status === 'review' && t.decision && t.decision.sig === sig) {
      t.status = 'decided'; t.note = null;
    }
    // A decision whose option no longer exists (e.g. a tag dropped out) must be re-made.
    if (t.decision && !t.options.some((o) => o.id === t.decision.opt) && t.status !== 'open') {
      t.status = 'review';
      t.note = 'The option chosen earlier no longer applies. Choose again.';
    }
  }
  for (const t of Object.values(pool.tqs)) {
    if (t.source !== source || seen.has(t.fp) || t.status === 'resolved') continue;
    if (applied && applied.has(t.fp) && t.status === 'decided') continue;
    t.lastDecision = t.decision; t.decision = null;
    t.status = 'resolved'; t.resolvedBy = reason || `Rev ${rev}`; t.note = null; t.provisional = !!provisional;
    pool.audit.unshift({ at: now, who: 'system', rev, fp: t.fp, id: t.id, action: 'resolved', label: `Resolved by ${t.resolvedBy}` });
  }
  pool.audit = pool.audit.slice(0, 2000);
}

function decide(pool, fp, optId, who, rev, comment) {
  const t = pool.tqs[fp];
  if (!t) throw new Error('unknown TQ');
  if (t.status === 'resolved') throw new Error('TQ is already resolved');
  const o = t.options.find((x) => x.id === optId);
  if (!o) throw new Error('unknown option');
  const now = Date.now();
  if (t.decision) t.history.push(t.decision);
  t.decision = { opt: o.id, label: o.label, effect: o.effect, who: who || 'engineer', at: now, rev, sig: t.sig, tags: t.tags.slice(), comment: comment || '' };
  t.status = 'decided'; t.note = null;
  pool.audit.unshift({ at: now, who: t.decision.who, rev, fp, id: t.id, action: 'decided', label: o.label, comment: comment || '' });
  // "Retire" acts on another TQ's decision.
  if (o.effect.kind === 'retire' && pool.tqs[o.effect.fp]) {
    const x = pool.tqs[o.effect.fp];
    if (x.decision) x.history.push(x.decision);
    x.decision = null;
    if (x.status !== 'resolved') x.status = 'open';
    pool.audit.unshift({ at: now, who: t.decision.who, rev, fp: x.fp, id: x.id, action: 'decision retired', label: `Retired via ${t.id}` });
  }
}

function reopen(pool, fp, who, rev) {
  const t = pool.tqs[fp];
  if (!t) throw new Error('unknown TQ');
  if (t.decision) t.history.push(t.decision);
  t.decision = null;
  t.status = 'open';
  pool.audit.unshift({ at: Date.now(), who: who || 'engineer', rev, fp, id: t.id, action: 'reopened', label: 'Decision withdrawn' });
}

const active = (pool) => Object.values(pool.tqs).filter((t) => t.status !== 'resolved');
// Blocking = makes placement ambiguous: open or under review, severity block.
const blocking = (pool) => active(pool).filter((t) => t.sev === 'block' && (t.status === 'open' || t.status === 'review'));

// The effects the engine should apply, with who/why for the exceptions log.
function effects(pool) {
  const out = [];
  for (const t of active(pool)) {
    if (t.decision && (t.status === 'decided' || (t.status === 'review' && t.sev === 'warn'))) {
      out.push({ fp: t.fp, id: t.id, title: t.title, label: t.decision.label, effect: t.decision.effect, who: t.decision.who, at: t.decision.at, rev: t.decision.rev, byDefault: false });
    } else if (t.status === 'open' && t.sev === 'warn' && t.def) {
      const o = t.options.find((x) => x.id === t.def);
      if (o) out.push({ fp: t.fp, id: t.id, title: t.title, label: o.label, effect: o.effect, who: 'default', at: null, rev: null, byDefault: true });
    }
  }
  return out;
}

module.exports = { load, save, remove, copy, reconcile, decide, reopen, active, blocking, effects, fpOf, SAFE };
