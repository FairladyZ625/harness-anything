import {
  defineEdgeReplicaQueryOnlyReadCommand,
  defineRepoReadCommand,
  defineCenterForwardWriteCommand,
  cliInput,
  defineCliCommand,
  defineLedgerWriteCommand,
  defineLocalArbiterCommand,
  generatedTaskActionProtocolDeclarations,
  generatedTaskCreateResultFields,
  generatedWriteReceiptFields,
  workspacePathFormat,
  type GeneratedTaskActionProtocolDeclaration,
} from "@harness-anything/preset/internal/preset-command-contract";
export { generatedTaskActionProtocolDeclarations, generatedTaskCreateResultFields, generatedWriteReceiptFields };
export type { GeneratedTaskActionProtocolDeclaration };

function taskActionPacketFields(id: "review") {
  const fields = generatedTaskActionProtocolDeclarations
    .find((action) => action.id === id)
    ?.input.fields.find((field) => field.field === "fromFile")?.cli?.jsonFields;
  if (!fields) throw new Error(`Task Action ${id} has no declared packet fields.`);
  return Object.freeze([...fields]);
}

export const reviewJsonFields = taskActionPacketFields("review");
export const reviewJsonAllowedFields = Object.freeze(
  generatedTaskActionProtocolDeclarations
    .find((action) => action.id === "review")
    ?.input.fields.find((field) => field.field === "fromFile")?.cli?.jsonAllowedFields ?? reviewJsonFields,
);

function taskActionCliInputs(action: GeneratedTaskActionProtocolDeclaration) {
  return Object.freeze(
    action.input.fields.flatMap((field) =>
      field.cli
        ? [
            Object.freeze({
              ...field.cli,
              field: field.field,
              required: field.required,
              error: Object.freeze({
                code: field.cli.error,
              }),
              ...(field.enum ? { enum: field.enum } : {}),
              ...(field.regex ? { regex: field.regex } : {}),
              // The kernel contract carries the packet shape; the workspace-root path rule belongs
              // to the daemon read layer, so it is added here where the CLI facet is assembled.
              // A boolean carries no value, so it has no coordinate to declare.
              ...(field.cli.kind === "boolean"
                ? {}
                : field.field === "fromFile"
                  ? {
                      pathKind: "workspace-file" as const,
                      zeroHit: "not-a-selection" as const,
                      format: workspacePathFormat,
                    }
                  : { pathKind: "non-path" as const }),
            }),
          ]
        : [],
    ),
  );
}

// Help layering is CLI presentation, so the CLI declaration decides it. The review/recovery
// actions are the advanced layer; create/start/submit/complete are the loop itself.
const advancedTaskLifecycleIngresses = new Set([
  "task-transition",
  "task-review-execution",
  "task-respond-review",
  "task-rework",
  "task-review-consent",
]);

function taskActionProtocolCommand(action: GeneratedTaskActionProtocolDeclaration) {
  const execution = action.execution;
  if (!execution?.topology) throw new Error(`Task Action ${action.id} has no command topology.`);
  const syntaxPath =
    action.id === "transition"
      ? ["task", "transition", "<task-id>", "<planned|active|blocked|in_review|done|cancelled>"]
      : action.id === "escalation-resolve"
        ? ["task", "escalation", "resolve", "<task-id>"]
        : ["task", execution.ingress.slice("task-".length), "<task-id>"];
  const declaration = {
    id: execution.ingress,
    helpTier: advancedTaskLifecycleIngresses.has(execution.ingress) ? "advanced" : "common",
    phase: "W3",
    path: syntaxPath,
    summary: action.explain,
    method: "repo.task.run",
    inputs: taskActionCliInputs(action),
    actionDefaults: {
      ...(action.input.fields.some(({ field }) => field === "verb")
        ? { verb: execution.ingress.slice("task-".length) }
        : {}),
      commandType: execution.lifecycle?.commandType,
    },
    actionConstraints: action.input.exactlyOneOf,
  } as const;
  if (execution.remoteEdgeAdmission === "via-center-forward")
    return execution.topology === "local-arbiter"
      ? defineCliCommand({
          ...declaration,
          commandClass: "arbiter" as const,
          admission: {
            local: "direct" as const,
            "remote-proxy": "rejected" as const,
            "remote-center": "direct" as const,
            "remote-edge": "via-center-forward" as const,
          },
        })
      : defineCenterForwardWriteCommand(declaration);
  if (execution.topology === "local-arbiter") return defineLocalArbiterCommand(declaration);
  return defineLedgerWriteCommand(declaration);
}

export const derivedTaskActionProtocolCommands = Object.freeze(
  generatedTaskActionProtocolDeclarations.map(taskActionProtocolCommand),
);

export const taskActionHelpRows = Object.freeze(
  generatedTaskActionProtocolDeclarations.map((action) => {
    const { usage, summary, help } = taskActionProtocolCommand(action);
    return Object.freeze({ usage, summary, help });
  }),
);

export const taskExecutionProtocolCommands = Object.freeze([
  ...derivedTaskActionProtocolCommands,
  defineCenterForwardWriteCommand({
    id: "task-escalate",
    helpTier: "advanced",
    actionKind: "task-escalate",
    payloadFields: [
      { field: "taskId", type: "string", required: true, regex: "^[A-Za-z0-9_-]{1,96}$" },
      { field: "question", type: "string", required: true, wire: { maxLength: 8 * 1024 } },
      { field: "options", type: "string-array", required: false },
      { field: "recommendation", type: "string", required: false, wire: { maxLength: 4 * 1024 } },
      { field: "reason", type: "string", required: false, wire: { maxLength: 8 * 1024 } },
    ],
    phase: "W3",
    path: ["task", "escalate", "<task-id>"],
    summary:
      'Worker-only upward channel for a real blocker. Use for forbidden boundaries, owner rulings, false preconditions, or another task blocking progress; do not use for choices you can decide yourself. Example: ha task escalate <task-id> --question "May I change the fleet protocol?" --option "Keep scope" --option "Extend protocol" --recommend "Keep scope" --reason "Required writer is outside this task."',
    method: "repo.task.run",
    inputs: [
      cliInput("--question", "single", true, { code: "missing_field" }, { pathKind: "non-path" }),
      cliInput("--option", "repeated", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--recommend", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--reason", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-escalation-resolve",
    helpTier: "advanced",
    actionKind: "task-escalation-resolve",
    payloadFields: [
      { field: "taskId", type: "string", required: true, regex: "^[A-Za-z0-9_-]{1,96}$" },
      { field: "dispatchId", type: "string", required: true, regex: "^dispatch_[a-f0-9]{24}$" },
      { field: "answer", type: "string", required: true, wire: { maxLength: 8 * 1024 } },
    ],
    phase: "W3",
    path: ["task", "escalation", "resolve", "<task-id>"],
    summary:
      "Owner/CEO answer to a worker escalation. Records the answer, unblocks the task, and injects it into the next dispatch.",
    method: "repo.task.run",
    inputs: [
      cliInput("--dispatch-id", "single", true, { code: "missing_field" }, { pathKind: "non-path" }),
      cliInput("--answer", "single", true, { code: "missing_field" }, { pathKind: "non-path" }),
    ],
  }),
  defineCliCommand({
    id: "task-push",
    actionKind: "task-push",
    phase: "W3",
    path: ["task", "push", "<task-id>"],
    summary:
      "Publish the task branch and create or update its submitted pull request through daemon-held hosting credentials.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--body-file",
        "single",
        false,
        { code: "invalid_field" },
        {
          field: "bodyFile",
          codec: { kind: "text-file", target: "body", maxBytes: 32 * 1024 },
          pathKind: "workspace-file",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
        },
      ),
    ],
    payloadFields: [{ field: "body", type: "string", required: false }],
    commandClass: "repo-write" as const,
    admission: {
      local: "direct" as const,
      "remote-proxy": "rejected" as const,
      "remote-center": "direct" as const,
      "remote-edge": "direct" as const,
    },
  }),
  defineCenterForwardWriteCommand({
    id: "task-progress-append",
    payloadFields: [
      { field: "taskId", type: "string", required: false, regex: "^[A-Za-z0-9_-]{1,96}$" },
      { field: "executionId", type: "string", required: false, regex: "^[A-Za-z0-9_-]{1,96}$" },
      { field: "text", type: "string", required: false, wire: { maxLength: 32 * 1024 } },
      {
        field: "evidence",
        type: "json-object-array",
        required: false,
        fields: [
          { field: "type", type: "string", required: true },
          {
            field: "path",
            type: "string",
            required: true,
            wire: { normalization: "NFC" },
            regex: "^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$",
          },
          { field: "summary", type: "string", required: true },
        ],
      },
      {
        field: "baseDocumentSha256",
        type: "string",
        required: false,
        regex: "^[0-9a-f]{64}$",
        wire: { nullable: true },
      },
    ],
    phase: "W3",
    path: ["task", "progress", "append", "<task-id>"],
    summary: "Append typed progress through the active task lease, or backfill after release with --as-owner.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--text",
        "single",
        true,
        {
          code: "missing_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--evidence",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", format: "<type>:<path>:<summary>", regex: "^[a-z][a-z0-9_-]{0,31}:[^:]+:.+$" },
      ),
      cliInput("--as-owner", "boolean", false, { code: "invalid_field" }, { field: "asOwner" }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-dispatch-review",
    helpTier: "advanced",
    payloadFields: [
      { field: "taskId", type: "string", required: false, wire: { omit: true } },
      {
        field: "taskIds",
        type: "string-array",
        required: true,
        items: { field: "taskId", type: "string", required: true, regex: "^[A-Za-z0-9_-]{1,96}$" },
      },
      { field: "agentId", type: "string", required: false, regex: "^[A-Za-z0-9_-]{1,96}$" },
      { field: "runtimeInstanceId", type: "string", required: false, regex: "^[A-Za-z0-9_-]{1,96}$" },
      { field: "executionId", type: "string", required: false, regex: "^[A-Za-z0-9_-]{1,96}$" },
    ],
    phase: "W3",
    path: ["task", "dispatch-review", "<task-id>"],
    summary:
      "Dispatch one independent reviewer per selected task; each review binds to the task's submitted cut, never to an implementation execution.",
    method: "repo.task.run",
    inputs: [
      cliInput("--task", "repeated", false, { code: "invalid_field" }, { pathKind: "non-path", field: "taskIds" }),
      cliInput("--agent", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "agentId" }),
      cliInput("--execution-id", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput(
        "--instance",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "runtimeInstanceId" },
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
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-artifact-add",
    payloadFields: [{ field: "squadRunId", type: "string", required: false, regex: "^squad_[a-f0-9]{24}$" }],
    phase: "W3",
    path: ["task", "artifact", "add", "<task-id>"],
    summary: "Publish a file or locally executed command transcript through canonical doc sync.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--source",
        "single",
        false,
        { code: "missing_field" },
        {
          conflictsWith: ["--run"],
          description: "Read artifact bytes from a local file",
          pathKind: "cli-local",
          pathReader: "cli-local",
        },
      ),
      cliInput(
        "--run",
        "boolean",
        false,
        { code: "invalid_field" },
        {
          conflictsWith: ["--source"],
          description: "Run argv after -- locally without a shell and publish its command transcript",
        },
      ),
      cliInput(
        "--destination",
        "single",
        false,
        { code: "missing_field" },
        {
          description:
            "Workspace-relative artifact path; required with --source, while --run defaults to a unique task-local artifacts/evidence path",
          pathKind: "workspace-file",
          pathReader: "workspace-text",
          zeroHit: "not-a-selection",
        },
      ),
    ],
    actionConstraints: [["source", "run"]],
  }),
  defineLedgerWriteCommand({
    id: "task-rematerialize",
    helpTier: "maintenance",
    phase: "W3",
    path: ["task", "rematerialize"],
    summary: "Re-render one Task's or every Task's managed lifecycle documents from the current canonical projection.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--all",
        "boolean",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--id"] },
      ),
      cliInput(
        "--id",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "taskId", conflictsWith: ["--all"] },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "task-show",
    repositoryRead: true,
    payloadFields: [{ field: "taskId", type: "string", required: true, regex: "^[A-Za-z0-9_-]{1,96}$" }],
    phase: "W3",
    path: ["task", "show", "<task-id>"],
    summary: "Read the task projection.",
    method: "repo.task.read",
    // <task-id> and --id are the same field in two spellings; the parser rejects both-at-once.
    inputs: [cliInput("--id", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "taskId" })],
  }),
  defineRepoReadCommand({
    id: "receipt-show",
    phase: "W3",
    path: ["receipt", "show", "<op-id>"],
    summary: "Read acceptance and independent progress; optionally wait for comma-separated receipt predicates.",
    method: "repo.task.read",
    inputs: [
      cliInput("--wait", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--timeout-ms", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
    ],
  }),
] as const);
