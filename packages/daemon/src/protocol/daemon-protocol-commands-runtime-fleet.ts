import {
  cliInput,
  defineEdgeReplicaQueryOnlyReadCommand,
  defineCenterForwardWriteCommand,
  defineHostAdminCommand,
  defineRepoReadCommand,
  defineRuntimeLocalWriteCommand,
  workspacePathFormat,
} from "@harness-anything/preset/internal/preset-command-contract";

export const agentRunProtocolCommand = defineRuntimeLocalWriteCommand({
  id: "agent-run",
  phase: "Runtime-B",
  kindRewrite: {
    authorizedKind: "runtime-run",
    sourceDecision: "dec_2BF45FF7E52020380F5F35CE2D/CH6",
    ownerTask: "task_0db67484d039c6f44bb815ba7c",
    expires: "2026-12-07",
  },
  path: ["agent", "run", "<id>"],
  summary: [
    "Dispatch task-bound work or resume its dispatch with the same Agent identity and working directory. ",
    "Use --claim-next to start the first claimable task on this node. Without --cwd a task bound to a worktree runs in it; Harness manages the worktree, no command is needed.",
  ].join(""),
  method: "repo.agentRuntime.spawn",
  positional: "agentId",
  positionalInputs: [{ name: "<id>", pathKind: "non-path", pathReader: "none" }],
  inputs: [
    cliInput(
      "--claim-next",
      "boolean",
      false,
      { code: "invalid_field" },
      {
        conflictsWith: ["--task", "--resume-dispatch", "--dry-run", "--cwd"],
      },
    ),
    cliInput("--task", "single", false, { code: "missing_field" }, { pathKind: "non-path" }),
    cliInput("--resume-dispatch", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
    cliInput(
      "--recover-dispatch",
      "single",
      false,
      { code: "invalid_field" },
      {
        pathKind: "non-path",
        description:
          "replace this stopped implementation dispatch of the task in one atomic compare-and-dispatch; " +
          "required whenever the task's active execution already has an implementation dispatch",
        requires: ["--task", "--execution-id", "--expected-version", "--idempotency-key"],
        conflictsWith: ["--resume-dispatch", "--claim-next", "--dry-run"],
      },
    ),
    cliInput(
      "--execution-id",
      "single",
      false,
      { code: "invalid_field" },
      {
        pathKind: "non-path",
        description: "the task execution the recovered dispatch ran",
        requires: ["--recover-dispatch"],
      },
    ),
    cliInput(
      "--expected-version",
      "single",
      false,
      { code: "invalid_field" },
      {
        pathKind: "non-path",
        description: "the task revision the recovery was decided on",
        regex: "^[0-9]+$",
        requires: ["--recover-dispatch"],
      },
    ),
    cliInput(
      "--idempotency-key",
      "single",
      false,
      { code: "invalid_field" },
      {
        pathKind: "non-path",
        description: "caller key; replaying the same recovery returns the dispatch it already produced",
        requires: ["--recover-dispatch"],
      },
    ),
    cliInput("--enable-handoff", "boolean", false, { code: "invalid_field" }),
    cliInput("--instance", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
    cliInput("--cwd", "single", false, { code: "invalid_field" }, { pathKind: "host-path" }),
    cliInput("--to", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
    cliInput(
      "--prompt",
      "single",
      false,
      { code: "invalid_field" },
      { pathKind: "non-path", conflictsWith: ["--mission", "--prompt-file"] },
    ),
    cliInput(
      "--prompt-file",
      "single",
      false,
      { code: "invalid_field" },
      {
        codec: { kind: "text-file", target: "prompt", maxBytes: 32 * 1024 },
        pathKind: "workspace-file",
        zeroHit: "not-a-selection",
        format: workspacePathFormat,
        conflictsWith: ["--mission", "--prompt"],
      },
    ),
    cliInput(
      "--mission",
      "single",
      false,
      { code: "invalid_field" },
      { pathKind: "non-path", conflictsWith: ["--prompt", "--prompt-file"] },
    ),
    cliInput("--model", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
    cliInput(
      "--effort",
      "single",
      false,
      { code: "invalid_runtime_effort" },
      { pathKind: "non-path", enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
    ),
    cliInput("--fast", "boolean", false, { code: "invalid_runtime_fast" }),
    cliInput("--detach", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--no-stream"] }),
    cliInput("--on-exit", "single", false, { code: "invalid_field" }, { pathKind: "non-path", requires: ["--detach"] }),
    cliInput("--no-stream", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--detach"] }),
    cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { conflictsWith: ["--on-exit"] }),
  ],
});

export const runtimeFleetProtocolCommands = Object.freeze([
  ...(["export", "claim", "revoke"] as const).map((operation) =>
    defineCenterForwardWriteCommand({
      id: `runtime-handoff-${operation}`,
      phase: "Runtime-B",
      path: ["runtime", "handoff", operation, "<dispatch-id>"],
      summary: `${operation} an explicitly enabled, settled Codex session checkpoint.`,
      method: "repo.agentRuntime.handoff",
      payloadFields:
        operation === "export"
          ? [
              { field: "commit", type: "string", required: true, regex: "^[a-f0-9]{40}$" },
              { field: "candidate", type: "json-object", required: true },
            ]
          : operation === "claim"
            ? [{ field: "offset", type: "number", required: false }]
            : [],
      inputs:
        operation === "claim"
          ? [
              cliInput(
                "--instance",
                "single",
                true,
                { code: "missing_field" },
                { field: "runtimeInstanceId", pathKind: "non-path", wire: { omit: true } },
              ),
              cliInput(
                "--prompt",
                "single",
                true,
                { code: "missing_field" },
                { pathKind: "non-path", wire: { omit: true } },
              ),
              cliInput(
                "--idempotency-key",
                "single",
                false,
                { code: "invalid_field" },
                { pathKind: "non-path", field: "dispatchKey" },
              ),
            ]
          : [],
    }),
  ),
  defineRuntimeLocalWriteCommand({
    id: "runtime-run",
    phase: "Runtime-B",
    path: ["runtime", "run", "<instance-id>"],
    summary: "Dispatch an unbound runtime prompt; use ha agent run for task-bound work.",
    method: "repo.agentRuntime.spawn",
    inputs: [
      cliInput("--agent", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--to", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--squad", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput(
        "--model",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
        },
        { pathKind: "non-path", enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
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
        { pathKind: "non-path", enum: ["bypass", "workspace-write", "read-only"] },
      ),
      cliInput(
        "--prompt",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", conflictsWith: ["--mission"] },
      ),
      cliInput(
        "--mission",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--task"], conflictsWith: ["--prompt"] },
      ),
      cliInput(
        "--cwd",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "host-path" },
      ),
      cliInput("--task", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput(
        "--resume",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--resume-dispatch",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--idempotency-key",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
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
        { pathKind: "non-path", requires: ["--detach"] },
      ),
      cliInput("--no-stream", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineRuntimeLocalWriteCommand({
    id: "runtime-batch",
    phase: "Runtime-B",
    kindRewrite: {
      authorizedKind: "runtime-run",
      sourceDecision: "dec_2BF45FF7E52020380F5F35CE2D/CH6",
      ownerTask: "task_0db67484d039c6f44bb815ba7c",
      expires: "2026-12-07",
    },
    path: ["runtime", "batch", "<batch-file>"],
    summary: [
      "Run a runtime-batch/v1 declaration through bounded concurrent runtime ",
      "dispatches and wait for every entry to settle.",
    ].join(""),
    method: "repo.agentRuntime.batch",
    inputs: [],
    positionalInputs: [
      {
        name: "<batch-file>",
        pathKind: "workspace-file",
        codec: { kind: "text-file", target: "declaration", maxBytes: Number.MAX_SAFE_INTEGER },
        zeroHit: "refused",
      },
    ],
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
      cliInput(
        "--task",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput("--wait", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--no-stream", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput("--limit", "single", false, { code: "invalid_field" }, { pathKind: "non-path", projection: "number" }),
    ],
  }),
  defineRepoReadCommand({
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
    summary: "Cancel a runtime session or record an owner ruling for an unreachable dispatch.",
    method: "repo.agentRuntime.cancel",
    inputs: [cliInput("--ruling", "single", false, { code: "invalid_field" }, { pathKind: "non-path" })],
  }),
  defineRuntimeLocalWriteCommand({
    id: "runtime-steer",
    phase: "Runtime-B",
    path: ["runtime", "steer", "<runtime-session|dispatch>"],
    summary: "Interrupt at a safe point and continue the same provider session with additional instructions.",
    method: "repo.agentRuntime.steer",
    inputs: [
      cliInput(
        "--prompt",
        "single",
        false,
        { code: "missing_field" },
        { pathKind: "non-path", conflictsWith: ["--prompt-file"] },
      ),
      cliInput(
        "--prompt-file",
        "single",
        false,
        { code: "missing_field" },
        {
          codec: { kind: "text-file", target: "prompt", maxBytes: 32 * 1024 },
          pathKind: "workspace-file",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
          conflictsWith: ["--prompt"],
        },
      ),
      // Compare-and-steer (#4372): each stated expectation must still hold when the daemon appends.
      cliInput(
        "--expect-task",
        "single",
        false,
        { code: "invalid_field" },
        {
          pathKind: "non-path",
          description: "refuse unless the target is bound to this task",
          conflictsWith: ["--expect-taskless"],
        },
      ),
      cliInput(
        "--expect-execution",
        "single",
        false,
        { code: "invalid_field" },
        {
          pathKind: "non-path",
          description: "refuse unless the target runs this execution",
          conflictsWith: ["--expect-taskless"],
        },
      ),
      cliInput(
        "--expect-taskless",
        "boolean",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", description: "refuse unless the target is a taskless conversation" },
      ),
      cliInput(
        "--expect-dispatch",
        "single",
        false,
        { code: "invalid_field" },
        {
          pathKind: "non-path",
          description: "refuse unless this dispatch is still the current leaf; never re-targeted",
        },
      ),
      cliInput(
        "--expect-version",
        "single",
        false,
        { code: "invalid_field" },
        {
          pathKind: "non-path",
          description: "refuse unless the leaf still carries this many steer requests",
          format: "<integer>",
        },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "runtime-incident-dismiss",
    phase: "Runtime-B",
    path: ["runtime", "incident-dismiss", "<dispatch-id>"],
    summary: [
      "Close one escalated incident receipt with a reason: its visible disposition becomes the ",
      "owner's no_action and it leaves the agenda's awaiting-ruling queue. Terminal dispatches ",
      "leave the queue on their own; this is for the receipts that still need a human decision.",
    ].join(""),
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--reason",
        "single",
        true,
        { code: "missing_field" },
        { pathKind: "non-path", format: "why this incident needs no further action" },
      ),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-stop",
    hostAuthority: "local-transport",
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
    summary:
      "Start or explicitly replace the daemon-owned fleet TLS center; replacement interrupts edge connections. Without --key/--cert the login service listener certificate is reused.",
    method: "daemon.fleet.center.start",
    inputs: [
      cliInput(
        "--port",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", regex: "^(?:0|[1-9][0-9]{0,4})$" },
      ),
      cliInput(
        "--key",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--cert",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--repo",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--quota-bytes",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", regex: "^[1-9][0-9]{0,15}$" },
      ),
      cliInput(
        "--bind",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--external-url",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--state-root",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "host-path" },
      ),
    ],
  }),
  defineHostAdminCommand({
    id: "daemon-fleet-edge-sync",
    hostAuthority: "local-transport",
    phase: "Fleet-Wiring",
    path: ["daemon", "fleet", "edge", "sync"],
    summary: "Mirror the fleet center ledger into the registered workspace harness over verified TLS.",
    method: "daemon.fleet.edge.sync",
    inputs: [
      cliInput(
        "--host",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--port",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^(?:0|[1-9][0-9]{0,4})$" },
      ),
      cliInput(
        "--ca",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--node-id",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[A-Za-z0-9_-]{1,96}$" },
      ),
      cliInput(
        "--credential",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--view-root",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "host-path" },
      ),
      cliInput(
        "--quota-bytes",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", regex: "^[1-9][0-9]{0,15}$" },
      ),
      cliInput(
        "--servername",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--timeout-ms",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[1-9][0-9]{0,9}$" },
      ),
    ],
  }),
] as const);

const scheduleIdInput = () =>
  cliInput(
    "--idempotency-key",
    "single",
    false,
    {
      code: "invalid_field",
    },
    { pathKind: "non-path" },
  );

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
    "mission",
    "reasoningEffort",
    "fast",
    "keepDays",
    "keepMonthly",
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
      codec: { kind: "json-object", source: "file", maxBytes: 64 * 1024 },
      pathKind: "workspace-file",
      zeroHit: "not-a-selection",
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
      pathKind: "non-path",
      jsonFields: requiredFields,
      jsonAllowedFields: allowedFields,
      codec: { kind: "json-object", source: "value", maxBytes: 64 * 1024 },
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
    summary: "Create an interval or cron Schedule using one Agent's or Squad's declarations.",
    method: "repo.task.run",
    positional: "scheduleId",
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
    inputs: [
      cliInput(
        "--name",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--mode",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path", enum: ["detect", "remediate"] },
      ),
      cliInput(
        "--every",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--cron",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--timezone",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--agent",
        "single",
        false,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--squad",
        "single",
        false,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--mission",
        "single",
        false,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--mission-file",
        "single",
        false,
        {
          code: "missing_field",
        },
        {
          codec: { kind: "markdown-file", target: "mission", maxBytes: 32 * 1024 },
          pathKind: "workspace-file",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
        },
      ),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
        },
        { pathKind: "non-path", enum: scheduleReasoningEfforts },
      ),
      cliInput("--fast", "boolean", false, {
        code: "invalid_runtime_fast",
      }),
      cliInput("--disabled", "boolean", false, {
        code: "invalid_field",
      }),
      scheduleIdInput(),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "schedule-list",
    phase: "Schedule-S3",
    path: ["schedule", "list"],
    summary: "List canonical Schedules and their projected run state.",
    method: "repo.task.read",
    inputs: [],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "schedule-reckon",
    phase: "Schedule-S5",
    path: ["schedule", "reckon"],
    summary: "Read general ledger friction signals for a recent time window.",
    method: "repo.task.read",
    inputs: [
      cliInput(
        "--window-hours",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: "^(?:[1-9]|[1-9][0-9]|1[0-6][0-8])$" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "schedule-runs",
    phase: "Schedule-S5",
    path: ["schedule", "runs", "<schedule-id>"],
    summary: "List occurrence history, including active, settled, and missed runs.",
    method: "repo.task.read",
    positional: "scheduleId",
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
    inputs: [
      cliInput(
        "--limit",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: "^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$" },
      ),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "schedule-show",
    phase: "Schedule-S3",
    path: ["schedule", "show", "<schedule-id>"],
    summary: "Show one canonical Schedule definition and projected run state.",
    method: "repo.task.read",
    positional: "scheduleId",
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
    inputs: schedulePacketInputs(scheduleShowJsonFields, scheduleShowJsonAllowedFields),
  }),
  defineCenterForwardWriteCommand({
    id: "schedule-update",
    phase: "Schedule-S3",
    path: ["schedule", "update", "<schedule-id>"],
    summary: "Replace selected Schedule definition fields in one canonical declaration event.",
    method: "repo.task.run",
    positional: "scheduleId",
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
    inputs: [
      ...schedulePacketInputs(scheduleUpdateJsonFields, scheduleUpdateJsonAllowedFields),
      cliInput(
        "--mode",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", enum: ["detect", "remediate"] },
      ),
      cliInput(
        "--name",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--every",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--cron",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--timezone",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--agent",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--mission",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--mission-file",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          codec: { kind: "markdown-file", target: "mission", maxBytes: 32 * 1024 },
          pathKind: "workspace-file",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
        },
      ),
      cliInput(
        "--effort",
        "single",
        false,
        {
          code: "invalid_runtime_effort",
        },
        { pathKind: "non-path", enum: scheduleReasoningEfforts },
      ),
      cliInput("--fast", "boolean", false, {
        code: "invalid_runtime_fast",
      }),
      cliInput(
        "--keep-days",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "keepDays", regex: "^[1-9][0-9]{0,3}$" },
      ),
      cliInput(
        "--keep-monthly",
        "boolean",
        false,
        { code: "invalid_field" },
        { field: "keepMonthly", conflictsWith: ["--no-keep-monthly"] },
      ),
      cliInput(
        "--no-keep-monthly",
        "boolean",
        false,
        { code: "invalid_field" },
        { field: "keepMonthly", conflictsWith: ["--keep-monthly"] },
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
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
    inputs: [
      ...schedulePacketInputs(scheduleDeleteJsonFields, scheduleDeleteJsonAllowedFields),
      cliInput(
        "--reason",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
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
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
    inputs: [scheduleIdInput()],
  }),
  defineCenterForwardWriteCommand({
    id: "schedule-disable",
    phase: "Schedule-S3",
    path: ["schedule", "disable", "<schedule-id>"],
    summary: "Pause a Schedule without deleting its definition or run history.",
    method: "repo.task.run",
    positional: "scheduleId",
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
    inputs: [scheduleIdInput()],
  }),
  defineRuntimeLocalWriteCommand({
    id: "schedule-run-now",
    phase: "Schedule-S3",
    path: ["schedule", "run-now", "<schedule-id>"],
    summary: "Claim one manual occurrence and launch it only after the claim is canonical.",
    method: "repo.task.run",
    positional: "scheduleId",
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
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
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
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
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
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
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
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
    positionalInputs: [{ name: "<schedule-id>", pathKind: "non-path", pathReader: "none" }],
    inputs: [],
  }),
] as const);
