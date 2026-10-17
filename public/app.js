// Signal Sudoku frontend. Plain ES module, no build step.
// Everything about signals, TQs, allocation and checking comes from the server; this file renders it.

const $ = (s) => document.querySelector(s);
const E = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cl = (o) => JSON.parse(JSON.stringify(o));
const COL = { AI: '--ai', AO: '--ao', DI: '--di', DO: '--do', DOI: '--doi' };
const col = (t) => COL[t] || '--mu';
const ENGINE = ['ab', 'group', 'spare', 'cable', 'cap'];

const BOOT = await fetch('/api/bootstrap').then((r) => { if (!r.ok) throw 0; return r.json(); }).catch(() => {
  document.body.innerHTML = '<p style="padding:24px">Cannot reach the Signal Sudoku server. Start it with: npm start</p>';
  throw new Error('no server');
});
const DFL = BOOT.defaults;

// ---------- state ----------
// S is saved with the project. POOL / RES / ING / MODAL are server data or transient UI state.
const S = { v: 'home', proj: 0, h: cl(DFL.h), rules: cl(DFL.rules), hw: cl(DFL.hw), pat: DFL.pat, rt: 'map', cab: 0, tqf: 'open', js: 0, rev: null, akey: '', ld: 0, al: 0, n: 0, dc: 0, q: '', so: 'r', lg: [], fz: null };
const PK = ['h', 'rules', 'hw', 'pat', 'rt', 'cab', 'tqf', 'akey', 'ld', 'al', 'n', 'rev'];
const snap = () => cl(Object.fromEntries(PK.map((k) => [k, S[k]])));
const DEF = snap();
let L = BOOT.projects || [];
let POOL = null, RES = null, ING = null, MODAL = null, BUSY = '';

const user = () => { try { return localStorage.getItem('ss-user') || 'engineer'; } catch (e) { return 'engineer'; } };
const setUser = (v) => { try { localStorage.setItem('ss-user', v.trim().slice(0, 60)); } catch (e) { /* storage off */ } };
const live = () => S.rules.filter((r) => !r.draft);
const ctx = () => ({ rules: live(), hw: S.hw, h: S.h, who: user() });
const akey = () => JSON.stringify([S.h, live().map((r) => [r.k, !!r.on, !!r.h]), Object.keys(S.hw).sort()]);

async function api(m, u, b) {
  const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-User': user() }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Server error');
  return j;
}
const P = () => L.find((p) => p.id == S.proj);
const purl = (x = '') => '/api/projects/' + encodeURIComponent(S.proj) + x;
const PT = {};
const persist = (p) => { clearTimeout(PT[p.id]); PT[p.id] = setTimeout(() => api('PUT', '/api/projects/' + p.id, p).catch(() => toast('Could not save to the server')), 350); };
const sv = () => { const p = P(); if (p) { p.st = snap(); p.ts = Date.now(); persist(p); } };
const log = (m) => { S.lg.unshift([new Date().toLocaleTimeString([], { hour12: false }), m]); S.lg = S.lg.slice(0, 40); };
const when = (t) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const day = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = 'none'), 2600); };
const curRev = () => (POOL && POOL.revs.length ? POOL.revs[POOL.revs.length - 1] : null);
const active = () => (POOL ? POOL.tqs.filter((t) => t.status !== 'resolved') : []);
const openTqs = () => active().filter((t) => t.status === 'open' || t.status === 'review');
const blocking = () => openTqs().filter((t) => t.sev === 'block');
const dirty = () => S.al && RES && (S.akey !== akey() || (POOL && POOL.allocStale));
const nm = (c, n) => S.pat.replace('{c}', String(c + 1).padStart(3, '0')).replace('{n}', n + 1);
const cabName = (c) => 'MC-' + String(c + 1).padStart(2, '0');
const ruleName = (k) => (S.rules.find((r) => r.k === k) || { n: k }).n;

async function loadPool() {
  if (!S.proj) return;
  try {
    POOL = await api('GET', purl('/pool'));
    const a = await api('GET', purl('/allocation'));
    RES = a.result;
    syncMeta();
  } catch (e) { toast(e.message); }
}
function syncMeta() {
  const r = curRev();
  S.ld = r ? 1 : 0;
  S.n = r ? r.signals : 0;
  S.al = RES && r && RES.rev === r.k ? 1 : 0;
  if (!S.al) RES = null;
  if (!S.rev || !POOL.revs.some((x) => x.k === S.rev)) S.rev = r ? r.k : null;
}

// ---------- rules.json ----------
// One self-contained file: the rule set (with priority order), the CHARM / terminal block lookup,
// the cabinet hierarchy and the baseplate name pattern. Importing it reproduces the project's rules.
// TQ decisions are not included: they belong to one IO list, not to the rule set.
const RULES_FORMAT = 'signal-sudoku-rules';
function rulesDoc() {
  const pj = P();
  return {
    format: RULES_FORMAT, version: 1,
    project: pj ? pj.name : '', exportedAt: new Date().toISOString(), exportedBy: user(),
    revision: curRev() ? curRev().k : null,
    hierarchy: { ciocsPerCabinet: S.h.cc, baseplatesPerCioc: S.h.bc, charmsPerBaseplate: S.h.pc },
    namePattern: S.pat,
    rules: live().map((r, i) => ({ id: r.k, name: r.n, description: r.d || '', hard: !!r.h, on: !!r.on, priority: i + 1, enforced: enforced(r), ...(r.spec ? { spec: r.spec } : {}), ...(r.code ? { code: r.code, summary: r.summary || '' } : {}) })),
    hardware: Object.fromEntries(Object.entries(S.hw).map(([k, v]) => [k, { charm: v[0], terminalBlock: v[1] }])),
  };
}
// Accepts the full rules.json object, or a bare list of rules (the older format). Throws a readable error.
function applyRulesDoc(j) {
  const doc = Array.isArray(j) ? { rules: j } : j;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rules)) throw new Error('No "rules" list found');
  if (doc.format && doc.format !== RULES_FORMAT) throw new Error('Not a Signal Sudoku rules file');
  const seen = new Set();
  const rules = [...doc.rules].sort((a, b) => (+a.priority || 0) - (+b.priority || 0)).map((r, i) => {
    if (!r || typeof r !== 'object' || !String(r.name ?? '').trim()) throw new Error(`Rule ${i + 1} has no name`);
    let k = String(r.id ?? '').trim() || 'x' + i;
    while (seen.has(k)) k += '_';
    seen.add(k);
    return { k, n: String(r.name).trim().slice(0, 200), d: String(r.description || 'Imported').slice(0, 200), h: r.hard ? 1 : 0, on: r.on === false ? 0 : 1, ...(r.spec && typeof r.spec === 'object' ? { spec: r.spec } : {}), ...(typeof r.code === 'string' && r.code ? { code: r.code.slice(0, 6000), summary: String(r.summary || '').slice(0, 300) } : {}) };
  });
  const out = { rules };
  if (doc.hardware && typeof doc.hardware === 'object') {
    out.hw = {};
    for (const [k, v] of Object.entries(doc.hardware)) {
      const key = String(k).trim().toUpperCase();
      if (!key) continue;
      out.hw[key] = Array.isArray(v) ? [String(v[0] ?? ''), String(v[1] ?? '')] : [String((v && v.charm) ?? ''), String((v && v.terminalBlock) ?? '')];
    }
  }
  if (doc.hierarchy) {
    const g = (x) => { const n = Math.round(+x); if (!(n >= 1 && n <= 1000)) throw new Error('Hierarchy values must be 1 to 1000'); return n; };
    out.h = { cc: g(doc.hierarchy.ciocsPerCabinet), bc: g(doc.hierarchy.baseplatesPerCioc), pc: g(doc.hierarchy.charmsPerBaseplate) };
  }
  if (typeof doc.namePattern === 'string' && doc.namePattern.trim()) out.pat = doc.namePattern.trim().slice(0, 60);
  Object.assign(S, out);
  return `${rules.length} rules${out.hw ? `, ${Object.keys(out.hw).length} IO types` : ''}${out.h ? ', hierarchy' : ''}${out.pat ? ', name pattern' : ''}`;
}
const slug = (x) => String(x || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- rule explanations (hover text) ----------
const DR = { name: '', desc: '', busy: 0, msg: '', err: 0 }; // rule-drafting form state
const BUILTIN = {
  ab: 'Within a process group, Seg A and Seg B signals are never placed in the same CIOC.',
  group: 'Each CIOC holds signals from one process group only.',
  spare: 'At least 10% of the CHARMs on every baseplate stay free (rounded, minimum 1).',
  cable: 'All pairs of a cable land in one CIOC, on consecutive CHARMs, in pair order.',
  cap: 'With grouping on, all CIOCs of a process group sit in one cabinet.',
};
const FL = { type: 'IO type', grp: 'group', seg: 'segregation', cable: 'cable', tag: 'tag' };
function selText(sel) {
  if (!sel) return 'all signals';
  const vs = sel.values.map((v) => (v === '' ? '(none)' : v)), list = vs.length > 1 ? vs.slice(0, -1).join(', ') + ' or ' + vs[vs.length - 1] : vs[0];
  const t = sel.op === 'prefix' ? `signals whose ${FL[sel.field]} starts with ${list}` : { type: `${list} signals`, grp: `signals in group ${list}`, seg: `Seg ${list} signals`, cable: `signals on cable ${list}`, tag: `signals tagged ${list}` }[sel.field];
  return sel.not ? `signals other than ${t}` : t;
}
function specText(s) {
  const sc = { cioc: 'CIOC', baseplate: 'baseplate', cabinet: 'cabinet' }[s.scope];
  const up = (x) => x[0].toUpperCase() + x.slice(1);
  if (s.type === 'separate') return `${up(selText(s.a))} and ${selText(s.b)} are never placed in the same ${sc}.`;
  if (s.type === 'exclusive') return `${up(selText(s.a))} get ${sc}s of their own; no other signal shares them.`;
  if (s.type === 'limit') return `At most ${s.max} ${s.a ? selText(s.a) : 'signals'} per ${sc}.`;
  if (s.type === 'together') return s.by ? `For each ${FL[s.by]}, its ${s.a ? selText(s.a) : 'signals'} are kept in one ${sc}.` : `All ${selText(s.a)} are kept in one ${sc}.`;
  if (s.type === 'spare') return `At least ${s.percent}% of the CHARMs on every baseplate stay free (rounded, minimum 1).`;
  return '';
}
const enforced = (r) => ENGINE.includes(r.k) || !!(r.spec && specText(r.spec)) || !!r.code;
function explainRule(r) {
  if (r.code) return `${r.summary || 'Generated code rule.'} Checked by generated code after allocation; it does not steer placement. Signals it flags become TQs for you to place by hand, accept, or leave unplaced. Not independently verified.`;
  const what = BUILTIN[r.k] || (r.spec && specText(r.spec));
  if (!what) return 'Stored only. The engine has no logic for this rule, so it is not enforced or checked.';
  return what + (r.h ? ' Hard: if it cannot be met, a blocking TQ is raised.' : ' Soft: if it clashes, it is relaxed and logged as an exception.');
}
const draftRow = (r, i) => `<tr class="dr"><td><span class="tag h">Draft</span></td><td><span class="nm" data-tip="${E(explainRule(r))}" tabindex="0">${E(r.n)}</span><div style="font-size:12.5px;margin-top:2px">${E(r.code ? r.summary : specText(r.spec))}</div>${r.code ? `<div class="wn" style="font-size:12px">No standard rule type fits, so this was drafted as code. It is checked after allocation and does not steer placement.</div>${r.pv ? `<div class="mu" style="font-size:12px">${E(r.pv)}</div>` : ''}<details style="margin-top:4px"><summary class="mu" style="font-size:12px;cursor:pointer">View the generated code</summary><pre class="mono" style="white-space:pre-wrap;margin:6px 0 0;padding:8px;background:var(--bg);border:1px solid var(--ln);max-height:220px;overflow:auto">${E(r.code)}</pre></details>` : ''}<div class="mu" style="font-size:12px">From: “${E(r.d)}”</div></td><td><button class="tag ${r.h ? 'h' : ''}" data-a="hs" data-v="${i}">${r.h ? 'Hard' : 'Soft'}</button></td><td><span class="tag">${r.code ? 'Checked once accepted' : 'Enforced once accepted'}</span></td><td></td><td style="white-space:nowrap"><button class="btn s p" data-a="acc" data-v="${i}">Accept</button> <button class="btn s" data-a="rej" data-v="${i}">Reject</button></td></tr>`;

// ---------- small render helpers ----------
const kp = (a) => `<div class="kp">${a.map((x) => `<div><b>${x[0]}</b><span>${x[1]}</span></div>`).join('')}</div>`;
const pn = (t, b) => `<div class="pn"><div class="ph">${t}</div><div class="pb">${b}</div></div>`;
const bars = (r, mx) => r.map((x) => `<div class="br"><span>${E(x[0])}</span><div><u style="width:${(x[1] / (mx || 1)) * 100}%"></u></div><span class="mono">${x[1]}${x[2] || ''}</span></div>`).join('');
const sevTag = (t) => `<span class="tag ${t.sev === 'block' ? 'e' : 'w'}">${t.sev === 'block' ? 'Blocking' : 'Warning'}</span>`;
const ST = { open: ['Open', 'w'], review: ['Review', 'h'], decided: ['Decided', 'g'], resolved: ['Resolved', ''] };
const stTag = (t) => `<span class="tag ${ST[t.status][1]}">${ST[t.status][0]}</span>`;
const sub = (t) => `<div class="sub">${t.map((a) => `<button class="${S.rt == a[0] ? 'on' : ''}" data-a="rt" data-v="${a[0]}">${a[1]}</button>`).join('')}</div>`;
const more = (a, n, fmt) => a.slice(0, n).map(fmt).join('') + (a.length > n ? `<div class="mu" style="font-size:12px">and ${a.length - n} more</div>` : '');

// One TQ with its decision controls. Used in the TQ list, the rules tab and the pre-allocation modal.
function tqBody(t, compact) {
  const dec = t.decision ? `<div class="ok mono" style="font-size:12px;margin-top:4px">Decision: ${E(t.decision.label)} · ${E(t.decision.who)} · ${when(t.decision.at)} · Rev ${E(t.decision.rev)}${t.decision.comment ? ' · “' + E(t.decision.comment) + '”' : ''}</div>` : '';
  const def = !t.decision && t.def && t.status === 'open' ? `<div class="mu" style="font-size:12px;margin-top:4px">Proceeds by default with: ${E((t.options.find((o) => o.id === t.def) || {}).label)}${t.softNote ? ' (' + E(t.softNote) + ')' : ''}</div>` : '';
  const note = t.note ? `<div class="wn" style="font-size:12px;margin-top:4px">${E(t.note)}</div>` : '';
  const res = t.status === 'resolved' ? `<div class="mu" style="font-size:12px;margin-top:4px">Resolved by ${E(t.resolvedBy)}</div>` : '';
  const ctl = t.status === 'resolved' ? '' : `<div class="row tqx" style="margin-top:8px"><select data-tqsel aria-label="Decision for ${E(t.id)}">${t.options.map((o) => `<option value="${E(o.id)}" ${(t.decision ? t.decision.opt : t.def) === o.id ? 'selected' : ''}>${E(o.label)}</option>`).join('')}</select>${compact ? '' : '<input data-tqc placeholder="Note (optional)" style="width:170px">'}<button class="btn s p" data-a="dc" data-v="${E(t.fp)}">${t.decision ? 'Change' : 'Decide'}</button>${t.decision && !compact ? `<button class="btn s" data-a="ro" data-v="${E(t.fp)}">Withdraw</button>` : ''}</div>`;
  const ur = t.custom ? `<span class="tag h" style="margin-right:6px" title="Raised by a rule you added; there are no rule-specific fixes, only the general options">User rule</span>` : '';
  const hint = t.custom && t.status !== 'resolved' ? (t.hint ? `<div style="font-size:12px;margin-top:6px;padding:6px 8px;border-left:2px solid var(--ac);background:var(--p2)"><span class="mu">LLM hint, unverified:</span> ${E(t.hint.text)}</div>` : `<div style="margin-top:6px"><button class="btn s" data-a="hint" data-v="${E(t.fp)}" ${HB.has(t.fp) ? 'disabled' : ''}>${HB.has(t.fp) ? 'Getting a hint…' : 'Get a hint'}</button></div>`) : '';
  return `${ur}<b>${E(t.title)}</b><div class="mu" style="font-size:12px">${E(t.detail)}</div>${dec}${def}${note}${res}${hint}${ctl}`;
}
const HB = new Set(); // TQs waiting for a hint

// ---------- views ----------
const V = {};

// Upload: drop zone -> column-map confirmation -> data health scan
V.up = () => {
  if (ING && ING.mode === 'base') return mapView();
  const r = curRev();
  return `<div class="hero"><div><h1>Every signal.<br>One right slot.</h1><p class="lead">Load the IO list. It is read on the server, the columns are mapped for you to confirm, and every data problem becomes a TQ.</p></div>${mini()}</div>
  <div class="strip">${[['Cabinet', S.h.cc + ' CIOCs · ' + S.h.cc * S.h.bc * S.h.pc], ['CIOC', S.h.bc + ' baseplates · ' + S.h.bc * S.h.pc], ['Baseplate', S.h.pc + ' CHARMs'], ['CHARM', '1 signal']].map((a) => `<div><b>${a[0]}</b><span>${a[1]}</span></div>`).join('')}</div>
  <label class="drop" id="drop"><input type="file" id="file" multiple hidden accept=".xlsx,.xls,.xlsm,.csv"><b>${r ? 'Drop a new IO list. It loads as the next revision' : 'Drop IO list workbooks'}</b><div class="mu" style="margin:4px 0 12px">Excel or CSV, one file or many. Click to browse.</div>${r ? '' : '<button type="button" class="btn p" data-a="smp">Use sample project</button>'}</label>
  ${BUSY ? `<p class="mu">${E(BUSY)}</p>` : ''}${r ? health(r) : ''}`;
};
function mini() {
  const r = curRev();
  const t = r ? Object.entries(r.types).flatMap(([k, n]) => Array(Math.max(1, Math.round((n / r.rows) * 96))).fill(k)).slice(0, 96) : [];
  while (t.length < 96) t.push('');
  return `<div class="mx" title="Signal mix of the current revision">${t.map((x, i) => `<i class="t ${x ? 'f' : ''}" style="--c:var(${col(x)});--d:${((i % 12) + Math.floor(i / 12)) * 40}ms"></i>`).join('')}</div>`;
}

function mapView() {
  const g = ING.data, rev = ING.mode === 'rev';
  const sigIx = Object.fromEntries(ING.maps.map((m, i) => [m.sig, i + 1]));
  const anyTag = ING.maps.some((m) => m.map.tag && g.files.some((f) => f.sheets.some((s) => s.sig === m.sig && ING.inc[f.name + '/' + s.name])));
  const srcRows = g.files.map((f) => f.error ? `<tr><td class="mono">${E(f.name)}</td><td colspan="5" class="er">${E(f.error)}</td></tr>` :
    f.sheets.map((s) => `<tr><td class="mono">${E(f.name)}</td><td>${E(s.name)}</td><td class="mono">${s.headerRow ?? '-'}</td><td class="mono">${s.rows}</td><td>${s.sig ? 'Map ' + sigIx[s.sig] : `<span class="mu">${E(s.skip || 'no header')}</span>`}</td><td>${s.sig ? `<input type="checkbox" data-inc="${E(f.name + '/' + s.name)}" ${ING.inc[f.name + '/' + s.name] ? 'checked' : ''} aria-label="Include ${E(s.name)}">` : ''}</td></tr>`).join('')).join('');
  const maps = ING.maps.map((m, i) => {
    const rows = BOOT.fields.map((fd) => {
      const h = m.map[fd.f] || '';
      const ci = m.headers.indexOf(h);
      const c = m.conf[fd.f];
      const tg = !h ? (fd.req ? '<span class="tag e">required</span>' : '<span class="mu">not in file</span>') : m.auto[fd.f] === h ? (c === 'high' ? '<span class="tag g">auto</span>' : '<span class="tag w">check</span>') : '<span class="tag h">you set</span>';
      return `<tr><td>${fd.label}</td><td><select data-mf="${i}:${fd.f}" aria-label="${fd.label} column"><option value="">(not in file)</option>${m.headers.map((x) => `<option ${x === h ? 'selected' : ''}>${E(x)}</option>`).join('')}</select></td><td>${tg}</td><td class="mono mu">${ci >= 0 ? m.sample.map((r) => E(r[ci]) || '·').join(' | ') : ''}</td></tr>`;
    }).join('');
    return pn(`Map ${i + 1} <span class="mu">${m.sheets.length} sheet${m.sheets.length > 1 ? 's' : ''}: ${E(m.sheets.join(', '))}</span>`, `<div style="overflow-x:auto"><table><tr><th>Field</th><th>Column in the file</th><th></th><th>First rows</th></tr>${rows}</table></div>`);
  }).join('');
  const k = nextKey();
  return `<h1 style="font-size:1.6rem">Confirm the column map</h1><p class="lead">Sheets with the same headers share one map. Columns were matched by name and content; check anything marked “check”. Untick sheets that are not IO lists.</p>
  ${pn('Sources', `<div style="overflow-x:auto"><table><tr><th>File</th><th>Sheet</th><th>Header row</th><th>Rows</th><th>Map</th><th>Use</th></tr>${srcRows}</table></div>`)}
  ${maps}
  <div class="row">${anyTag ? '' : '<span class="er">Map the Tag column on at least one included sheet.</span>'}<button class="btn p" data-a="ingok" ${anyTag ? '' : 'disabled'}>${rev || curRev() ? 'Load as Rev ' + k : 'Load as Rev A (baseline)'}</button><button class="btn" data-a="ingx">Cancel</button></div>`;
}
const nextKey = () => { const ks = POOL ? POOL.revs.map((r) => r.k) : []; for (let i = 0; i < 26; i++) { const k = String.fromCharCode(65 + i); if (!ks.includes(k)) return k; } return 'R' + ks.length; };

function health(r) {
  const scan = active().filter((t) => t.source === 'scan');
  const nb = scan.filter((t) => t.sev === 'block' && t.status !== 'decided').length, nw = scan.filter((t) => t.sev === 'warn').length;
  const src = r.sources.map((s) => `<tr><td class="mono">${E(s.file)}</td><td>${E(s.sheet)}</td><td class="mono">${s.rows}</td><td>${Object.entries(s.map).map(([f, h]) => `<span class="tag" style="margin:0 4px 4px 0;display:inline-block">${E(f)} = ${E(h)}</span>`).join('')}</td></tr>`).join('');
  return pn(`Rev ${E(r.k)} <span class="mu">${r.signals} signals from ${r.rows} rows · loaded ${when(r.at)} by ${E(r.who)}</span>`, `<div style="overflow-x:auto"><table><tr><th>File</th><th>Sheet</th><th>Rows</th><th>Columns read</th></tr>${src}</table></div>`)
    + `<div class="pn ${nb ? 'warn' : ''}"><div class="ph">Data health scan <span class="tag ${nb ? 'e' : 'g'}">${nb} blocking</span><span class="tag ${nw ? 'w' : 'g'}">${nw} warnings</span></div>
    ${scan.length ? `<table>${scan.slice(0, 14).map((t) => `<tr><td class="mono">${E(t.id)}</td><td>${sevTag(t)} ${stTag(t)}</td><td><b>${E(t.title)}</b></td><td class="mono mu">${t.count || ''}</td></tr>`).join('')}</table>` : '<div class="pb ok">No data problems found.</div>'}
    <div class="pb row" style="border-top:1px solid var(--ln)"><button class="btn p" data-a="go" data-v="ru">Continue to rules</button><button class="btn" data-a="go" data-v="re" data-t="tq">Open TQ list${scan.length > 14 ? ` (${scan.length})` : ''}</button></div></div>`;
}

// Rules
const RULE_TQ = ['cable-mixed-seg', 'cable-mixed-group', 'group-exceeds-cabinet', 'cable-exceeds-cioc'];
V.ru = () => {
  const R = S.rules;
  const rt = active().filter((t) => RULE_TQ.includes(t.type));
  const conflicts = rt.length ? `<div class="pn ${rt.some((t) => t.status !== 'decided') ? 'warn' : ''}"><div class="ph">Rule conflicts <span class="tag ${rt.some((t) => t.status !== 'decided' && t.sev === 'block') ? 'e' : 'w'}">${rt.length} data vs rule</span><span class="mu">from the data scan and the last allocation</span></div><div class="pb">${rt.slice(0, 8).map((t) => `<div class="tqc"><div class="row"><span class="mono mu">${E(t.id)}</span>${sevTag(t)}${stTag(t)}<span class="mono mu sp1">${E(t.clash)}</span></div>${tqBody(t)}</div>`).join('')}${rt.length > 8 ? `<p class="mu">${rt.length - 8} more in the TQ list.</p>` : ''}</div></div>` : '';
  return conflicts
    + `<div class="pn"><div class="ph">Rule set <span class="mu">${live().filter((r) => r.on).length} of ${live().length} active${R.length > live().length ? ` · ${R.length - live().length} draft${R.length - live().length > 1 ? 's' : ''} to review` : ''}</span><span class="sp1 row"><button class="btn s" data-a="js">${S.js ? 'Hide JSON' : 'JSON import / export'}</button></span></div>
  ${S.js ? `<div class="pb"><textarea id="jsn" aria-label="Rules JSON">${E(JSON.stringify(rulesDoc(), null, 1))}</textarea><div class="row" style="margin-top:8px"><button class="btn s p" data-a="jsap">Apply JSON</button><label class="btn s" style="cursor:pointer">Import rules.json<input type="file" id="rjf" accept=".json,application/json" hidden></label><button class="btn s" data-a="xr">Export rules.json</button><span class="mu mono">Paste or import a rule set; it replaces the rules, lookup, hierarchy and name pattern</span></div></div>` : ''}
  <div style="overflow-x:auto"><table><tr><th></th><th>Rule <span class="mu" style="font-weight:400">hover a rule to see what it does</span></th><th>Strength</th><th>Engine</th><th>Priority</th><th></th></tr>${R.map((r, i) => r.draft ? draftRow(r, i) : `<tr class="${r.on ? '' : 'off'}"><td><button class="sw ${r.on ? 'on' : ''}" data-a="tg" data-v="${i}" aria-label="Switch rule"></button></td><td><span class="nm" data-tip="${E(explainRule(r))}" tabindex="0">${E(r.n)}</span><div class="mu" style="font-size:12px">${E(r.d)}</div></td><td><button class="tag ${r.h ? 'h' : ''}" data-a="hs" data-v="${i}" title="Hard rules raise blocking TQs; a clash with a soft rule proceeds by relaxing it">${r.h ? 'Hard' : 'Soft'}</button></td><td>${r.code ? '<span class="tag h" title="Generated code checks it after allocation; it does not steer placement">Code · checked after</span>' : enforced(r) ? '<span class="tag g">Enforced</span>' : '<span class="tag w" title="The engine has no logic for this rule">Not enforced</span>'}</td><td class="mono">P${R.filter((x, j) => !x.draft && j <= i).length}</td><td style="white-space:nowrap"><button class="ib" data-a="mv" data-v="${i}" data-d="-1" aria-label="Up">▲</button><button class="ib" data-a="mv" data-v="${i}" data-d="1" aria-label="Down">▼</button><button class="ib" data-a="del" data-v="${i}" aria-label="Delete">✕</button></td></tr>`).join('')}</table></div>
  <div class="pb" style="border-top:1px solid var(--ln)"><div class="sec" style="text-transform:none;letter-spacing:0;font-size:12px">Add a rule: name it and describe what it must do. It is drafted for you to accept or reject.</div>
  <div class="row"><input class="w" id="rn" placeholder="Rule name, e.g. Isolated outputs apart" maxlength="120" value="${E(DR.name)}"></div>
  <div class="row" style="margin-top:8px"><textarea id="rdsc" placeholder="What the rule must do, e.g. DO isolated signals never share a baseplate with standard DO" maxlength="1000" style="height:64px">${E(DR.desc)}</textarea></div>
  <div class="row" style="margin-top:8px"><button class="btn p" data-a="drf" ${DR.busy ? 'disabled' : ''}>${DR.busy ? 'Drafting…' : 'Draft rule'}</button>${DR.msg ? `<span class="${DR.err ? 'er' : 'wn'}" style="font-size:12.5px">${E(DR.msg)}</span>` : ''}</div>
  <div class="row" style="margin-top:8px">${[['Never mix AI and DI', 'AI and DI signals never share a CIOC'], ['Each unit in one cabinet', 'Keep every process group in a single cabinet'], ['20% spare', 'Reserve 20% spare CHARMs on every baseplate'], ['Max 6 DO per baseplate', 'No more than 6 DO signals on any baseplate']].map((x) => `<button class="tag" data-a="eg" data-v="${E(x[0])}" data-d="${E(x[1])}">${E(x[0])}</button>`).join('')}</div></div></div>`
    + pn('CHARM and terminal block lookup <span class="mu">an IO type missing here raises a TQ</span>', `<div style="overflow-x:auto"><table><tr><th>IO type</th><th>CHARM</th><th>Terminal block</th><th></th></tr>${Object.entries(S.hw).map(([k, v]) => `<tr><td class="mono">${E(k)}</td><td><input data-h="${E(k)}:0" value="${E(v[0])}"></td><td><input data-h="${E(k)}:1" value="${E(v[1])}"></td><td><button class="ib" data-a="hwd" data-v="${E(k)}" aria-label="Remove ${E(k)}">✕</button></td></tr>`).join('')}</table></div>
    <div class="row" style="margin-top:12px"><input id="hwk" placeholder="New IO type, e.g. PI" style="width:150px"><input id="hwc" placeholder="CHARM"><input id="hwt" placeholder="Terminal block"><button class="btn s" data-a="hwa">Add IO type</button></div>
    <div class="row" style="margin-top:12px"><span class="mu">Baseplate name pattern</span><input id="pat" value="${E(S.pat)}"><span class="mono ok" id="pv">${E(nm(0, 0))}</span></div>`)
    + `<div class="row"><button class="btn p" data-a="go" data-v="re">Continue to allocation</button></div>`;
};

// Allocation
V.re = () => {
  const ob = blocking().length, ow = openTqs().length - ob;
  const mq = RES && RES.manualQueue ? RES.manualQueue.length : 0, mpl = RES && RES.manualPlaced ? RES.manualPlaced.length : 0;
  const tabs = [['map', 'Cabinet map'], ['tq', `TQs (${openTqs().length} open)`]].concat(mq || mpl ? [['mp', `Manual placement (${mq} waiting)`]] : []).concat([['ck', 'Checker']]);
  let h = `<div class="row" style="margin-bottom:16px"><h1 style="font-size:1.6rem;margin:0">Allocation</h1>${curRev() ? `<span class="tag">Rev ${E(curRev().k)}</span>` : ''}<span class="mu">Cabinet to CIOC to baseplate to CHARM</span><div class="sp1 row"><button class="btn p" data-a="al" ${S.ld && !BUSY ? '' : 'disabled'}>${BUSY || (S.al ? 'Re-allocate' : 'Allocate')}</button></div></div>`
    + (dirty() ? `<div class="ban"><span class="wn">Rules, hardware, decisions or data changed since the last allocation.</span><button class="btn s p" data-a="al">Re-allocate now</button></div>` : '');
  if (S.rt !== 'tq' && !RES) return h + sub(tabs) + `<div class="pn"><div class="pb" style="text-align:center;padding:50px"><b>${S.ld ? 'Nothing allocated yet' : 'Load an IO list first'}</b>${ob ? `<p class="wn">${ob} blocking TQ${ob > 1 ? 's' : ''} need a decision first. ${ow ? ow + ' warnings will proceed with their defaults.' : ''}</p>` : `<p class="mu">${S.ld ? 'Allocate places every signal, or explains why not.' : ''}</p>`}${S.ld ? '' : '<button class="btn p" data-a="go" data-v="up">Go to Upload</button>'}</div></div>`;
  h += sub(tabs);
  if (S.rt === 'map') h += mapTab();
  if (S.rt === 'tq') h += tqTab();
  if (S.rt === 'ck') h += ckTab();
  if (S.rt === 'mp') h += mpTab();
  return h;
};

function grid() {
  const g = {};
  RES.placements.forEach((p) => { ((g[p.cab] = g[p.cab] || {})[p.cioc] = g[p.cab][p.cioc] || {})[p.bp * RES.H.pc + p.ch] = p; });
  return g;
}
// One cabinet as a grid of CHARMs. pick=true makes free CHARMs clickable for manual placement.
function cabGrid(cab, pick, g) {
  const H = RES.H, pcEff = H.pc - RES.spare;
  g = g || grid();
  let cells = '', d = 0;
  for (let ci = 0; ci < H.cc; ci++) {
    const cm = RES.ciocs.find((c) => c.cab === cab && c.cioc === ci);
    const lab = cm ? [...new Set(cm.grps.map((x) => (x || 'No group') + (cm.segs[x] && cm.segs[x].length ? '·' + cm.segs[x].join('/') : '')))].join(', ') : 'empty';
    let r = '';
    for (let b = 0; b < H.bc; b++) {
      let row = '';
      for (let k = 0; k < H.pc; k++) {
        const p = g[cab] && g[cab][ci] && g[cab][ci][b * H.pc + k];
        const dl = pick ? '0ms' : (d++ % 400) * 2 + 'ms', where = `${E(nm(cab, ci * H.bc + b))} · CHARM ${k + 1}`;
        const sel = pick && MP.pos && MP.pos.cab === cab && MP.pos.cioc === ci && MP.pos.bp === b && MP.pos.ch === k;
        if (p) row += `<i class="c ${p.manual ? 'mn' : ''}" style="--c:var(${col(p.type)});--d:${dl}" data-t="${E(p.tag)}${p.manual ? ' (placed by hand)' : ''}|${E(p.type)} · ${E(p.grp || 'No group')}${p.seg ? ' Seg ' + E(p.seg) : ''}|${E((S.hw[p.type] || ['no CHARM'])[0])} · ${E((S.hw[p.type] || ['', ''])[1])}|${where}|${p.cable ? E(p.cable) + ' pair ' + (p.pair ?? '?') : 'no cable'}${p.pinned ? '|pinned from earlier revision' : ''}"></i>`;
        else if (pick) row += `<i class="c ${k >= pcEff ? 'sp' : 'em'} pk ${sel ? 'on' : ''}" style="--d:0ms" data-a="mpc" data-v="${cab}/${ci}/${b}/${k}" role="button" tabindex="0" aria-label="${where}" data-t="${k >= pcEff ? 'Reserved spare CHARM (placing here eats into the spare)' : 'Free CHARM'}|${where}|Click to check this slot"></i>`;
        else row += `<i class="c ${k >= pcEff ? 'sp' : 'em'}" style="--d:${dl}" data-t="${k >= pcEff ? 'Reserved spare CHARM' : 'Free CHARM'}|${where}"></i>`;
      }
      r += `<div class="bp" style="grid-template-columns:repeat(${H.pc},1fr)">${row}</div>`;
    }
    cells += `<div class="cio"><h4>CIOC ${ci + 1}<span>${E(lab)}</span></h4>${r}</div>`;
  }
  return cells;
}

// Manual placement: signals sent here by a "Place manually" decision. Pick a free CHARM, see what it
// would break (the checker runs on the layout with the signal there), then place it.
const MP = { tag: null, cab: 0, pos: null, res: null, busy: 0 };
function mpTab() {
  const q = RES.manualQueue || [], pl = RES.manualPlaced || [], H = RES.H;
  if (MP.tag && !q.some((x) => x.tag === MP.tag) && !pl.some((x) => x.tag === MP.tag)) Object.assign(MP, { tag: null, pos: null, res: null });
  const N = RES.stats.cabinets + 1; // one extra, empty cabinet to place into
  if (MP.cab >= N) MP.cab = 0;
  const slot = (x) => `${cabName(x.cab)} CIOC ${x.cioc + 1} · ${nm(x.cab, x.cioc * H.bc + x.bp)} · CHARM ${x.ch + 1}`;
  const sig = q.find((x) => x.tag === MP.tag) || pl.find((x) => x.tag === MP.tag);
  let picker = '';
  if (MP.tag) {
    const r = MP.res;
    const verdict = !MP.pos ? '<span class="mu">Click a free CHARM. Grey ones are reserved spare.</span>'
      : MP.busy ? '<span class="mu">Checking this slot…</span>'
      : !r ? '' : !r.ok ? `<span class="er">${E(r.reason)}</span>`
      : `<div><b>${E(slot(MP.pos))}</b>${r.spare ? ' <span class="tag w">reserved spare CHARM</span>' : ''}</div>${r.breaks.length ? `<div class="wn" style="margin-top:4px">Placing it here breaks:</div>${r.breaks.slice(0, 8).map((b) => `<div class="mono" style="font-size:12px">· ${E(b.rule)}: ${E(b.msg)}</div>`).join('')}<div class="mu" style="font-size:12px;margin-top:4px">If you place it anyway, these are logged as accepted exceptions (your manual placement).</div>` : '<div class="ok" style="margin-top:4px">Breaks no rule.</div>'}`;
    picker = pn(`Place ${E(MP.tag)} <span class="mu">${sig ? `${E(sig.type || '?')} · ${E(sig.grp || 'No group')}${sig.seg ? ' Seg ' + E(sig.seg) : ''}${sig.cable ? ' · ' + E(sig.cable) + ' pair ' + (sig.pair ?? '?') : ''}` : ''}</span><span class="sp1 row"><button class="btn s" data-a="mpx">Cancel</button></span>`,
      `<div class="cabs" style="flex-wrap:wrap">${Array.from({ length: N }, (_, i) => `<button class="${i == MP.cab ? 'on' : ''}" data-a="mpcab" data-v="${i}">${cabName(i)}${i === N - 1 ? ' (new)' : ''}</button>`).join('')}</div>
      <div class="cab" style="grid-template-columns:repeat(${H.cc},minmax(190px,1fr))">${cabGrid(MP.cab, true)}</div>
      <div class="pb" style="border:1px solid var(--ln);margin-top:12px">${verdict}<div class="row" style="margin-top:10px"><button class="btn p" data-a="mpok" ${MP.pos && r && r.ok && !MP.busy ? '' : 'disabled'}>Place here</button></div></div>`);
  }
  return picker
    + pn(`Waiting for manual placement <span class="mu">${q.length} signals · sent here by “Place manually” decisions</span>`, q.length ? `<div style="overflow-x:auto"><table><tr><th>Tag</th><th>Signal</th><th>Cable</th><th>TQ</th><th></th></tr>${q.map((x) => `<tr class="${x.tag === MP.tag ? 'dr' : ''}"><td class="mono">${E(x.tag)}</td><td>${E(x.type || '?')} · ${E(x.grp || 'No group')}${x.seg ? ' Seg ' + E(x.seg) : ''}</td><td class="mono">${x.cable ? E(x.cable) + ' / ' + (x.pair ?? '?') : '-'}</td><td><span class="mono">${E(x.tq)}</span><div class="mu" style="font-size:12px">${E(x.tqTitle || '')}</div></td><td><button class="btn s ${x.tag === MP.tag ? '' : 'p'}" data-a="mps" data-v="${E(x.tag)}">${x.tag === MP.tag ? 'Selected' : 'Place'}</button></td></tr>`).join('')}</table></div>` : '<span class="ok">Nothing waiting.</span>')
    + (pl.length ? pn(`Placed by hand <span class="mu">${pl.length}</span>`, `<div style="overflow-x:auto"><table><tr><th>Tag</th><th>Slot</th><th>By</th><th></th></tr>${pl.map((x) => `<tr><td class="mono">${E(x.tag)}</td><td class="mono">${E(slot(x))}</td><td>${E(x.who)} <span class="mu">${when(x.at)} · Rev ${E(x.rev)}</span></td><td style="white-space:nowrap"><button class="btn s" data-a="mps" data-v="${E(x.tag)}">Move</button> <button class="btn s" data-a="mprm" data-v="${E(x.tag)}">Remove</button></td></tr>`).join('')}</table></div>`) : '');
}

function mapTab() {
  const H = RES.H, pcEff = H.pc - RES.spare, N = RES.stats.cabinets, g = grid();
  if (S.cab >= N) S.cab = 0;
  const cells = cabGrid(S.cab, false, g);
  const ty = {};
  RES.placements.forEach((p) => (ty[p.type] = (ty[p.type] || 0) + 1));
  const fr = Array.from({ length: N }, (_, i) => {
    const ps = RES.placements.filter((p) => p.cab === i), cs = RES.ciocs.filter((c) => c.cab === i);
    const bps = cs.reduce((a, c) => a + Math.ceil(c.n / pcEff), 0), f = bps ? Math.round((ps.length / (bps * H.pc)) * 100) : 0;
    return `<tr><td class="mono">${cabName(i)}</td><td>${cs.length}</td><td>${ps.length}</td><td><div class="row" style="flex-wrap:nowrap"><div style="flex:1;min-width:60px;height:7px;background:var(--sp)"><u style="display:block;height:100%;width:${f}%;background:var(--ac)"></u></div><span class="mono">${f}%</span></div></td></tr>`;
  }).join('');
  const rc = [['All rules as set', N, '']].concat(Object.entries(RES.costs || {}).map(([k, n]) => [ruleName(k) + ' off', n, n !== N ? ` (${n - N > 0 ? '+' : ''}${n - N})` : '']));
  const ck = RES.check.results.filter((r) => r.status !== 'unchecked');
  return kp([[RES.stats.signals, 'signals placed'], [RES.unplaced.filter((u) => !u.pending).length, 'left unplaced (TQ)'], [(RES.manualQueue || []).length, 'awaiting manual placement'], [N, 'cabinets'], [RES.stats.ciocs, 'CIOCs'], [RES.stats.fill + '%', 'CHARM fill'], [openTqs().length, 'open TQs'], [RES.check.violations, 'violations']])
    + `<div class="row" style="margin:-4px 0 16px">${ck.map((r) => `<span class="tag ${r.status === 'fail' ? 'e' : r.status === 'accepted' ? 'h' : 'g'}" title="${E(r.note)}">${r.status === 'fail' ? '✕' : '✓'} ${E(r.name)}${r.accepted.length ? ` (${r.accepted.length} accepted)` : ''}</span>`).join('')}</div>`
    + pn('Cabinet map', `<div class="cabs" style="flex-wrap:wrap">${Array.from({ length: N }, (_, i) => `<button class="${i == S.cab ? 'on' : ''}" data-a="cb" data-v="${i}">${cabName(i)}</button>`).join('')}</div><div class="cab" style="grid-template-columns:repeat(${H.cc},minmax(190px,1fr))">${cells}</div><div class="leg">${Object.keys(ty).map((t) => `<span><i style="background:var(${col(t)})"></i>${E(t)}</span>`).join('')}<span><i style="background:var(--sp)"></i>Reserved spare</span><span><i style="box-shadow:inset 0 0 0 1px var(--l2)"></i>Free</span>${RES.placements.some((p) => p.manual) ? '<span><i style="box-shadow:inset 0 0 0 2px var(--ink)"></i>Placed by hand</span>' : ''}</div>`)
    + `<div class="g2">` + pn('Signal mix and cabinet fill', `<div class="stk">${Object.entries(ty).map(([t, c]) => `<i title="${E(t)} ${c}" style="width:${(c / RES.stats.signals) * 100}%;background:var(${col(t)})"></i>`).join('')}</div><div class="leg" style="margin:8px 0 14px">${Object.entries(ty).map(([t, c]) => `<span>${E(t)} ${c}</span>`).join('')}</div><div style="overflow-x:auto"><table><tr><th>Cabinet</th><th>CIOCs</th><th>Signals</th><th>Fill</th></tr>${fr}</table></div>`)
    + pn('What each rule costs <span class="mu">cabinets with the rule off</span>', bars(rc, Math.max(...rc.map((r) => r[1])))) + `</div>`
    + (RES.unplaced.some((u) => !u.pending) ? pn(`Left unplaced <span class="mu">${RES.unplaced.filter((u) => !u.pending).length} signals, each covered by a TQ decision</span>`, `<div style="overflow-x:auto"><table><tr><th>Tag</th><th>TQ</th><th>Decision</th></tr>${RES.unplaced.filter((u) => !u.pending).slice(0, 60).map((u) => `<tr><td class="mono">${E(u.tag)}</td><td class="mono">${E(u.tq)}</td><td class="mu">${E(u.reason)}</td></tr>`).join('')}</table></div>`) : '');
}

function tqTab() {
  const F = { open: (t) => t.status === 'open' || t.status === 'review', decided: (t) => t.status === 'decided', resolved: (t) => t.status === 'resolved', all: () => true };
  const list = (POOL ? POOL.tqs : []).filter(F[S.tqf] || F.all).sort((a, b) => (a.sev === 'block' ? 0 : 1) - (b.sev === 'block' ? 0 : 1) || a.id.localeCompare(b.id));
  const cnt = (k) => (POOL ? POOL.tqs.filter(F[k]).length : 0);
  return pn(`TQ list <span class="mu">raised by the data scan and the allocator, kept across revisions</span><span class="sp1 row">${['open', 'decided', 'resolved', 'all'].map((f) => `<button class="tag ${S.tqf == f ? 'h' : ''}" data-a="tf" data-v="${f}">${f} ${cnt(f)}</button>`).join('')}</span>`, '')
    + `<div class="pn" style="margin-top:-17px;border-top:0"><div style="overflow-x:auto"><table><tr><th>ID</th><th>State</th><th>Issue</th><th>Clash</th><th>Signals</th></tr>${list.map((t) => `<tr><td class="mono">${E(t.id)}<div class="mu" style="font-size:11px">Rev ${E(t.firstRev)}${t.lastRev !== t.firstRev ? '–' + E(t.lastRev) : ''}</div></td><td style="white-space:nowrap">${sevTag(t)}<div style="margin-top:4px">${stTag(t)}</div></td><td>${tqBody(t)}</td><td class="mu" style="font-size:12px">${E(t.clash)}<div class="mono" style="font-size:11px">${E(t.fp)}</div></td><td class="mono" title="${E(t.tags.join(', '))}">${t.count || ''}</td></tr>`).join('') || '<tr><td colspan="5" class="mu">Nothing here.</td></tr>'}</table></div></div>`;
}

function ckTab() {
  const ex = RES.exceptions || [];
  const audit = POOL ? POOL.audit : [];
  return pn(`Independent checker <span class="tag ${RES.check.violations ? 'e' : 'g'}">${RES.check.violations} unacknowledged violations</span><span class="tag h">${RES.check.accepted} accepted exceptions</span><span class="mu">re-verified from the final placements · ${when(RES.at)}</span>`,
    `<div style="overflow-x:auto"><table><tr><th>Result</th><th>Rule</th><th>Checked</th><th>Details</th></tr>${RES.check.results.map((r) => `<tr><td class="${r.status === 'fail' ? 'er' : r.status === 'unchecked' ? 'wn' : 'ok'}">${{ pass: 'Pass', fail: 'Fail', accepted: 'Pass with exceptions', unchecked: 'Not checked' }[r.status]}</td><td>${E(r.name)}</td><td class="mono mu">${r.checked}</td><td style="font-size:12px">${r.note ? `<div class="mu">${E(r.note)}</div>` : ''}${more(r.violations, 8, (x) => `<div class="er">${E(x)}</div>`)}${more(r.accepted, 6, (x) => `<div class="mu">${E(x)}</div>`)}</td></tr>`).join('')}</table></div>`)
    + pn(`Accepted exceptions <span class="mu">every decision that changed what the engine did, at this allocation</span>`, ex.length ? `<div style="overflow-x:auto"><table><tr><th>TQ</th><th>Decision</th><th>By</th><th>When</th></tr>${ex.map((x) => `<tr><td class="mono">${E(x.id)}</td><td><b>${E(x.label)}</b><div class="mu" style="font-size:12px">${E(x.title)}</div></td><td>${x.byDefault ? '<span class="tag w">default</span>' : E(x.who)}</td><td class="mono mu">${x.byDefault ? '' : when(x.at) + ' · Rev ' + E(x.rev)}</td></tr>`).join('')}</table></div>` : '<span class="mu">None. Accepted conflicts appear here, never hidden.</span>')
    + pn('Audit trail <span class="mu">who decided what, when, in which revision</span>', `<div class="log">${audit.slice(0, 80).map((a) => `<div><span>${when(a.at)}</span><span>Rev ${E(a.rev)}</span><b style="font-weight:500">${E(a.who)}</b><span>${E(a.action)}</span>${a.id ? `<span class="mono">${E(a.id)}</span>` : ''}${E(a.label)}${a.comment ? ' · “' + E(a.comment) + '”' : ''}</div>`).join('') || '<span class="mu">Nothing yet.</span>'}</div>`);
}

// Revise
V.rv = () => {
  const H1 = '<h1 style="font-size:1.6rem">Revise</h1>';
  if (!S.ld) return H1 + `<div class="pn"><div class="pb" style="text-align:center;padding:40px"><b>Load the IO list first</b><p class="mu">Revisions are compared with it.</p><button class="btn p" data-a="go" data-v="up">Go to Upload</button></div></div>`;
  if (ING && ING.mode === 'rev') return mapView();
  const i0 = Math.max(0, POOL.revs.findIndex((q) => q.k === S.rev)), r = POOL.revs[i0];
  const d = r.diff, imp = r.impact;
  const pairs = imp ? imp.relocated + d.added : d ? d.added + d.moved : 0, cabs = imp ? imp.cabinetsHit : 0;
  const tqr = POOL.tqs.filter((t) => t.firstRev === r.k && i0), tqx = POOL.tqs.filter((t) => t.status === 'resolved' && String(t.resolvedBy).includes('Rev ' + r.k));
  let cells = '';
  if (d) {
    const un = Math.max(0, r.signals - d.added - d.moved), sc = Math.min(1, 1500 / (un + d.added + d.moved + d.deleted || 1));
    cells = '<i></i>'.repeat(Math.round(un * sc)) + '<i class="mv"></i>'.repeat(Math.ceil(d.moved * sc)) + '<i class="nw"></i>'.repeat(Math.ceil(d.added * sc)) + '<i class="dl"></i>'.repeat(Math.ceil(d.deleted * sc));
  }
  return H1 + `<p class="lead">Upload the customer's revised IO list. It is compared with the previous revision; TQs that the new data fixes close themselves, problems that come back reopen, and decisions on signals that changed are flagged for review.</p>
  <div class="row" style="margin-bottom:16px">${POOL.revs.map((q) => `<button class="btn ${S.rev == q.k ? 'p' : ''}" data-a="rev" data-v="${E(q.k)}">Rev ${E(q.k)}${q.vs ? '' : ' (baseline)'}</button>`).join('')}</div>
  <label class="drop" id="rdrop" style="margin-bottom:16px"><input type="file" id="rfile" multiple hidden accept=".xlsx,.xls,.xlsm,.csv"><b>Drop the revised IO list</b><div class="mu" style="margin:4px 0 12px">Excel or CSV, full list. Loads as Rev ${nextKey()}. Click to browse.</div><button type="button" class="btn s" data-a="rsm">No file handy? Try a sample revision</button></label>${BUSY ? `<p class="mu">${E(BUSY)}</p>` : ''}`
    + kp(d ? [[d.added, 'added'], [d.deleted, 'deleted'], [d.moved, 'changed'], [imp ? imp.relocated : '–', 'relocated'], [imp ? cabs : '–', 'cabinets hit'], [(pairs * 0.25 + cabs * 2).toFixed(1) + ' h', 'estimated rework'], [r.signals, 'signals in Rev ' + E(r.k)]] : [[r.signals, 'signals'], [r.rows, 'rows read'], [r.sources.length, 'sheets']])
    + (d && !imp ? `<p class="mu" style="margin-top:-6px">Allocate Rev ${E(r.vs)} and Rev ${E(r.k)} to see relocated signals and cabinets hit.</p>` : '')
    + (d ? pn(`Revision heatmap <span class="mu">Rev ${E(r.k)} vs Rev ${E(r.vs)}</span>`, `<div class="heat">${cells}</div><div class="leg"><span><i style="background:var(--di)"></i>untouched</span><span><i style="background:var(--ac)"></i>changed</span><span><i style="background:var(--er)"></i>new</span><span><i style="box-shadow:inset 0 0 0 1px var(--mu)"></i>deleted</span></div>`)
      + pn(`TQ changes in Rev ${E(r.k)}`, `<div class="row">${[[tqr.length, 'raised', 'w'], [tqx.length, 'resolved by this revision', 'g'], [POOL.tqs.filter((t) => t.status === 'review').length, 'decisions to review now', 'h']].map((x) => `<span class="tag ${x[2]}">${x[0]} ${x[1]}</span>`).join('')}</div>${tqx.length ? `<div style="margin-top:10px">${tqx.slice(0, 12).map((t) => `<div class="mono mu" style="padding:2px 0">${E(t.id)} ${E(t.title)}</div>`).join('')}</div>` : ''}`)
      + pn('What changed', `<div style="overflow-x:auto"><table><tr><th>Change</th><th>Tag</th><th>Detail</th></tr>${d.list.map((q) => `<tr><td><span class="tag ${q[0] == 'Added' ? 'g' : q[0] == 'Deleted' ? 'e' : 'h'}">${q[0] === 'Moved' ? 'Changed' : q[0]}</span></td><td class="mono">${E(q[1])}</td><td class="mu">${E(q[2])}</td></tr>`).join('') || '<tr><td colspan="3" class="mu">No differences found.</td></tr>'}${d.added + d.deleted + d.moved > d.list.length ? `<tr><td colspan="3" class="mu">Showing ${d.list.length} of ${d.added + d.deleted + d.moved}</td></tr>` : ''}</table></div>`)
      : pn('Rev ' + E(r.k), '<span class="mu">Baseline. Upload a revision above to see the impact.</span>'))
    + pn('Revisions', `<div style="overflow-x:auto"><table><tr><th>Rev</th><th>Source</th><th>Vs</th><th>Added</th><th>Deleted</th><th>Changed</th><th>Signals</th><th>Allocation</th><th></th></tr>${POOL.revs.map((q, i) => `<tr class="${S.rev == q.k ? 'dr' : ''}"><td class="mono">${E(q.k)}</td><td>${E(q.name)}<div class="mu" style="font-size:11px">${when(q.at)} · ${E(q.who)}</div></td><td class="mono">${E(q.vs || '-')}</td><td>${q.diff ? q.diff.added : '-'}</td><td>${q.diff ? q.diff.deleted : '-'}</td><td>${q.diff ? q.diff.moved : '-'}</td><td class="mono">${q.signals}</td><td>${q.alloc ? `<span class="tag ${q.alloc.check.violations ? 'e' : 'g'}">${q.alloc.stats.cabinets} cab · ${q.alloc.check.violations} viol.</span>` : '<span class="mu">-</span>'}</td><td>${i && i === POOL.revs.length - 1 ? `<button class="btn s" data-a="rvd">Remove</button>` : ''}</td></tr>`).join('')}</table></div>`);
};

// Dashboard
const donut = (d, c, sb, T) => { const R = 42, C = 2 * Math.PI * R; T = T || d.reduce((a, x) => a + x[1], 0) || 1; let o = 0; return `<svg viewBox="0 0 120 120" width="132" height="132" role="img"><circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--sp)" stroke-width="14"/>${d.map((x) => { const l = (x[1] / T) * C, e = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="var(${x[2]})" stroke-width="14" stroke-dasharray="${l} ${C - l}" stroke-dashoffset="${-o}" transform="rotate(-90 60 60)"><title>${E(x[0])} ${x[1]}</title></circle>`; o += l; return e; }).join('')}<text x="60" y="59" text-anchor="middle" fill="var(--ink)" style="font:500 18px var(--m)">${c}</text><text x="60" y="75" text-anchor="middle" fill="var(--mu)" style="font:11px var(--m)">${sb}</text></svg>`; };
const line = (v, lb, c) => { const W = 300, H = 130, p = 22, mx = Math.max(...v), mn = Math.min(...v), x = (i) => (v.length < 2 ? W / 2 : p + (i * (W - 2 * p)) / (v.length - 1)), y = (a) => H - p - (mx == mn ? 0.5 : (a - mn) / (mx - mn)) * (H - 2 * p - 8), pts = v.map((a, i) => x(i) + ',' + y(a)).join(' '); return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"><line x1="${p}" y1="${H - p + 6}" x2="${W - p}" y2="${H - p + 6}" stroke="var(--l2)"/><polyline points="${pts}" fill="none" stroke="var(${c})" stroke-width="2"/>${v.map((a, i) => `<circle cx="${x(i)}" cy="${y(a)}" r="3.5" fill="var(${c})"><title>Rev ${lb[i]}: ${a}</title></circle><text x="${x(i)}" y="${y(a) - 8}" text-anchor="middle" fill="var(--ink)" style="font:10px var(--m)">${a}</text><text x="${x(i)}" y="${H - 5}" text-anchor="middle" fill="var(--mu)" style="font:10px var(--m)">${lb[i]}</text>`).join('')}</svg>`; };
const gauge = (p, c, sb) => { const C = Math.PI * 50; return `<svg viewBox="0 0 120 80" width="150" role="img"><path d="M10 64A50 50 0 0 1 110 64" fill="none" stroke="var(--sp)" stroke-width="12"/><path d="M10 64A50 50 0 0 1 110 64" fill="none" stroke="var(${c})" stroke-width="12" stroke-dasharray="${(p / 100) * C} ${C}"/><text x="60" y="56" text-anchor="middle" fill="var(--ink)" style="font:500 18px var(--m)">${p}%</text><text x="60" y="77" text-anchor="middle" fill="var(--mu)" style="font:11px var(--m)">${sb}</text></svg>`; };

V.db = () => {
  const r = curRev(), ty = r ? r.types : {}, tq = POOL ? POOL.tqs : [];
  const ob = tq.filter((t) => t.sev === 'block' && (t.status === 'open' || t.status === 'review')).length, ow = tq.filter((t) => t.sev === 'warn' && t.status === 'open').length, dcd = tq.filter((t) => t.status === 'decided').length, rs = tq.filter((t) => t.status === 'resolved').length;
  const placed = RES ? RES.stats.signals : 0, total = r ? r.signals : 0;
  const cap = RES ? RES.H.bc * RES.H.pc : 1;
  const cm = RES ? RES.ciocs.map((c) => { const t = {}; RES.placements.filter((p) => p.cab === c.cab && p.cioc === c.cioc).forEach((p) => (t[p.type] = (t[p.type] || 0) + 1)); return `<div class="br" style="grid-template-columns:80px 1fr 36px"><span class="mono">${cabName(c.cab)}/${c.cioc + 1}</span><div style="display:flex;height:10px">${Object.entries(t).map(([k, x]) => `<u style="width:${(x / cap) * 100}%;background:var(${col(k)})" title="${E(k)} ${x}"></u>`).join('')}</div><span class="mono">${c.n}</span></div>`; }).join('') : '<span class="mu">Allocate to see CIOC makeup.</span>';
  const fz = S.fz;
  return `<h1 style="font-size:1.6rem">Live dashboard</h1><p class="lead"><span class="live"></span>Updates as you load data, decide TQs and allocate.</p>`
    + kp([[total, 'signals'], [total ? Math.round(((placed + (RES ? RES.unplaced.length : 0)) / total) * 100) + '%' : '0%', 'placed or TQ’d'], [RES ? RES.stats.cabinets : 0, 'cabinets'], [RES ? RES.stats.ciocs : 0, 'CIOCs'], [(RES ? RES.stats.fill : 0) + '%', 'CHARM fill'], [ob + ow, 'open TQs'], [RES ? RES.check.violations : '–', 'violations']])
    + `<div class="g3">` + pn('Allocation and CHARM fill', `<div class="dn" style="justify-content:space-around">${gauge(total ? Math.round((placed / total) * 100) : 0, '--ok', 'placed')}${gauge(RES ? RES.stats.fill : 0, '--ac', 'CHARM fill')}</div>`)
    + pn('Signals by type', `<div class="dn">${donut(Object.entries(ty).map((a) => [a[0], a[1], col(a[0])]), total, 'signals')}<div class="leg" style="flex-direction:column;margin:0;gap:6px">${Object.entries(ty).map((a) => `<span><i style="background:var(${col(a[0])})"></i>${E(a[0])} ${a[1]}</span>`).join('')}</div></div>`)
    + pn('TQ status', `<div class="dn">${donut([['Open blocking', ob, '--er'], ['Open warnings', ow, '--wn'], ['Decided', dcd, '--ac'], ['Resolved', rs, '--ok']], ob + ow, 'open TQs', tq.length || 1)}<div class="leg" style="flex-direction:column;margin:0;gap:6px"><span><i style="background:var(--er)"></i>Open blocking ${ob}</span><span><i style="background:var(--wn)"></i>Open warnings ${ow}</span><span><i style="background:var(--ac)"></i>Decided ${dcd}</span><span><i style="background:var(--ok)"></i>Resolved ${rs}</span></div></div>`)
    + (POOL && POOL.revs.length ? pn('Signals across revisions', line(POOL.revs.map((q) => q.signals), POOL.revs.map((q) => q.k), '--ac')) : '')
    + `</div><div class="g2">` + pn('CIOC makeup <span class="mu">signals by type per CIOC</span>', `<div style="max-height:360px;overflow:auto">${cm}</div>`)
    + pn('Fuzz test <span class="mu">generated projects through the real engine and checker</span>', `<div style="font:500 2rem var(--m)">${fz ? fz.runs : 0}<span class="mu" style="font-size:1rem"> / 100 projects</span></div><div style="height:4px;background:var(--sp);margin:10px 0"><i style="display:block;height:100%;width:${fz ? fz.runs : 0}%;background:${fz && fz.violations ? 'var(--er)' : 'var(--ok)'}"></i></div><div class="row"><span class="tag ${fz && fz.violations ? 'e' : 'g'}">${fz ? fz.violations : 0} violations</span>${fz ? `<span class="mu mono">${fz.signals} signals · ${fz.tqs} TQs raised</span>` : ''}<button class="btn s" data-a="fz" ${fz && fz.running ? 'disabled' : ''}>${fz && fz.running ? 'Running…' : 'Run fuzz test'}</button></div>`)
    + `</div>` + pn('Event log', `<div class="log">${(POOL ? POOL.audit.slice(0, 30) : []).map((a) => `<div><span>${when(a.at)}</span>${E(a.who)} · ${E(a.action)} ${a.id ? E(a.id) : ''} ${E(a.label)}</div>`).join('') || S.lg.map((l) => `<div><span>${l[0]}</span>${E(l[1])}</div>`).join('') || '<span class="mu">No events yet.</span>'}</div>`);
};

// Home and library
const stage = (p) => (!p.st.ld ? ['No data yet', ''] : !p.st.al ? ['Ready to allocate', 'w'] : ['Allocated', 'g']);
V.home = () => {
  const rc = [...L].sort((a, b) => b.ts - a.ts).slice(0, 4), t = ['AI', 'AI', 'DI', 'DI', 'DI', 'DO', 'AO', 'DOI'];
  return `<div class="wl"><div class="logo" style="padding:0 0 18px;border:0"><div class="mk"></div>SIGNAL SUDOKU</div><div class="hero"><div><h1>Every signal.<br>One right slot.</h1><p class="lead">Create a project, load your IO list, confirm the column map, decide what the data scan raises, then allocate. Anything unclear becomes a TQ for you to decide.</p></div><div class="mx">${Array.from({ length: 96 }, (_, i) => `<i class="t f" style="--c:var(${col(t[(i * 7) % 8])});--d:${((i % 12) + Math.floor(i / 12)) * 40}ms"></i>`).join('')}</div></div>
  <div class="g2 fm">` + pn('New project', `<label>Project name<input id="pn" placeholder="e.g. Refinery Unit 10"></label><label>Customer or site <span class="mu">(optional)</span><input id="pc"></label><div class="sec">Cabinet hierarchy</div><div class="hi"><label>CIOCs per cabinet<input type="number" min="1" id="h1" value="4"></label><label>Baseplates per CIOC<input type="number" min="1" id="h2" value="8"></label><label>CHARMs per baseplate<input type="number" min="1" id="h3" value="12"></label></div><div class="row"><button class="btn p" data-a="pnew">Create project</button><button class="btn" data-a="pnew" data-v="s">Try with sample data</button></div>`)
    + pn(`Recent projects <span class="mu">${L.length}</span><span class="sp1 row"><button class="btn s" data-a="go" data-v="lib">Open library</button></span>`, rc.length ? rc.map((p) => `<div class="pr"><div class="i"><b>${E(p.name)}</b><div class="mu" style="font-size:12px">${E(p.cust || 'No customer')} · ${stage(p)[0]} · ${day(p.ts)}</div></div><button class="btn s p" data-a="popen" data-v="${E(p.id)}">Open</button></div>`).join('') : '<span class="mu">No projects yet. Create your first one on the left.</span>') + `</div></div>`;
};
function lg() {
  const q = S.q.toLowerCase(), a = L.filter((p) => (p.name + ' ' + p.cust).toLowerCase().includes(q)).sort(S.so == 'n' ? (x, y) => x.name.localeCompare(y.name) : (x, y) => y.ts - x.ts);
  return a.length ? a.map((p) => { const g = stage(p), h = p.st.h; return `<div class="card ${p.id == S.proj ? 'cur' : ''}"><div class="row"><b>${E(p.name)}</b>${p.id == S.proj ? '<span class="tag h sp1">Open</span>' : ''}</div><div class="mu" style="font-size:12.5px">${E(p.cust || 'No customer')}</div><div class="row"><span class="tag ${g[1]}">${g[0]}</span><span class="mono mu">${p.st.n || 0} signals${p.st.rev ? ' · Rev ' + E(p.st.rev) : ''}</span></div><div class="mono mu">${h.cc} CIOC × ${h.bc} BP × ${h.pc} CHARM · ${day(p.ts)}</div><div class="row" style="margin-top:auto"><button class="btn s p" data-a="popen" data-v="${E(p.id)}">Open</button><button class="btn s" data-a="pdup" data-v="${E(p.id)}">Duplicate</button><button class="btn s" data-a="pdel" data-v="${E(p.id)}">${S.dc == p.id ? 'Confirm delete' : 'Delete'}</button></div></div>`; }).join('') : `<div class="pn" style="grid-column:1/-1"><div class="pb mu">${L.length ? 'No projects match your search.' : 'No projects yet.'}</div></div>`;
}
V.lib = () => `<h1 style="font-size:1.6rem">Project library</h1><p class="lead">Every project you have created. Open one to continue where you left off, duplicate it as a starting point, or delete it.</p><div class="row" style="margin-bottom:16px"><input class="w" id="lq" placeholder="Search by name or customer" value="${E(S.q)}"><select id="lso" aria-label="Sort"><option value="r">Recently updated</option><option value="n" ${S.so == 'n' ? 'selected' : ''}>Name A to Z</option></select><button class="btn p" data-a="go" data-v="home">+ New project</button></div><div class="lib" id="lg">${lg()}</div>`;

// ---------- shell ----------
const NAV = [['home', 'Home'], ['lib', 'Library'], ['up', 'Upload'], ['ru', 'Rules'], ['re', 'Allocation'], ['rv', 'Revise'], ['db', 'Live dashboard']];
function render() {
  sv();
  document.body.classList.toggle('hm', S.v == 'home');
  const pj = P(), ot = openTqs().length;
  $('#pj').innerHTML = pj ? `<span class="mu">Project</span><b>${E(pj.name)}</b><span class="mu">${E(pj.cust)}</span>` : '<span class="mu">No project open</span>';
  $('#nav').innerHTML = NAV.map((n, i) => `${i == 2 ? '<hr>' : ''}<button ${i > 1 && !S.proj ? 'disabled' : ''} class="${S.v == n[0] ? 'on' : ''}" data-a="go" data-v="${n[0]}">${n[1]}${n[0] == 're' && ot ? `<i>${ot}</i>` : ''}</button>`).join('');
  $('#cr').innerHTML = `Project <b>${pj ? E(pj.name) : 'none'}</b> / <b>${NAV.find((n) => n[0] == S.v)[1]}</b>`;
  $('#rsel').innerHTML = (POOL ? POOL.revs : []).map((x) => `<option value="${E(x.k)}" ${S.rev == x.k ? 'selected' : ''}>Rev ${E(x.k)}</option>`).join('') || '<option>No data</option>';
  const r = curRev();
  $('#rs').innerHTML = `<span class="live"></span><b>Data pool</b> server<br>${r ? r.signals : 0} signals · Rev <b>${r ? E(r.k) : '-'}</b><br>${live().filter((x) => x.on).length} rules active · ${ot} open TQs<br>${RES ? RES.check.violations + ' unack. violations' : 'not allocated'}<br><label class="mu" style="display:block;margin-top:6px">Your name<input id="usr" value="${E(user())}" style="width:100%;margin-top:2px;padding:3px 6px"></label>`;
  $('#v').innerHTML = V[S.v]();
  drawM();
}

function drawM() {
  if (!MODAL) { $('#md').innerHTML = ''; return; }
  const o = blocking();
  $('#md').innerHTML = `<div class="ov" data-a="xm"><div class="mdl" data-a="noop" role="dialog" aria-label="TQs to decide"><div class="ph">Decide these TQs before allocating <span class="tag ${o.length ? 'e' : 'g'}">${o.length} blocking</span><button class="btn s sp1" data-a="xm">Close</button></div><div class="mb"><p class="mu" style="margin:0">These make placement ambiguous. Warnings don’t stop allocation; they proceed with their stated default and stay in the TQ list.</p>${o.map((t, k) => `<div class="tqc ${MODAL.an ? 'n' : ''}" style="--d:${k * 120 + 80}ms"><div class="row"><span class="mono mu">${E(t.id)}</span>${stTag(t)}<span class="mono mu sp1">${E(t.clash)} · ${t.count} signals</span></div>${tqBody(t, true)}</div>`).join('') || `<p class="ok" style="margin:12px 0 0">Every blocking TQ has a decision. You can allocate now.</p>`}</div><div class="pb row" style="border-top:1px solid var(--ln)"><button class="btn p" data-a="al" ${o.length || BUSY ? 'disabled' : ''}>Run allocation</button><button class="btn" data-a="mtq">Open TQ list</button><button class="btn sp1" data-a="xm">Not now</button></div></div></div>`;
  MODAL.an = 0;
}

// ---------- uploads ----------
const b64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Could not read ' + f.name)); r.readAsDataURL(f); });
async function upload(files, mode) {
  files = [...files].filter((f) => /\.(xlsx|xls|xlsm|csv)$/i.test(f.name));
  if (!files.length) return toast('Choose .xlsx, .xls, .xlsm or .csv files');
  if (files.reduce((a, f) => a + f.size, 0) > 28e6) return toast('Files too large (28 MB total max)');
  BUSY = 'Reading ' + files.map((f) => f.name).join(', ') + '…'; render();
  try {
    const body = { files: await Promise.all(files.map(async (f) => ({ name: f.name, b64: await b64(f) }))) };
    startIng(await api('POST', purl('/ingest/preview'), body), mode);
  } catch (e) { toast(e.message); }
  BUSY = ''; render();
}
function startIng(d, mode) {
  const inc = {};
  d.files.forEach((f) => f.sheets.forEach((s) => s.sig && (inc[f.name + '/' + s.name] = !!s.include)));
  ING = { mode, data: d, inc, maps: d.mappings.map((m) => ({ ...m, map: { ...m.map }, auto: { ...m.map } })) };
  log('Read ' + d.files.map((f) => f.name).join(', ') + ' for column mapping');
}

// ---------- actions ----------
// Take an allocation response: held (show the blocking TQs) or a new result.
function took(r, stay) {
  POOL = r.pool;
  if (r.blocked) { MODAL = { an: 1 }; log(`Allocation held: ${r.blocking.length} blocking TQs`); return; }
  RES = r; S.al = 1; S.akey = akey(); MODAL = null;
  if (!stay) { S.rt = (r.manualQueue || []).length ? 'mp' : 'map'; S.cab = 0; }
  log(`Allocated ${r.stats.signals} signals into ${r.stats.cabinets} cabinets, checker: ${r.check.violations} violations`);
  if (!stay) toast(`Allocated ${r.stats.signals} signals. ${(r.manualQueue || []).length ? r.manualQueue.length + ' waiting for manual placement. ' : ''}${r.check.violations} unacknowledged violations.`);
}
let scanT = 0;
const rescan = () => { clearTimeout(scanT); if (!S.ld) return; scanT = setTimeout(async () => { try { POOL = await api('POST', purl('/scan'), ctx()); render(); } catch (e) { toast(e.message); } }, 400); };

const A = {
  async pnew(v) {
    const g = (i) => Math.max(1, +$('#h' + i).value || 1), st = cl(DEF);
    st.h = { cc: g(1), bc: g(2), pc: g(3) };
    const p = { id: Date.now().toString(36), name: $('#pn').value.trim() || (v ? 'Sample refinery' : 'Untitled project'), cust: $('#pc').value.trim(), ts: Date.now(), st };
    L.push(p);
    await api('PUT', '/api/projects/' + p.id, p).catch(() => toast('Could not save to the server'));
    await A.popen(p.id);
    if (v) A.smp();
  },
  async popen(id) {
    sv();
    Object.assign(S, cl(DEF), cl(L.find((p) => p.id == id).st), { proj: id, v: 'up', js: 0, lg: [], fz: null });
    POOL = RES = ING = MODAL = null;
    log('Opened project');
    scrollTo(0, 0);
    await loadPool();
    if (S.ld) S.v = 're';
    render();
  },
  pdup(id) { sv(); const c = cl(L.find((p) => p.id == id)); c.copyOf = id; c.id = Date.now().toString(36); c.name += ' (copy)'; c.ts = Date.now(); L.push(c); api('PUT', '/api/projects/' + c.id, c).then(() => delete c.copyOf).catch(() => toast('Could not copy on the server')); render(); },
  pdel(id) { if (S.dc != id) { S.dc = id; render(); return; } L = L.filter((p) => p.id != id); clearTimeout(PT[id]); api('DELETE', '/api/projects/' + id).catch(() => toast('Could not delete on the server')); S.dc = 0; if (S.proj == id) { S.proj = 0; POOL = RES = null; } render(); },
  go(v, e) { S.dc = 0; MODAL = null; S.v = v; if (e.dataset.t) S.rt = e.dataset.t; scrollTo(0, 0); render(); },
  async smp() { BUSY = 'Generating sample workbook…'; render(); try { startIng(await api('POST', purl('/sample'), { kind: 'base' }), 'base'); S.v = 'up'; } catch (e) { toast(e.message); } BUSY = ''; render(); },
  async rsm() { BUSY = 'Generating sample revision…'; render(); try { startIng(await api('POST', purl('/sample'), { kind: 'rev' }), 'rev'); } catch (e) { toast(e.message); } BUSY = ''; render(); },
  ingx() { ING = null; render(); },
  async ingok() {
    const mappings = Object.fromEntries(ING.maps.map((m) => [m.sig, Object.fromEntries(Object.entries(m.map).filter(([, h]) => h))]));
    const mode = ING.mode;
    BUSY = 'Loading and scanning…'; render();
    try {
      POOL = await api('POST', purl('/ingest/commit'), { uploadId: ING.data.uploadId, mappings, include: ING.inc, ...ctx() });
      ING = null; RES = null; S.al = 0;
      syncMeta();
      S.rev = curRev().k;
      log(`Loaded Rev ${curRev().k}: ${curRev().signals} signals`);
      toast(`Rev ${curRev().k} loaded. ${blocking().length} blocking TQs, ${openTqs().length - blocking().length} warnings.`);
      S.v = mode === 'rev' ? 'rv' : 'up';
    } catch (e) { toast(e.message); }
    BUSY = ''; render();
  },
  tg(i) { S.rules[i].on ^= 1; log((S.rules[i].on ? 'Enabled: ' : 'Disabled: ') + S.rules[i].n); render(); rescan(); },
  hs(i) { S.rules[i].h ^= 1; render(); rescan(); },
  mv(i, e) { i = +i; const j = i + +e.dataset.d, R = S.rules; if (j >= 0 && j < R.length) { [R[i], R[j]] = [R[j], R[i]]; log('Priority changed: ' + R[j].n); } render(); rescan(); },
  del(i) { log('Deleted rule: ' + S.rules[i].n); S.rules.splice(i, 1); render(); rescan(); },
  acc(i) { const r = S.rules[i]; if (!r) return; delete r.draft; delete r.pv; log('Accepted rule: ' + r.n); toast('Rule added: ' + r.n); render(); rescan(); },
  rej(i) { const r = S.rules[i]; if (!r) return; S.rules.splice(i, 1); log('Rejected draft: ' + r.n); render(); },
  eg(name, e) { DR.name = name; DR.desc = e.dataset.d || ''; DR.msg = ''; render(); },
  async drf() {
    DR.name = $('#rn').value.trim(); DR.desc = $('#rdsc').value.trim();
    if (!DR.name && !DR.desc) { DR.msg = 'Give the rule a name and say what it must do.'; DR.err = 1; render(); return; }
    DR.busy = 1; DR.msg = ''; render();
    try {
      const r = await api('POST', '/api/rules/draft', { name: DR.name, description: DR.desc, hw: S.hw, h: S.h, project: S.proj });
      if (r.supported) { S.rules.push({ ...r.rule, ...(r.preview ? { pv: r.preview } : {}) }); DR.name = DR.desc = ''; log('Drafted rule: ' + r.rule.n); }
      else { DR.msg = 'Could not draft this as an enforceable rule: ' + r.reason; DR.err = 0; }
    } catch (e) { DR.msg = e.message; DR.err = 1; }
    DR.busy = 0; render();
  },
  js() { S.js ^= 1; render(); },
  jsap() { try { const m = applyRulesDoc(JSON.parse($('#jsn').value)); log('Imported ' + m + ' from JSON'); toast('Imported ' + m); render(); rescan(); } catch (e) { toast('Invalid rules JSON: ' + (e.message || 'could not parse')); } },
  hwa() { const k = $('#hwk').value.trim().toUpperCase(); if (!k) return; S.hw[k] = [$('#hwc').value.trim() || 'CHARM ' + k, $('#hwt').value.trim() || 'TB']; log('Added IO type ' + k); render(); rescan(); },
  hwd(k) { delete S.hw[k]; log('Removed IO type ' + k); render(); rescan(); },
  async dc(fp, e) {
    const box = e.closest('.tqx'), opt = box.querySelector('[data-tqsel]').value, c = box.querySelector('[data-tqc]');
    try {
      const before = POOL.tqs.find((x) => x.fp === fp), o = before && before.options.find((x) => x.id === opt);
      POOL = await api('POST', purl('/tqs/decide'), { fp, opt, comment: c ? c.value : '', ...ctx() });
      const t = POOL.tqs.find((x) => x.fp === fp);
      log(`${t.id}: ${t.decision ? t.decision.label : 'decided'}`);
      // "Turn the rule off" / "Make it soft" change the rule table itself
      const rule = o && o.rule && S.rules.find((x) => x.k === o.rule);
      if (o && o.act && rule) {
        if (o.act === 'off') rule.on = 0; else rule.h = 0;
        log(`${o.act === 'off' ? 'Turned off' : 'Made soft'}: ${rule.n}`);
        toast(`${rule.n} is now ${o.act === 'off' ? 'off' : 'soft'}. Re-allocate to apply.`);
        rescan();
      } else if (opt === 'manual') toast(`${t.count} signal${t.count > 1 ? 's' : ''} will wait in Manual placement after you allocate.`);
    } catch (x) { toast(x.message); }
    render();
  },
  async ro(fp) { try { POOL = await api('POST', purl('/tqs/reopen'), { fp, who: user() }); } catch (x) { toast(x.message); } render(); },
  async al() {
    if (!S.ld) return;
    BUSY = 'Allocating…'; render();
    try { took(await api('POST', purl('/allocate'), ctx())); } catch (e) { toast(e.message); }
    BUSY = ''; render();
  },
  async hint(fp) {
    HB.add(fp); render();
    try { POOL = await api('POST', purl('/tqs/hint'), { fp, ...ctx() }); } catch (e) { toast(e.message); }
    HB.delete(fp); render();
  },
  mps(tag) { Object.assign(MP, { tag, pos: null, res: null }); const x = (RES.manualPlaced || []).find((y) => y.tag === tag); if (x) MP.cab = x.cab; render(); },
  mpx() { Object.assign(MP, { tag: null, pos: null, res: null }); render(); },
  mpcab(i) { MP.cab = +i; MP.pos = null; MP.res = null; render(); },
  async mpc(v) {
    const [cab, cioc, bp, ch] = v.split('/').map(Number);
    Object.assign(MP, { pos: { cab, cioc, bp, ch }, res: null, busy: 1 }); render();
    try { MP.res = await api('POST', purl('/manual/check'), { tag: MP.tag, pos: MP.pos, ...ctx() }); } catch (e) { MP.res = { ok: false, reason: e.message }; }
    MP.busy = 0; render();
  },
  async mpok() {
    if (!MP.tag || !MP.pos) return;
    const tag = MP.tag;
    BUSY = 'Placing…'; render();
    try {
      took(await api('POST', purl('/manual/place'), { tag, pos: MP.pos, ...ctx() }), true);
      log(`Placed ${tag} by hand`); toast(`${tag} placed. The checker re-verified the layout.`);
      Object.assign(MP, { tag: null, pos: null, res: null });
    } catch (e) { toast(e.message); }
    BUSY = ''; render();
  },
  async mprm(tag) {
    BUSY = 'Updating…'; render();
    try { took(await api('POST', purl('/manual/remove'), { tag, ...ctx() }), true); log(`${tag} back in the manual queue`); } catch (e) { toast(e.message); }
    BUSY = ''; render();
  },
  async rvd() { try { POOL = await api('DELETE', purl('/revs/last'), {}); await loadPool(); log('Removed the latest revision'); } catch (e) { toast(e.message); } render(); },
  rt(v) { S.rt = v; render(); }, cb(i) { S.cab = +i; render(); }, tf(v) { S.tqf = v; render(); },
  rev(v) { S.rev = v; render(); },
  mtq() { MODAL = null; S.v = 're'; S.rt = 'tq'; S.tqf = 'open'; render(); }, xm() { MODAL = null; drawM(); }, noop() {},
  xr() {
    if (!S.proj) return;
    const r = curRev();
    download(`rules-${slug(P() && P().name)}${r ? '-rev-' + r.k : ''}.json`, JSON.stringify(rulesDoc(), null, 2), 'application/json');
    log('Exported rules.json');
  },
  xl() { if (!RES) return toast('Allocate first, then export'); location.href = purl('/export.csv?pat=' + encodeURIComponent(S.pat)); log('Exported allocation CSV'); },
  async fz() {
    S.fz = { runs: 0, violations: 0, signals: 0, tqs: 0, running: 1 }; render();
    try {
      for (let b = 0; b < 4; b++) {
        const r = await api('POST', '/api/fuzz', { n: 25, start: 1 + b * 25 * 7919 });
        Object.assign(S.fz, { runs: S.fz.runs + r.runs, violations: S.fz.violations + r.violations, signals: S.fz.signals + r.signals, tqs: S.fz.tqs + r.tqs });
        if (S.v === 'db') render();
      }
      log(`Fuzz run: ${S.fz.runs} generated projects, ${S.fz.violations} violations`);
    } catch (e) { toast(e.message); }
    S.fz.running = 0; render();
  },
};

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-a]');
  if (!a || !A[a.dataset.a] || a.dataset.a === 'noop') return; // clicks inside the modal body stay there
  e.preventDefault();
  A[a.dataset.a](a.dataset.v, a);
});
document.addEventListener('input', (e) => {
  if (e.target.id == 'lq') { S.q = e.target.value; $('#lg').innerHTML = lg(); }
  const h = e.target.dataset.h;
  if (h) { const [k, i] = h.split(':'); S.hw[k][i] = e.target.value; sv(); }
  if (e.target.id == 'pat') { S.pat = e.target.value; $('#pv').textContent = nm(0, 0); sv(); }
  if (e.target.id == 'usr') setUser(e.target.value);
  if (e.target.id == 'rn') DR.name = e.target.value;
  if (e.target.id == 'rdsc') DR.desc = e.target.value;
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id == 'lso') { S.so = t.value; $('#lg').innerHTML = lg(); }
  if (t.id == 'file') { upload(t.files, 'base'); t.value = ''; }
  if (t.id == 'rfile') { upload(t.files, 'rev'); t.value = ''; }
  if (t.dataset.mf && ING) { const [i, f] = t.dataset.mf.split(':'); ING.maps[+i].map[f] = t.value; render(); }
  if (t.dataset.inc && ING) { ING.inc[t.dataset.inc] = t.checked; render(); }
  if (t.id == 'rsel') A.rev(t.value);
  if (t.id == 'rjf' && t.files[0]) {
    const f = t.files[0]; t.value = '';
    if (f.size > 2e6) { toast('rules.json is too large'); return; }
    f.text().then((x) => { const m = applyRulesDoc(JSON.parse(x)); log('Imported ' + m + ' from ' + f.name); toast('Imported ' + m); render(); rescan(); })
      .catch((e) => toast('Could not import ' + f.name + ': ' + (e.message || 'invalid JSON')));
  }
});
['dragover', 'dragleave', 'drop'].forEach((v) => document.addEventListener(v, (e) => {
  const z = e.target.closest && e.target.closest('#drop,#rdrop');
  if (!z) return;
  e.preventDefault();
  z.classList.toggle('dg', v === 'dragover');
  if (v === 'drop') upload(e.dataTransfer.files, z.id === 'rdrop' ? 'rev' : 'base');
}));
const tip = $('#tip');
document.addEventListener('mousemove', (e) => {
  const c = e.target.closest && e.target.closest('.c, [data-tip]');
  const t = c && (c.dataset.t || c.dataset.tip);
  if (!t) { tip.style.display = 'none'; return; }
  tip.innerHTML = c.dataset.t ? t.split('|').map(E).join('<br>') : E(t);
  tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 14, innerWidth - 260) + 'px'; tip.style.top = e.clientY + 14 + 'px';
});
// Enter / Space on clickable CHARMs (manual placement) acts like a click
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && t.getAttribute && t.getAttribute('role') === 'button' && t.dataset.a && A[t.dataset.a]) { e.preventDefault(); A[t.dataset.a](t.dataset.v, t); }
});
// keyboard users get the same rule explanation on focus
document.addEventListener('focusin', (e) => { const t = e.target.dataset && e.target.dataset.tip; if (!t) return; const b = e.target.getBoundingClientRect(); tip.textContent = t; tip.style.display = 'block'; tip.style.left = Math.min(b.left, innerWidth - 360) + 'px'; tip.style.top = b.bottom + 6 + 'px'; });
document.addEventListener('focusout', () => (tip.style.display = 'none'));
addEventListener('pagehide', () => { const p = P(); if (p) { p.st = snap(); navigator.sendBeacon('/api/projects/' + p.id, new Blob([JSON.stringify(p)], { type: 'application/json' })); } });

log('Session started');
render();
