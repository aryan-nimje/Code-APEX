# Signal Sudoku

Node.js backend + web frontend. TQs are produced from the real uploaded IO list, not a fixed list.

## Run

    npm install          # one dependency: SheetJS (xlsx) for reading Excel on the server
    npm start            # http://localhost:3000   (PORT=4000 npm start to change)
    LLM_API_KEY=sk-... npm start          # enables the LLM rule drafter (OpenAI by default, gpt-4.1-mini)
    npm test             # checker tamper tests, TQ lifecycle tests, 200-project fuzz run
    npm run samples      # writes samples/clean_RevA.xlsx, clean_RevB, dirty_RevA, dirty_RevB

Requires Node 18+. If `cdn.sheetjs.com` is blocked on your network, `npm install xlsx@0.18.5` works too
(same API, but it has known advisories for crafted files, so prefer 0.20.3).

## Layout

    server.js             HTTP server + REST API (built-in http module)
    src/ingest.js         reads xlsx/xls/csv on the server, finds the header row, auto-maps columns
    src/detectors.js      checks that turn data problems into TQ findings (add new ones to DETECTORS)
    src/pool.js           TQ pool: fingerprints, lifecycle, decisions, audit log (data/pool/<project>.json)
    src/engine.js         decisions -> constraints, allocator, allocator-raised TQs, rule cost
    src/rules.js          custom rule schema: validation, selectors, plain-English explanation
    src/llm.js            LLM rule drafter (name + description -> schema rule or code rule) and TQ hints
    src/coderules.js      runs generated-code rules in the sandbox
    src/sandbox.js        sandbox child process (permission model, empty vm context, timeouts)
    src/checker.js        independent checker: re-verifies the final placements
    src/service.js        wires the above together for the API
    src/sample.js         sample workbook generator (clean, dirty, revisions)
    src/fuzz.js           fuzz harness: generated projects through the real engine + checker
    src/store.js          project list (data/projects.json)
    public/               frontend: index.html, styles.css, app.js

## How TQs work

1. **Ingest.** Uploaded workbooks are parsed on the server into one record per signal (tag, IO type,
   cable, pair, group, segregation, cable size), each remembering its file, sheet and spreadsheet row.
   Columns are auto-mapped by header name and content; the user confirms or overrides the map.
   Sheets with the same headers share one map; sheets without a tag column (notes, legends) are off by default.
2. **Detectors** run on the raw signals and return findings:
   duplicate tags, the same tag with different values (same sheet or across sheets), missing tags,
   missing or unknown IO types (no CHARM mapping), missing groups, bad segregation values, malformed tags,
   a cable pair claimed twice, more signals than cable pairs, cables mixing A/B or groups,
   decisions on signals deleted in a revision, and placed signals that moved in a revision.
3. **Allocator TQs.** When a hard rule cannot be met (a cable bigger than a CIOC, a group needing more
   CIOCs than a cabinet holds) the allocator raises a TQ instead of breaking the rule.
4. **Stable identity.** Each TQ is fingerprinted as `type:entity`, e.g. `pair-claimed-twice:CBL-114/7`.
   Re-scans update it instead of duplicating it. A revision that fixes the data resolves it ("Resolved by Rev C");
   if the problem returns it reopens; if its signals changed after a decision, the decision is flagged for review.
5. **Decisions change the result.** Options map to engine effects: exclude signals, override a field,
   merge duplicates (keep first/last), relax a rule for one cable or group, pin signals to their previous CIOC.
   Every decision records who, when and which revision; the audit trail and exceptions list come from these.
6. **Gating.** Blocking TQs stop allocation until decided. Warnings proceed with a stated default and stay listed.
   A clash involving a soft rule becomes a warning whose default relaxes the lowest-priority soft rule.
7. **Independent checker.** After allocation, every placement is re-verified: capacity, every signal placed or
   TQ'd, CHARM for every IO type, A/B, grouping, spare, cable-together, group-in-one-cabinet and pins.
   A break covered by a logged decision is an accepted exception; anything else is a violation.

## Rules the engine enforces

| Key | Rule |
|---|---|
| ab | A and B of the same group never share a CIOC |
| group | a CIOC holds one process group |
| spare | 10% of CHARMs per baseplate stay free (at least 1) |
| cable | a cable's pairs land in one CIOC on consecutive CHARMs, in pair order |
| cap | with grouping on, each group fits in one cabinet |

## Custom rules

On the Rules tab you give a rule a name and describe what it must do. The server sends that text
(plus IO types, group names and tag prefixes, never signal rows) to an LLM, which answers with a rule
in the schema below, or with a reason it cannot be expressed. The draft appears in the rule list with
its plain-English meaning; **Accept** adds it to the rule set, **Reject** removes it. Drafts do not
affect allocation. Hovering any rule shows what it actually does, generated from the rule itself.

| Type | Meaning | Scopes |
|---|---|---|
| separate | signals in `a` and `b` never share a scope | cioc, baseplate |
| exclusive | signals in `a` get scopes of their own | cioc, baseplate |
| limit | at most `max` matching signals per scope | baseplate, cioc |
| together | matching signals (per value of `by`) share one scope | cioc, cabinet |
| spare | at least `percent`% of CHARMs per baseplate stay free | - |

A selector is `{field: type|grp|seg|cable|tag, op: in|prefix, values: [...], not?: true}`.
Accepted custom rules are enforced by the engine and verified by the checker like the built-in ones.
If one cannot be met (e.g. a 10-pair DO cable under "max 5 DO per baseplate") a TQ is raised with a
"relax for this cable" option. Hard/soft works the same as for built-in rules.

### When no schema type fits: generated-code rules

If the rule cannot be expressed with the five types, the LLM writes a pure function instead:

```js
function check(placements, H) { /* return [{ tags: [...], message: '...' }] per violation */ }
```

The draft shows a one-line summary, the code itself, and (when the project is allocated) how many signals
it would flag today. Code rules run after allocation; they **do not steer placement**, they flag signals.
They run in a separate Node process with the permission model on (no file access, no child processes),
inside an empty vm context with code-from-strings disabled, a 3 s timeout per rule and a memory cap,
after a static screen for `require`, `process`, `constructor` and similar. That is defence in depth for a
college project, not a hardened multi-tenant sandbox. The checker reports code rules as
"checked by its generated code, not independently", because the same code does both jobs.

### TQs from user-added rules

Rules you add have no rule-specific fixes, so every TQ they raise (schema or code) offers the same options,
with **Place manually** first:

1. **Place manually**: the signals go to the *Manual placement* tab in Allocation.
2. **Accept the break**: allowed for these signals and logged as an exception.
3. **Leave unplaced** until clarified.
4. **Make the rule soft** (also accepts this break) or **turn it off**: these change the rule table.

**Get a hint** asks the LLM for a short pointer (cause, which option, where to look). It is shown as an
unverified hint and never applied. Only the rule text, the TQ title and counts of the signals by type and
group are sent.

### Manual placement

The Allocation tab gets a *Manual placement* sub-tab listing the waiting signals. Pick one, pick a cabinet
(including one new, empty cabinet), click a free CHARM: the server runs the checker on the layout with the
signal there and lists any rule it would break. **Place here** stores the slot (who, when, which revision)
and re-allocates; the checker re-verifies everything. Breaks caused by a hand-placed signal are shown as
accepted exceptions. Hand-placed signals can be moved or sent back to the queue.

Re-allocating the same revision with the same rules keeps every signal in its previous CHARM where still
valid, so manual work and pulled-out pairs do not reshuffle the layout. A pair taken out of a cable leaves
its CHARM empty; the checker accepts that gap only while that pair is unplaced or waiting.

LLM settings (environment variables): `LLM_API_KEY` (required for drafting and hints; `OPENAI_API_KEY`
or `ANTHROPIC_API_KEY` also work), `LLM_PROVIDER` (`openai` or `anthropic`; picked from the key if unset:
`sk-ant-...` is Anthropic, anything else OpenAI), `LLM_MODEL` (default `gpt-4.1-mini` for OpenAI,
`claude-haiku-5-5` for Anthropic) and `LLM_URL` (override the endpoint). Without a key everything else
works; the Draft button explains that a key is needed.

## rules.json

"Export rules.json" (top bar, or the JSON panel on the Rules tab) downloads the project's rule set:

```json
{
  "format": "signal-sudoku-rules", "version": 1,
  "project": "Unit 10", "exportedAt": "…", "exportedBy": "aryan", "revision": "B",
  "hierarchy": { "ciocsPerCabinet": 4, "baseplatesPerCioc": 8, "charmsPerBaseplate": 12 },
  "namePattern": "{c}-CBP-{n}",
  "rules": [ { "id": "ab", "name": "A and B never share a CIOC", "description": "Segregation",
               "hard": true, "on": true, "priority": 1, "enforced": true } ],
  "hardware": { "AI": { "charm": "CHARM AI 4-20 mA", "terminalBlock": "2-wire TB" } }
}
```

"Import rules.json" (or pasting into the JSON panel) applies the same file to any project, replacing its rules,
lookup, hierarchy and name pattern. A bare list of `{id, name, hard, on}` (the older format) also imports.
TQ decisions are not in this file: they belong to one IO list, not to the rule set.

## API

    GET    /api/bootstrap                       defaults, mappable fields, saved projects
    PUT    /api/projects/:id                    create / update a project (copyOf duplicates its pool)
    DELETE /api/projects/:id                    delete a project and its pool
    POST   /api/projects/:id/ingest/preview     {files:[{name,b64}]} -> sheets, suggested column maps
    POST   /api/projects/:id/sample             {kind:'base'|'rev'} -> same, for a generated sample
    POST   /api/projects/:id/ingest/commit      {uploadId, mappings, include, rules, hw} -> new revision + scan
    DELETE /api/projects/:id/revs/last          remove the latest revision
    GET    /api/projects/:id/pool               revisions, TQs, exceptions, audit
    POST   /api/projects/:id/scan               {rules, hw} re-run detectors (rules or lookup changed)
    POST   /api/projects/:id/tqs/decide         {fp, opt, comment}
    POST   /api/projects/:id/tqs/reopen         {fp}
    POST   /api/projects/:id/allocate           {h, rules, hw} -> held (blocking TQs) or allocation + checker
    GET    /api/projects/:id/allocation         last allocation of the latest revision
    GET    /api/projects/:id/export.csv?pat=    final allocation as CSV
    POST   /api/rules/draft                     {name, description, hw, h, project} -> draft rule or reason
    POST   /api/projects/:id/tqs/hint           {fp} -> LLM hint stored on the TQ (user-rule TQs only)
    POST   /api/projects/:id/manual/check       {tag, pos} -> what placing it there would break
    POST   /api/projects/:id/manual/place       {tag, pos} -> store the slot and re-allocate
    POST   /api/projects/:id/manual/remove      {tag} -> back to the queue and re-allocate
    POST   /api/fuzz                            {n} generated projects through engine + checker

The user name for the audit trail comes from the "Your name" box in the sidebar (sent as `X-User`).

## Known limits

- A new revision lays signals out from scratch; slot stability applies within one revision.
- Generated-code rules only flag; they cannot steer the allocator. Rules with many violations are better
  made soft or turned off than placed one by one.
- No authentication yet. The pool is a JSON file per project; swap `pool.load/save` for a database or S3.
