import { cliInput, defineCliCommand } from "../../../preset/src/preset-command-contract.ts";

export const runtimeFleetProtocolCommands = Object.freeze([
  defineCliCommand({
    id: "runtime-run",
    phase: "Runtime-B",
    path: ["runtime", "run", "<instance-id>"],
    summary: [
      "Dispatch work through an optional declared Agent, deriving the mission ",
      "from --task when no prompt is supplied; stream and wait by default, or ",
      "use --detach and retrieve the result with ha runtime status ",
      "<runtime-session-id> --wait.",
    ].join(""),
    method: "repo.agentRuntime.spawn",
    commandClass: "repo-write",
    inputs: [
      cliInput("--agent", "single", false, {
        code: "invalid_field",
        nextAction: "Use one installed Agent id whose runtime_type matches the instance.",
      }),
      cliInput("--to", "single", false, {
        code: "invalid_field",
        nextAction: "Use --to <worker-agent-id> only with --agent <leader-agent-id>.",
      }),
      cliInput("--model", "single", false, {
        code: "invalid_field",
        nextAction: "Use one model supported by the runtime instance.",
      }),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
          nextAction: "Use minimal, low, medium, high, or xhigh with a Codex instance.",
        },
        { enum: ["minimal", "low", "medium", "high", "xhigh"] },
      ),
      cliInput(
        "--permission-mode",
        "single",
        false,
        {
          code: "invalid_runtime_permission",
          nextAction:
            "Use bypass, workspace-write, or read-only to override the instance permission mode for this dispatch.",
        },
        { enum: ["bypass", "workspace-write", "read-only"] },
      ),
      cliInput("--prompt", "single", false, {
        code: "invalid_field",
        nextAction: "Use one of --prompt <text> or --prompt-file <path>, or omit both with --task.",
      }),
      cliInput("--prompt-file", "single", false, {
        code: "invalid_field",
        nextAction: "Use one of --prompt <text> or --prompt-file <path>, or omit both with --task.",
      }),
      cliInput("--cwd", "single", false, {
        code: "invalid_field",
        nextAction: "Use a repository-relative directory; omit --cwd for the repository root.",
      }),
      cliInput("--task", "single", false, {
        code: "invalid_field",
        nextAction: "Use one active task id for --task.",
      }),
      cliInput("--resume", "single", false, {
        code: "invalid_field",
        nextAction: "Use one provider session id returned by runtime status.",
      }),
      cliInput("--resume-dispatch", "single", false, {
        code: "invalid_field",
        nextAction: "Use one dispatch id returned by ha task dispatches.",
      }),
      cliInput("--idempotency-key", "single", false, {
        code: "invalid_field",
        nextAction: "Use one stable non-empty idempotency key, or omit it for automatic allocation.",
      }),
      cliInput("--detach", "boolean", false, {
        code: "invalid_field",
        nextAction: [
          "Use --detach once to return after the daemon accepts the dispatch, then ",
          "run ha runtime status <runtime-session-id> --wait.",
        ].join(""),
      }),
      cliInput("--on-exit", "single", false, {
        code: "invalid_field",
        nextAction: [
          "Use --on-exit <executable> only with --detach. The executable receives ",
          "runtime-session-exited/v1 JSON on stdin, runs without shell parsing in ",
          "the dispatch cwd, and inherits only PATH, HOME, TMPDIR, LANG, LC_ALL, ",
          "LC_CTYPE, and SHELL on POSIX or PATH/Path, PATHEXT, SystemRoot, COMSPEC, ",
          "TEMP, TMP, and USERPROFILE on Windows; provider launch credentials are ",
          "never inherited.",
        ].join(""),
      }),
      cliInput("--no-stream", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --no-stream once to hide live activity.",
      }),
    ],
  }),
  defineCliCommand({
    id: "runtime-batch",
    phase: "Runtime-B",
    path: ["runtime", "batch", "<batch-file>"],
    summary: [
      "Run a runtime-batch/v1 declaration through bounded concurrent runtime ",
      "dispatches and wait for every entry to settle.",
    ].join(""),
    method: "repo.agentRuntime.spawn",
    commandClass: "repo-write",
    inputs: [],
  }),
  defineCliCommand({
    id: "runtime-status",
    phase: "Runtime-B",
    path: ["runtime", "status", "[<runtime-session-id>]"],
    summary: "List runtime sessions, show one session, or use --wait to stream and wait for its final result.",
    method: "repo.agentRuntime.overview",
    commandClass: "repo-read",
    inputs: [
      cliInput("--task", "single", false, {
        code: "invalid_field",
        nextAction: "Use --task only when listing runtime sessions.",
      }),
      cliInput("--wait", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --wait once with a runtime session id.",
      }),
      cliInput("--no-stream", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --no-stream only with --wait to hide live activity.",
      }),
    ],
  }),
  defineCliCommand({
    id: "runtime-cancel",
    phase: "Runtime-B",
    path: ["runtime", "cancel", "<runtime-session-id>"],
    summary: "Idempotently cancel a runtime session.",
    method: "repo.agentRuntime.cancel",
    commandClass: "repo-write",
    inputs: [],
  }),
  defineCliCommand({
    id: "daemon-stop",
    phase: "W3",
    path: ["daemon", "stop"],
    summary: "Stop the resident daemon.",
    method: "protocol.hello",
    commandClass: "admin",
    inputs: [
      cliInput("--force", "boolean", false, {
        code: "invalid_field",
        nextAction: [
          "Use --force once, after a cooperative stop times out, to signal the ",
          "daemon's pid directly and clear its bookkeeping.",
        ].join(""),
      }),
    ],
  }),
  defineCliCommand({
    id: "daemon-fleet-center-start",
    phase: "Fleet-Wiring",
    path: ["daemon", "fleet", "center", "start"],
    summary: "Start the daemon-owned fleet TLS center serving the authoritative ledger to admitted edge nodes.",
    method: "daemon.fleet.center.start",
    commandClass: "admin",
    inputs: [
      cliInput(
        "--port",
        "single",
        true,
        {
          code: "missing_field",
          nextAction: [
            "Fleet center start requires --port (0 binds an ephemeral port), --key, ",
            "--cert, --roster, and --quota-bytes.",
          ].join(""),
        },
        { regex: "^(?:0|[1-9][0-9]{0,4})$" },
      ),
      cliInput("--key", "single", true, {
        code: "missing_field",
        nextAction: "Fleet center start requires the TLS private key path --key.",
      }),
      cliInput("--cert", "single", true, {
        code: "missing_field",
        nextAction: "Fleet center start requires the TLS certificate path --cert.",
      }),
      cliInput("--roster", "single", true, {
        code: "missing_field",
        nextAction:
          "Fleet center start requires --roster pointing at a fleet-roster/v1 JSON declaring nodes and assignments.",
      }),
      cliInput(
        "--quota-bytes",
        "single",
        true,
        {
          code: "missing_field",
          nextAction: "Fleet center start requires a positive persistent replica disk quota --quota-bytes.",
        },
        { regex: "^[1-9][0-9]{0,15}$" },
      ),
      cliInput("--bind", "single", false, {
        code: "invalid_field",
        nextAction: "Use one bind hostname or address for --bind; the default is 127.0.0.1.",
      }),
      cliInput("--state-root", "single", false, {
        code: "invalid_field",
        nextAction: "Use one directory path for --state-root; the default is <user-root>/fleet.",
      }),
    ],
  }),
  defineCliCommand({
    id: "daemon-fleet-edge-sync",
    phase: "Fleet-Wiring",
    path: ["daemon", "fleet", "edge", "sync"],
    summary: "Mirror the fleet center ledger into a local edge view over verified TLS.",
    method: "daemon.fleet.edge.sync",
    commandClass: "admin",
    inputs: [
      cliInput("--host", "single", true, {
        code: "missing_field",
        nextAction: [
          "Edge sync requires --host, --port, --ca, --node-id, one credential ",
          "source, --assignment, --view-root, and --quota-bytes.",
        ].join(""),
      }),
      cliInput(
        "--port",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Use a TCP port from 0 to 65535 for --port.",
        },
        { regex: "^(?:0|[1-9][0-9]{0,4})$" },
      ),
      cliInput("--ca", "single", true, {
        code: "missing_field",
        nextAction: "Edge sync requires the center CA certificate path --ca.",
      }),
      cliInput(
        "--node-id",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Use the node id declared in the center roster for --node-id.",
        },
        { regex: "^[A-Za-z0-9_-]{1,96}$" },
      ),
      cliInput("--credential", "single", false, {
        code: "invalid_field",
        nextAction: [
          "Use the machine credential issued for --node-id only for an explicit ",
          "authentication check; production sync should use --roster.",
        ].join(""),
      }),
      cliInput("--roster", "single", false, {
        code: "invalid_field",
        nextAction: "Use the mode-0600 fleet-roster/v1 file containing the credential for --node-id.",
      }),
      cliInput(
        "--assignment",
        "single",
        true,
        {
          code: "invalid_field",
          nextAction: "Use one assignment id declared in the center roster for --assignment.",
        },
        { regex: "^[A-Za-z0-9_-]{1,96}$" },
      ),
      cliInput("--view-root", "single", true, {
        code: "missing_field",
        nextAction: "Edge sync requires --view-root, the directory that will hold repos/<repo-id>/views/<view-id>.",
      }),
      cliInput(
        "--quota-bytes",
        "single",
        true,
        {
          code: "missing_field",
          nextAction: "Edge sync requires a positive local mirror disk quota --quota-bytes.",
        },
        { regex: "^[1-9][0-9]{0,15}$" },
      ),
      cliInput("--servername", "single", false, {
        code: "invalid_field",
        nextAction:
          "Use the TLS server name matching the center certificate for --servername; the default is localhost.",
      }),
      cliInput(
        "--timeout-ms",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use a positive response timeout in milliseconds for --timeout-ms; the default is 60000.",
        },
        { regex: "^[1-9][0-9]{0,9}$" },
      ),
    ],
  }),
] as const);
