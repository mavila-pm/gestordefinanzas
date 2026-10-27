#!/usr/bin/env bash
# Prints the demo-account seed (scripts/qa/demo-account.sql) with a fresh run id and DEMO_PASSWORD from the environment.
# Run the output in the Supabase SQL Editor of the DEV project (jeloegnvaxlfqjntbbyy). Never commit the password.
#   DEMO_PASSWORD='…' scripts/qa/demo-account.sh > /tmp/demo.sql
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${DEMO_PASSWORD:?set DEMO_PASSWORD (12+ chars, letters and numbers)}"
[[ ${#DEMO_PASSWORD} -ge 12 && "$DEMO_PASSWORD" =~ [A-Za-z] && "$DEMO_PASSWORD" =~ [0-9] ]] || { echo "DEMO_PASSWORD: 12+ chars with letters and numbers" >&2; exit 1; }
run="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 10)"
sed -e "s/__DEMO_PASSWORD__/${DEMO_PASSWORD//\'/\'\'}/" -e "s/__DEMO_RUN__/$run/g" scripts/qa/demo-account.sql
echo "-- login: demo-$run@gestordefinanzas.invalid" >&2
