#!/usr/bin/env bash
# Runs a command with its full output saved to .qa/<label>.log and prints only a short summary.
# The exit code is the command's own (never lost to grep/tail).  Usage: scripts/qa/run.sh <label> -- <cmd…>
set -uo pipefail
label="${1:?label}"; shift; [[ "${1:-}" == "--" ]] && shift
mkdir -p .qa; log=".qa/${label}.log"
start=$(date +%s)
"$@" >"$log" 2>&1; code=$?
secs=$(( $(date +%s) - start ))
# Summary lines understood across our runners (vitest, e2e.sh, tsc, next build).
summary=$(grep -E "Tests +[0-9]|Test Files|E2E TOTAL|: [0-9]+/[0-9]+ passed|error TS|Failed to compile|Compiled successfully|✓ Compiled|FAIL|ERROR|×" "$log" | grep -v "^\s*$" | tail -12)
echo "[$label] exit=$code ${secs}s log=$log"
[[ -n "$summary" ]] && echo "$summary" || tail -5 "$log"
exit $code
