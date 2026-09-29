#!/usr/bin/env bash
# PreToolUse(Bash) guard — deterministic, no model calls. Blocks what CLAUDE.md forbids; exit 2 = blocked (stderr
# is shown to Claude). Anything else passes untouched. Tests: scripts/qa/test-guard.sh
cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null)
block() { echo "blocked by .claude/hooks/guard-bash.sh: $1. Ask the PO if this is really intended." >&2; exit 2; }
grep -Eq 'git +push\b[^;&|]*(\s|:)(main|master)(\s|$)' <<<"$cmd" && block "push to main"
grep -Eq 'git +push\b[^;&|]*(\s--force|\s-f(\s|$)|\s\+[A-Za-z0-9_/.-]+)' <<<"$cmd" && block "force push (incl. --force-with-lease)"
grep -Eq 'git +(checkout|switch) +(main|master)\b' <<<"$cmd" && grep -Eq 'git +(merge|commit|cherry-pick|rebase)\b' <<<"$cmd" && block "changing main"
grep -Eq 'git +reset +--hard' <<<"$cmd" && block "git reset --hard"
grep -Eq '\bvercel\b[^;&|]*--prod' <<<"$cmd" && block "production deploy"
grep -Eq '\bsupabase +(db +(push|reset)|projects +delete)' <<<"$cmd" && block "remote Supabase schema/project operation (use migrations + the reviewed apply path)"
exit 0
