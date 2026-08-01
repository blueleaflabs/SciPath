# SciPath

Software for planning, running, and publishing high school science fair projects.

One project lifecycle: **register → work → get fair ready → compete → publish.** Publication is the last stage, not a separate product.

Two surfaces:

- **Public.** Published records, guides, deadline calendars, and a searchable archive. No account required, ever. Entirely static.
- **Working.** Authenticated. Projects in progress, field notes, competition milestones, form date checks, submission and review.

Built and maintained by [Blue Leaf Labs](https://blueleaflabs.org), a registered 501(c)(3) nonprofit. Open source so any school or fair organization can run its own copy.

---

## Why it exists

A student at a well-resourced school has a parent who knows what ISEF Form 1B is, a teacher with time, and a family friend with a lab. A student without that misses the pre-experimentation signature deadline and is disqualified before running a single experiment.

The failures that disqualify students are procedural, not intellectual. Software that surfaces a deadline and checks a date ordering is a real intervention, and it costs nothing to deliver at scale.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Astro 5, Cloudflare adapter |
| Hosting | Cloudflare Pages |
| Database and auth | Supabase (Postgres, Google OAuth, row-level security) |
| Search | Pagefind, built at deploy time |
| Scheduled jobs | Cloudflare Worker with a cron trigger |

Everything runs inside a free tier. Domain registration is the only recurring cost.

---

## Layout

```
src/
├── styles/tokens.css     ALL color and type values
├── config/site.ts        ALL organization-specific values
├── components/           shared by public and app routes
├── content/              articles, guides, question bank
├── lib/supabase.ts       NEVER imported by a prerendered route
└── pages/
    ├── articles/  authors/  topics/  guides/   prerendered
    ├── search.astro                            prerendered
    └── app/                                    SSR, authenticated
public/pdf/               article PDFs, committed
supabase/migrations/      schema, versioned, committed
tests/                    automated tests, committed
```

Astro's per-route prerender flag does the separation. Public routes ship as static files served from the CDN; `app/` routes run in a Worker. One build, one deployment.

---

## Rules that must not be broken

These are load-bearing. Breaking any of them is expensive to undo.

**1. A prerendered route never imports `lib/supabase`.**
The public archive builds from files in this repository and nothing else. `npm run build` must succeed with the Supabase environment variables entirely absent. CI proves this on every push. If the database is down, paused, or gone, the archive keeps serving.

**2. Token names are semantic, never descriptive.**
`--brand`, `--surface`, `--rule`, `--stage-work`, `--face-ed`. A token named `--purple` means one theme is hardcoded and the others are silently broken. All values live in `src/styles/tokens.css`. No hex literal appears in any component.

**3. `org_id` on every table, from the first migration.**
Row-level security is scoped by it. The software is multi-tenant structurally even while one organization uses it. Retrofitting this is brutal.

**4. No organization-specific strings in components.**
Everything comes from the org record. No component contains "Monta Vista", "FUHSD", "Synopsys", or "Blue Leaf Labs".

**5. Google OAuth scopes are `openid`, `email`, `profile`. Nothing else, ever.**
No Drive, no Classroom, no Gmail. The software is technically incapable of reading a student's files, and that is a promise made to parents and districts.

**6. Nothing publishes before guardian consent is confirmed.**
The grace period covers working, never publishing.

**7. Schema lives in migration files.**
Applied through the Supabase CLI, never clicked in the dashboard. This is the difference between a system a successor can rebuild and one they cannot.

---

## Data handling

Read this before touching the signup flow or anything under `app/`.

**We collect:** name, email, school, expected graduation year, teacher sponsor email, parent or guardian name and email, and the project work a student chooses to enter.

**We do not collect:** date of birth, home address, phone number, government identifiers, grades, transcripts, test scores, or any demographic information.

**We never:** sell data, show advertising, build profiles for anything other than running the service, read linked documents programmatically, or train models on student work.

Nobody under 13 may hold an account. Accounts held by anyone under 18 require a parent or guardian to confirm by email, with a 14-day grace period, paused at 15 days, deleted at 60.

Email addresses are never rendered publicly, including on author pages.

---

## Running it locally

```bash
npm install
cp .env.example .env          # fill in values
npm run dev
```

For the authenticated routes you also need a Supabase project and a Google OAuth client of type **Web application**. See `docs/setup.md`.

```bash
npm run build                 # full build
npm run build:static          # public routes only, no env vars needed
npm run test
```

### Local files that are not committed

| Directory | Contents |
|---|---|
| `local-data/` | Dumps, sample exports, anything with real names in it |
| `prd/` | Working specification, design brief, policy drafts |

`prd/` is deliberately kept out of this public repository. It contains unreviewed legal drafts and notes about identifiable students. See "Where the specification lives" below.

`.dev.vars` holds Wrangler's local secrets, including the Supabase `service_role` key, which bypasses row-level security entirely. It is gitignored. Never commit it.

---

## Where the specification lives

The full design brief is **not in this repository**, for the reasons above. It covers the data model, the competition and milestone system, the review workflow, the theming system, and the compliance position, and it records why each decision was made rather than just what was decided.

Ask the maintainer for it. If you have inherited this project and cannot reach anyone, the schema in `supabase/migrations/` and this README are the authoritative description of how the system actually works.

---

## Themes

The platform ships a default theme with **no brand color**. Color is functional and stage-coded: five lifecycle stages, five muted tones, appearing only in stage indicators and status marks. Everything else is achromatic.

That is deliberate. An organization's identity appears in exactly one place, the lockup in the masthead, and a school logo in any color has to sit there without clashing.

Additional themes are token sets plus a short list of structural variants. The active theme is a field on the organization record. Every shipped theme is contrast-checked in CI.

---

## Succession

This project was started by Rohan Agarwal and is currently maintained under the Blue Leaf Labs GitHub organization.

**If a school or fair organization wants to take ownership**, the repository can be transferred between GitHub organizations while preserving history, issues, and URL redirects. The license below permits a fork at any time with no permission needed.

**If you are inheriting this**, the things that will bite you first:

1. Schema changes go in migration files, never the dashboard.
2. The daily cron job is also what keeps the Supabase project from pausing over the summer. If it stops, the database eventually sleeps, and July and September are exactly when it must not.
3. Someone has to re-verify competition deadline templates every year. A stale deadline is worse than no deadline, because a student trusted it.
4. Every June: flip graduated students to alumni, freeze their projects, publish anything sitting accepted.

Maintainer contact: see the organization page.

---

## Contributing

Issues and pull requests are welcome. Two things to know:

- Automated tests live in `tests/`. `local-data/` is scratch and is not committed.
- CI runs a build with the Supabase environment variables removed. If your change makes a public route depend on the database, that build fails, and it is meant to.

---

## License

[MIT](./LICENSE) — or Apache-2.0, decide before the first commit and do not leave it unset.

Published student work is licensed separately, CC BY 4.0 by default, and authors retain copyright.