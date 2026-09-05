#!/bin/sh
set -eu

if [ "$#" -ne 7 ]; then
  echo "usage: $0 CENTER_HOST PORT CA_FILE CONNECTION_NAME WORKSPACE_ROOT VIEW_ROOT QUOTA_BYTES" >&2
  exit 64
fi

CENTER_HOST=$1
CENTER_PORT=$2
CA_FILE=$3
CONNECTION_NAME=$4
WORKSPACE_ROOT=$5
VIEW_ROOT=$6
QUOTA_BYTES=$7

ha daemon connection add \
  --connection "$CONNECTION_NAME" \
  --display-name "S4 fleet campaign" \
  --endpoint "tls://$CENTER_HOST:$CENTER_PORT"

seed=1
while [ "$seed" -le 3 ]; do
  repo_id="stress-seed-$seed"
  workspace="$WORKSPACE_ROOT/$repo_id"
  assignment="$repo_id-schedule-1"
  node_id="edge-1"
  view="$VIEW_ROOT/$repo_id"

  (
    cd "$workspace"
    ha daemon repo register \
      --repo-id "$repo_id" \
      --root "$workspace" \
      --mode remote-edge
    ha daemon fleet edge sync \
      --host "$CENTER_HOST" \
      --port "$CENTER_PORT" \
      --ca "$CA_FILE" \
      --servername localhost \
      --node-id "$node_id" \
      --roster "$workspace/fleet-roster.json" \
      --assignment "$assignment" \
      --view-root "$view" \
      --quota-bytes "$QUOTA_BYTES"
  )
  seed=$((seed + 1))
done

echo "Open the Electron GUI and verify all three repos show the remote-edge badge and live revision growth."
