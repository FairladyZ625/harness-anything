import {
  defineCenterForwardReadCommand,
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
              ...(field.field === "fromFile" ? { format: workspacePathFormat } : {}),
            }),
          ]
        : [],
    ),
  );
}

function taskActionProtocolCommand(action: GeneratedTaskActionProtocolDeclaration) {
  const execution = action.execution;
  if (!execution?.topology) throw new Error(`Task Action ${action.id} has no command topology.`);
  const syntaxPath =
    action.id === "transition"
      ? ["task", "transition", "<task-id>", "<planned|active|blocked|in_review|done|cancelled>"]
      : action.id === "reconcile" || action.id === "repoint"
        ? ["task", "code-doc", action.id, "<task-id>"]
        : ["task", execution.ingress.slice("task-".length), "<task-id>"];
  const declaration = {
    id: execution.ingress,
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
      cliInput("--text", "single", true, {
        code: "missing_field",
      }),
      cliInput(
        "--evidence",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        {
          format: "<type>:<path>:<summary>",
          regex: "^[a-z][a-z0-9_-]{0,31}:[^:]+:.+$",
        },
      ),
      cliInput("--as-owner", "boolean", false, { code: "invalid_field" }, { field: "asOwner" }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "task-dispatch-review",
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
      cliInput("--task", "repeated", false, { code: "invalid_field" }, { field: "taskIds" }),
      cliInput("--agent", "single", false, { code: "invalid_field" }, { field: "agentId" }),
      cliInput("--execution-id", "single", false, { code: "invalid_field" }),
      cliInput("--instance", "single", false, { code: "invalid_field" }, { field: "runtimeInstanceId" }),
      cliInput("--model", "single", false, { code: "invalid_field" }),
      cliInput(
        "--effort",
        "single",
        false,
        { code: "invalid_runtime_effort" },
        { enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
      ),
      cliInput("--fast", "boolean", false, { code: "invalid_runtime_fast" }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-artifact-add",
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
        { conflictsWith: ["--run"], description: "Read artifact bytes from a local file" },
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
          description: "Required with --source; with --run defaults to a unique artifacts/evidence path",
        },
      ),
    ],
    actionConstraints: [["source", "run"]],
  }),
  defineLedgerWriteCommand({
    id: "task-rematerialize",
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
        { field: "taskId", conflictsWith: ["--all"] },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineCenterForwardReadCommand({
    id: "task-show",
    payloadFields: [{ field: "taskId", type: "string", required: true, regex: "^[A-Za-z0-9_-]{1,96}$" }],
    phase: "W3",
    path: ["task", "show", "<task-id>"],
    summary: "Read the task projection.",
    method: "repo.task.read",
    // <task-id> and --id are the same field in two spellings; the parser rejects both-at-once.
    inputs: [cliInput("--id", "single", false, { code: "invalid_field" }, { field: "taskId" })],
  }),
  defineRepoReadCommand({
    id: "receipt-show",
    phase: "W3",
    path: ["receipt", "show", "<op-id>"],
    summary: "Read acceptance and independent progress; optionally wait for comma-separated receipt predicates.",
    method: "repo.task.read",
    inputs: [
      cliInput("--wait", "single", false, { code: "invalid_field" }),
      cliInput("--timeout-ms", "single", false, { code: "invalid_field" }),
    ],
  }),
] as const);
