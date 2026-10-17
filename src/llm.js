'use strict';
// LLM rule drafter: rule name + plain-English description -> a rule in the schema of src/rules.js.
// It never chats: one request in, one rule (or a reason it cannot be expressed) out.
// Only rule text and project metadata (IO types, group names, tag prefixes) are sent, never signal rows.
//
// Config (environment variables):
//   LLM_API_KEY         required (OPENAI_API_KEY or ANTHROPIC_API_KEY also work)
//   LLM_PROVIDER        openai | anthropic; default: anthropic for sk-ant-... keys, otherwise openai
//   LLM_MODEL           default gpt-4.1-mini (openai) / claude-haiku-5-5 (anthropic)
//   LLM_URL             override the endpoint (proxy, Azure OpenAI, a local mock)
const RU = require('./rules');
const coderules = require('./coderules');

const KEY = () => process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const PROVIDER = () => (process.env.LLM_PROVIDER || (KEY().startsWith('sk-ant-') || (!process.env.OPENAI_API_KEY && !process.env.LLM_API_KEY && process.env.ANTHROPIC_API_KEY) ? 'anthropic' : 'openai')).toLowerCase();
const MODEL = () => process.env.LLM_MODEL || (PROVIDER() === 'anthropic' ? 'claude-haiku-5-5' : 'gpt-4.1-mini');
const URL_ = () => process.env.LLM_URL || (PROVIDER() === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions');

function system(ctx) {
  return `You convert an engineer's rule for DeltaV IO allocation into JSON. You do not chat. Reply with one JSON object and nothing else.

Hardware: Cabinet -> CIOC (${ctx.h.cc} per cabinet) -> Baseplate (${ctx.h.bc} per CIOC) -> CHARM (${ctx.h.pc} per baseplate, 1 signal each).
Each signal has fields: type (IO type), grp (process group), seg (segregation A or B), cable, tag.
IO types in this project: ${ctx.types.join(', ') || 'AI, AO, DI, DO, DOI'}.
Groups in this project: ${ctx.groups.length ? ctx.groups.join(', ') : 'unknown'}.
Common tag prefixes: ${ctx.prefixes.length ? ctx.prefixes.join(', ') : 'unknown'}.
Built-in rules already exist (do not recreate them): A and B of the same group never share a CIOC; each group in its own CIOCs; 10% spare per baseplate; cable pairs kept together; each group fits in one cabinet.

A selector picks signals: {"field": "type"|"grp"|"seg"|"cable"|"tag", "op": "in"|"prefix", "values": [..], "not": true (optional)}.
Use op "prefix" for tag families (e.g. pumps tagged P-..., use the prefixes listed above when they fit).

Rule types (pick exactly one):
- separate: {"type":"separate","a":SEL,"b":SEL,"scope":"cioc"|"baseplate"}  signals in a and b never share a scope
- exclusive: {"type":"exclusive","a":SEL,"scope":"cioc"|"baseplate"}  a gets scopes of its own, nothing else in them
- limit: {"type":"limit","a":SEL or null,"max":N,"scope":"baseplate"|"cioc"}  at most N matching signals per scope
- together: {"type":"together","a":SEL or null,"by":FIELD or null,"scope":"cioc"|"cabinet"}  matching signals share one scope; with "by", one scope per distinct value of that field
- spare: {"type":"spare","percent":N}  at least N% of CHARMs per baseplate stay free

Output, when the rule fits a type (always prefer this):
{"supported": true, "kind": "schema", "spec": {...}, "hard": true|false, "name": "short rule name"}

Only when no type above can express the rule, write a checking function instead:
{"supported": true, "kind": "code", "code": "function check(placements, H) { ... }", "summary": "one sentence: what the code flags", "hard": true|false, "name": "short rule name"}
The function receives placements: [{tag, type, grp, seg, cable, pair, cab, cioc, bp, ch}] (positions are 0-based numbers: cabinet, CIOC within cabinet, baseplate within CIOC, CHARM within baseplate) and H: {cc, bc, pc}.
It returns an array with one entry per violation: {"tags": [tags of the signals involved], "message": "short reason"}. Return [] when nothing is broken.
Code rules: plain JavaScript, pure and deterministic, no I/O, no require/import, no eval/Function/constructor/prototype/globalThis/process, no timers. Use only Array, Object, Map, Set, Math, String, Number, JSON. Keep it O(n log n) for 20,000 placements. Code rules do not steer placement; they flag signals after allocation so the engineer can place them by hand.

"hard" is true for must/never/always wording, false for prefer/try/ideally wording.
When it cannot be expressed either way, or it is ambiguous:
{"supported": false, "reason": "one sentence on what is missing"}

Examples:
"Never mix AI and DI in one CIOC" -> {"supported":true,"spec":{"type":"separate","a":{"field":"type","op":"in","values":["AI"]},"b":{"field":"type","op":"in","values":["DI"]},"scope":"cioc"},"hard":true,"name":"Never mix AI and DI in one CIOC"}
"Keep each unit in one cabinet" (units are the process groups) -> {"supported":true,"spec":{"type":"together","a":null,"by":"grp","scope":"cabinet"},"hard":true,"name":"Keep each unit in one cabinet"}
"Reserve 20% spare per baseplate" -> {"supported":true,"spec":{"type":"spare","percent":20},"hard":true,"name":"Reserve 20% spare per baseplate"}
"Isolated outputs get their own baseplates" -> {"supported":true,"spec":{"type":"exclusive","a":{"field":"type","op":"in","values":["DOI"]},"scope":"baseplate"},"hard":true,"name":"Isolated outputs on their own baseplates"}
"No more than 6 DO on a baseplate" -> {"supported":true,"spec":{"type":"limit","a":{"field":"type","op":"in","values":["DO"]},"max":6,"scope":"baseplate"},"hard":true,"name":"Max 6 DO per baseplate"}
"Analog inputs only on the first four CHARMs of a baseplate" -> {"supported":true,"kind":"code","code":"function check(placements, H) { return placements.filter(p => p.type === 'AI' && p.ch > 3).map(p => ({ tags: [p.tag], message: 'AI beyond CHARM 4' })); }","summary":"Flags AI signals placed on CHARM 5 or later of a baseplate.","hard":true,"name":"AI only on CHARMs 1-4"}
"Put the fire and gas signals in the north cabinet" -> {"supported":false,"reason":"Cabinets have no names or locations here, so a specific cabinet cannot be chosen."}`;
}

function parse(text) {
  const t = String(text || '').replace(/```(json)?/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('No JSON in the reply');
  return JSON.parse(t.slice(a, b + 1));
}

async function call(messages, ctx) { return callWith(system(ctx), messages, 900, true); }
// json=true asks for a JSON object (rule drafting); hints are plain text.
async function callWith(sys, messages, maxTokens, json) {
  const key = KEY();
  if (!key) { const e = new Error('The rule drafter needs an LLM API key. Start the server with LLM_API_KEY set.'); e.code = 503; throw e; }
  const openai = PROVIDER() === 'openai';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(URL_(), {
      method: 'POST', signal: ac.signal,
      headers: openai
        ? { 'content-type': 'application/json', authorization: 'Bearer ' + key }
        : { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(openai
        ? { model: MODEL(), max_completion_tokens: maxTokens, temperature: 0, messages: [{ role: 'system', content: sys }, ...messages], ...(json ? { response_format: { type: 'json_object' } } : {}) }
        : { model: MODEL(), max_tokens: maxTokens, temperature: 0, system: sys, messages }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error('LLM request failed: ' + ((j.error && j.error.message) || r.status)); e.code = 502; throw e; }
    if (openai) return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  } catch (e) {
    if (e.name === 'AbortError') { const x = new Error('The LLM did not answer within 30 seconds'); x.code = 504; throw x; }
    throw e;
  } finally { clearTimeout(timer); }
}


// -> { supported: true, spec, hard, name, explain } | { supported: false, reason }
async function draft({ name, description, ctx }) {
  const prompt = `Rule name: ${name || '(none)'}\nWhat the rule must do: ${description || name}`;
  const messages = [{ role: 'user', content: prompt }];
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await call(messages, ctx);
    try {
      const out = parse(text);
      if (out.supported === false) return { supported: false, reason: String(out.reason || 'This rule cannot be expressed yet.').slice(0, 300) };
      const nm = String(out.name || name || '').trim().slice(0, 120);
      if (out.kind === 'code') {
        const code = coderules.screen(out.code);
        const [t] = await coderules.run([{ id: 't', code }], coderules.sample(), { cc: 4, bc: 8, pc: 12 }, 8000);
        if (t.error) throw new Error('the code does not run: ' + t.error);
        const summary = String(out.summary || '').trim().slice(0, 300);
        if (!summary) throw new Error('"summary" is missing');
        return { supported: true, kind: 'code', code, summary, hard: out.hard !== false, name: nm, explain: summary };
      }
      const spec = RU.validate(out.spec);
      return { supported: true, kind: 'schema', spec, hard: out.hard !== false, name: nm, explain: RU.explain(spec) };
    } catch (e) {
      lastErr = e.message;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That JSON is invalid: ${e.message}. Reply with the corrected JSON object only.` });
    }
  }
  return { supported: false, reason: `The drafted rule was not valid (${lastErr}). Try rewording it.` };
}

// A short pointer toward resolving a TQ from a user-added rule. Shown as an unverified hint; never applied.
async function hint({ h, rule, tq, options }) {
  const sys = `You help an engineer resolve a technical query (TQ) in DeltaV IO allocation. Hardware: cabinet -> CIOC (${h.cc} per cabinet) -> baseplate (${h.bc} per CIOC) -> CHARM (${h.pc} per baseplate). You do not fix anything and you do not chat. Reply with at most 3 short sentences of plain text: what probably causes the conflict and which direction to look (one of the listed options, where to place signals by hand, or how the rule could be reworded). Do not claim the problem is solved.`;
  const msg = `Rule: ${rule.name}\nWhat the user asked for: ${rule.description || '(no description)'}\nWhat the rule does: ${rule.definition || '(unknown)'}\nTQ: ${tq.title}\nSignals involved: ${tq.signals} (${Object.entries(tq.mix).map(([k, n]) => n + ' ' + k).join(', ')})\nOptions the engineer has: ${options.join('; ')}`;
  const text = await callWith(sys, [{ role: 'user', content: msg }], 300);
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600) || 'No hint available.';
}

module.exports = { draft, hint, system, parse };
