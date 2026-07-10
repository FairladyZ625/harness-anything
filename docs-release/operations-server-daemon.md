# Server Daemon Operations

Harness Anything can run a local daemon that coordinates reads and writes for
one or more canonical repositories on the same machine. The CLI does not switch
to the daemon automatically: by default it runs in-process direct mode. Set
`HARNESS_DAEMON_MODE=local` for commands that should use the local daemon.

The remote path is experimental. A remote CLI command opens an SSH stdio relay
to an already-running daemon; it does not start a daemon over SSH. Remote team
access must use one SSH `authorized_keys` forced command per member, as described
in [Team onboarding with SSH forced commands](#team-onboarding-with-ssh-forced-commands).

## Supported Topologies

- Local daemon, one repository: start the daemon next to the canonical
  repository, then opt CLI commands into it with `HARNESS_DAEMON_MODE=local`.
- Local daemon, multiple repositories on one machine: register each repository
  in the user daemon registry, start one daemon, and route commands with
  `--repo <id>`.
- Remote SSH relay: use `HARNESS_DAEMON_MODE=remote` for one CLI command at a
  time. The client runs `ssh <host> ha daemon connect --stdio`; sshd's forced
  command connects that stdio stream to the persistent local daemon.

Unsupported deployments:

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
  experimental remote relay.

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

## Remote SSH Relay

Remote mode is a single-command client of a persistent remote daemon. It opens
an SSH stdio session, which the server's forced command relays to the daemon:

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

The client invokes `ssh <host> <remote-ha> daemon connect --stdio`. The server
must already be running `ha daemon start --service` for the canonical root. The
remote root is sent with each request and must match the root pinned by the
member's forced command.

## Team onboarding with SSH forced commands

This experimental path authenticates a person through the server's sshd, not
through `process.env.USER` or a client-supplied principal. Configure it on the
daemon host, where the persistent daemon and the canonical repository live.

1. Start and register the daemon for `/srv/harness/team`; the bootstrap command
   above can create the initial roster and service. Ensure the service is
   running with `ha --root /srv/harness/team daemon start --service`.
2. Add each member to `harness/people.yaml`. Their entry needs a stable
   `personId`, `displayName`, `primaryEmail`, a role whose command classes grant
   the intended access, and an exact transport credential. Its issuer must
   match `host:<os.hostname()>` as observed by the daemon process, not merely
   an SSH alias used by clients. Restart the daemon service after every roster
   edit; the running repo binding loads the roster when it starts.

   ```yaml
   - personId: person_alice
     displayName: Alice
     primaryEmail: alice@example.com
     roles: [maintainer]
     credentials:
       - kind: ssh-forced-command-person
         issuer: host:team-host
         subject: person_alice
   ```

3. Add one `authorized_keys` line for that member's public key on the daemon
   account. This example pins both Alice and `/srv/harness/team`; replace the
   key material and comment, but keep the command arguments structurally
   identical.

   ```text
   command="ha --root /srv/harness/team daemon connect --stdio --principal person_alice --expect-original-command 'ha daemon connect --stdio'",restrict ssh-ed25519 AAAA... alice@example.com
   ```

4. On the member's client, use the remote mode variables shown above. The
   expected original command is exact. The example assumes the remote binary is
   `ha`; if `HARNESS_DAEMON_REMOTE_HA` changes it, make the forced command's
   expected string match the actual SSH command exactly.

### Revocation

Remove the member's `authorized_keys` line first: that immediately prevents new
SSH sessions. Then remove the matching credential or person from
`harness/people.yaml`, or mark the person disabled, and restart the daemon so
the roster change applies and existing relay sessions are disconnected. Review
and rotate a key if its custody is in doubt; changing only a display name or
role is not key revocation.

### Security boundary

The following checks are mechanical:

- sshd authenticates the key and runs the static forced command; the relay
  rejects a process without a root-owned `sshd` ancestor.
- `SSH_ORIGINAL_COMMAND` must exactly equal the authorized expected command.
  The expected command itself rejects `--principal`, `--root`, and
  `--expect-original-command`, so a client cannot smuggle those privileged
  options through it.
- The forced command pins the canonical root. A request for another root is
  rejected, and the daemon resolves the forced principal only through the exact
  `ssh-forced-command-person` credential in the roster.

These are not substitutes for administration discipline. Administrators must
verify public-key ownership before assigning a `personId`, protect the daemon
account and its `authorized_keys` / roster files, grant the minimum role, and
remove keys and credentials promptly when access ends. The mechanism proves
which configured key path was used; it cannot prove that an administrator mapped
the right human to that key or that the human retained sole control of it.

## Security Model

The local Unix socket is the real access boundary. The daemon creates the socket
directory as `0700` and the socket file as `0600`.

The Unix transport does not inspect the connected process identity. It records
`unix-socket-owner-boundary`, whose subject is the socket file owner's
`stat.uid`. Every accepted client is attributed to that owner solely because
the `0700` directory and `0600` socket permit only the owner to connect. Widening
either permission invalidates this boundary and requires a different identity
source.

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
