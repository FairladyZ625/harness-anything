# Server Daemon Operations

Harness Anything has three connection modes. They are machine-local registry
choices in `~/.harness/registry.json`; a repository is registered in exactly
one mode.

## Headless center first administrator

On the center host, start the daemon and install the managed identity service:

```bash
ha bootstrap
ha bootstrap --operation listener
ha bootstrap --operation listener-set --listen-address <address> --hostname <hostname> --port 8443 --certificate-file <certificate.pem> --certificate-key-file <key.pem> --expected-version <version>
ha bootstrap --operation bootstrap-status
ha bootstrap --operation bootstrap-admin --username <username> --email <email> --display-name <name> --person-id <person-id> --password-file <protected-password-file>
ha bootstrap --operation login
ha bootstrap --operation session
ha bootstrap --operation node-register --operation-id <unique-id> --node-id <node-id> --person-id <person-id> --credential-file <new-credential-file>
```

Prepare the password in a file readable only by its owner (for example, mode
`0600`); pass its path, never the password, on the command line. The CLI reads
one trailing newline as a file terminator and sends the password only through
the center's original local socket. Remove the password file after use.

Before any `access-admin` member exists, that socket's owner may set the
existing HTTPS listener. Read its version first and use a certificate trusted
by the browser device. Listener changes and first-administrator creation share
one queue: only one first administrator succeeds, and subsequent listener
changes require a signed-in `access-admin`, even after logout. Fleet and remote
GUI connections cannot perform first-administrator bootstrap or open this window.

`login` displays a verification URL, a one-time code and its expiry, then waits
for browser approval. Open that URL on another device and sign in as the first
administrator. Center and edge use the same Device login/session/logout entry.
Node registration writes its machine credential once to a new protected file.

## Connection modes

| Registry mode                   | Use it for                                | Local machine                                        | Data and write authority                      |
| ------------------------------- | ----------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| `local`                         | Normal local development                  | daemon, runtime, GUI, and a workspace                | local ledger and its single-writer queue      |
| `remote-proxy`                  | View-only display of a server repository  | GUI and a forwarding daemon; no workspace            | the remote daemon and its single-writer queue |
| `remote-center` / `remote-edge` | Existing Fleet center and edge deployment | center or edge components and a mirror as applicable | the Fleet center lease queue                  |

For development on a server repository, SSH to the server. A `remote-proxy`
machine has no local workspace and is not a remote CLI development environment.

## First use: Windows view-only display of a server

Use this flow when Windows should show a repository that remains on a server.
The server daemon socket path is shown by `ha daemon status` in its `target:
endpoint=` line.

1. On the server, install the daemon as a user service (see
   [Resident service](#resident-service-macos-and-linux)):

   ```bash
   ha daemon service install
   ```

2. On Windows, forward a local TCP port to that server socket. Replace the
   socket path and host with your own values:

   ```bash
   ssh -L 9911:/path/to/server-daemon.sock <host> -N
   ```

   UU, FRP, or a VPN can be used instead when they forward the remote daemon
   endpoint to a local port.

3. On Windows, add and probe the local endpoint, then register the selected
   server repository as view-only. The connection identifier returned by the
   add command is used in the repository registration:

   ```bash
   ha daemon connection add --endpoint tcp://127.0.0.1:9911
   ha daemon connection probe --endpoint tcp://127.0.0.1:9911
   ha daemon repo register --repo-id <id> --mode remote-proxy --connection <connection>
   ha gui
   ```

   You can instead register directly with the endpoint:

   ```bash
   ha daemon repo register --repo-id <id> --mode remote-proxy --endpoint tcp://127.0.0.1:9911
   ```

   The GUI path is **Settings → Repos & connections → Add connection → Probe →
   Register selected as view-only**.

In view-only mode, opening an artifact opens a server copy. Links to local
files outside the project are unavailable, and there is no local bootstrap
entry point.

## Local mode

Register a workspace and start the resident daemon:

```bash
ha daemon repo register --repo-id <id> --root /path/to/workspace --mode local
ha daemon start --service
ha gui
```

## Resident service (macOS and Linux)

A machine that should keep its daemon running across crashes and reboots hands
the daemon to the operating system's service manager:

```bash
ha daemon service install     # write and load the user-level unit, start the daemon
ha daemon service status      # is the unit loaded, and is the running daemon the one it supervises
ha daemon service uninstall   # stop the supervised daemon and remove the unit
```

`install` generates a launchd agent under `~/Library/LaunchAgents` on macOS and
a systemd user unit under `~/.config/systemd/user` on Linux. It needs no
`sudo`. There is one unit per user root and daemon id, so installing twice is
a no-op and two user roots on one machine get two units. Windows is not
supported; use `ha daemon start --service` there.

While the unit is installed:

- A daemon that crashes or is killed is started again by the service manager.
  Running agent sessions are not stopped with it; the new daemon adopts them.
- A daemon that leaves for a newer build on disk is restarted by the service
  manager, so only one daemon exists at any time.
- `ha daemon stop` stays stopped, including across the service manager's own
  restarts and a reboot, until `ha daemon start --service`. Both commands keep
  the daemon under the service manager.
- `ha daemon service status` exits `0` only when the running daemon is the
  process the unit started. Use it, not the exit code of `ha daemon status`,
  as the health signal for a resident node.

The unit records the `PATH` of the shell that ran `install`; the daemon finds
`git` and the agent CLIs through it. Run `install` again after that `PATH`,
the Node.js location, or the Harness Anything checkout changes.

Starting at boot before anyone logs in needs one privileged step that Harness
Anything does not perform: `loginctl enable-linger <user>` on Linux, and
automatic login for the user on macOS.

## Recovering from task and runtime rejections

Receipts include a validation diagnostic with the rejected field, its current
value, and a retry command. Use these state rules when recovering:

| Code                                    | Condition                                                        | Recovery                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_submission`                    | The closeout document cannot produce a valid submission          | Fix the named `closeout.md` section, then retry `ha task submit <task-id>`.                                                                                          |
| `invalid_runtime_mission`               | `--mission` was given a path or invalid id                       | Use a bare lowercase id. The daemon reads `harness/<task-package>/artifacts/missions/<name>.md`; retry `ha agent run <agent> --task <task-id> --mission <name>`. |
| `invalid_proof` from `declare-executor` | The execution is not `submitted/review` with `executor=none`     | An assigned submitted execution proceeds with `ha task review-execution`; only an unassigned one uses `ha task declare-executor`.                                    |
| `executor_binding_invalid`              | The claimed executor differs from the task binding or held lease | Run the receipt's retry command from the expected executor named in its diagnostic.                                                                                  |
| `invalid_transition` from `task start`  | The current round already has an active execution                | Run `ha task start <task-id>` without `--execution-id` to reuse it.                                                                                                  |
| `lease_required`                        | Submitter does not hold the execution lease                      | Run `ha task start <task-id>`, then retry submit as the holder.                                                                                                      |
| `lease_not_found`                       | Runtime settlement already released the lease                    | Run `ha task start <task-id>` without a new execution id, then retry submit.                                                                                         |

## Registry v2 hard cut

Versions that include PR #2155 require registry v2. A machine with a v1
`~/.harness/registry.json` is rejected and must register its repositories
again. Register a local workspace with:

```bash
ha daemon repo register --repo-id <id> --root /path/to/workspace --mode local
```

For a view-only repository, use the `remote-proxy` registration shown above.
There is no compatibility path for a v1 registry.

## Fleet center and edges

`remote-center` and `remote-edge` are for the existing Fleet topology, not for
view-only display. See [Fleet center deployment](../tools/fleet-center/README.md)
for its deployment and operating instructions.

An edge mirror holds the documents the center's ledger has accepted, nothing
else. `ha init` publishes the scaffold documents it writes under
`harness/governance/` and `harness/context/` as ledger documents, so a new
center's edges receive them. A center initialized by an earlier version has
those files on disk only. Publish them once, at the center:

```sh
ha doc sync --submit --path governance/standards/README.md --path context/README.md
```

Repeat `--path` for every file. `--path` takes files, not directories: a
directory is reported as `inapplicable` and nothing is published. The same
step applies to any standard or context document written by hand at the center.
An edge sees a published document on its next sync.

## Local socket boundary

The local daemon socket is the access boundary. Its directory is created with
mode `0700` and the socket file with mode `0600`; do not widen either
permission. The endpoint tunnel in the view-only flow remains user-managed and
should not expose a daemon socket as a public listener.
