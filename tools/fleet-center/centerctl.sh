#!/usr/bin/env bash
set -euo pipefail
umask 077

# User-space Fleet center deployment for the W5-R rehearsal. This script never
# uses sudo, edits service configuration, or touches the host's default Harness
# daemon.

action=${1:-}
case "$action" in
  up|status|down) ;;
  *) echo "usage: $0 up|status|down" >&2; exit 64 ;;
esac

center_root=${HARNESS_CENTER_ROOT:-"$HOME/harness-center"}
app_root="$center_root/app"
repo_root="$center_root/repo"
user_root="$center_root/user-root"
fleet_root="$center_root/fleet"
state_root="$center_root/fleet-state"
cache_root="$center_root/cache"
daemon_id=${HARNESS_CENTER_DAEMON_ID:-center-rehearsal}
repo_id=${HARNESS_CENTER_REPO_ID:-canonical}
app_url=${HARNESS_CENTER_APP_URL:-https://github.com/FairladyZ625/harness-anything.git}
app_ref=${HARNESS_CENTER_APP_REF:-origin/main}
backup_dir=${HARNESS_CENTER_BACKUP_DIR:-}
fleet_port=${HARNESS_CENTER_PORT:-7443}
fleet_bind=${HARNESS_CENTER_BIND:-0.0.0.0}
fleet_quota_bytes=${HARNESS_CENTER_QUOTA_BYTES:-4294967296}
executor_id=${HARNESS_CENTER_EXECUTOR_ID:-codex-sol-w5r}
node_version=24.18.0
node_dist="node-v${node_version}-linux-x64"
node_sha256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
node_root="$HOME/.local/opt/$node_dist"
node_bin="$node_root/bin/node"
cli_entry="$app_root/packages/cli/dist/cli/src/index.js"

fail() { echo "centerctl: $*" >&2; exit 1; }
note() { echo "centerctl: $*"; }

require_server_shape() {
  [[ $(uname -s) == Linux ]] || fail "this deployment targets Linux"
  [[ $(uname -m) == x86_64 ]] || fail "this deployment targets Linux x86_64"
  [[ $fleet_port =~ ^[1-9][0-9]{0,4}$ ]] && (( fleet_port <= 65535 )) || fail "HARNESS_CENTER_PORT must be 1..65535"
  [[ $fleet_quota_bytes =~ ^[1-9][0-9]*$ ]] || fail "HARNESS_CENTER_QUOTA_BYTES must be positive"
}

ensure_node() {
  if [[ -x $node_bin ]]; then
    [[ $($node_bin --version) == "v$node_version" ]] || fail "$node_root contains the wrong Node version"
    note "Node v$node_version already present at $node_root"
    return
  fi
  [[ ! -e $node_root ]] || fail "$node_root exists but does not contain the expected Node binary"
  mkdir -p "$cache_root" "$HOME/.local/opt" "$center_root/tmp"
  local archive="$cache_root/$node_dist.tar.xz" temporary
  if [[ ! -f $archive ]]; then
    curl --fail --location --silent --show-error "https://nodejs.org/dist/v${node_version}/${node_dist}.tar.xz" --output "$archive.part"
    mv "$archive.part" "$archive"
  fi
  printf '%s  %s\n' "$node_sha256" "$archive" | sha256sum --check --status || fail "Node archive SHA256 mismatch"
  temporary=$(mktemp -d "$center_root/tmp/node.XXXXXX")
  tar -xJf "$archive" -C "$temporary"
  mv "$temporary/$node_dist" "$node_root"
  rmdir "$temporary"
  [[ $($node_bin --version) == "v$node_version" ]] || fail "Node installation verification failed"
  note "installed Node v$node_version at $node_root"
}

ensure_app() {
  if [[ ! -e $app_root ]]; then
    git clone "$app_url" "$app_root"
  fi
  [[ -d $app_root/.git ]] || fail "$app_root is not a Git checkout"
  git -C "$app_root" diff --quiet && git -C "$app_root" diff --cached --quiet || fail "$app_root has tracked changes"
  if ! git -C "$app_root" rev-parse --verify --quiet "$app_ref^{commit}" >/dev/null; then
    git -C "$app_root" fetch --quiet origin "$app_ref"
  fi
  git -C "$app_root" checkout --quiet --detach "$app_ref"
  PATH="$node_root/bin:$PATH" npm --prefix "$app_root" ci
  PATH="$node_root/bin:$PATH" npm --prefix "$app_root" run build -w @harness-anything/cli
  [[ -f $cli_entry ]] || fail "CLI build did not create $cli_entry"
  note "app built at $(git -C "$app_root" rev-parse HEAD)"
}

ha() {
  env \
    HARNESS_DAEMON_USER_ROOT="$user_root" \
    HARNESS_DAEMON_ID="$daemon_id" \
    HARNESS_ACTOR="agent:$executor_id" \
    HARNESS_GIT_AUTHOR_NAME="PLT Center Rehearsal" \
    HARNESS_GIT_AUTHOR_EMAIL="plt-center-rehearsal@invalid" \
    GIT_AUTHOR_NAME="PLT Center Rehearsal" \
    GIT_AUTHOR_EMAIL="plt-center-rehearsal@invalid" \
    GIT_COMMITTER_NAME="PLT Center Rehearsal" \
    GIT_COMMITTER_EMAIL="plt-center-rehearsal@invalid" \
    "$node_bin" "$cli_entry" --json "$@"
}

daemon_pid_file() { printf '%s/daemon-%s.pid\n' "$user_root" "$daemon_id"; }

stop_daemon_if_running() {
  local pid_file
  pid_file=$(daemon_pid_file)
  if [[ ! -f $pid_file ]]; then return; fi
  if ! ha daemon stop; then
    fail "isolated daemon did not stop cooperatively; inspect it before using --force"
  fi
}

# A Git clone of the private ledger is not a bootstrappable center: the SQLite
# canonical store and its activation never enter Git (F-BE0B012E). The first up
# instead restores a consistent backup produced by `ha backup` on the source
# machine, which carries the accepted SQLite ledger, the activation, and the
# authored tree as one verified unit.
restore_repo_from_backup() {
  if [[ -d $repo_root/harness ]]; then
    validate_restore_receipt "$center_root/restore-receipt.json" ||
      fail "$repo_root is present but has no accepted restore receipt; inspect $center_root/restore-receipt.json"
    note "repository already present at $repo_root"
    return
  fi
  [[ ! -e $repo_root ]] || fail "$repo_root already exists; inspect it instead of restoring over it"
  [[ -n $backup_dir ]] || fail "set HARNESS_CENTER_BACKUP_DIR to a backup produced by 'ha backup' for the first up"
  [[ -f $backup_dir/manifest.json ]] || fail "HARNESS_CENTER_BACKUP_DIR has no manifest.json; pass a directory produced by 'ha backup'"
  admit_backup "$backup_dir/manifest.json" || fail "$backup_dir is not admissible for this center; inspect its manifest.json"
  local receipt="$center_root/restore-receipt.json"
  ha restore "$backup_dir" --to "$repo_root" >"$receipt" || fail "restore failed; inspect $receipt"
  validate_restore_receipt "$receipt" || fail "restore did not produce a bootstrappable center ledger; inspect $receipt"
  note "ledger restored to $repo_root from $backup_dir"
}

# The admission decisions the backup's own manifest already carries: the restore
# receipt only echoes these fields, so a backup this center would reject is
# refused before `ha restore` materializes anything. A materialized-but-rejected
# restore would leave a directory that a later up must not mistake for an
# initialized repository.
admit_backup() {
  "$node_bin" -e '
    const fs = require("node:fs"), manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const reject = (reason) => { process.stderr.write(`centerctl: ${reason}\n`); process.exit(1); };
    if (manifest.schema !== "ledger-backup/v1") reject("the backup manifest is not ledger-backup/v1");
    if (manifest.sqlite?.present !== true) reject("the backup carries no SQLite canonical store");
    if (manifest.registration && manifest.registration.repoId !== process.argv[2])
      reject(`the backup belongs to repository ${manifest.registration.repoId}, not ${process.argv[2]}`);
  ' "$1" "$repo_id"
}

validate_restore_receipt() {
  "$node_bin" -e '
    const fs = require("node:fs"), receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const reject = (reason) => { process.stderr.write(`centerctl: ${reason}\n`); process.exit(1); };
    if (receipt.ok !== true || receipt.schema !== "ledger-restore-receipt/v1") reject("restore did not succeed");
    if (receipt.sqlite?.present !== true) reject("the backup carries no SQLite canonical store");
    if (receipt.registration && receipt.registration.repoId !== process.argv[2])
      reject(`the backup belongs to repository ${receipt.registration.repoId}, not ${process.argv[2]}`);
  ' "$1" "$repo_id"
}

register_restored_repo() {
  ha daemon repo register --repo-id "$repo_id" --root "$repo_root" --mode remote-center >/dev/null
}

start_daemon() {
  mkdir -p "$user_root"
  ha daemon start --service >/dev/null
}

wait_for_center_repo() {
  local deadline=$((SECONDS + 900)) status_file="$center_root/daemon-status.json"
  while (( SECONDS < deadline )); do
    if ha daemon status >"$status_file" 2>/dev/null && "$node_bin" -e '
      const fs=require("fs"), [file,id]=process.argv.slice(1), value=JSON.parse(fs.readFileSync(file,"utf8"));
      process.exit(value.repos?.some(r=>r.repoId===id&&r.state==="attached"&&r.mode==="remote-center")?0:1);
    ' "$status_file" "$repo_id"; then
      note "repo $repo_id attached in remote-center mode"
      return
    fi
    sleep 2
  done
  fail "repo $repo_id did not attach within 900 seconds"
}

rebuild_projection() {
  local receipt="$center_root/projection-rebuild.json"
  ha --root "$repo_root" daemon projection rebuild >"$receipt"
  "$node_bin" -e '
    const fs = require("node:fs"), receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (receipt.outcome !== "applied" || receipt.ok !== true || receipt.proof?.committedRevision !== receipt.proof?.appliedCut) process.exit(1);
  ' "$receipt" || fail "projection rebuild did not reach the exact center cut; inspect $receipt"
  note "projection rebuilt to the exact canonical cut"
}

# Installs and starts the managed Keycloak and PostgreSQL the center verifies
# node credentials against. It needs no sign-in; the first administrator, the
# sign-in, and node registration are an operator's steps and are not run here.
start_authorization_service() {
  local receipt="$center_root/rbac-bootstrap.json"
  ha bootstrap >"$receipt" || fail "the authorization service did not start; inspect $receipt"
  "$node_bin" -e '
    const fs = require("node:fs"), receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (receipt.ok !== true || receipt.ready !== true) process.exit(1);
  ' "$receipt" || fail "the authorization service is not ready; inspect $receipt"
  note "authorization service ready"
}

ensure_tls() {
  mkdir -p "$fleet_root" "$state_root"
  chmod 700 "$fleet_root" "$state_root"
  if [[ ! -f $fleet_root/server.key || ! -f $fleet_root/server.crt ]]; then
    [[ ! -e $fleet_root/server.key && ! -e $fleet_root/server.crt ]] || fail "TLS material is partial; inspect it instead of overwriting"
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$fleet_root/server.key.staging" -out "$fleet_root/server.crt.staging" \
      -subj '/CN=tencent-lighthouse-prod' -days 30 \
      -addext 'subjectAltName=DNS:tencent-lighthouse-prod,DNS:localhost,IP:43.142.81.196,IP:127.0.0.1' >/dev/null 2>&1
    chmod 600 "$fleet_root/server.key.staging"
    mv "$fleet_root/server.key.staging" "$fleet_root/server.key"
    mv "$fleet_root/server.crt.staging" "$fleet_root/server.crt"
  fi

}

tls_healthy() {
  timeout 5 openssl s_client -connect "127.0.0.1:$fleet_port" -servername tencent-lighthouse-prod \
    -CAfile "$fleet_root/server.crt" -verify_return_error </dev/null >/dev/null 2>&1
}

start_center() {
  if tls_healthy; then
    note "Fleet TLS listener already healthy on 127.0.0.1:$fleet_port"
    return
  fi
  ha daemon fleet center start --port "$fleet_port" --bind "$fleet_bind" \
    --key "$fleet_root/server.key" --cert "$fleet_root/server.crt" \
    --repo "$repo_id" --quota-bytes "$fleet_quota_bytes" \
    --state-root "$state_root" >"$center_root/fleet-start.json"
  local deadline=$((SECONDS + 30))
  until tls_healthy; do
    (( SECONDS < deadline )) || fail "Fleet TLS listener did not become healthy"
    sleep 1
  done
  note "Fleet TLS listener healthy on $fleet_bind:$fleet_port"
}

print_status() {
  local pid_file pid rss_kb=0 daemon_state=down fleet_state=down
  pid_file=$(daemon_pid_file)
  if [[ -f $pid_file ]]; then
    pid=$(tr -d '[:space:]' <"$pid_file")
    if [[ $pid =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
      daemon_state=up
      rss_kb=$(ps -o rss= -p "$pid" | tr -d '[:space:]')
    else
      pid=null
    fi
  else
    pid=null
  fi
  if [[ -f $fleet_root/server.crt ]] && tls_healthy; then fleet_state=up; fi
  printf '{"schema":"fleet-center-deployment-status/v1","daemon":"%s","fleet":"%s","pid":%s,"rssKiB":%s,"port":%s,"repoId":"%s","appCommit":"%s"}\n' \
    "$daemon_state" "$fleet_state" "$pid" "${rss_kb:-0}" "$fleet_port" "$repo_id" \
    "$(git -C "$app_root" rev-parse HEAD 2>/dev/null || printf unknown)"
}

require_server_shape
if [[ $action == down ]]; then
  [[ -x $node_bin && -f $cli_entry ]] || fail "deployment is not prepared"
  stop_daemon_if_running
  note "isolated daemon stopped; repository, TLS and Fleet state retained"
  print_status
  exit 0
fi
if [[ $action == status ]]; then
  [[ -x $node_bin && -f $cli_entry ]] || fail "deployment is not prepared"
  print_status
  exit 0
fi

ensure_node
ensure_app
restore_repo_from_backup
start_daemon
register_restored_repo
wait_for_center_repo
rebuild_projection
start_authorization_service
ensure_tls
start_center
print_status
