# Server Daemon Operations

Harness Anything can run a local daemon that coordinates reads and writes for
one or more canonical repositories on the same machine. The CLI does not switch
to the daemon automatically: by default it runs in-process direct mode. Set
`HARNESS_DAEMON_MODE=local` for commands that should use the local daemon.

Do not deploy the daemon as a long-lived SSH team server. The supported remote
path is an experimental single-command SSH shim that starts `ha daemon serve
--stdio` for that one client command. It is not a persistent daemon with
concurrent SSH clients.

## Supported Topologies

- Local daemon, one repository: start the daemon next to the canonical
  repository, then opt CLI commands into it with `HARNESS_DAEMON_MODE=local`.
- Local daemon, multiple repositories on one machine: register each repository
  in the user daemon registry, start one daemon, and route commands with
  `--repo <id>`.
- Remote SSH shim: use `HARNESS_DAEMON_MODE=remote` for one CLI command at a
  time. The client spawns `ssh <host> ha daemon serve --stdio ...` and exits
  after the command completes.

Unsupported deployments:

- A persistent daemon reached by many SSH clients. Each SSH client starts its
  own `daemon serve` process, so it can collide with the persistent service on
  `global.lock`.
- Binding the daemon to TCP, HTTP, or WebSocket. The implemented transports are
  the local Unix socket and the Windows named pipe.
- Remote GUI attachment to another machine's daemon. The GUI connects to the
  local daemon endpoint.
- Real-time notification subscriptions. The subscription method is currently a
  no-op stub.

## Prerequisites

- Node.js that satisfies the package engine policy.
- `ha` available on the machine that runs daemon commands.
- Git available on that machine.
- One or more initialized canonical repository paths writable by the daemon
  user.
- SSH access only when using bootstrap checks, read-only mirrors, or the
  experimental remote shim.

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

## Local Daemon

Start the daemon as a detached service:

```bash
ha daemon start --service
```

Run it in the foreground when a service manager should supervise the process:

```bash
ha daemon start --foreground
```

CLI commands keep using direct mode unless you opt in:

```bash
HARNESS_DAEMON_MODE=local ha task list
```

## Multi-Repository Registry

Register every local canonical repository that one daemon should serve:

```bash
ha daemon repo register --repo-id A --root /srv/harness/a
ha daemon repo register --repo-id B --root /srv/harness/b
ha daemon start --service
```

Route CLI commands to a registered repository with `--repo`:

```bash
HARNESS_DAEMON_MODE=local ha --repo A task list
```

The running daemon reconciles the registry every second. A newly registered
repository can attach without restarting the daemon.

## Remote SSH Shim

Remote mode is a single-session shim, not a client for a persistent remote
daemon:

```bash
HARNESS_DAEMON_MODE=remote \
HARNESS_DAEMON_SSH_HOST=team-host \
HARNESS_DAEMON_REMOTE_ROOT=/srv/harness/team \
HARNESS_DAEMON_REMOTE_HA=ha \
ha task list
```

`HARNESS_DAEMON_MODE`, `HARNESS_DAEMON_SSH_HOST`, and
`HARNESS_DAEMON_REMOTE_ROOT` are required. `HARNESS_DAEMON_REMOTE_HA` defaults
to `ha`; set it when the remote binary path is different. Set
`HARNESS_DAEMON_REPO_ID` when the remote side should serve a registered repo id
other than `canonical`.

Do not run this against a repository already held by a persistent daemon. The
SSH shim starts another `daemon serve` process, and that process must acquire
the same `global.lock`.

## Security Model

The local Unix socket is the real access boundary. The daemon creates the socket
directory as `0700` and the socket file as `0600`.

The Unix transport does not perform kernel peer credential validation such as
`SO_PEERCRED`. The recorded peer credential is derived from the daemon process
owner (`process.getuid()` / `process.getgid()`), not from the connecting client.

`harness/people.yaml` enables roster-based authorization when it exists. Without
that roster, local connections are trusted by the transport boundary.

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
daemon version, protocol version, and attached repository status. Stop sends
`SIGTERM` and waits for the daemon runtime to drain queued writes and release
the global lock.
