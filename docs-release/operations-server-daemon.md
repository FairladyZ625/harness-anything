# Server Daemon Operations

Harness Anything has three connection modes. They are machine-local registry
choices in `~/.harness/registry.json`; a repository is registered in exactly
one mode.

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

1. On the server, start the resident daemon:

   ```bash
   ha daemon start --service
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

## Recovering from task and runtime rejections

Receipts include a validation diagnostic with the rejected field, its current
value, and a retry command. Use these state rules when recovering:

| Code                                    | Condition                                                        | Recovery                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_submission`                    | A submission field has the wrong type or value                   | Fix the named JSON field, then retry `ha task submit <task-id> --execution-id <execution-id> --from-file <submission.json>`.                                         |
| `invalid_runtime_mission`               | `--mission` was given a path or invalid id                       | Use a bare lowercase id. The daemon reads `harness/<task-package>/artifacts/missions/<name>.md`; retry `ha runtime run <runtime> --task <task-id> --mission <name>`. |
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

## Local socket boundary

The local daemon socket is the access boundary. Its directory is created with
mode `0700` and the socket file with mode `0600`; do not widen either
permission. The endpoint tunnel in the view-only flow remains user-managed and
should not expose a daemon socket as a public listener.
