#!/usr/bin/env bash
#
# THE MIGRATION, RUN.
#
# Everything else about the schema is checked by reading it: names, ordering,
# which function a policy calls. None of that catches a rule that is written
# correctly and answers wrongly, and the visibility rule is the one place
# where being wrong is invisible until somebody sees a project they should
# not.
#
# So this stands up a Postgres, applies the migration, and asks the questions
# section 6.6 makes claims about.
#
# It found a real one on its first run: `can_edit_project` counted a project's
# creator and `can_see_project` did not, so between creating a project and
# writing its first author row, somebody could edit a row they could not read.
#
# Needs postgresql installed. Skips cleanly when it is not, because it is not
# worth making everybody install a database to run the unit tests.
#
#   ./tests/db/run.sh
#
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_DIR="${PG_DIR:-/tmp/scipath-pg}"
PG_PORT="${PG_PORT:-5433}"

if [ ! -x "$PG_BIN/initdb" ]; then
  echo "No Postgres at $PG_BIN, so the database tests are skipped."
  echo "Install it with: apt-get install -y postgresql"
  exit 0
fi

say() { printf '\n%s\n' "$1"; }

# Postgres refuses to run as root, which is what a container usually gives
# you. Drop to the postgres account when that is the case.
AS=""
if [ "$(id -u)" = "0" ]; then
  if id postgres >/dev/null 2>&1; then
    AS="postgres"
  else
    echo "Running as root and there is no postgres account, so this is skipped."
    exit 0
  fi
fi

run() {
  if [ -n "$AS" ]; then su "$AS" -s /bin/bash -c "$1"; else bash -c "$1"; fi
}

# ── A database, from nothing ───────────────────────────────────────────────

if [ -d "$PG_DIR/data" ]; then
  "$PG_BIN/pg_ctl" -D "$PG_DIR/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$PG_DIR"
fi

mkdir -p "$PG_DIR"
[ -n "$AS" ] && chown -R "$AS" "$PG_DIR"

run "$PG_BIN/initdb -D $PG_DIR/data -U postgres" >/dev/null
# A unix socket only. Binding TCP means colliding with whatever else is on
# the port, and nothing here needs the network.
run "$PG_BIN/pg_ctl -D $PG_DIR/data -l $PG_DIR/log -o '-k $PG_DIR -p $PG_PORT -h \"\"' start" >/dev/null
sleep 1

stop() { run "$PG_BIN/pg_ctl -D $PG_DIR/data stop -m immediate" >/dev/null 2>&1 || true; }
[ "${KEEP:-}" = "1" ] || trap stop EXIT

psql() {
  local file="$1"
  cp "$file" "$PG_DIR/current.sql"
  chmod 644 "$PG_DIR/current.sql"

  # The status is psql's, not grep's.
  #
  # This used to end in `|| true`, which was there because grep exits 1 when
  # it filters every line away, and which also swallowed psql's own exit
  # code. The whole suite therefore reported success no matter what: an
  # injected `select 1/0` printed its error, printed "The migration applies
  # and behaves", and exited 0. Fifty-four assertions that could not fail.
  #
  # So the output is captured, the status kept, and the filtering done
  # afterwards where grep's exit code is nobody's business. `set -e` at the
  # top turns the return into the failure it always should have been.
  local output status=0
  output=$(run "$PG_BIN/psql -h $PG_DIR -p $PG_PORT -U postgres -q -t -A -v ON_ERROR_STOP=1 -f $PG_DIR/current.sql" 2>&1) || status=$?

  printf '%s\n' "$output" \
    | grep -vE '^(SET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|DO|CREATE|INSERT|UPDATE [0-9]+|t|f)$' || true

  return $status
}

# ── What Supabase provides before any migration runs ───────────────────────
#
# Enough to exercise the migration, not a reimplementation of Supabase.

psql tests/db/platform.sql

say "── Applying the migration"
for migration in supabase/migrations/*.sql; do psql "$migration"; done
echo "  ok   it applies to an empty database"

say "── Visibility"
psql tests/db/visibility.sql

say "── Access, from the outside"
psql tests/db/access.sql

say "── The functions a page calls"
psql tests/db/functions.sql

say ""
echo "The migration applies and behaves."
