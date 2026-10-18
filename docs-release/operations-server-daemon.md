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

## External Keycloak center credentials

On the center host, use an existing fleet realm with the `harness-center`
confidential service-account client and the Harness realm-management and
Authorization Services configuration. Browser login uses `harness-gui`.
Configure it before the first-administrator commands above:

```bash
ha bootstrap --mode external --url https://identity.example.com --realm fleet --client-id harness-center --client-secret-stdin < /path/to/protected-client-secret
```

The secret is accepted only through redirected stdin and the original local
socket. It is stored in the center user root with owner-only file permissions,
never returned in health/status or receipts. A failed realm or credential check
leaves the existing configuration unchanged. Other client IDs are refused.
After the first administrator exists, replacing this configuration requires an
`access-admin` session against the current authority.

In the local GUI, open **Identity & access → Connect external Keycloak**, enter
the URL, realm and center client secret, then apply. The password field clears
on submission, including failure. The first-administrator form also appears for
an external realm when bootstrap is required. Edge and remote-proxy connections
cannot configure the center credentials.

## Connection modes

Read retained request-log statistics from a registered workspace:

```bash
ha daemon metrics --window 1h
ha daemon metrics --window 7d --json
```

The default window is 24h; 15m, 1h, 24h and 7d are supported. The command reads
existing rotated logs through `observe.tail`, with no new storage or sampling.
Request logging excludes only `observe.tail` reads with `kind: repo-log` and
`direction: history`, including failed reads, so diagnostics do not grow their
own denominator or retained request history. Business requests, other observe
kinds and repo-log follow reads keep their existing logging behavior; connection
logs still record diagnostic traffic. Previously recorded diagnostics remain in
retained history and statistics; they are neither rewritten nor filtered out.
It reports completed request counts, observed first/last timestamps and silent
intervals over one hour. Retained-history exhaustion does not establish continuous
coverage: inactivity and retention loss cannot be distinguished. A 7d request
never extrapolates a shorter retained span into a weekly traffic estimate.

P50/P95 use nearest-rank over all eligible samples. Each timing field reports its
own sample and missing counts; fewer than 20 samples is labeled low sample, and
missing values remain unknown. Parked runtime awaits are counted separately and
excluded from latency. These are daemon duration, service and dispatch timings;
CLI end-to-end latency and handler-internal queue waiting are not independently
measured. Request logs include multiple clients, so counts are not CLI-only.
Unavailable sources or cursor gaps fail the command instead of returning partial
statistics. `--root` and `--repo` select the registered repository.

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

## Task branch publishing and direct-push protection

A task whose output is a repository change runs in a Harness-managed worktree
on the branch named after the task. The dispatched worker commits there and
publishes through daemon-mediated commands, never with a personal GitHub
login:

```bash
ha task push <task-id>        # publish the task branch through the daemon-held credential
ha task pr <task-id>          # create the pull request (--update edits the existing one)
```

Workers read checks with their hosting-platform CLI and their own platform
credentials. For GitHub, use `gh pr checks <PR-number> --watch` and
`gh run view <run-id> --log-failed`.

Every bound worker gets `ha` from the CLI bin directory belonging to the
running daemon's installation, with its dispatched repository root and daemon
route in the worker environment. This is shared by center and edge daemons;
the edge-only wrapper that pins a canonical root is not used. The worker's Git
author and committer identity is derived from the dispatching person and stored
in that checkout's worktree config. Settlement and edge delivery check commits against the
same person identity recorded by the execution lease.

`ha task push` pushes only the branch whose name equals the task id, with
`--force-with-lease`, so a newer remote tip is never silently replaced. It
refuses the push when the checkout is on another branch or when a commit above
the default branch carries a different author or committer than the dispatch
person's identity; refusals surface as `delivery_publish_failed` with the
reason. A settled task-bound run publishes its branch through the same path;
`ha task push` is how the worker publishes before submit. Merge stays with the
maintainer — see [PR, review, and merge](contributing/en/04-pr-review-and-merge.md).

The credential these commands use is bound by the operator, not by the worker:
[Hosted Git credentials](hosted-credentials.md).

Direct-push protection is enforced in the worker's own environment, not only
at the daemon. A task-bound worker receives its git credential through an
askpass helper that answers `github.com` prompts only, and a git wrapper ahead
of the real git on `PATH` refuses any `git push` that would update anything
other than the `task_*` branch (including `--all`, `--mirror`, and `--delete`).
The same wrapper refuses worker commits and new branch checkouts in the
canonical repository root. A worker that pushes by hand therefore cannot
publish anything other than its own task branch.

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

If HTTPS endpoints use a private CA, explicitly provide its PEM file when installing:

```bash
NODE_EXTRA_CA_CERTS=/path/to/ca.pem ha daemon service install
```

The unit preserves this path alongside `PATH`; it does not copy other shell
environment variables. Relative CA paths are resolved against the installer's
current directory. Keep the file readable by the service user. Certificate
verification remains enabled, and Node loads the extra certificates at process
startup. Re-run `install` with the new path to change it, or without the variable
to remove it; a changed unit is reloaded. After changing the file contents at
the same path, run `ha daemon stop` then `ha daemon start --service` to reload
the certificates. This configures Node HTTPS trust, including OIDC; Fleet's
separate `caPath` setting does not configure OIDC trust.

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
| `runtime_credential_unavailable` from `ha task pr` | The dispatch's runtime instance has no configured hosting credential, or the native vault cannot resolve it | The operator binds the credential ([Hosted Git credentials](hosted-credentials.md)). |
| `runtime_credential_unavailable` from provider key commands | The native credential vault is unavailable (for example a locked Linux keyring) | Follow the headless keyring setup in [Provider API keys](provider-credentials.md#linux-without-a-desktop). |
| `delivery_publish_failed` from `ha task push` | The task branch push was refused or rejected (another branch checked out, missing or foreign git identity, lost compare-and-swap cut, network) | Read the reason in the receipt, fix the named cause locally, then retry `ha task push <task-id>`. |
| `unsupported_command` naming `task push` / `task pr` | The CLI or daemon on that machine predates these commands | Upgrade the CLI and daemon, then retry. |

## Registry v2 hard cut

Versions that include PR #2155 require registry v2. A machine with a v1
`~/.harness/registry.json` is rejected and must register its repositories
again. Register a local workspace with:

```bash
ha daemon repo register --repo-id <id> --root /path/to/workspace --mode local
```

For a view-only repository, use the `remote-proxy` registration shown above.
There is no compatibility path for a v1 registry.

## Fleet center LAN reachability and edge self-service

There are two separate HTTPS entrances. `listener-set` configures the managed Keycloak login service; it is the browser/token issuer. The Fleet TLS listener is the edge synchronization service and is configured with `daemon fleet center start`. Do not use one command's address as the other's configuration.

For the login service, the bind address must be an IP assigned to the center host and `--hostname` must be present in the certificate SAN. Keep the private key owner-readable (mode `0600`):

```bash
ha bootstrap --operation listener
ha bootstrap --operation listener-set --listen-address 192.168.1.20 --hostname center.example.test --port 8443 --certificate-file /etc/harness/center.pem --certificate-key-file /etc/harness/center-key.pem --expected-version <version>
```

For edge synchronization, bind the Fleet listener to the LAN address and include that address in the certificate SAN. The daemon validates the certificate SAN before opening the listener; bind failures such as an occupied, unavailable, or permission-denied address are returned with their error code:

```bash
ha daemon fleet center start --bind 192.168.1.20 --port 9443 --key /etc/harness/center-key.pem --cert /etc/harness/center.pem --repo <repo-id> --quota-bytes 1073741824
```

Read the listener again after a change and use the returned version for the next change. Re-signing with the same key keeps existing invitation pins valid. Replacing the key changes the SPKI pin: create a new invitation after the replacement; an old link is rejected with `pin_mismatch`. A listener replacement interrupts current edge connections, which resume only after the edge trusts the new certificate and runs `ha daemon fleet edge sync` again.

The supported edge path is an invitation link. A signed-in center administrator creates one, and the edge owner consumes it once; the link carries the center URL and certificate pin, never a machine credential:

```bash
ha bootstrap --operation edge-join-create --center-url https://center.example.test:9443 --node-id <node-id> --spki-sha256 <sha256-pin>
ha bootstrap --operation edge-join-consume --link '<harness-edge://join/...>' --observed-spki-sha256 <sha256-pin>
ha daemon fleet edge sync --host center.example.test --port 9443 --ca /path/to/center-ca.pem --node-id <node-id> --view-root /var/lib/harness/edge-view --quota-bytes 1073741824
```

The edge command must use the certificate authority (and `--servername` when the certificate name differs from the DNS name). TLS hostname verification rejects a certificate that does not cover the requested server name. A closed port fails the connection; an expired link, wrong signed-in person, or changed pin is rejected by join admission. Credentials are written by the local daemon and are not placed in the invitation URL.

### Install, upgrade, and development rescue

Install the CLI and daemon from the same candidate checkout as described in [Install](start/en/01-install.md). Upgrade the managed center authority with the existing command, then restart the daemon-managed services and re-read the listener version before changing it:

```bash
ha bootstrap --operation upgrade --backup-dir /var/backups/harness-rbac
ha bootstrap --operation listener
```

For development diagnosis only, an operator may forward the listener or local daemon endpoint through an SSH tunnel. The tunnel is a temporary rescue path; production edge access still uses the configured listener, certificate SAN, invitation pin, and edge sync flow.

## Fleet center and edges

`remote-center` and `remote-edge` are for the existing Fleet topology, not for
view-only display. Deployment procedures are environment-specific and are not
part of the public product documentation; use the private operator runbook for
environment-specific deployment and rehearsal steps.

A successful `ha daemon fleet center start` saves listener intent per user root
and daemon id. The daemon restores it on startup; `ha daemon stop` retains it.
Run the same authorized center-start command with the new options to replace
an active listener, on the same or a different port. This interrupts edge
connections. Authorization and input validation precede closing the old listener.
If startup or saving fails after closing it, the command reports no listener;
the last successful intent remains for restart, with no automatic rollback.

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
