#!/bin/bash
# Host-side read-path smoke for the PLT-Center testbed. Assumes
# `docker compose up -d --wait` succeeded. Verifies both edges can pull and read
# the center ledger projection, that the canonical ledger is visible on GitLab,
# and prints the center's key log lines.

set -euo pipefail
cd "$(dirname "$0")"

: "${GITLAB_TOKEN:?export GITLAB_TOKEN=$(cat ~/.harness-secrets-center-testbed-token)}"
GITLAB_URL="${GITLAB_URL:-http://43.142.81.196:8929}"
PROJECT_PATH="${TESTBED_GITLAB_PROJECT:-plt-center-testbed}"

echo "== edge read-path smoke =="
docker compose exec -T edge-1 node /opt/testbed/smoke-edge.mjs edge-1
docker compose exec -T edge-2 node /opt/testbed/smoke-edge.mjs edge-2

echo
echo "== GitLab visibility =="
PROJECT_JSON=$(curl -fsS -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/root%2F$PROJECT_PATH")
echo "$PROJECT_JSON" | python3 -c '
import json, sys
project = json.load(sys.stdin)
print("web_url:", project["web_url"])
print("path_with_namespace:", project["path_with_namespace"])
print("default_branch:", project["default_branch"])
print("last_activity_at:", project["last_activity_at"])
'
BRANCH_JSON=$(curl -fsS -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/root%2F$PROJECT_PATH/repository/branches/main")
echo "$BRANCH_JSON" | python3 -c '
import json, sys
branch = json.load(sys.stdin)
print("main head:", branch["commit"]["short_id"], "-", branch["commit"]["title"][:60])
'

echo
echo "== center log (key lines) =="
docker compose logs --no-log-prefix center 2>/dev/null | grep "testbed:" | tail -12

echo
echo "SMOKE PASS: both edges read the center projection; the ledger is visible on GitLab."
