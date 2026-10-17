'use strict';
const RU = require('./rules');
// Independent checker. It does not reuse any allocator logic: it starts from the final
// placements and re-verifies every active rule. A rule break is either
//   an accepted exception  (covered by a logged decision, e.g. "relax A/B for CBL-207"), or
//   a violation            (nobody decided it; this is what must be zero).

const grpOf = (p) => p.grp || '';
const by = (arr, fn) => arr.reduce((m, x) => ((m[fn(x)] = m[fn(x)] || []).push(x), m), {});
const ciocKey = (p) => `${p.cab}/${p.cioc}`;
const cabLabel = (c) => 'MC-' + String(c + 1).padStart(2, '0');
const label = (k) => { const [c, i] = k.split('/').map(Number); return `MC-${String(c + 1).padStart(2, '0')} CIOC ${i + 1}`; };

// A break that involves a manually placed signal is the engineer's own call: an accepted exception.
const manualOf = (ps) => { const p = ps.find((x) => x.manual); return p ? `manual placement of ${p.tag}` : ''; };

// gapAllow: { cable: n } pairs of that cable that are unplaced or awaiting manual placement; their empty
// CHARMs may stay inside the cable's run.
function check({ placements, H, spare, rules, rulesMeta, relax, pins, pinAck, signals, rawTags, unplaced, exceptionsBy, hw, customs, codeResults, gapAllow }) {
  const results = [];
  const add = (key, name, checked, violations, accepted, note) =>
    results.push({ key, name, checked, violations, accepted: accepted || [], status: violations.length ? 'fail' : accepted && accepted.length ? 'accepted' : 'pass', note: note || '' });
  const byC = by(placements, ciocKey);
  const relaxBy = (rule, k) => exceptionsBy[`${rule}:${k}`];

  // capacity and slot uniqueness
  {
    const v = [];
    const seen = new Map();
    placements.forEach((p) => {
      if (p.cioc >= H.cc || p.bp >= H.bc || p.ch >= H.pc || p.cioc < 0 || p.bp < 0 || p.ch < 0) v.push(`${p.tag} is outside the hierarchy (${label(ciocKey(p))} BP ${p.bp + 1} CH ${p.ch + 1})`);
      const s = `${p.cab}/${p.cioc}/${p.bp}/${p.ch}`;
      if (seen.has(s)) v.push(`${p.tag} and ${seen.get(s)} share ${label(ciocKey(p))} BP ${p.bp + 1} CHARM ${p.ch + 1}`);
      else seen.set(s, p.tag);
    });
    add('capacity', 'Hierarchy capacity, one signal per CHARM', placements.length, v);
  }

  // completeness: every tagged signal is placed exactly once, or covered by a TQ decision
  {
    const v = [];
    const placed = by(placements, (p) => p.tag);
    Object.entries(placed).forEach(([t, ps]) => ps.length > 1 && v.push(`${t} is placed ${ps.length} times`));
    const out = new Set(unplaced.map((u) => u.tag));
    const eff = new Set(signals.map((s) => s.tag));
    for (const t of eff) if (!placed[t] && !out.has(t)) v.push(`${t} is neither placed nor covered by a TQ`);
    for (const t of rawTags) if (!eff.has(t) && !out.has(t)) v.push(`${t} disappeared without a decision`);
    const acc = unplaced.map((u) => `${u.tag} left unplaced: ${u.tq} · ${u.reason}`);
    add('complete', 'Every signal placed or TQ’d', rawTags.size, v, acc);
  }

  // hardware: every placed IO type has a CHARM in the lookup
  {
    const v = placements.filter((p) => !hw[p.type]).map((p) => `${p.tag} has IO type "${p.type || '(blank)'}" with no CHARM mapping`);
    add('hw', 'Right CHARM for every IO type', placements.length, v);
  }

  if (rules.ab) {
    const v = [], a = [];
    for (const [k, ps] of Object.entries(byC)) {
      for (const [g, gp] of Object.entries(by(ps, grpOf))) {
        const A = gp.filter((p) => p.seg === 'A'), B = gp.filter((p) => p.seg === 'B');
        if (!A.length || !B.length) continue;
        // allowed only if a cable carrying both A and B of this group was relaxed for A/B
        const ok = Object.entries(by(gp.filter((p) => p.cable), (p) => p.cable))
          .find(([c, cp]) => relax.ab.has(c) && cp.some((p) => p.seg === 'A') && cp.some((p) => p.seg === 'B'));
        const msg = `${label(k)} holds ${g || 'No group'} Seg A (${A.length}) and Seg B (${B.length})`;
        const mn = manualOf([...A, ...B]);
        ok ? a.push(`${msg} · ${relaxBy('ab', ok[0]) || 'relaxed'}`) : mn ? a.push(`${msg} · ${mn}`) : v.push(msg);
      }
    }
    add('ab', rulesMeta.ab.n, placements.length, v, a);
  }

  if (rules.group) {
    const v = [], a = [];
    for (const [k, ps] of Object.entries(byC)) {
      const gs = [...new Set(ps.map(grpOf))];
      if (gs.length < 2) continue;
      const ok = Object.entries(by(ps.filter((p) => p.cable), (p) => p.cable))
        .find(([c, cp]) => relax.group.has(c) && gs.every((g) => cp.some((p) => grpOf(p) === g)));
      const msg = `${label(k)} mixes groups ${gs.map((g) => g || 'No group').join(', ')}`;
      const mn = manualOf(ps);
      ok ? a.push(`${msg} · ${relaxBy('group', ok[0]) || 'relaxed'}`) : mn ? a.push(`${msg} · ${mn}`) : v.push(msg);
    }
    add('group', rulesMeta.group.n, placements.length, v, a);
  }

  if (rules.spare) {
    const v = [], a = [];
    const lim = H.pc - spare;
    for (const [k, ps] of Object.entries(by(placements, (p) => `${p.cab}/${p.cioc}/${p.bp}`))) {
      if (ps.length <= lim) continue;
      const [c, i, b] = k.split('/').map(Number), msg = `${label(c + '/' + i)} BP ${b + 1} uses ${ps.length} of ${H.pc} CHARMs, leaving fewer than ${spare} spare`;
      const mn = manualOf(ps);
      mn ? a.push(`${msg} · ${mn}`) : v.push(msg);
    }
    add('spare', rulesMeta.spare.n, placements.length, v, a);
  }

  if (rules.cable) {
    const v = [], a = [];
    for (const [c, ps] of Object.entries(by(placements.filter((p) => p.cable), (p) => p.cable))) {
      const cs = [...new Set(ps.map(ciocKey))];
      let bad = '';
      if (cs.length > 1) bad = `${c} is split over ${cs.map(label).join(', ')}`;
      else {
        // consecutive CHARMs, skipping only reserved spare CHARMs at the end of a baseplate
        const pe = H.pc - spare;
        const s = ps.map((p) => p.bp * pe + p.ch).sort((x, y) => x - y);
        const holes = s[s.length - 1] - s[0] + 1 - s.length;
        if (holes) {
          const used = new Set(placements.filter((p) => ciocKey(p) === cs[0]).map((p) => p.bp * pe + p.ch));
          let empty = true;
          for (let x = s[0]; x <= s[s.length - 1]; x++) if (!s.includes(x) && used.has(x)) empty = false;
          if (empty && holes <= ((gapAllow || {})[c] || 0)) { a.push(`${c} keeps ${holes} empty CHARM${holes > 1 ? 's' : ''} for pairs that are unplaced or awaiting manual placement`); continue; }
          bad = `${c} is not on consecutive CHARMs in ${label(cs[0])}`;
        }
      }
      if (!bad) continue;
      const mn = manualOf(ps);
      relax.cable.has(c) ? a.push(`${bad} · ${relaxBy('cable', c) || 'relaxed'}`) : mn ? a.push(`${bad} · ${mn}`) : v.push(bad);
    }
    add('cable', rulesMeta.cable.n, placements.filter((p) => p.cable).length, v, a);
  }

  if (rules.cap) {
    if (!rules.group) add('cap', rulesMeta.cap.n, 0, [], [], 'Skipped: needs the grouping rule to know which CIOCs form a group');
    else {
      const v = [], a = [];
      for (const [g, ps] of Object.entries(by(placements, grpOf))) {
        const cabs = [...new Set(ps.map((p) => p.cab))];
        if (cabs.length < 2) continue;
        const msg = `${g || 'No group'} spans cabinets ${cabs.map((c) => 'MC-' + String(c + 1).padStart(2, '0')).join(', ')}`;
        if (relax.cap.has(g)) a.push(`${msg} · ${relaxBy('cap', g) || 'relaxed'}`);
        else if (ps.some((p) => p.pinned)) a.push(`${msg} · pinned from an earlier revision`);
        else if (manualOf(ps)) a.push(`${msg} · ${manualOf(ps)}`);
        else v.push(msg);
      }
      add('cap', rulesMeta.cap.n, placements.length, v, a);
    }
  }

  // pins honoured
  if (Object.keys(pins).length) {
    const v = [], a = [];
    const at = Object.fromEntries(placements.map((p) => [p.tag, p]));
    Object.entries(pins).forEach(([t, pin]) => {
      const p = at[t];
      if (!p || (p.cab === pin.pos.cab && p.cioc === pin.pos.cioc)) return;
      const msg = `${t} pinned to ${label(pin.pos.cab + '/' + pin.pos.cioc)} but placed in ${label(ciocKey(p))}`;
      pinAck && pinAck.has(t) ? a.push(msg + ' · pin could not be kept (TQ)') : v.push(msg);
    });
    add('pins', 'Pinned signals stay in their CIOC', Object.keys(pins).length, v, a);
  }


  // custom rules: compiled from their spec again here, checked only against the final placements
  for (const r of RU.compile((customs || []).map((c) => ({ k: c.id, n: c.name, on: 1, spec: c.spec })))) {
    const rx = relax[r.id] || new Set();
    const tag = (k) => exceptionsBy[`${r.id}:${k}`] || 'relaxed';
    const v = [], a = [];
    let checked = placements.length;
    if (r.type === 'separate' || r.type === 'exclusive' || r.type === 'limit') {
      const cont = r.scope === 'baseplate' ? (p) => `${p.cab}/${p.cioc}/${p.bp}` : ciocKey;
      const where = (k) => { const [c, i, b] = k.split('/').map(Number); return label(c + '/' + i) + (b !== undefined && !Number.isNaN(b) ? ` BP ${b + 1}` : ''); };
      for (const [k, ps] of Object.entries(by(placements, cont))) {
        const A = ps.filter(r.A), B = r.B ? ps.filter(r.B) : [];
        const bad = r.type === 'limit' ? A.length > r.max : A.length && B.length;
        if (!bad) continue;
        const msg = r.type === 'limit' ? `${where(k)} has ${A.length} matching signals (max ${r.max})` : `${where(k)} mixes ${A.length} and ${B.length} signals that must be apart`;
        const rel = [...A, ...B].map((p) => p.cable || p.tag).find((x) => rx.has(x)) || [...A, ...B].map((p) => p.tag).find((x) => rx.has(x));
        const mn = manualOf([...A, ...B]);
        rel ? a.push(`${msg} · ${tag(rel)}`) : mn ? a.push(`${msg} · ${mn}`) : v.push(msg);
      }
    } else if (r.type === 'together') {
      const sel = placements.filter(r.A);
      checked = sel.length;
      const kf = (p) => (r.by ? String(p[r.by] ?? '').toUpperCase() : '*');
      for (const [k, ps] of Object.entries(by(sel, kf))) {
        const cs = [...new Set(ps.map(r.scope === 'cabinet' ? (p) => cabLabel(p.cab) : (p) => label(ciocKey(p))))];
        if (cs.length < 2) continue;
        const msg = `${r.by ? (k || '(none)') + ': ' : ''}${ps.length} signals spread over ${cs.join(', ')}`;
        if (rx.has(k)) a.push(`${msg} · ${tag(k)}`);
        else if (r.scope === 'cabinet' && ps.some((p) => p.pinned)) a.push(`${msg} · pinned from an earlier revision`);
        else if (manualOf(ps)) a.push(`${msg} · ${manualOf(ps)}`);
        else v.push(msg);
      }
    } else if (r.type === 'spare') {
      const lim = H.pc - RU.spareCount(H.pc, r.percent);
      for (const [k, ps] of Object.entries(by(placements, (p) => `${p.cab}/${p.cioc}/${p.bp}`))) {
        if (ps.length <= lim) continue;
        const [c, i, b] = k.split('/').map(Number), msg = `${label(c + '/' + i)} BP ${b + 1} uses ${ps.length} of ${H.pc} CHARMs`;
        manualOf(ps) ? a.push(`${msg} · ${manualOf(ps)}`) : v.push(msg);
      }
    }
    add(r.id, r.name, checked, v, a);
  }

  // generated-code rules: their own check() ran on these placements (in the sandbox) before this call
  const at = Object.fromEntries(placements.map((p) => [p.tag, p]));
  for (const cr of codeResults || []) {
    const rx = relax[cr.id] || new Set();
    if (cr.error) { results.push({ key: cr.id, name: cr.name, checked: 0, violations: [], accepted: [], status: 'unchecked', note: `Not checked: the rule's code failed (${cr.error})` }); continue; }
    const v = [], a = [];
    for (const x of cr.violations) {
      const msg = `${x.message} (${x.tags.slice(0, 4).join(', ')}${x.tags.length > 4 ? '…' : ''})`;
      const rel = x.tags.find((t) => rx.has(t)), mn = manualOf(x.tags.map((t) => at[t]).filter(Boolean));
      rel ? a.push(`${msg} · ${exceptionsBy[`${cr.id}:${rel}`] || 'accepted'}`) : mn ? a.push(`${msg} · ${mn}`) : v.push(msg);
    }
    add(cr.id, cr.name, placements.length, v, a, 'Checked by its generated code, not independently');
  }

  // custom rules the engine has no logic for: shown honestly, never as a pass
  Object.values(rulesMeta).filter((r) => r.on && !r.engine).forEach((r) =>
    results.push({ key: r.k, name: r.n, checked: 0, violations: [], accepted: [], status: 'unchecked', note: 'No engine logic for this rule yet, so it is not enforced or checked' }));

  const violations = results.reduce((a, r) => a + r.violations.length, 0);
  const accepted = results.reduce((a, r) => a + r.accepted.length, 0);
  return { results, violations, accepted };
}

module.exports = { check };
