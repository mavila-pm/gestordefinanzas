#!/usr/bin/env python3
"""Render tests/e2e/seed.sql for a subset of probe pairs: delete/recreate only those users and keep only their
`if/elsif r.tag …` branches. Reads the rendered seed (password already filled) on stdin. Usage: … | seed-subset.py s13a s13b"""
import re, sys
tags = sys.argv[1:]
src = sys.stdin.read()
emails = ",".join(f"'e2e-{t}@gestordefinanzas.invalid'" for t in tags)
src = re.sub(r"^delete from auth\.users where email like 'e2e-%@gestordefinanzas\.invalid';", f"delete from auth.users where email in ({emails});", src, flags=re.M)
src = re.sub(r"\(values \('s3a'\).*?\) v\(tag\)", "(values " + ",".join(f"('{t}')" for t in tags) + ") v(tag)", src)
out, keep, first = [], True, True
for line in src.split("\n"):
    m = re.match(r"\s+(if|elsif) r\.tag (=|in) (.+?) then$", line)
    if m and ("'s" in m.group(3)) and "<>" not in line:
        branch_tags = re.findall(r"'(s\w+)'", m.group(3))
        keep = any(t in tags for t in branch_tags)
        if keep:
            line = re.sub(r"^(\s+)(if|elsif)", lambda k: k.group(1) + ("if" if first else "elsif"), line); first = False
    elif re.match(r"\s+end if;", line) and not keep:
        keep = True
        if first: continue  # no branch kept: drop the whole if-block's end
    if keep and not line.lstrip().startswith("--"): out.append(line)
sys.stdout.write("\n".join(out))
