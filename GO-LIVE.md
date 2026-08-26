# Going live on scipath.org

Follow in order. Each step says what it needs from the one before, so a step
that fails is a step you can stop on rather than one you have to unwind.

Times are wall clock, mostly waiting on DNS and certificates.

**Before anything.** Four suites green locally, and a full `npm run reset` that
completes. If `reset` does not finish on your laptop it will not finish
anywhere.

```bash
npm test && npm run build && npm run test:db && npm run test:probes
npm run reset
```

---

## 0. What is actually being deployed

One build serves every tenant. A tenant stores only its label — `montavista` —
and `PUBLIC_ROOT_DOMAIN` supplies the other half of the address. Nothing in the
source names a hostname.

| Label | Address in production | Signup |
|---|---|---|
| `montavista` | `montavista.scipath.org` | by school domain |
| `svslc` | `svslc.scipath.org` | by invitation |
| `demo` | `demo.scipath.org` | by invitation, and fixtures |
| `scipath` | `scipath.org`, `www`, and any name matching no tenant | open |

`demo` is a school like the others and not a separate environment. Its rows are
separated from Monta Vista's by `org_id` and by the policies `test:probes`
proves, which is the same separation two real schools already rely on. What is
different is that its people are invented and its credentials are published, so
its file carries `demo: true` — the flag `seed-demo` requires before it will
write fixtures into this project. **Nothing real goes in it.**

It runs Monta Vista's six programs from the same template files — the class,
the club, both fairs, the micro grant and the journal — because a school level
template gets a row per school and two organizations naming one template fork
no calendar. So a demonstration shows IRPD's own twenty nine steps and the
club's nineteen, not an imitation of them, and a change to the class reaches
both.

`example` is a fourth record in `src/config/orgs/` marked `provisioned: false`.
It gets prerendered pages so the alternate theme is contrast-checked in CI, and
it has no database row. `example.scipath.org` will therefore serve pages and
fail at sign-in. Harmless, and worth knowing before somebody finds it.

---

## 1. Merge to `main`

CI runs on `main` and on pull requests, and it is green today — including
`test:output`, which was red from 1.39 until this session. So open the pull
request and let it run rather than pushing straight.

```bash
git checkout feat/workbench-0001
git status                    # nothing uncommitted, and .dev.vars must not appear
git push origin feat/workbench-0001
```

Then on GitHub: open a pull request into `main`, wait for **CI** to pass, merge.

**Check `.dev.vars` is not in the diff.** It is gitignored, and the one time
that matters is the day somebody runs `git add -f`. `npm test` includes
`test:config`, which scans all 220 committed files for secret literals, so a
key committed by accident fails CI rather than reaching the repository — but
look anyway.

CI does not deploy. Cloudflare does that, in step 5.

---

## 1a. Mail for the fixture domain

**Before demonstrating notifications.**

Fixture accounts are addressed on `scipath.org`. They used to be on
`demo.invalid`, which RFC 2606 reserves and nobody can register, so a fixture
address could never become a real mailbox and no message could ever leave.

That is given up on purpose. The thing worth demonstrating is a guardian
consent request landing in an inbox and being answered, and a domain that
cannot receive mail cannot show it. So `scipath.org` wants a **catch-all**
pointed somewhere you can read.

Two things stand in for what `.invalid` was doing, and both are already in the
code:

- Every fixture address is `{tenant}.{handle}@scipath.org`. Nobody is issued a
  real mailbox in that shape, so a fixture cannot collide with a person.
- The transport refuses the fixture domain **by default**. `MAIL_FIXTURES=send`
  is the deliberate act that permits it, compared exactly — `no` and an empty
  value both still refuse. Addresses on `.invalid` are refused whatever it
  says.

So the ordinary state is that fixture mail cannot leave, and demonstrating the
flow is one variable rather than an edit. Set it for the demonstration; leave
it unset the rest of the time.

---

## 2. Supabase

**2.1 Create the project.** A new project in the Blue Leaf Labs org. Region
`us-west-1`. Save the database password in the password manager; you will not
be shown it again.

**2.2 Link and push the schema.**

```bash
npx supabase login
npx supabase link --project-ref <the new ref>
npx supabase db push
```

`db push` applies `0001_identity_and_tenancy.sql`. There is no down migration.
The nine `does not exist, skipping` notices are expected — they are
`drop ... if exists` against an empty database.

**2.3 Create the organization rows.** This is the only seed that runs in
production. It writes organizations and nothing else, and running it twice
changes nothing the second time.

```bash
PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SECRET_KEY=<secret key> \
node scripts/seed-orgs.mjs
```

Set them inline like this, exported into that one command. **Do not put
production credentials in `.dev.vars`** — `npm run reset` runs `db reset`
against whatever that file says, and `db reset` drops everything.

Expect: three organizations provisioned, one not provisioned by declaration.

**2.4 Collect the keys.** Project Settings → API keys.

| Key | Where it goes |
|---|---|
| Project URL | `PUBLIC_SUPABASE_URL` |
| Publishable key | `PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| Secret key | `SUPABASE_SECRET_KEY` — a secret, never a build variable |

The secret key bypasses row level security entirely. It goes in Cloudflare as
an encrypted secret and nowhere else.

**2.5 Auth URLs.** Authentication → URL Configuration.

- Site URL: `https://scipath.org`
- Redirect URLs, one line each:
  - `https://scipath.org/auth/callback/`
  - `https://www.scipath.org/auth/callback/`
  - `https://montavista.scipath.org/auth/callback/`
  - `https://svslc.scipath.org/auth/callback/`
  - `https://demo.scipath.org/auth/callback/`

Supabase does not accept a wildcard subdomain here reliably, so list them. **A
tenant added later needs a line added here**, and the failure is quiet: every
school that already worked goes on working, so it reads as one school being
broken rather than as a setting nobody added. `db reset` does not touch this,
which is the same reason the existing lines survive a rebuild.

`npm run reset:cloud` prints the full list at the end of a run, derived from
`src/config/orgs/*.yaml`, so comparing it against the dashboard is ten seconds
and does not require knowing which tenant is new.

**2.6 Google sign-in.** A **new** OAuth client in Google Cloud, separate from
your local one. Authorized redirect URI is Supabase's, not ours:

```
https://<ref>.supabase.co/auth/v1/callback
```

The client id and secret go in Supabase's Google provider settings. They never
go in Cloudflare — the Worker does not talk to Google.

Publish the OAuth app rather than leaving it in Testing. An app in Testing
issues seven-day refresh tokens, which present as students being randomly
logged out.

Password sign-in works without any of this, which is what the fixtures use.

---

## 3. Cloudflare: keep Pages

**Do not delete anything and do not move to Workers.** Pages does everything
this needs — R2 bindings, build variables, encrypted secrets, wildcard custom
domains — and the README and the brief both describe Pages. Switching platforms
on deployment day is a second unfamiliar thing to debug at the same time as the
first.

**One trap.** `wrangler.jsonc` in the repository is read by the Astro adapter's
platform proxy **in local development only**. It has no `pages_build_output_dir`,
so the Pages build ignores it. The R2 binding in that file does not reach
production; you configure it in the dashboard in 3.2. Expect this to be
counterintuitive.

**3.1 Connect the project.** Workers & Pages → your Pages project → Settings →
Builds. If you are creating it fresh, connect it to `blueleaflabs/SciPath`.

| Field | Value |
|---|---|
| Production branch | `main` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 22 |

Node 22 is set as a build variable, `NODE_VERSION = 22`. Local, CI and
Cloudflare must agree; a mismatch produces a failure that appears only here.

**3.2 Build variables** — Settings → Environment variables → Production.
These are read at **build** time and inlined.

```
NODE_VERSION                      22
PUBLIC_ROOT_DOMAIN                scipath.org
PUBLIC_SUPABASE_URL               https://<ref>.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY   <publishable key>
```

`PUBLIC_ROOT_DOMAIN` **must** be a build variable. `src/lib/deployment.ts`
reads it from `import.meta.env`, and `astro.config.mjs` reads it from
`process.env` to set the canonical URL and the sitemap. There is no runtime
binding for it. Set it as a runtime secret only and every mailed link and
canonical tag will say `localhost:4321`.

**Do not set `PUBLIC_ORG`.** It pins the whole deployment to one tenant. It
exists for a single-tenant install on a bare domain, which this is not.

**3.3 Secrets** — same screen, marked encrypted.

```
SUPABASE_SECRET_KEY               <secret key>
```

Later, not needed on day one: `GITHUB_DISPATCH_TOKEN`, `GITHUB_REPO`,
`MAIL_TRANSPORT`, `MAIL_FROM`, `MAIL_ALLOWLIST`, `RESEND_API_KEY`.

---

## 4. R2 storage

Notebook photographs and signed forms. Private — no public URL, no custom
domain. Every read goes through `/app/media/`, which checks project membership
before serving a byte.

**4.1 Create the bucket.** R2 → Create bucket, named **exactly**:

```
scipath-notebook
```

The name is not arbitrary: it is what the code binds. Public access stays
disabled.

**4.2 Bind it to the Pages project.** Settings → Functions → R2 bucket
bindings → Add:

| Variable name | Bucket |
|---|---|
| `NOTEBOOK` | `scipath-notebook` |

Add it for **Production**. The variable name must be `NOTEBOOK` — that is what
`src/lib/blob.ts` and `src/lib/records-store.ts` read off
`locals.runtime.env`.

Without this binding, pages render and every upload and every published record
file fails. It is the easiest thing on this page to forget.

---

## 5. DNS and the subdomains

**5.1 Add the zone.** If `scipath.org` is not already in this Cloudflare
account, add it and change the nameservers at Namecheap to the two Cloudflare
gives you. Propagation is usually under an hour.

**5.2 Custom domains.** Pages project → Custom domains → Set up a custom
domain, three times:

```
scipath.org
www.scipath.org
*.scipath.org
```

Cloudflare creates the records itself. The wildcard is the one that matters:
every school is a subdomain, so tenancy is entirely hostname-based.

**5.3 THE THING TO ACTUALLY TEST.** Wait for all three custom domains to read
**Active**, then open a subdomain, not the apex:

```
https://montavista.scipath.org/
```

**If the wildcard certificate does not come up, the apex looks perfectly fine
and every school is unreachable.** The apex is not evidence. A wildcard
certificate can take 15 minutes; if it is still pending after an hour, the
fallback is to name `montavista.scipath.org` and `svslc.scipath.org`
individually as custom domains and revisit the wildcard later.

---

## 6. Deploy and verify

Merging to `main` triggers the build. Watch it in the Pages dashboard.

Then walk this, in order. Each one fails differently, which is the point.

1. **`https://scipath.org/`** — the base tenant's home page. If this 500s, the
   build variables are wrong.
2. **`https://montavista.scipath.org/`** — the masthead reads *Monta Vista High
   School · MVHS*. If it reads *SciPath*, the wildcard is not resolving or
   `PUBLIC_ORG` got set.
3. **`https://svslc.scipath.org/about/`** — reads *Silicon Valley Student
   Leadership Council*, badge `SVSLC`. Proves the second tenant and the
   five-character mark.
4. **View source on any page** — the canonical tag says `https://scipath.org`,
   not `localhost:4321`. That is `PUBLIC_ROOT_DOMAIN` proven.
5. **`https://montavista.scipath.org/app/`** — redirects to sign-in rather than
   erroring. Proves Supabase is reachable.
6. **Sign in with Google**, as yourself. Proves the OAuth client and the
   redirect URLs.
7. **Open a project, add a notebook entry with a photograph.** Proves the R2
   binding. This is the step that catches a missing `NOTEBOOK`.
8. **`https://scipath.org/showcase/`** — published records render.

---

## 7. Fixtures in production, and how they leave

Fixtures live in production deliberately, because a demonstration needs
something to show. They live in **one school**, which is what makes it a
narrower departure from 12.11a than it was: `demo`, on `demo.scipath.org`,
whose file says `demo: true`.

Three scripts invent people — `seed-demo`, `seed-scenarios`, `seed-cases` —
and all three ask the same question, from `scripts/fixture-target.mjs`: a host
that is not loopback needs `--allow-remote`, and takes only organizations
whose own file carries `demo: true`. A real school in the list is refused by
name.

`npm run reset:cloud` runs all of them, into `demo`, so the deployed tenant
holds what a laptop holds: the fourteen fixture accounts, the thirteen
scenarios, the cases, two published records and a search index over them. One
case is skipped there and says so — it needs a co-author at a second school,
and the second school has no fixtures in the deployed project.

`.cloud.vars` needs `PUBLIC_ROOT_DOMAIN=scipath.org` alongside the Supabase
and R2 values. Every address the reset prints is built from it — the tenants,
and the redirect URLs to register — and its default is a laptop's, so without
it the run tells you to register `http://demo.localhost:4321/auth/callback/`.
The reset refuses to start when it is absent and the project is a deployed
one, before anything is dropped.

To run one on its own:

```bash
DEMO_ORGS=demo \
PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
node scripts/seed-demo.mjs --allow-remote=<production-ref>
```

Never point `npm run reset` at the cloud project — it drops the database
before it seeds anything.

Add `demo.scipath.org` as a custom domain the same way as the others. Wildcards
are not accepted, so every subdomain is named explicitly.

When they go:

```bash
node scripts/wipe-demo.mjs            # dry run, prints what it would remove
node scripts/wipe-demo.mjs --yes      # acts
```

It finds them by the `@demo.invalid` domain through the admin API, unwinds
children before parents, and refuses to delete a project a real person has
joined unless told twice.

---

## 8. Not needed today

- **Search index rebuilds.** `GITHUB_DISPATCH_TOKEN` (fine-grained, Contents:
  read and write, this repository only) and `GITHUB_REPO=blueleaflabs/SciPath`
  as Pages secrets, plus `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY` as GitHub Actions secrets for `index-records.yml`.
  Without them publishing still works and the index updates on the nightly run
  at 06:17 UTC.
- **Mail.** The drain exists now: `npm run send` prints what would go, and
  `npm run send -- --send` hands it to the transport. The Worker's `scheduled`
  handler does the same thing on a cron trigger, and that trigger is set to
  midnight on 1 January — deliberately, so nothing sends unattended before
  somebody has watched a run by hand.

  Before the first real send, three settings and one habit:

  - `MAIL_TRANSPORT=resend` and `RESEND_API_KEY`. Without the first, the
    transport is the console and nothing leaves.
  - `MAIL_ALLOWLIST` holding **one address, your own**. Every fixture is on
    `demo.invalid` and refused outright, but the demo tenant's queue also
    holds real-looking rows.
  - Run `npm run send` with no flag first. It changes nothing.

  The send window is an hour. Anything older is marked `skipped` with a reason
  rather than sent, so a queue that has been filling for months cannot mail
  everybody a year of arrears on its first run. A cron schedule sparser than
  that window would skip messages rather than send them late; `tests/scripts.mjs`
  compares the two and fails if they disagree.

---

## Afterwards

Two things to write down while they are fresh: the Supabase project ref, and
the date. The brief's 19.11b is the reference version of this document; if
anything here was wrong, fix it there rather than in your memory.
