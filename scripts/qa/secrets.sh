#!/usr/bin/env bash
# Secret scan of tracked + staged files. Uses gitleaks when installed (redacted); otherwise fixed patterns.
# Prints file:line and the rule only — never the value. Exit 1 if anything is found.
set -uo pipefail
if command -v gitleaks >/dev/null; then gitleaks detect --no-banner --redact --exit-code 1; exit $?; fi
patterns='(sb_secret_[A-Za-z0-9_-]{10,}|service_role[^\n]{0,20}eyJ[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{36}|postgres(ql)?://[^:@/ ]+:[^@/ ]{6,}@)'
hits=$(git grep -nIE "$patterns" -- . ':!package-lock.json' ':!scripts/qa/secrets.sh' ':!docs/**' 2>/dev/null | cut -d: -f1,2 || true)
if [[ -n "$hits" ]]; then echo "possible secrets (values redacted):"; sed 's/^/  /' <<<"$hits"; exit 1; fi
echo "secrets: none found (pattern scan; install gitleaks for a deeper scan)"
