import {
  defineCenterForwardReadCommand,
  defineCenterForwardWriteCommand,
  cliInput,
  consentJsonFields,
  defineLedgerWriteCommand,
  defineLocalArbiterCommand,
  defineRepoReadCommand,
} from "../../../preset/src/preset-command-contract.ts";

interface GeneratedTaskActionInputField {
  readonly field: string;
  readonly type: "string" | "number" | "boolean" | "string-array" | "fact-hold-array";
  readonly required: boolean;
  readonly enum?: readonly string[];
  readonly regex?: string;
  readonly cli?: {
    readonly name: string;
    readonly kind: "single" | "repeated" | "boolean";
    readonly error: { readonly code: string };
    readonly jsonFields?: readonly string[];
    readonly jsonEnums?: Readonly<Record<string, readonly string[]>>;
    readonly conflictsWith?: readonly string[];
    readonly format?: string;
    readonly projection?: "number" | "fact-hold-array";
  };
}

export interface GeneratedTaskActionProtocolDeclaration {
  readonly id: "start" | "submit" | "review" | "complete";
  readonly input: {
    readonly schema: "entity-action-input/v1";
    readonly fields: readonly GeneratedTaskActionInputField[];
    readonly exactlyOneOf: readonly (readonly string[])[];
  };
  readonly explain: string;
  readonly execution: {
    readonly ingress: "task-start" | "task-submit" | "task-review-execution" | "task-complete";
    readonly compile: null;
    readonly read: false;
    readonly implementation: "task-lifecycle" | "task-completion";
    readonly topology: "center-forward-write" | "ledger-write" | "local-arbiter";
    readonly targetIdField: "taskId";
    readonly lifecycle: {
      readonly transitionId: string;
      readonly commandType: "StartExecution" | "SubmitExecution" | "RecordReview" | "CompleteTask";
      readonly targetIdField: "executionId";
      readonly coordination: "reserve" | "execute";
    };
  };
}

// task-action-projection:generated:start
export const generatedTaskActionProtocolDeclarations = Object.freeze([
  {
    id: "start",
    input: {
      schema: "entity-action-input/v1",
      fields: [
        {
          field: "taskId",
          type: "string",
          required: true,
        },
        {
          field: "expectedVersion",
          type: "number",
          required: false,
        },
        {
          field: "executionId",
          type: "string",
          required: false,
          cli: {
            name: "--execution-id",
            kind: "single",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "ttlMs",
          type: "number",
          required: false,
          regex: "^[1-9][0-9]*$",
          cli: {
            projection: "number",
            name: "--ttl-ms",
            kind: "single",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "dryRun",
          type: "boolean",
          required: false,
          cli: {
            name: "--dry-run",
            kind: "boolean",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "commandType",
          type: "string",
          required: false,
          enum: ["StartExecution"],
        },
      ],
      exactlyOneOf: [],
    },
    explain: "Acquire or idempotently reuse the authenticated actor's execution lease.",
    execution: {
      ingress: "task-start",
      compile: null,
      read: false,
      implementation: "task-lifecycle",
      topology: "center-forward-write",
      targetIdField: "taskId",
      lifecycle: {
        transitionId: "start_execution",
        commandType: "StartExecution",
        targetIdField: "executionId",
        coordination: "reserve",
      },
    },
  },
  {
    id: "submit",
    input: {
      schema: "entity-action-input/v1",
      fields: [
        {
          field: "taskId",
          type: "string",
          required: true,
        },
        {
          field: "expectedVersion",
          type: "number",
          required: false,
        },
        {
          field: "executionId",
          type: "string",
          required: false,
          cli: {
            name: "--execution-id",
            kind: "single",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "fromFile",
          type: "string",
          required: false,
          cli: {
            jsonFields: [
              "completionClaim",
              "deliverables",
              "outputs",
              "verificationNotes",
              "knownGaps",
              "residualRisks",
              "commitSha",
            ],
            conflictsWith: ["--json-input"],
            name: "--from-file",
            kind: "single",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "jsonInput",
          type: "string",
          required: false,
          cli: {
            jsonFields: [
              "completionClaim",
              "deliverables",
              "outputs",
              "verificationNotes",
              "knownGaps",
              "residualRisks",
              "commitSha",
            ],
            format: "<json|@->",
            conflictsWith: ["--from-file"],
            name: "--json-input",
            kind: "single",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "verb",
          type: "string",
          required: false,
          enum: ["submit"],
        },
        {
          field: "commandType",
          type: "string",
          required: false,
          enum: ["SubmitExecution"],
        },
      ],
      exactlyOneOf: [["fromFile", "jsonInput"]],
    },
    explain: "Atomically fence and release the execution lease while publishing its submission.",
    execution: {
      ingress: "task-submit",
      compile: null,
      read: false,
      implementation: "task-lifecycle",
      topology: "ledger-write",
      targetIdField: "taskId",
      lifecycle: {
        transitionId: "submit_execution",
        commandType: "SubmitExecution",
        targetIdField: "executionId",
        coordination: "execute",
      },
    },
  },
  {
    id: "review",
    input: {
      schema: "entity-action-input/v1",
      fields: [
        {
          field: "taskId",
          type: "string",
          required: true,
        },
        {
          field: "expectedVersion",
          type: "number",
          required: false,
        },
        {
          field: "executionId",
          type: "string",
          required: false,
          cli: {
            name: "--execution-id",
            kind: "single",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "reviewId",
          type: "string",
          required: true,
          cli: {
            name: "--review-id",
            kind: "single",
            error: {
              code: "missing_field",
            },
          },
        },
        {
          field: "fromFile",
          type: "string",
          required: true,
          cli: {
            jsonFields: ["verdict", "reason", "evidenceChecked"],
            jsonEnums: {
              verdict: ["approved", "changes_requested", "dismissed"],
            },
            name: "--from-file",
            kind: "single",
            error: {
              code: "missing_field",
            },
          },
        },
        {
          field: "commandType",
          type: "string",
          required: false,
          enum: ["RecordReview"],
        },
      ],
      exactlyOneOf: [],
    },
    explain: "Record an independent, content-pinned review for the submitted execution.",
    execution: {
      ingress: "task-review-execution",
      compile: null,
      read: false,
      implementation: "task-lifecycle",
      topology: "local-arbiter",
      targetIdField: "taskId",
      lifecycle: {
        transitionId: "record_execution_review",
        commandType: "RecordReview",
        targetIdField: "executionId",
        coordination: "execute",
      },
    },
  },
  {
    id: "complete",
    input: {
      schema: "entity-action-input/v1",
      fields: [
        {
          field: "taskId",
          type: "string",
          required: true,
        },
        {
          field: "expectedVersion",
          type: "number",
          required: false,
        },
        {
          field: "executionId",
          type: "string",
          required: false,
          cli: {
            name: "--execution-id",
            kind: "single",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "ci",
          type: "string",
          required: false,
          enum: ["passed"],
          cli: {
            name: "--ci",
            kind: "single",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "paths",
          type: "string-array",
          required: false,
          cli: {
            name: "--path",
            kind: "repeated",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "factHolds",
          type: "fact-hold-array",
          required: false,
          regex: "^(?:fact/)?F-[0-9A-HJKMNP-TV-Z]{8}:.+$",
          cli: {
            format: "<fact-id>:<rationale>",
            projection: "fact-hold-array",
            name: "--fact-holds",
            kind: "repeated",
            error: {
              code: "invalid_field",
            },
          },
        },
        {
          field: "verb",
          type: "string",
          required: false,
          enum: ["complete"],
        },
        {
          field: "commandType",
          type: "string",
          required: false,
          enum: ["CompleteTask"],
        },
      ],
      exactlyOneOf: [],
    },
    explain: "Complete the reviewed execution after canonical closeout readiness and gate checks.",
    execution: {
      ingress: "task-complete",
      compile: null,
      read: false,
      implementation: "task-completion",
      topology: "ledger-write",
      targetIdField: "taskId",
      lifecycle: {
        transitionId: "complete_task",
        commandType: "CompleteTask",
        targetIdField: "executionId",
        coordination: "execute",
      },
    },
  },
] as const satisfies readonly GeneratedTaskActionProtocolDeclaration[]);
// task-action-projection:generated:end

function taskActionPacketFields(id: "submit" | "review") {
  const fields = generatedTaskActionProtocolDeclarations
    .find((action) => action.id === id)
    ?.input.fields.find((field) => field.field === "fromFile")?.cli?.jsonFields;
  if (!fields) throw new Error(`Task Action ${id} has no declared packet fields.`);
  return Object.freeze([...fields]);
}

export const taskSubmissionJsonFields = taskActionPacketFields("submit"),
  reviewJsonFields = taskActionPacketFields("review");

function taskActionCliInputs(action: GeneratedTaskActionProtocolDeclaration) {
  return Object.freeze(
    action.input.fields.flatMap((field) =>
      field.cli
        ? [
            Object.freeze({
              ...field.cli,
              field: field.field,
              required: field.required,
              ...(field.enum ? { enum: field.enum } : {}),
              ...(field.regex ? { regex: field.regex } : {}),
            }),
          ]
        : [],
    ),
  );
}

function taskActionProtocolCommand(action: GeneratedTaskActionProtocolDeclaration) {
  const execution = action.execution;
  if (!execution?.topology) throw new Error(`Task Action ${action.id} has no command topology.`);
  const declaration = {
    id: execution.ingress,
    phase: "W3",
    path: ["task", execution.ingress.slice("task-".length), "<task-id>"],
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
    summary: "Publish an untracked UTF-8 artifact through canonical doc sync.",
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
  defineLedgerWriteCommand({
    id: "task-closeout",
    phase: "W3",
    path: ["task", "closeout", "<task-id>"],
    summary: [
      "Run submission, independent review, owner consent, and completion in ",
      "canonical order, resuming from the current closeout stage.",
    ].join(""),
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--from-file",
        "single",
        false,
        {
          code: "missing_field",
        },
        {
          jsonFields: ["review", "consent", "completion"],
          jsonAllowedFields: ["submission", "review", "consent", "completion"],
          format: "task-closeout-packet/v1 JSON; run --print-schema for the field contract",
          conflictsWith: ["--print-template", "--print-schema"],
        },
      ),
      cliInput(
        "--print-template",
        "boolean",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--from-file", "--print-schema"] },
      ),
      cliInput(
        "--print-schema",
        "boolean",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--from-file", "--print-template", "--execution-id"] },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-review-consent",
    phase: "W3",
    path: ["task", "review-consent", "<task-id>"],
    summary: "Select a recorded Review with content-pinned owner consent.",
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--review-id", "single", false, {
        code: "invalid_field",
      }),
      cliInput("--consent-id", "single", true, {
        code: "invalid_field",
      }),
      cliInput(
        "--from-file",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { jsonFields: consentJsonFields },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-code-doc-reconcile",
    phase: "W3",
    path: ["task", "code-doc", "reconcile", "<task-id>"],
    summary: "Publish a typed code-doc witness.",
    method: "repo.task.run",
    inputs: [
      cliInput("--path", "repeated", true, {
        code: "missing_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-code-doc-repoint",
    phase: "W3",
    path: ["task", "code-doc", "repoint", "<task-id>"],
    summary: "Append an audited code-doc witness correction for a completed task.",
    method: "repo.task.run",
    inputs: [
      cliInput("--record", "single", true, {
        code: "missing_field",
      }),
      cliInput("--path", "repeated", false, {
        code: "invalid_field",
      }),
      cliInput("--reason", "single", true, {
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
    summary: "Read a write receipt.",
    method: "repo.task.read",
    inputs: [],
  }),
] as const);
