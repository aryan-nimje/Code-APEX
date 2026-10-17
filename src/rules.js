'use strict';
// Custom rule schema. A custom rule is data the engine and checker understand, so a rule drafted
// from plain English (src/llm.js) is enforced exactly like the built-in rules.
//
// Selector (which signals a rule is about); null means "all signals":
//   { field: 'type'|'grp'|'seg'|'cable'|'tag', op: 'in'|'prefix', values: [...], not?: true }
//
// Rule types:
//   separate   { a: Sel, b: Sel, scope: 'cioc'|'baseplate' }      a and b never share a scope
//   exclusive  { a: Sel, scope: 'cioc'|'baseplate' }              a gets its own scopes, nothing else in them
//   limit      { a: Sel|null, max: n, scope: 'baseplate'|'cioc' } at most n matching signals per scope
//   together   { a: Sel|null, by: field|null, scope: 'cioc'|'cabinet' }
//                                                                 matching signals (per value of `by`) share one scope
//   spare      { percent: 1..90 }                                 at least this % of CHARMs per baseplate stay free

const FIELDS = ['type', 'grp', 'seg', 'cable', 'tag'];
const FIELD_LABEL = { type: 'IO type', grp: 'group', seg: 'segregation', cable: 'cable', tag: 'tag' };
const TYPES = {
  separate: ['cioc', 'baseplate'],
  exclusive: ['cioc', 'baseplate'],
  limit: ['baseplate', 'cioc'],
  together: ['cioc', 'cabinet'],
  spare: [],
};

function vSel(x, name, required) {
  if (x === null || x === undefined) {
    if (required) throw new Error(`"${name}" is required`);
    return null;
  }
  if (typeof x !== 'object') throw new Error(`"${name}" must be an object`);
  if (!FIELDS.includes(x.field)) throw new Error(`"${name}.field" must be one of ${FIELDS.join(', ')}`);
  const op = x.op || 'in';
  if (!['in', 'prefix'].includes(op)) throw new Error(`"${name}.op" must be "in" or "prefix"`);
  if (!Array.isArray(x.values) || !x.values.length || x.values.length > 50) throw new Error(`"${name}.values" must list 1 to 50 values`);
  const values = [...new Set(x.values.map((v) => {
    let s = String(v ?? '').trim().toUpperCase();
    if (x.field === 'seg') s = s.replace(/^SEG(REGATION)?\s*/, '');
    if (x.field === 'grp' && /^(NONE|NO GROUP|UNGROUPED|-)$/.test(s)) s = '';
    if (s.length > 40) throw new Error(`"${name}" has a value longer than 40 characters`);
    return s;
  }))];
  if (op === 'prefix' && values.some((v) => !v)) throw new Error(`"${name}" prefix values cannot be empty`);
  return { field: x.field, op, values, ...(x.not ? { not: true } : {}) };
}

// Returns a clean spec or throws a readable error.
function validate(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Rule spec missing');
  const t = spec.type;
  if (!TYPES[t]) throw new Error(`Unknown rule type "${t}"`);
  const scope = () => {
    const s = spec.scope || TYPES[t][0];
    if (!TYPES[t].includes(s)) throw new Error(`Scope for ${t} must be ${TYPES[t].join(' or ')}`);
    return s;
  };
  if (t === 'separate') {
    const a = vSel(spec.a, 'a', true), b = vSel(spec.b, 'b', true);
    if (JSON.stringify(a) === JSON.stringify(b)) throw new Error('"a" and "b" select the same signals');
    return { type: t, a, b, scope: scope() };
  }
  if (t === 'exclusive') return { type: t, a: vSel(spec.a, 'a', true), scope: scope() };
  if (t === 'limit') {
    const max = Math.round(+spec.max);
    if (!(max >= 1 && max <= 1000)) throw new Error('"max" must be 1 to 1000');
    return { type: t, a: vSel(spec.a, 'a', false), max, scope: scope() };
  }
  if (t === 'together') {
    const a = vSel(spec.a, 'a', false);
    const by = spec.by == null || spec.by === '' ? null : spec.by;
    if (by !== null && !FIELDS.includes(by)) throw new Error(`"by" must be one of ${FIELDS.join(', ')}`);
    if (!a && !by) throw new Error('"together" needs "a", "by" or both');
    return { type: t, a, by, scope: scope() };
  }
  const percent = Math.round(+spec.percent);
  if (!(percent >= 1 && percent <= 90)) throw new Error('"percent" must be 1 to 90');
  return { type: 'spare', percent };
}
const isValid = (spec) => { try { validate(spec); return true; } catch (e) { return false; } };

// Selector -> predicate over a signal or placement (both carry type, grp, seg, cable, tag).
function pred(sel) {
  if (!sel) return () => true;
  const vs = sel.values;
  const get = (s) => String(s[sel.field] ?? '').toUpperCase();
  const f = sel.op === 'prefix' ? (s) => vs.some((v) => get(s).startsWith(v)) : (s) => vs.includes(get(s));
  return sel.not ? (s) => !f(s) : f;
}

// Compile active custom rules for the engine and checker.
function compile(rules) {
  const out = [];
  for (const r of rules || []) {
    if (!r || !r.on || r.draft || !r.spec) continue;
    let spec;
    try { spec = validate(r.spec); } catch (e) { continue; }
    const c = { id: r.k, name: r.n, ...spec };
    if (spec.type === 'separate') { c.A = pred(spec.a); c.B = pred(spec.b); }
    else if (spec.type === 'exclusive') { c.A = pred(spec.a); const A = c.A; c.B = (s) => !A(s); }
    else if (spec.type === 'limit' || spec.type === 'together') c.A = pred(spec.a);
    out.push(c);
  }
  return out;
}
const spareCount = (pc, percent) => Math.min(pc - 1, Math.max(1, Math.round((pc * percent) / 100)));

function selText(sel) {
  if (!sel) return 'all signals';
  const vs = sel.values.map((v) => (v === '' ? '(none)' : v));
  const list = vs.length > 1 ? vs.slice(0, -1).join(', ') + ' or ' + vs[vs.length - 1] : vs[0];
  let t;
  if (sel.op === 'prefix') t = `signals whose ${FIELD_LABEL[sel.field]} starts with ${list}`;
  else t = { type: `${list} signals`, grp: `signals in group ${list}`, seg: `Seg ${list} signals`, cable: `signals on cable ${list}`, tag: `signals tagged ${list}` }[sel.field];
  return sel.not ? `signals other than ${t}` : t;
}
function explain(spec) {
  const s = validate(spec);
  const sc = { cioc: 'CIOC', baseplate: 'baseplate', cabinet: 'cabinet' }[s.scope];
  if (s.type === 'separate') return `${cap(selText(s.a))} and ${selText(s.b)} are never placed in the same ${sc}.`;
  if (s.type === 'exclusive') return `${cap(selText(s.a))} get ${sc}s of their own; no other signal shares them.`;
  if (s.type === 'limit') return `At most ${s.max} ${s.a ? selText(s.a) : 'signals'} per ${sc}.`;
  if (s.type === 'together') {
    if (s.by) return `For each ${FIELD_LABEL[s.by]}, its ${s.a ? selText(s.a) : 'signals'} are kept in one ${sc}.`;
    return `All ${selText(s.a)} are kept in one ${sc}.`;
  }
  return `At least ${s.percent}% of the CHARMs on every baseplate stay free (rounded, minimum 1).`;
}
const cap = (x) => x[0].toUpperCase() + x.slice(1);

module.exports = { FIELDS, TYPES, validate, isValid, pred, compile, spareCount, explain };
