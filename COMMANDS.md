# Every `npm run` command

What each script in `package.json` does, when to run it, and the flags it
takes. Arguments after `--` reach the script (`npm run send -- --send`).
`tests/scripts.mjs` fails if a script is added to `package.json` and not
to this file.

Three words recur. **Local** is the Docker stack on your laptop and reads
`.dev.vars`. **Cloud** is the hosted Supabase project and reads
`.cloud.vars`; every command that can touch it takes `--cloud` (or
`--linked` / `--remote`, the CLI's own words) and refuses unless
`PILOT_PROJECT_REF` in that file matches the project it is pointed at.
**Dry run** is the default for anything that sends or destroys; the flag
that makes it real is named in each entry.

## Day to day

| Command | What it does |
| --- | --- |
| `npm run dev` | The site at `http://montavista.localhost:4321` (and every other tenant's hostname), against the local stack. |
| `npm run doctor` | Checks the machine: Docker, the stack, `.dev.vars` (including whether `GOOGLE_CLIENT_ID` is set and what the auth container is holding), the CLI version. Run it first when anything looks wrong. |
| `npm run who` | Which project the scripts would talk to, and the accounts on it. `-- --cloud` for the hosted project; `-- --cloud <email or name>` looks one person up. |
| `npm run build` | Production build plus the search index (`scripts/index-search.mjs`, one Pagefind index per tenant). What CI and the deploy run. |
| `npm run build:public-only` | The same build; kept as a named alias for a deploy of the public pages alone. |
| `npm run preview` | Serve the built `dist/` locally, the way Cloudflare would. |
| `npm run walk` | Every workflow, walked: `-- --student <email> --elder <email> --elder2 <email> --teacher <email> --password '<phrase>'` signs in as each in turn and does what they do (write, ask, submit; answer, score, give the feedback; see it handled; notebook, showcase, exports; teacher score, tracker, class, live log), one picture per step into `local-data/walk/<scenario>/`, and `local-data/walk/report.md` saying which expectations held. Against a freshly loaded pilot; `--base <url>` for the hosted site, `--only <scenario>` for one. Exits non-zero when anything failed. |
| `npm run shots` | Every page as a picture at phone, tablet and laptop widths (390, 768, 1280), into `local-data/shots/<width>/<who>/`, driving the Chrome already on the machine (or `CHROME=/path`). Public pages alone by default; `-- --as <email> --password '<phrase>'` (repeatable) signs in and shoots that person's Workbench, project, deadlines, first document, class, tracker, profile and live log; `--base <url>` for the hosted site; `--pages /a/,/b/` and `--widths 390,1280` narrow it. Prints any element wider than the screen. Look through the folder before a drop. |
| `npm run check` | `astro check`: the TypeScript and template checker, every severity. |

## The local stack

| Command | What it does |
| --- | --- |
| `npm run db:start` | Start the Supabase containers **with `.dev.vars` loaded**, so the Google client id reaches the auth container. `npx supabase start` typed by hand does not load the file, and Google then answers `invalid_client`. |
| `npm run db:stop` | Stop them. |
| `npm run live:policies` | Apply the two Realtime policies (`live_listen`, `live_speak`) once the Realtime service has recreated `realtime.messages`, which on a local `db reset` happens after the migrations ran. Idempotent; part of `reset`. `-- --cloud` for the hosted project, where the migration has usually already applied them. |
| `npm run db:restart` / `npm run restart` | Stop everything and bring it back. The fix when `supabase status` prints healthy addresses and every seed says connection refused (Kong did not come back), and the fix after a Docker cold start left the auth container without its Google keys. |
| `npm run supabase -- <args>` | The Supabase CLI with `.dev.vars` loaded. `db reset --linked` is refused unless `.cloud.vars` names the project. |
| `npm run reset` | **Clean slate, local only.** Asks, then: `db reset` (schema from `0001`), the live policies on `realtime.messages` (`live:policies`), empty the local file bucket, seed orgs, the demo tenant, programs from the templates, the thirteen scenarios, the fourteen cases, people (`--optional`), the published records, the journal back catalogue, and index the records. Run after any change to `0001` and before `pilot:load`. Refuses if a Cloudflare token is in the environment. |
| `npm run reset:storage` | Empty the local file bucket alone. `-- --remote --bucket=<name>` empties a real R2 bucket and needs the four `R2_` variables; nothing else reaches production storage. |

## Seeding, one piece at a time

Each is one step of `npm run reset`, for when only that step changed.
All read `.dev.vars` and refuse a hosted project unless told otherwise.

| Command | What it does |
| --- | --- |
| `npm run seed:demo` | The demonstration tenant and its accounts. `--allow-remote=<ref>` is the only way it touches a hosted project, and only a non-production ref. |
| `npm run seed:programs` | Every program a school runs, from `src/config/programs/*.yaml`, with its deadlines and staff tasks; a program the org file lists under `hidden_until.programs` is written as `draft`. Refuses when any template program exists (local: `reset` instead). `-- --add <template-id>` is the additive path: inserts that one program for every school that lists it and leaves everything else alone; with `--cloud` it is how a program reaches the hosted project. A class already loaded keeps its own copies of the calendar until `pilot:load` runs again. |
| `npm run programs:status -- <template-id> <draft\|open\|closed\|archived>` | Flip one seeded program's status, nothing else. `--org <slug>` where two schools run the template; `--cloud` for the hosted project. `open` is what puts a program on students' Workbenches. |
| `npm run seed:scenarios` | The thirteen workbench situations. |
| `npm run seed:cases` | The fourteen cases from brief 22.14, added after the scenarios. |
| `npm run seed:people` | The first advisor's reservation, the teachers, the demo account. `--optional` (what `reset` passes) skips it quietly when the file is absent. |
| `npm run seed:publish` | The published records fixture. |
| `npm run seed:journal` | The twenty nine back-catalogue articles from `src/data/mvrj-archive.yaml`, into the demo tenant. |
| `npm run seed:orgs` | The organizations from `src/config/orgs/*.yaml`, through `provision_org`. |
| `npm run index:records` | Rebuild the records index from the file bucket. `-- --remote` reads the real bucket over S3. |

## Adding a program to the live site

The database is live and nothing is reseeded on it. A new program is
three steps, none destructive, and the same three locally and on the
cloud.

1. **Write the template** in `src/config/programs/<id>.yaml` and list it
   under `programs:` in the school's `src/config/orgs/<slug>.yaml`.
   `npm test` checks that it resolves, validates, and every staff step has
   a gate. Ship that in the ordinary way; the site reads templates at
   build time, so the deploy carries it.
2. **Add it to the database:** `npm run seed:programs -- --add <id>`
   locally, then the same with `--cloud`. This inserts the program and its
   deadlines and touches no existing row. If the school lists it under
   `hidden_until.programs`, it lands as `draft`: present, invisible.
3. **Open it when it is approved:** `npm run programs:status -- <id> open
   --cloud`, and remove it from `hidden_until.programs` so the next seed
   agrees. Students see it on the Workbench from the next page load.

A template edited after it was added (a date moved, a step renamed) is a
different case: the seeded rows are copies, and rewriting them under a
live class is the thing `seed-programs` refuses. Change the template,
ship it, and change the affected rows by hand in the SQL editor with the
diff in front of you; a migration `0002` onward is the right vehicle once
`0001` is frozen (decision 71).

## The pilot

| Command | What it does |
| --- | --- |
| `npm run pilot:sheet -- "<sheet>.xlsx"` | Turn the class spreadsheet into `local-data/pilot-irpd.yaml`. Keeps `started_on`, `granted_through`, the teachers and the domains from an existing file; `--out <path>` writes elsewhere. `local-data/` is gitignored because it names minors. |
| `npm run pilot:load -- --org <slug>` | Load the class from the file: accounts, roles, memberships, projects, Elder assignments, sponsorships, each project's calendar, and the work granted as done through `granted_through` (on its due dates, verified by the first teacher). Idempotent. `--check` reads the file and writes nothing. `--password '<phrase>'` puts one rehearsal password on every account (local only unless `--testing-phase`). `--forget-passwords` replaces them with ones nobody holds, before students arrive. `--grant-through <date>` overrides the file's date. `--file <path>` reads another file. `--cloud` targets the pilot project. |
| `npm run pilot:password -- <email>` | Set a password on one staff or advisor account so it can sign in without Google: generated, or `--set '<phrase>'`. `--cloud` for the pilot. Students are refused. |

## Mail

| Command | What it does |
| --- | --- |
| `npm run send` | Drain the notification outbox (nudges, replies, everything queued). Prints and sends nothing by default. `-- --send` hands it to the transport, which is `console` unless `MAIL_TRANSPORT=resend` and the allowlist admit the address. `-- --cloud` reads `.cloud.vars`. `--minutes=<n>` widens the send window (rows older than 60 minutes are skipped, not sent). On the cloud the Worker's cron does this every fifteen minutes; locally there is no cron and this is it. |
| `npm run digest` | The weekly summary per person. Same `--send` rule. Reads opportunities only; a class is not in it yet (decision 84). |

## The cloud

Every one of these reads `.cloud.vars` and checks `PILOT_PROJECT_REF`.

| Command | What it does |
| --- | --- |
| `npm run backup` | Dump the local database. `-- --cloud` dumps the linked project. Take one before anything below. |
| `npm run backup:media` | Mirror the R2 bucket (every photograph, journey map, drawn graphic, signed form and published record) into a dated folder under `local-data/backups/`, with a manifest. Needs the four `R2_` variables. `-- --cloud` reads `.cloud.vars`; `-- --into <folder>` continues an earlier mirror and copies only what changed. Read-only against the bucket. |
| `npm run restore:db -- <base>` | Replay a `backup` set (roles, schema, data) into the **local** stack, resetting it first, through `psql` in the database container. Refuses `--cloud`: restoring the hosted project is done by hand with the commands `backup` prints. Run it once before you need it. |
| `npm run verify:cloud` | Count every table on the hosted project and change nothing. |
| `npm run reset:cloud` | **Destroys the hosted project's data**: `node scripts/reset-cloud.mjs --yes --project=<ref>`, and it will not run without both. `--keep-storage` leaves R2 alone. Not for a project holding real work (decision 71). |
| `npm run wipe:demo` | Remove the demonstration tenant's rows. Says what it would remove; `--yes` removes it; `--force` also where a real account has touched it. |
| `npm run load -- --pilot <pilot file> --password '<phrase>'` | The whole class at once: signs in as the pilot's roster (or `--as <email>` repeated), everyone within `--ramp` seconds (90), then `--seconds` (120) of each person reading their own Workbench, project, deadlines, first document and tracker, saving a box on the document as they type, and asking the pulse; `--users` (40) seats, `--think` (1500) ms between clicks, `--base` for the hosted site (the pilot's real database: before the students, or the demonstration tenant). Reports per route requests, errors, p50/p95/p99 and the database's share from Server-Timing, names the call each route waits on most (`slow` from Server-Timing, sent only to a caller that asks with `x-timing-trace`), counts sign-ins refused by the auth rate limit and retried, and writes the same to `local-data/load/<when>.json` to compare runs before and after a plan change. A 302 is listed with where it went. Local stacks admit 1000 sign-ins per five minutes per address (`supabase/config.toml`, after `supabase stop && supabase start`). |

## Tests

`npm test` runs every static suite below in order and stops at the first
failure. The four that have to be green before a drop: `npm test`,
`npm run build`, `npm run test:db`, `npm run test:probes`.

| Command | What it reads |
| --- | --- |
| `npm test` | All of the `test:*` suites except `db`, `probes`, `output` and `serve`. |
| `npm run verify` | `build`, then `test`, then `test:output`. |
| `npm run test:db` | Applies `0001` to a throwaway Postgres and runs `tests/db/*.sql`: policies, access, every function. Needs a local `postgres` binary. |
| `npm run test:probes` | Every probe in `tests/db/probes.sh` is refused; each new check has been seen to fail once. |
| `npm run test:output` | Reads the built `dist/`: no tenant's pages carry another tenant's name. Needs `build` first. |
| `npm run test:serve` | Reads responses from a running server rather than sources: headers, prerendered pages on every tenant. |
| `npm run test:types` | `astro check` at error severity. |
| `test:deps` | Dependencies pinned and present. |
| `test:scripts` | The scripts and the cron: kinds with messages, the send window, the reset table list, this file. |
| `test:tdz` | No page reads a `const` before its declaration. |
| `test:next` | `?next=` is a safe path. |
| `test:status` | Status computation. |
| `test:transport` | The mail transport's guards. |
| `test:history` | Every draft kept: the history table and the write in `save_field`, the page's earlier drafts with Use this, the Worker's clock pruning old drafts to the last before each version. |
| `test:showcase` | The showcase that writes itself: a submitted deliverable becomes a section by its shape's `showcase` block, the tile takes the newest picture and the first headline, drafts are not read, the pages assemble from one loader. |
| `test:tracker` | The tracker: shared arithmetic, three views over one grid, the key map, one cell saved at a time with the id it opened on, the broadcast updating a cell, the Elder writing and the teacher reading on one page. |
| `test:hosts` | Which hostnames the deployment answers for: the root, www, a tenant's label, local names and previews; a stranger's host is refused. |
| `test:door` | The door: a school whose `signup_mode` is `closed` (Monta Vista, for the pilot), or `SIGNUPS=closed` in the deployment, makes no account by signing in — refused in the OAuth callback, the middleware, the welcome page and `complete_signup`; `TENANTS` names which schools' addresses answer at all. |
| `test:plate` | The plate's one order over rows from three assemblies: the sort key read from the page and run against rows missing an id, a number or a late flag. |
| `test:mobile` | The phone guards: the body clips sideways overflow, the masthead and the working-surface bar have their narrow-screen rules, touch targets key on the pointer, wide tables scroll in their own box. |
| `test:back` | An export's Back link returns to the page it was opened from (care list, class, project) when the browser says so, else to the page's fallback. |
| `test:live` | Live updates: the socket first, the pulse only on fallback and paced by the school's class periods, broadcast triggers on every watched table, the document room's presence and soft lock. |
| `test:config-sources` | Every configured variable has a source. |
| `test:dates` | Date ordering rules. |
| `test:reach` | Who reaches which program. |
| `test:queue` | The advisor queue's order. |
| `test:structure` | Structural review rules. |
| `test:workflow` | The workflow model. |
| `test:roster` | Rosters. |
| `test:publish` | Publishing rules. |
| `test:journal` | The journal loader. |
| `test:seeds` | Seeded manuscripts. |
| `test:fixtures` | The fixture scenarios. |
| `test:pdftext` | PDF text extraction. |
| `test:search` | Search is scoped to the tenant. |
| `test:devvars` | `.dev.vars.example` documents every variable. |
| `test:drift` | Queries in `src/` name columns the schema has. |
| `test:additive` | Migrations after `0001` are additive. |
| `test:indexes` | Every foreign key has an index. |
| `test:orgs` | Org files the database would accept; a `hidden_until` date that has not passed. |
| `test:props` | No dead component props. |
| `test:policy` | Policies are scoped to the org. |
| `test:visibility` | Row visibility. |
| `test:sqlorder` | No function in `0001` calls one declared later. |
| `test:declarations` | Distinct names in the migration. |
| `test:sqlcols` | Columns the SQL names exist. |
| `test:embeds` | Embeds are safe. |
| `test:contrast` | Every color pair in every theme passes. |
| `test:static` | No database read in a static page. |
| `test:tokens` | Colors and org names only in `tokens.css` and org config. |
| `test:config` | No secret in config. |
| `test:tenant` | Tenant resolution by hostname. |
| `test:templates` | The program templates resolve and validate. |
| `test:shapes` | Every shape (a deliverable's template, `src/config/shapes/`) is one a student can fill, and every shape a deliverable names exists. |
| `test:registry` | The template registry. |
| `test:video` | Video URL parsing. |
| `test:drive` | A Google Drive link becomes Google's preview address and nothing else does. |
| `test:ordering` | Page ordering rules: outcome anchors, deadline queries by date, labels, the authority sentence. |
| `test:media` | Media paths. |
| `test:markdown` | The Markdown renderer against hostile input. |
| `test:uploads` | Disguised uploads are refused. |
| `test:caching` | Cache headers per route. |
| `test:frontmatter` | No immediate block reads a later `const`. |
| `test:paths` | Path helpers. |
| `test:routes` | Tenant routes. |
