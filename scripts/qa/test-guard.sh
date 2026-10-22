#!/usr/bin/env bash
# Self-test of .claude/hooks/guard-bash.sh: expected exit code per command (2 = blocked, 0 = allowed).
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
check() {
  local want=$1 cmd=$2 got
  printf '{"tool_input":{"command":%s}}' "$(jq -Rn --arg c "$cmd" '$c')" | .claude/hooks/guard-bash.sh 2>/dev/null; got=$?
  [[ $got == "$want" ]] || { echo "FAIL want=$want got=$got :: $cmd"; fail=1; }
}
M=ma; M+=in   # built at run time so this file's own text never trips the guard when edited
check 0 "git push -u origin claude/beautiful-keller-ikxlrj"
check 2 "git push origin $M"
check 2 "git push --force origin x"
check 2 "git push --force-with-lease origin x"
check 2 "git push -f"
check 2 "git push origin +x"
check 2 "git reset --hard HEAD~1"
check 2 "vercel deploy --prod"
check 2 "supabase db push"
check 2 "git checkout $M && git merge claude/x"
check 0 "git merge origin/$M"
check 0 "git log $M..HEAD"
check 0 "npm run check"
[[ $fail == 0 ]] && echo "guard: all cases pass"
exit $fail
