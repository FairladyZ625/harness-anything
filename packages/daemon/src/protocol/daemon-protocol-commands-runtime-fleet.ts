import {
  cliInput,
  defineCenterForwardReadCommand,
  defineCenterForwardWriteCommand,
  defineHostAdminCommand,
  defineRepoReadCommand,
  defineRuntimeLocalWriteCommand,
  workspacePathFormat,
} from "../../../preset/src/preset-command-contract.ts";

export const agentRunProtocolCommand = defineRuntimeLocalWriteCommand({
  id: "agent-run",
  phase: "Runtime-B",
  path: ["agent", "run", "<id>"],
  summary: "Dispatch task-bound work or resume its dispatch with the same Agent identity and working directory.",
  method: "repo.agentRuntime.spawn",
  positional: "agentId",
  inputs: [
    cliInput("--task", "single", false, { code: "missing_field" }),
    cliInput("--resume-dispatch", "single", false, { code: "invalid_field" }),
    cliInput("--instance", "single", false, { code: "invalid_field" }),
    cliInput("--cwd", "single", false, { code: "invalid_field" }),
    cliInput("--to", "single", false, { code: "invalid_field" }),
    cliInput("--prompt", "single", false, { code: "invalid_field" }, { conflictsWith: ["--mission", "--prompt-file"] }),
    cliInput("--prompt-file", "single", false, { code: "invalid_field" }, { conflictsWith: ["--mission", "--prompt"] }),
    cliInput("--mission", "single", false, { code: "invalid_field" }, { conflictsWith: ["--prompt", "--prompt-file"] }),
    cliInput("--model", "single", false, { code: "invalid_field" }),
    cliInput(
      "--effort",
      "single",
      false,
      { code: "invalid_runtime_effort" },
      {
        enum: ["minimal", "low", "medium", "high", "xhigh", "max"],
      },
    ),
    cliInput("--fast", "boolean", false, { code: "invalid_runtime_fast" }),
    cliInput("--detach", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--no-stream"] }),
    cliInput("--on-exit", "single", false, { code: "invalid_field" }, { requires: ["--detach"] }),
    cliInput("--no-stream", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--detach"] }),
    cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--on-exit"] }),
  ],
});

export const runtimeFleetProtocolCommands = Object.freeze([
  defineRuntimeLocalWriteCommand({
    id: "runtime-run",
    phase: "Runtime-B",
    path: ["runtime", "run", "<instance-id>"],
    summary: "Dispatch an unbound runtime prompt; use ha agent run for task-bound work.",
    method: "repo.agentRuntime.spawn",
    inputs: [
      cliInput("--agent", "single", false, { code: "invalid_field" }),
      cliInput("--to", "single", false, { code: "invalid_field" }),
      cliInput("--squad", "single", false, { code: "invalid_field" }),
      cliInput("--model", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
        },
        { enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
      ),
      cliInput("--fast", "boolean", false, {
        code: "invalid_runtime_fast",
      }),
      cliInput(
        "--permission-mode",
        "single",
        false,
        {
          code: "invalid_runtime_permission",
        },
        { enum: ["bypass", "workspace-write", "read-only"] },
      ),
      cliInput("--prompt", "single", false, { code: "invalid_field" }, { conflictsWith: ["--mission"] }),
      cliInput(
        "--mission",
        "single",
        false,
        { code: "invalid_field" },
        { requires: ["--task"], conflictsWith: ["--prompt"] },
      ),
      cliInput("--cwd", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--task", "single", false, { code: "invalid_field" }),
      cliInput("--resume", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--resume-dispatch", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--idempotency-key", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--detach", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--on-exit",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { requires: ["--detach"] },
      ),
      cliInput("--no-stream", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineRuntimeLocalWriteCommand({
    id: "runtime-batch",
    phase: "Runtime-B",
    path: ["runtime", "batch", "<batch-file>"],
    summary: [
      "Run a runtime-batch/v1 declaration through bounded concurrent runtime ",
      "dispatches and wait for every entry to settle.",
    ].join(""),
    method: "repo.agentRuntime.batch",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "runtime-status",
    phase: "Runtime-B",
    path: ["runtime", "status", "[<runtime-session-id>]"],
    summary: [
      "List runtime sessions, show one session, or use --wait to wait for terminal results. ",
      "--wait accepts several session ids (first to settle wins unless --all) and repeated --task.",
    ].join(""),
    method: "repo.agentRuntime.overview",
    inputs: [
      cliInput("--task", "repeated", false, {
        code: "invalid_field",
      }),
      cliInput("--wait", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--no-stream", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineRuntimeLocalWriteCommand({
    id: "runtime-sessions-await",
    actionKind: "runtime-sessions-await",
    internal: true,
    phase: "Runtime-B",
    path: ["runtime", "_await"],
    summary: "Daemon-side long wait over a set of runtime sessions or task dispatches.",
    method: "repo.agentRuntime.sessions.await",
    inputs: [],
  }),
  defineRuntimeLocalWriteCommand({
    id: "runtime-cancel",
    phase: "Runtime-B",
    path: ["runtime", "cancel", "<runtime-session-id>"],
    summary: "Idempotently cancel a runtime session.",
    method: "repo.agentRuntime.cancel",
    inputs: [],
  }),
  defineHostAdminCommand({
    id: "daemon-stop",
    phase: "W3",
    path: ["daemon", "stop"],
    summary: "Stop the resident daemon.",
    method: "daemon.stop",
    inputs: [
      cliInput("--force", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-fleet-center-start",
    phase: "Fleet-Wiring",
    path: ["daemon", "fleet", "center", "start"],
    summary: "Start the daemon-owned fleet TLS center serving the authoritative ledger to admitted edge nodes.",
    method: "daemon.fleet.center.start",
    inputs: [
      cliInput(
        "--port",
        "single",
        true,
        {
          code: "missing_field",
        },
        { regex: "^(?:0|[1-9][0-9]{0,4})$" },
      ),
      cliInput("--key", "single", true, {
        code: "missing_field",
      }),
      cliInput("--cert", "single", true, {
        code: "missing_field",
      }),
      cliInput("--roster", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--quota-bytes",
        "single",
        true,
        {
          code: "missing_field",
        },
        { regex: "^[1-9][0-9]{0,15}$" },
      ),
      cliInput("--bind", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--state-root", "single", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-fleet-edge-sync",
    phase: "Fleet-Wiring",
    path: ["daemon", "fleet", "edge", "sync"],
    summary: "Mirror the fleet center ledger into the registered workspace harness over verified TLS.",
    method: "daemon.fleet.edge.sync",
    inputs: [
      cliInput("--host", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--port",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: "^(?:0|[1-9][0-9]{0,4})$" },
      ),
      cliInput("--ca", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--node-id",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: "^[A-Za-z0-9_-]{1,96}$" },
      ),
      cliInput("--credential", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--roster", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--assignment",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { regex: "^[A-Za-z0-9_-]{1,96}$" },
      ),
      cliInput("--view-root", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--quota-bytes",
        "single",
        true,
        {
          code: "missing_field",
        },
        { regex: "^[1-9][0-9]{0,15}$" },
      ),
      cliInput("--servername", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--timeout-ms",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { regex: "^[1-9][0-9]{0,9}$" },
      ),
    ],
  }),
] as const);

const scheduleIdInput = () =>
  cliInput("--idempotency-key", "single", false, {
    code: "invalid_field",
  });

export const scheduleShowJsonFields = Object.freeze(["scheduleId"] as const),
  scheduleShowJsonAllowedFields = scheduleShowJsonFields,
  scheduleUpdateJsonFields = Object.freeze(["scheduleId"] as const),
  scheduleUpdateJsonAllowedFields = Object.freeze([
    ...scheduleUpdateJsonFields,
    "name",
    "mode",
    "everyMs",
    "cronExpression",
    "timezone",
    "agentId",
    "runtimeInstanceId",
    "mission",
    "model",
    "reasoningEffort",
    "fast",
    "writableRoots",
    "idempotencyKey",
  ] as const),
  scheduleDeleteJsonFields = Object.freeze(["scheduleId"] as const),
  scheduleDeleteJsonAllowedFields = Object.freeze([...scheduleDeleteJsonFields, "reason", "idempotencyKey"] as const),
  scheduleReasoningEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const schedulePacketInputs = (requiredFields: readonly string[], allowedFields: readonly string[]) => [
  cliInput(
    "--from-file",
    "single",
    false,
    { code: "invalid_field" },
    {
      jsonFields: requiredFields,
      jsonAllowedFields: allowedFields,
      format: workspacePathFormat,
      conflictsWith: ["--json-input"],
    },
  ),
  cliInput(
    "--json-input",
    "single",
    false,
    { code: "invalid_field" },
    {
      jsonFields: requiredFields,
      jsonAllowedFields: allowedFields,
      format: "<json|@->",
      conflictsWith: ["--from-file"],
    },
  ),
];

export const scheduleProtocolCommands = Object.freeze([
  defineCenterForwardWriteCommand({
    id: "schedule-create",
    phase: "Schedule-S3",
    path: ["schedule", "create", "<schedule-id>"],
    summary: "Create an interval or cron Schedule targeting one declared Agent and runtime instance.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [
      cliInput("--name", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--mode",
        "single",
        true,
        {
          code: "missing_field",
        },
        { enum: ["detect", "remediate"] },
      ),
      cliInput("--every", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--cron", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--timezone", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--agent", "single", true, {
        code: "missing_field",
      }),
      cliInput("--instance", "single", true, {
        code: "missing_field",
      }),
      cliInput("--mission", "single", false, {
        code: "missing_field",
      }),
      cliInput("--mission-file", "single", false, {
        code: "missing_field",
      }),
      cliInput("--model", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
        },
        { enum: scheduleReasoningEfforts },
      ),
      cliInput("--fast", "boolean", false, {
        code: "invalid_runtime_fast",
      }),
      cliInput("--writable-root", "repeated", false, { code: "invalid_field" }, { field: "writableRoots" }),
      cliInput("--disabled", "boolean", false, {
        code: "invalid_field",
      }),
      scheduleIdInput(),
    ],
  }),
  defineCenterForwardReadCommand({
    id: "schedule-list",
    phase: "Schedule-S3",
    path: ["schedule", "list"],
    summary: "List canonical Schedules and their projected run state.",
    method: "repo.task.read",
    inputs: [],
  }),
  defineCenterForwardReadCommand({
    id: "schedule-runs",
    phase: "Schedule-S5",
    path: ["schedule", "runs", "<schedule-id>"],
    summary: "List occurrence history, including active, settled, and missed runs.",
    method: "repo.task.read",
    positional: "scheduleId",
    inputs: [
      cliInput(
        "--limit",
        "single",
        false,
        { code: "invalid_field" },
        { regex: "^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$" },
      ),
    ],
  }),
  defineCenterForwardReadCommand({
    id: "schedule-show",
    phase: "Schedule-S3",
    path: ["schedule", "show", "<schedule-id>"],
    summary: "Show one canonical Schedule definition and projected run state.",
    method: "repo.task.read",
    positional: "scheduleId",
    inputs: schedulePacketInputs(scheduleShowJsonFields, scheduleShowJsonAllowedFields),
  }),
  defineCenterForwardWriteCommand({
    id: "schedule-update",
    phase: "Schedule-S3",
    path: ["schedule", "update", "<schedule-id>"],
    summary: "Replace selected Schedule definition fields in one canonical declaration event.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [
      ...schedulePacketInputs(scheduleUpdateJsonFields, scheduleUpdateJsonAllowedFields),
      cliInput(
        "--mode",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { enum: ["detect", "remediate"] },
      ),
      cliInput("--name", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--every", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--cron", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--timezone", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--agent", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--instance", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--mission", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--mission-file", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--model", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
        },
        { enum: scheduleReasoningEfforts },
      ),
      cliInput("--fast", "boolean", false, {
        code: "invalid_runtime_fast",
      }),
      cliInput(
        "--writable-root",
        "repeated",
        false,
        { code: "invalid_field" },
        { field: "writableRoots", conflictsWith: ["--clear-writable-roots"] },
      ),
      cliInput(
        "--clear-writable-roots",
        "boolean",
        false,
        { code: "invalid_field" },
        { conflictsWith: ["--writable-root"] },
      ),
      scheduleIdInput(),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "schedule-delete",
    phase: "Schedule-S3",
    path: ["schedule", "delete", "<schedule-id>"],
    summary: "Delete a Schedule definition while retaining its canonical event history.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [
      ...schedulePacketInputs(scheduleDeleteJsonFields, scheduleDeleteJsonAllowedFields),
      cliInput("--reason", "single", false, {
        code: "invalid_field",
      }),
      scheduleIdInput(),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "schedule-enable",
    phase: "Schedule-S3",
    path: ["schedule", "enable", "<schedule-id>"],
    summary: "Arm a paused Schedule without changing its cadence.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [scheduleIdInput()],
  }),
  defineCenterForwardWriteCommand({
    id: "schedule-disable",
    phase: "Schedule-S3",
    path: ["schedule", "disable", "<schedule-id>"],
    summary: "Pause a Schedule without deleting its definition or run history.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [scheduleIdInput()],
  }),
  defineRuntimeLocalWriteCommand({
    id: "schedule-run-now",
    phase: "Schedule-S3",
    path: ["schedule", "run-now", "<schedule-id>"],
    summary: "Claim one manual occurrence and launch it only after the claim is canonical.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [scheduleIdInput()],
  }),
  defineRuntimeLocalWriteCommand({
    id: "schedule-settle",
    actionKind: "schedule-settle",
    internal: true,
    phase: "Schedule-S3",
    path: ["schedule", "_settle", "<schedule-id>"],
    summary: "Settle a claimed Schedule occurrence from a trusted runtime outcome.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [],
  }),
  defineRuntimeLocalWriteCommand({
    id: "schedule-claim",
    actionKind: "schedule-claim",
    internal: true,
    phase: "Schedule-S3",
    path: ["schedule", "_claim", "<schedule-id>"],
    summary: "Claim a Schedule occurrence without launching it.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [],
  }),
  defineRuntimeLocalWriteCommand({
    id: "schedule-dispatch-link",
    actionKind: "schedule-dispatch-link",
    internal: true,
    phase: "Schedule-S3",
    path: ["schedule", "_link", "<schedule-id>"],
    summary: "Link a runtime dispatch to its fenced Schedule occurrence.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [],
  }),
  defineRuntimeLocalWriteCommand({
    id: "schedule-missed",
    actionKind: "schedule-missed",
    internal: true,
    phase: "Schedule-S3",
    path: ["schedule", "_missed", "<schedule-id>"],
    summary: "Record aggregated missed Schedule occurrences.",
    method: "repo.task.run",
    positional: "scheduleId",
    inputs: [],
  }),
] as const);
