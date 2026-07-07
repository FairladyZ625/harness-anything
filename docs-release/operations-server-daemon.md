# Server Daemon Operations

Harness Anything team mode runs one canonical repository behind one long-lived daemon.
Clients reach it over SSH; no public TCP port is required.

## Prerequisites

- Node.js that satisfies the package engine policy.
- `ha` available on the server user's `PATH`.
- Git available on the server.
- SSH access for each team member.
- A canonical repository path writable by the daemon user.

## Bootstrap

Run the server bootstrap once, then rerun it safely whenever you need to verify
the layout:

```bash
ha daemon bootstrap-server \
  --canonical-root /srv/harness/team \
  --ssh-host team-host \
  --ssh-user alice \
  --person-id person_alice \
  --display-name "Alice Admin" \
  --email alice@example.com \
  --readonly-mirror /srv/harness/team-readonly.git
```

The command initializes the canonical repository, ensures `harness/people.yaml`,
installs the canonical pre-receive hook, optionally creates a read-only mirror,
starts the local daemon service, verifies SSH reachability, and writes a
`daemon-bootstrap-report/v1` JSON report.

Use `--skip-ssh-check` for offline preparation and `--no-start` when a service
manager will start the daemon later.

## Service Templates

Copy platform templates from the CLI package:

```bash
ha daemon install-templates --out ./daemon-service-templates
```

Templates are intentionally package-manager neutral:

- `harness-anything-daemon.service` for systemd.
- `com.harness-anything.daemon.plist` for launchd.
- `install-harness-anything-daemon.ps1` for Windows Service registration.

Replace `{{HA_BIN}}`, `{{CANONICAL_ROOT}}`, `{{USER}}`, and log placeholders for
your host before installing them.

## Direct Push Hook

The canonical repository hook rejects non-daemon pushes and tells users to use
the daemon-backed `ha` path. It is a server-side accident guard, not content
review. It fails closed unless a future daemon-managed push path supplies the
server-local daemon token.

## Read-Only Mirror

The mirror is for bulk context reads:

```bash
git fetch ssh://team-host/srv/harness/team-readonly.git
```

Mirror synchronization is ordinary Git fetch from the canonical repository. It
does not require daemon push logic. The mirror has its own pre-receive hook that
rejects writes and points users back to the canonical daemon path.

## Status And Stop

```bash
ha --root /srv/harness/team daemon status --json
ha --root /srv/harness/team daemon stop --timeout-ms 5000 --json
```

Status reports the lock holder, queue depth, active and total connections,
daemon version, and protocol version. Stop sends `SIGTERM` and waits for the
daemon runtime to drain queued writes and release the global lock.
