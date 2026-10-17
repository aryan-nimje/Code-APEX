# Signal Sudoku

Node.js backend + web frontend. TQs are produced from the real uploaded IO list, not a fixed list.

## Run

    npm install          # one dependency: SheetJS (xlsx) for reading Excel on the server
    npm start            # http://localhost:3000   (PORT=4000 npm start to change)
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

Custom rules (added by hand or by the rule filler) are stored and shown, but marked "Not enforced yet"
in the rules table and "Not checked" in the checker until engine logic exists for them.

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
    POST   /api/fuzz                            {n} generated projects through engine + checker

The user name for the audit trail comes from the "Your name" box in the sidebar (sent as `X-User`).

## Known limits

- Revisions re-place signals from scratch; unchanged signals are not yet held in their old slots
  (the "Keep each in its previous CIOC" decision on moved signals does pin those).
- No authentication yet. The pool is a JSON file per project; swap `pool.load/save` for a database or S3.
