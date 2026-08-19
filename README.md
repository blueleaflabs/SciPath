# SciPath

Free, open source software for planning, running, and publishing student
science fair projects. One project moves through five stages, from the day it
is registered to the day it is published, and publication is the last of those
stages rather than a separate product.

Licensed under the MIT license. Any organization may run its own copy, hold its
own students' data, and keep operating whether or not anyone else does.

---

## The four things that bite an inheriting maintainer first

Read these before changing anything. Each one is cheap now and expensive later.

**1. A prerendered route must never import `lib/supabase`.** The public
surface builds from files in this repository and nothing else, and it has to
keep serving with the database gone. `npm run test:static` proves it and CI
runs it on every push. If you need data in a public page, put the data in the
repository.

**2. Token names are semantic, never descriptive.** Everything visual lives in
`src/styles/tokens.css` under names like `--brand`, `--surface`, `--stage-work`,
`--face-ed`. A token named `--purple` means one theme is hardcoded and every
other theme is already broken. No component contains a hex literal.
`npm run test:contrast` checks every shipped theme against the WCAG AA floor.

**3. Nothing organization-specific belongs in a component.** The name of a
school, a district, a fair, or the operator comes from the organization record
in `src/config/orgs.ts` or from `src/config/site.ts`. Running this for a second
organization is a config edit, not a search and replace.

**4. `org_id` goes on every table from the first migration, with row level
security scoped by it.** The software is multi-tenant structurally and operated
single-tenant at first. Retrofitting tenancy touches everything; adding it now
costs a column.

---

## Stack

| Piece | What |
|---|---|
| Astro 5 | One project, one repository, one deployment |
| Cloudflare Pages | Static hosting, previews on every branch |
| Supabase | Postgres, auth, and row level security, for the working surface only |
| Pagefind | Search, indexed at build, served as static files. No search service, ever |
| GitHub Actions | CI, free on public repositories |

The public surface is prerendered. The working surface lives under `app/` and
is separated by Astro's per-route prerender flag, not by a second application.
A monorepo was considered and rejected.

## Layout

```
src/
  styles/tokens.css     every color and type value, all themes
  config/site.ts        platform values and the discipline taxonomy
  config/orgs.ts        the organization record, selected by PUBLIC_ORG
  config/fonts.ts       per-theme font loading
  content.config.ts     schemas for published records and guides
  content/              records and guides, as files
  components/           shared by public and app routes
  lib/                  helpers. lib/supabase.ts is off limits to public routes
  pages/                public routes now, app/ later
tests/                  the two rules above, as scripts
```

## Running it

```bash
npm install
npm run dev              # local
npm run build            # astro build, then the Pagefind index
PUBLIC_ORG=example npm run dev   # render a second organization
```

Node 22. Cloudflare Pages build command is `npm run build`, output directory
`dist`, with `NODE_VERSION` set to 22.

### The tests

Four suites, and all four have to be green. The last two need Postgres but not
Docker: they apply the migration to a scratch database directly.

```bash
npm test                 # the schema, the templates, the pages
npm run build
npm run test:db          # what the migration does
npm run test:probes      # passes only when a statement is refused
```

### Rebuilding a database

Two commands. Each drops everything and seeds from scratch, and which one you
get is which file you have.

```bash
npm run reset            # local:  reads .dev.vars
npm run reset:cloud      # cloud:  reads .cloud.vars
npm run verify:cloud     # count the cloud project, change nothing
```

Both print the database they are about to destroy, where that value came from,
and what will be removed, then wait for y/n. Answering anything else stops the
chain.

Copy `.dev.vars.example` and `.cloud.vars.example` to fill those in. **They are
two files on purpose**: `npm run reset` destroys whatever `.dev.vars` names, so
a cloud project's credentials must never be in it.

The local reset also seeds 69 fixture accounts on `demo.invalid`, thirteen
scenarios and the published records. The cloud reset does not — those scripts
refuse a target that is not loopback.

Both seed advisor accounts from `local-data/people.yaml` if it exists.
`src/config/people.example.yaml` shows the shape; it is gitignored because it
holds real addresses.

## Data handling

This service holds student data, most of it about minors, and the position is
architectural rather than documentary.

Collected: name, email, school, graduation year, teacher sponsor email,
guardian name and email, and the project work a student enters. Nothing else.
No date of birth, no address, no phone number, no grades, no demographics.

- Accounts start at age 13. There is no account below it.
- A guardian confirms permission at signup. Nothing publishes before they do.
- A teacher sponsor confirms the school. Until then, affiliation shows as
  unverified on published work.
- Email addresses are never rendered publicly, including on author pages.
  Contact routes through the organization.
- We never read documents a student links to, and never train models on
  student work.
- Deletion is available from settings, always, with no reason required.
- Sign-in requests three scopes: `openid`, `email`, `profile`. Nothing else,
  ever.

## What is not in this repository

`prd/` and `local-data/` are gitignored, and that is a disclosure requirement
rather than a preference. The repository is public; the specification and
policy drafts are unreviewed, and the migration inventory names identifiable
students. **The specification lives outside this repository**, which is why
this README carries as much as it does.

`.dev.vars` is also ignored. It holds the Supabase `service_role` key, which
bypasses row level security entirely, and it is not covered by any standard
Node gitignore template.

## Succession

This repository currently sits under the Blue Leaf Labs GitHub organization,
which holds it on behalf of the program using it. It is open source from the
first commit specifically so that this is a short conversation rather than a
long one.

If the program or its school wants ownership, GitHub transfers a repository
between organizations while preserving history and issues and redirecting the
old URL, and Cloudflare Pages reconnects to the moved repository. Neither is a
rebuild.

If nobody is maintaining this: the published archive is static files in
`src/content/` and `public/`, and it will keep serving from any host that can
serve a directory, with no database and no build step required to read it.
That property is deliberate and should survive every future decision.

Contact for the repository is in `src/config/site.ts`.
