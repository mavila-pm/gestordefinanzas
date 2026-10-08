#!/usr/bin/env bash
# E2E orchestrator (docs/runbooks/e2e.md): controlled server lifecycle + health check + suites + guaranteed stop.
#   scripts/e2e.sh [suite ...]        run the given suites (default: all), e.g. scripts/e2e.sh review-manual
#   scripts/e2e.sh render-seed [tags] print an insert-only seed under a NEW run id (all pairs, or just those tags) and
#                                     record the run per tag in .e2e/runs.json (the suites read it)
# Env: E2E_PASSWORD (required), NEXT_PUBLIC_SUPABASE_* (from .env.local), E2E_PORT (default 3000),
#      E2E_DB_URL (optional: seed before and clean after via psql; without it seed/cleanup run through the SQL tool).
set -euo pipefail
cd "$(dirname "$0")/.."

ALL=(auth-dashboard review-manual import-learning analysis-dashboard planning-account splits cashflow onboarding income-link vels account-delete registration)
PORT="${E2E_PORT:-3000}"
BASE="http://localhost:${PORT}"
STATE=.e2e
PIDFILE="$STATE/server.pid"
LOG="$STATE/server.log"
mkdir -p "$STATE"

: "${E2E_PASSWORD:?E2E_PASSWORD is required}"
# Every render = a fresh run id: new synthetic users, so the seed never collides with an earlier run (no delete needed).
new_run() { printf '%s%s' "$(date -u +%y%m%d%H%M%S)" "$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"; }
render_seed() { sed -e "s/__E2E_PASSWORD__/${E2E_PASSWORD//\'/\'\'}/" -e "s/__E2E_RUN__/$1/" tests/e2e/seed.sql; }
record_run() { # record_run <run> <tag…>: the suites resolve each tag's probe users from .e2e/runs.json
  python3 - "$@" <<'PY'
import json, re, sys, pathlib
run, tags = sys.argv[1], sys.argv[2:]
assert re.fullmatch(r"[a-z0-9]{8,20}", run), run
p = pathlib.Path(".e2e/runs.json"); runs = json.loads(p.read_text()) if p.exists() else {}
runs.update({t: run for t in tags}); p.write_text(json.dumps(runs, indent=1, sort_keys=True))
PY
}
ALL_TAGS=(s3a s3b s4a s4b s56a s56b s78a s78b s9a s9b s10a s10b s11a s11b s12a s12b s13a s13b s14a s14b s15a s15b s16a s16b)
if [[ "${1:-}" == "render-seed" ]]; then
  shift; run="$(new_run)"
  if (($#)); then render_seed "$run" | python3 scripts/qa/seed-subset.py "$@"; record_run "$run" "$@"
  else render_seed "$run"; record_run "$run" "${ALL_TAGS[@]}"; fi
  exit 0
fi

if [[ -f .env.local ]]; then set -a; source .env.local; set +a; fi
export E2E_BASE_URL="$BASE"

stop_server() {
  if [[ -f "$PIDFILE" ]]; then
    local pid; pid="$(cat "$PIDFILE")"
    # The server runs in its own process group (setsid): stop the whole group, never other processes.
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

cleanup() {
  local code=$?
  stop_server
  if [[ -n "${E2E_DB_URL:-}" ]]; then
    psql "$E2E_DB_URL" -qAt -v ON_ERROR_STOP=1 -f tests/e2e/cleanup.sql | tail -1 | sed 's/^/cleanup (probe_users|orphan_rows): /'
  else
    echo "cleanup: run tests/e2e/cleanup.sql with the SQL tool (expect 0|0)"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

# 1. Lifecycle: stop our previous server; refuse to run against a foreign process on the port.
stop_server
if pid="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)" && [[ -n "$pid" ]]; then
  if [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" == "$(pwd -P)" ]]; then
    echo "stopping stale server of this repo on :$PORT (pid $pid)"; kill -TERM "$pid"; sleep 1
  else
    echo "port $PORT is used by another process (pid $pid): refusing to run" >&2; exit 2
  fi
fi

# 2. Build only when sources are newer than the last build.
if [[ ! -f .next/BUILD_ID ]] || [[ -n "$(find app components lib src next.config.* package.json tsconfig.json -newer .next/BUILD_ID -print -quit 2>/dev/null)" ]]; then
  echo "building..."; npm run build >"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }
fi

# 3. Start in its own process group and wait for a healthy answer (not a fixed sleep).
AI_PROVIDER=fixture AI_ALLOW_FIXTURE=1 setsid node_modules/.bin/next start -p "$PORT" >"$LOG" 2>&1 &
echo $! >"$PIDFILE"
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login" || true)"
  [[ "$code" == "200" ]] && break
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "server died:"; tail -20 "$LOG"; exit 1; }
  sleep 0.5
done
[[ "$code" == "200" ]] || { echo "health check failed ($code)"; tail -20 "$LOG"; exit 1; }
echo "server healthy on $BASE (pid $(cat "$PIDFILE"))"

# 4. Seed (idempotent) when a DB URL is available.
if [[ -n "${E2E_DB_URL:-}" ]]; then run="$(new_run)"; render_seed "$run" | psql "$E2E_DB_URL" -q -v ON_ERROR_STOP=1 >/dev/null; record_run "$run" "${ALL_TAGS[@]}"; echo "seeded (run $run)"; fi

# 5. Suites: one summary line each; failures and diagnosis are printed in full, passes are not.
if (($#)); then SUITES=("$@"); else SUITES=("${ALL[@]}"); fi
pass=0; total=0; failed=()
for s in "${SUITES[@]}"; do
  file="tests/e2e/$s.e2e.ts"; [[ -f "$file" ]] || file="tests/e2e/$s.ts"   # e.g. "visual" (screenshots + overflow check)
  out="$(node --experimental-strip-types --no-warnings "$file" 2>&1)" && ok=1 || ok=0
  line="$(grep -E "^$s: [0-9]+/[0-9]+ passed" <<<"$out" || echo "$s: crashed")"
  echo "$line"
  grep -E "^PERF " <<<"$out" || true   # latency rows of the perf probe
  if [[ "$line" =~ ([0-9]+)/([0-9]+) ]]; then pass=$((pass + BASH_REMATCH[1])); total=$((total + BASH_REMATCH[2])); fi
  if [[ $ok == 0 ]]; then failed+=("$s"); grep -E "^(FAIL|ERROR|ISSUE|  )" <<<"$out" || tail -15 <<<"$out"; fi
done
echo "E2E TOTAL ${pass}/${total}${failed[*]:+  FAILED: ${failed[*]}}"
if ((${#failed[@]})); then echo "--- server log (last 15) ---"; tail -15 "$LOG"; exit 1; fi
