#!/usr/bin/env bash
# Maps the current diff (vs a base, default HEAD = uncommitted; e.g. `scripts/qa/risk.sh origin/main`) to the
# minimum verification level of docs/qa.md. Deterministic: path patterns only.
set -uo pipefail
base="${1:-HEAD}"
files=$( { git diff --name-only "$base"; git diff --name-only --cached "$base"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
[[ -z "$files" ]] && { echo "no changes → nothing to verify"; exit 0; }
has() { grep -Eq "$1" <<<"$files"; }
level=0; reasons=()
add() { (( $1 > level )) && level=$1; reasons+=("$2"); }
has '^(src|lib|app|components|proxy\.ts|next\.config\.ts)/?' && add 1 "code → N1 check"
has '\.test\.ts$' && add 0 "tests changed → N0 targeted"
has '^(supabase/|tests/db/|src/infrastructure/)' && add 1 "SQL/persistence → N1 + npm run test:db (RLS, A/B)"
has '^(app|components)/|\.tsx$|globals\.css$|next\.config' && add 2 "UI/app → N2 build"
has '^supabase/migrations/' && add 3 "migration → N3: apply to project, compact verify, advisors, E2E of touched suites"
has '^(app/.*actions\.ts|lib/(planning|assistant|onboarding|learning)\.ts|src/engine/|src/ai/(apply|assistant|draft)\.ts)' && add 3 "financial/write paths → N3 focused E2E + financial-safety skill"
has '^(proxy\.ts|lib/supabase/|app/auth/|app/\(auth\)/|app/api/|lib/ai\.ts)' && add 4 "auth/shared request path → N4 full E2E + security-reviewer"
has '^(src/ingestion/|src/engine/fingerprint|src/engine/ingest)' && add 4 "dedupe/ingestion → N4 full E2E"
(( ${#reasons[@]} )) || reasons+=("docs/agent config only → N0: validate config; no app tests needed")
echo "files: $(wc -l <<<"$files" | tr -d ' ')  required: N$level"
printf '  - %s\n' "${reasons[@]}" | sort -u
