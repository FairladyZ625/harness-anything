import {
  defineCenterForwardReadCommand,
  defineCenterForwardWriteCommand,
  cliInput,
  defineLedgerWriteCommand,
  defineLocalArbiterCommand,
  defineRepoReadCommand,
  generatedTaskActionProtocolDeclarations,
  generatedTaskCreateResultFields,
  generatedWriteReceiptFields,
  workspacePathFormat,
  type GeneratedTaskActionProtocolDeclaration,
} from "../../../preset/src/preset-command-contract.ts";
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
  if (execution.topology === "center-forward-write") return defineCenterForwardWriteCommand(declaration);
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
    phase: "W3",
    path: ["task", "progress", "append", "<task-id>"],
    summary: "Append typed progress through the active task lease.",
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
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-artifact-add",
    phase: "W3",
    path: ["task", "artifact", "add", "<task-id>"],
    summary: "Publish an untracked task artifact through canonical doc sync.",
    method: "repo.task.run",
    inputs: [
      cliInput("--source", "single", true, {
        code: "missing_field",
      }),
      cliInput("--destination", "single", true, {
        code: "missing_field",
      }),
    ],
  }),
  defineCenterForwardReadCommand({
    id: "task-show",
    phase: "W3",
    path: ["task", "show", "<task-id>"],
    summary: "Read the task projection.",
    method: "repo.task.read",
    inputs: [],
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
