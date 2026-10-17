'use strict';
// Independent checker. It does not reuse any allocator logic: it starts from the final
// placements and re-verifies every active rule. A rule break is either
//   an accepted exception  (covered by a logged decision, e.g. "relax A/B for CBL-207"), or
//   a violation            (nobody decided it; this is what must be zero).

const grpOf = (p) => p.grp || '';
const by = (arr, fn) => arr.reduce((m, x) => ((m[fn(x)] = m[fn(x)] || []).push(x), m), {});
const ciocKey = (p) => `${p.cab}/${p.cioc}`;
const label = (k) => { const [c, i] = k.split('/').map(Number); return `MC-${String(c + 1).padStart(2, '0')} CIOC ${i + 1}`; };

function check({ placements, H, spare, rules, rulesMeta, relax, pins, pinAck, signals, rawTags, unplaced, exceptionsBy, hw }) {
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
        ok ? a.push(`${msg} · ${relaxBy('ab', ok[0]) || 'relaxed'}`) : v.push(msg);
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
      ok ? a.push(`${msg} · ${relaxBy('group', ok[0]) || 'relaxed'}`) : v.push(msg);
    }
    add('group', rulesMeta.group.n, placements.length, v, a);
  }

  if (rules.spare) {
    const v = [];
    const lim = H.pc - spare;
    for (const [k, ps] of Object.entries(by(placements, (p) => `${p.cab}/${p.cioc}/${p.bp}`))) {
      if (ps.length > lim) { const [c, i, b] = k.split('/').map(Number); v.push(`${label(c + '/' + i)} BP ${b + 1} uses ${ps.length} of ${H.pc} CHARMs, leaving fewer than ${spare} spare`); }
    }
    add('spare', rulesMeta.spare.n, placements.length, v);
  }

  if (rules.cable) {
    const v = [], a = [];
    for (const [c, ps] of Object.entries(by(placements.filter((p) => p.cable), (p) => p.cable))) {
      const cs = [...new Set(ps.map(ciocKey))];
      let bad = '';
      if (cs.length > 1) bad = `${c} is split over ${cs.map(label).join(', ')}`;
      else {
        // consecutive CHARMs, skipping only reserved spare CHARMs at the end of a baseplate
        const s = ps.map((p) => p.bp * (H.pc - spare) + p.ch).sort((x, y) => x - y);
        if (s[s.length - 1] - s[0] + 1 !== s.length) bad = `${c} is not on consecutive CHARMs in ${label(cs[0])}`;
      }
      if (!bad) continue;
      relax.cable.has(c) ? a.push(`${bad} · ${relaxBy('cable', c) || 'relaxed'}`) : v.push(bad);
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

  // custom rules the engine has no logic for: shown honestly, never as a pass
  Object.values(rulesMeta).filter((r) => r.on && !r.engine).forEach((r) =>
    results.push({ key: r.k, name: r.n, checked: 0, violations: [], accepted: [], status: 'unchecked', note: 'No engine logic for this rule yet, so it is not enforced or checked' }));

  const violations = results.reduce((a, r) => a + r.violations.length, 0);
  const accepted = results.reduce((a, r) => a + r.accepted.length, 0);
  return { results, violations, accepted };
}

module.exports = { check };
