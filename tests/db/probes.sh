#!/usr/bin/env bash
#
# EVERY NEW CHECK, SEEN TO FAIL.
#
# Section 19.9: a check that has only ever passed has not been shown to read
# what it claims. Four of the last session's checks passed for the wrong
# reason, and the `programs.process_id` rule this refactor added was asserted
# in a comment for the whole of the previous design while enforcing nothing.
#
# So each probe below is a statement the schema is supposed to refuse. The
# probe passes when the statement raises, and fails when it is accepted --
# the inverse of the rest of the suite, which is the point.
#
#   ./tests/db/probes.sh
#
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_DIR="${PG_DIR:-/tmp/scipath-probe}"
PG_PORT="${PG_PORT:-5435}"

if [ ! -x "$PG_BIN/initdb" ]; then
  echo "No Postgres at $PG_BIN, so the probes are skipped."
  exit 0
fi

AS=""
if [ "$(id -u)" = "0" ]; then
  if id postgres >/dev/null 2>&1; then AS="postgres"; else
    echo "Running as root with no postgres account, so the probes are skipped."
    exit 0
  fi
fi

run() {
  if [ -n "$AS" ]; then su "$AS" -s /bin/bash -c "$1"; else bash -c "$1"; fi
}

if [ -d "$PG_DIR/data" ]; then
  "$PG_BIN/pg_ctl" -D "$PG_DIR/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$PG_DIR"
fi

mkdir -p "$PG_DIR"
[ -n "$AS" ] && chown -R "$AS" "$PG_DIR"

run "$PG_BIN/initdb -D $PG_DIR/data -U postgres" >/dev/null
run "$PG_BIN/pg_ctl -D $PG_DIR/data -l $PG_DIR/log -o '-k $PG_DIR -p $PG_PORT -h \"\"' start" >/dev/null
sleep 1

stop() { run "$PG_BIN/pg_ctl -D $PG_DIR/data stop -m immediate" >/dev/null 2>&1 || true; }
trap stop EXIT

apply() {
  cp "$1" "$PG_DIR/current.sql"
  chmod 644 "$PG_DIR/current.sql"
  run "$PG_BIN/psql -h $PG_DIR -p $PG_PORT -U postgres -q -t -A -v ON_ERROR_STOP=1 -f $PG_DIR/current.sql" >/dev/null
}

apply tests/db/platform.sql
for m in supabase/migrations/*.sql; do apply "$m"; done
echo "── The schema is up. Now the things it must refuse."
echo

passed=0
failed=0

# refuse <name> <sql>  -- the sql must raise
refuse() {
  local name="$1" sql="$2" out status=0
  printf '%s' "$sql" > "$PG_DIR/probe.sql"
  chmod 644 "$PG_DIR/probe.sql"
  out=$(run "$PG_BIN/psql -h $PG_DIR -p $PG_PORT -U postgres -q -t -A -v ON_ERROR_STOP=1 -f $PG_DIR/probe.sql" 2>&1) || status=$?

  if [ "$status" -ne 0 ]; then
    echo "  ok     refused: $name"
    passed=$((passed + 1))
  else
    echo "  FAIL   ACCEPTED, and should not have: $name"
    failed=$((failed + 1))
  fi
}

# A fixture to hang the probes on.
apply /dev/stdin <<'SEED'
insert into public.organizations
  (id, slug, hostname, lockup_name, mark, theme, status)
values ('00000000-0000-0000-0000-0000000000aa', 'probe', 'probe.test',
        'Probe School', 'PR', 'entry', 'active');

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000e1');

insert into public.users (id, org_id, display_name)
values ('00000000-0000-0000-0000-0000000000e1',
        '00000000-0000-0000-0000-0000000000aa', 'Probe Person');

insert into public.programs (id, org_id, slug, name, season_year, program_role, kind)
values ('00000000-0000-0000-0000-0000000000b1',
        '00000000-0000-0000-0000-0000000000aa', 'probe-club', 'Probe Club', 2027,
        'cohort', 'course'),
       ('00000000-0000-0000-0000-0000000000b2',
        '00000000-0000-0000-0000-0000000000aa', 'probe-fair', 'Probe Fair', 2027,
        'opportunity', 'competition');

insert into public.projects (id, org_id, title, created_by)
values ('00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000aa', 'Probe Project',
        '00000000-0000-0000-0000-0000000000e1'),
       ('00000000-0000-0000-0000-0000000000c2',
        '00000000-0000-0000-0000-0000000000aa', 'Other Project',
        '00000000-0000-0000-0000-0000000000e1'),
       ('00000000-0000-0000-0000-0000000000c3',
        '00000000-0000-0000-0000-0000000000aa', 'Third Project',
        '00000000-0000-0000-0000-0000000000e1');

insert into public.participations (id, org_id, project_id, program_id)
values ('00000000-0000-0000-0000-0000000000d1',
        '00000000-0000-0000-0000-0000000000aa',
        '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000b1'),
       ('00000000-0000-0000-0000-0000000000d2',
        '00000000-0000-0000-0000-0000000000aa',
        '00000000-0000-0000-0000-0000000000c1',
        '00000000-0000-0000-0000-0000000000b2'),
       ('00000000-0000-0000-0000-0000000000d3',
        '00000000-0000-0000-0000-0000000000aa',
        '00000000-0000-0000-0000-0000000000c2',
        '00000000-0000-0000-0000-0000000000b1');
SEED

# accept <name> <sql>  -- the sql must succeed. The mirror of refuse: a check
# narrowed to admit a real exception has to be shown to admit it, or the next
# person tightens it back and the seed fails again.
accept() {
  local name="$1" sql="$2" out status=0
  printf '%s' "$sql" > "$PG_DIR/probe.sql"
  chmod 644 "$PG_DIR/probe.sql"
  out=$(run "$PG_BIN/psql -h $PG_DIR -p $PG_PORT -U postgres -q -t -A -v ON_ERROR_STOP=1 -f $PG_DIR/probe.sql" 2>&1) || status=$?

  if [ "$status" -eq 0 ]; then
    echo "  ok     allowed: $name"
    passed=$((passed + 1))
  else
    echo "  FAIL   REFUSED, and should not have: $name"
    echo "         $out"
    failed=$((failed + 1))
  fi
}

# 1. programs_only_cohorts_prescribe_process
refuse "an opportunity prescribing a research process" \
"update public.programs set process_id = 'process-science'
  where id = '00000000-0000-0000-0000-0000000000b2';"

# 2. the same rule on insert, not only on update
refuse "an opportunity created with a process already set" \
"insert into public.programs (org_id, slug, name, season_year, program_role, kind, process_id)
 values ('00000000-0000-0000-0000-0000000000aa', 'probe-fair-2', 'Probe Fair 2', 2027,
         'opportunity', 'competition', 'process-science');"

# 2b. ...but a grant may, and this is the documented exception. A check that
#     refuses this breaks `grant-mvhs-micro-2027` and the whole reset with it.
accept "a grant naming its application steps as a process" \
"insert into public.programs (org_id, slug, name, season_year, program_role, kind, process_id)
 values ('00000000-0000-0000-0000-0000000000aa', 'probe-grant', 'Probe Grant', 2027,
         'opportunity', 'grant', 'process-grant');"

# 2c. and the exception is a grant's, not every opportunity's
refuse "a publication borrowing the grant exception" \
"insert into public.programs (org_id, slug, name, season_year, program_role, kind, process_id)
 values ('00000000-0000-0000-0000-0000000000aa', 'probe-pub', 'Probe Journal', 2027,
         'opportunity', 'publication', 'process-science');"

# 3. app.participation_role_ok
refuse "a participation in a program that is neither cohort nor opportunity" \
"insert into public.programs (id, org_id, slug, name, season_year, program_role, kind)
 values ('00000000-0000-0000-0000-0000000000b3',
         '00000000-0000-0000-0000-0000000000aa', 'probe-none', 'Probe None', 2027,
         'none', 'independent');
 insert into public.participations (org_id, project_id, program_id)
 values ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000c1',
         '00000000-0000-0000-0000-0000000000b3');"

# 4. app.participation_via_ok -- through an opportunity
refuse "an entry made through another opportunity rather than a cohort" \
"update public.participations set via_id = '00000000-0000-0000-0000-0000000000d2'
  where id = '00000000-0000-0000-0000-0000000000d1';"

# 5. app.participation_via_ok -- through another project's cohort
refuse "an entry made through a cohort on a different project" \
"update public.participations set via_id = '00000000-0000-0000-0000-0000000000d3'
  where id = '00000000-0000-0000-0000-0000000000d2';"

# 6. app.participation_via_ok -- through itself
refuse "a participation made through itself" \
"update public.participations set via_id = '00000000-0000-0000-0000-0000000000d2'
  where id = '00000000-0000-0000-0000-0000000000d2';"

# 7. app.record_is_opportunity
refuse "a record minted out of a cohort participation" \
"insert into public.records
   (id, org_id, record_kind, project_id, participation_id, slug, year, title,
    discipline, published_on, date_precision, source, reviewed, body_format, license)
 values ('PROBE-2027-0001', '00000000-0000-0000-0000-0000000000aa', 'project',
         '00000000-0000-0000-0000-0000000000c1',
         '00000000-0000-0000-0000-0000000000d1', 'probe', 2027, 'Probe',
         'other', current_date, 'day', 'workbench', false, 'none', 'cc-by-4.0');"

# 7b. One student, one fair, two projects: refused. They would compete
#     against themselves for one place.
refuse "one author entering the same fair with a second project" \
"insert into public.project_authors (org_id, project_id, user_id, role)
 values ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000c1',
         '00000000-0000-0000-0000-0000000000e1', 'author'),
        ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000c2',
         '00000000-0000-0000-0000-0000000000e1', 'author');
 insert into public.participations (org_id, project_id, program_id)
 values ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000c2',
         '00000000-0000-0000-0000-0000000000b2');"

# 7c. ...and the same student with a second project in their own class:
#     allowed. A class is not a fair, and reading `participations` raw made
#     this indistinguishable from 7b -- which is what broke the reset.
accept "one author with a second project in the same cohort" \
"insert into public.project_authors (org_id, project_id, user_id, role)
 values ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000c3',
         '00000000-0000-0000-0000-0000000000e1', 'author');
 insert into public.participations (org_id, project_id, program_id)
 values ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000c3',
         '00000000-0000-0000-0000-0000000000b1');"

# ── The gates. 22.13. ──────────────────────────────────────────────────────
#
# A fixture where the school runs a club that prepares for the fair, and a
# second school that runs no club at all.
apply /dev/stdin <<'GATES'
insert into public.organizations
  (id, slug, hostname, lockup_name, mark, theme, status)
values ('00000000-0000-0000-0000-0000000000ab', 'open', 'open.test',
        'Open Program', 'OP', 'entry', 'active');

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000e2');
insert into public.users (id, org_id, display_name)
values ('00000000-0000-0000-0000-0000000000e2',
        '00000000-0000-0000-0000-0000000000ab', 'Unaffiliated Person');

-- The shared fair, owned by nobody.
insert into public.programs (id, org_id, slug, name, season_year, program_role, kind, status)
values ('00000000-0000-0000-0000-0000000000f1', null, 'probe-regional',
        'Probe Regional Fair', 2027, 'opportunity', 'competition', 'open');

-- The state fair it advances to.
insert into public.programs
  (id, org_id, slug, name, season_year, program_role, kind, status, reached_by_advancing)
values ('00000000-0000-0000-0000-0000000000f2', null, 'probe-state',
        'Probe State Fair', 2027, 'opportunity', 'competition', 'open', true);

update public.programs
   set advances_to_fairs = array['Probe State Fair']
 where id = '00000000-0000-0000-0000-0000000000f1';

-- One school's club, which prepares for the regional. The other school
-- runs nothing.
insert into public.programs
  (id, org_id, slug, name, season_year, program_role, kind, status, prepares_for)
values ('00000000-0000-0000-0000-0000000000f3',
        '00000000-0000-0000-0000-0000000000aa', 'probe-club-2', 'Probe Club', 2027,
        'cohort', 'course', 'open', '00000000-0000-0000-0000-0000000000f1');
GATES

# The gate probes below use `accept`, not `refuse`, and the reason is worth
# recording. Written as refusals they read:
#
#     if the gate is null then raise 'no gate'; end if; raise 'gated';
#
# which raises on both branches, so the statement always errored and `refuse`
# always passed. Both gates were disabled and all five still reported ok --
# a check that could not fail, found the only way such a thing is ever found,
# by breaking the thing it watched.
#
# So each one asserts the *expected* answer and raises only when it is wrong.

# 8a. A school that runs a club enters the fair through it.
accept "a fair is gated when your school's club has not accepted you" \
"do \$\$ begin
   if app.entry_gate('00000000-0000-0000-0000-0000000000f1',
                     null,
                     '00000000-0000-0000-0000-0000000000e1') is null then
     raise exception 'expected a gate, and there was none';
   end if;
 end \$\$;"

# 8b. And once they are in it, the way is clear.
accept "and open once the club has accepted you" \
"insert into public.memberships (org_id, user_id, cohort_id, state)
 values ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000e1',
         '00000000-0000-0000-0000-0000000000f3', 'member');
 do \$\$ begin
   if app.entry_gate('00000000-0000-0000-0000-0000000000f1',
                     null,
                     '00000000-0000-0000-0000-0000000000e1') is not null then
     raise exception 'still gated: %',
       app.entry_gate('00000000-0000-0000-0000-0000000000f1', null,
                      '00000000-0000-0000-0000-0000000000e1');
   end if;
 end \$\$;"

# 8c. **A school with no club has no gate.** This is the Open Program: no
#     club, nobody to ask, and a rule copied from a school that has one
#     would lock them out of a fair they are entitled to enter.
accept "and never gated at a school that runs no club" \
"do \$\$ begin
   if app.entry_gate('00000000-0000-0000-0000-0000000000f1',
                     null,
                     '00000000-0000-0000-0000-0000000000e2') is not null then
     raise exception 'gated with no club to join: %',
       app.entry_gate('00000000-0000-0000-0000-0000000000f1', null,
                      '00000000-0000-0000-0000-0000000000e2');
   end if;
 end \$\$;"

# 8d. The state fair is not a first entry.
accept "a fair reached by advancing is gated before any result" \
"do \$\$ begin
   if app.entry_gate('00000000-0000-0000-0000-0000000000f2',
                     '00000000-0000-0000-0000-0000000000c1',
                     '00000000-0000-0000-0000-0000000000e1') is null then
     raise exception 'expected a gate, and there was none';
   end if;
 end \$\$;"

# 8e. ...and it opens once a result says the project advanced.
accept "and open once a result says the project advanced" \
"insert into public.participations (org_id, project_id, program_id)
 values ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000c1',
         '00000000-0000-0000-0000-0000000000f1')
 on conflict do nothing;
 update public.participations set advanced_to = 'Probe State Fair'
  where project_id = '00000000-0000-0000-0000-0000000000c1'
    and program_id = '00000000-0000-0000-0000-0000000000f1';
 do \$\$ begin
   if app.entry_gate('00000000-0000-0000-0000-0000000000f2',
                     '00000000-0000-0000-0000-0000000000c1',
                     '00000000-0000-0000-0000-0000000000e1') is not null then
     raise exception 'still gated: %',
       app.entry_gate('00000000-0000-0000-0000-0000000000f2',
                      '00000000-0000-0000-0000-0000000000c1',
                      '00000000-0000-0000-0000-0000000000e1');
   end if;
 end \$\$;"

# 8f. **A class has deadlines, and joining one copies them.** This is what
#     makes the participation page rich for a cohort rather than an empty
#     calendar: `set_project_cohort` attached the project and copied nothing,
#     so a class's steps had no rows and therefore no state -- nothing could
#     be marked done, because there was nothing to mark.
accept "joining a cohort copies its deadlines onto the participation" \
"insert into public.program_milestones
   (org_id, program_id, name, kind, due_on, sort_order)
 values ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000b1',
         'Hand in the plan', 'form', current_date + 30, 10);
 do \$\$
 declare v_n int;
 begin
   perform app.copy_milestones('00000000-0000-0000-0000-0000000000d1',
                               '00000000-0000-0000-0000-0000000000b1',
                               '00000000-0000-0000-0000-0000000000aa');

   select count(*) into v_n from public.entry_milestones
    where participation_id = '00000000-0000-0000-0000-0000000000d1';

   if v_n = 0 then
     raise exception 'a class participation still has no deadlines';
   end if;
 end \$\$;"

# 8. the same relationship the other way: a person cannot enrol in a fair
refuse "a person enrolled in an opportunity" \
"insert into public.memberships (org_id, user_id, cohort_id)
 values ('00000000-0000-0000-0000-0000000000aa',
         '00000000-0000-0000-0000-0000000000e1',
         '00000000-0000-0000-0000-0000000000b2');"

echo
if [ "$failed" -gt 0 ]; then
  echo "$failed probe(s) were accepted. A rule that cannot refuse is not a rule."
  exit 1
fi

echo "$passed probes refused, as they should be."
echo
echo "Every new check has now been seen to fail."
