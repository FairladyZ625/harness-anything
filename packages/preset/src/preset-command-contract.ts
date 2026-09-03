import type {
  CliInputError,
  CliInputFacet,
  CommandAdmission,
  CommandAdmissionRoute,
  CommandTopology,
  GeneratedTaskActionProtocolProjection,
  RpcShape,
} from "./preset-command-contract-support.ts";

export type {
  CliInputError,
  CliInputFacet,
  CommandAdmission,
  CommandAdmissionRoute,
  CommandTopology,
  GeneratedTaskActionInputField,
  GeneratedTaskActionProtocolDeclaration,
  RpcShape,
} from "./preset-command-contract-support.ts";

const commandTopology = (
  commandClass: CommandTopology["commandClass"],
  center: CommandAdmissionRoute,
  edge: CommandAdmissionRoute,
): CommandTopology =>
  Object.freeze({
    commandClass,
    admission: Object.freeze({
      local: "direct",
      "remote-proxy": "rejected",
      "remote-center": center,
      "remote-edge": edge,
    }),
  });
export const repoReadCommandTopology = commandTopology("repo-read", "direct", "direct"),
  ledgerWriteCommandTopology = commandTopology("repo-write", "via-assignment", "rejected"),
  centerForwardReadCommandTopology = commandTopology("repo-read", "direct", "via-center-forward"),
  centerForwardWriteCommandTopology = commandTopology("repo-write", "via-assignment", "via-center-forward"),
  runtimeLocalWriteCommandTopology = commandTopology("repo-write", "via-assignment", "direct"),
  centerRepairWriteCommandTopology = commandTopology("repo-write", "direct", "rejected"),
  localArbiterCommandTopology = commandTopology("arbiter", "rejected", "rejected"),
  hostAdminCommandTopology = commandTopology("admin", "direct", "direct");
const shape = (fields: RpcShape["fields"]): RpcShape => ({ fields }),
  repo = shape({ repoId: "string" });

export function cliInput<const Extra extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>>(
  name: string,
  kind: CliInputFacet["kind"],
  required: boolean,
  error: CliInputError,
  extra?: Extra,
): Readonly<CliInputFacet & Extra> {
  return Object.freeze({ ...extra, name, kind, required, error: Object.freeze(error) }) as Readonly<
    CliInputFacet & Extra
  >;
}

export function regexLength(regex: string | undefined): readonly [number, number] | undefined {
  const match = regex?.match(
    /^\^(?:\[(?:\\.|[^\]\\\r\n])*\]|\\(?:[dDsSwW]|[pP]\{[^}\r\n]+\})|\.)(?:\{(\d+)(?:,(\d+))?\})\$$/u,
  );
  if (!match) return undefined;
  const min = Number(match[1]),
    max = Number(match[2] ?? match[1]);
  return Number.isSafeInteger(min) && Number.isSafeInteger(max) ? [min, max] : undefined;
}

export function parameterRelationHint(value: string): boolean {
  return /(?:\b(?:exactly one|one of|either|together|not both|only valid|requires|without|with)\b|,\s*or\b)/iu.test(
    value,
  );
}

export function cliInputHelp(input: CliInputFacet): string {
  const facts = [
    input.required ? "required" : input.requiredWhen ? "conditionally required" : "optional",
    input.kind === "repeated" ? "repeatable" : input.kind === "boolean" ? "flag" : "value",
  ];
  if (input.enum) facts.push(`values: ${input.enum.join(", ")}`);
  if (input.jsonFields) facts.push(`JSON required fields: ${input.jsonFields.join(", ") || "none"}`);
  if (input.jsonAllowedFields) facts.push(`JSON accepted fields: ${input.jsonAllowedFields.join(", ")}`);
  if (input.jsonEnums)
    facts.push(
      `JSON values: ${Object.entries(input.jsonEnums)
        .map(([field, values]) => `${field}: ${values.join("|")}`)
        .join(", ")}`,
    );
  if (input.format) facts.push(`format: ${input.format}`);
  else if (input.regex) facts.push(`pattern: /${input.regex}/u`);
  const bounds =
    input.minLength !== undefined || input.maxLength !== undefined
      ? [input.minLength ?? 0, input.maxLength ?? "∞"]
      : regexLength(input.regex);
  if (bounds) facts.push(`length: ${bounds[0]}..${bounds[1]} ${input.lengthUnit ?? "characters"}`);
  if (input.minItems !== undefined || input.maxItems !== undefined)
    facts.push(`count: ${input.minItems ?? 0}..${input.maxItems ?? "∞"} items`);
  if (input.unique) facts.push("values must be unique");
  if (input.requiredWhen)
    facts.push(`required when ${input.requiredWhen.field} is ${input.requiredWhen.values.join(" or ")}`);
  if (input.allowedWhen)
    facts.push(`allowed when ${input.allowedWhen.field} is ${input.allowedWhen.values.join(" or ")}`);
  if (input.requires?.length) facts.push(`requires: ${input.requires.join(", ")}`);
  if (input.requiresAny?.length) facts.push(`requires one of: ${input.requiresAny.join(", ")}`);
  if (input.conflictsWith?.length) facts.push(`mutually exclusive with: ${input.conflictsWith.join(", ")}`);
  return `${input.name} — ${facts.join("; ")}`;
}

export function cliCommandHelp(inputs: readonly CliInputFacet[]): string {
  return inputs.map((input) => `    ${cliInputHelp(input)}`).join("\n");
}

export function defineCliCommand<
  const Command extends {
    readonly path: readonly string[];
    readonly syntaxPath?: readonly string[];
    readonly inputs: readonly CliInputFacet[];
    readonly commandClass: CommandTopology["commandClass"];
    readonly admission: CommandAdmission;
  },
>(declaration: Command) {
  const rawPath = declaration.syntaxPath ?? declaration.path,
    syntaxPath = Object.freeze([...rawPath]),
    firstPositional = syntaxPath.findIndex((token) => token.includes("<") || token.startsWith("[")),
    path = Object.freeze(syntaxPath.slice(0, firstPositional < 0 ? syntaxPath.length : firstPositional)),
    inputs = Object.freeze(declaration.inputs.map((input) => Object.freeze(input))) as Command["inputs"],
    usageInputs = inputs.map((input) => {
      const placeholder = input.enum?.join("|") ?? input.name.slice(2),
        suffix = input.kind === "repeated" && input.required ? "..." : "",
        value = input.kind === "boolean" ? input.name : `${input.name} <${placeholder}>${suffix}`,
        rendered = input.required ? value : `[${value}]`;
      return input.kind === "repeated" && !input.required ? `${rendered}...` : rendered;
    }),
    usage = ["ha", ...syntaxPath, ...usageInputs].join(" "),
    help = cliCommandHelp(inputs);
  // Re-applying defineCliCommand to its own prior output (a daemon-effective rebuild spreading an
  // already-built command) must stay idempotent: syntaxPath, not the already-truncated routing path,
  // is the source of truth, so a positional like <task-id> survives every rebuild automatically.
  return Object.freeze({ ...declaration, path, syntaxPath, inputs, flags: inputs, usage, help });
}

type CliCommandDeclaration = {
  readonly path: readonly string[];
  readonly syntaxPath?: readonly string[];
  readonly inputs: readonly CliInputFacet[];
};
const defineTopologyCommand =
  (topology: CommandTopology) =>
  <const Command extends CliCommandDeclaration>(declaration: Command) =>
    defineCliCommand({ ...declaration, ...topology });
export const defineRepoReadCommand = defineTopologyCommand(repoReadCommandTopology),
  defineLedgerWriteCommand = defineTopologyCommand(ledgerWriteCommandTopology),
  defineCenterForwardReadCommand = defineTopologyCommand(centerForwardReadCommandTopology),
  defineCenterForwardWriteCommand = defineTopologyCommand(centerForwardWriteCommandTopology),
  defineRuntimeLocalWriteCommand = defineTopologyCommand(runtimeLocalWriteCommandTopology),
  defineCenterRepairWriteCommand = defineTopologyCommand(centerRepairWriteCommandTopology),
  defineLocalArbiterCommand = defineTopologyCommand(localArbiterCommandTopology),
  defineHostAdminCommand = defineTopologyCommand(hostAdminCommandTopology);

export const decisionProposalJsonFields = Object.freeze([
  "title",
  "question",
  "riskTier",
  "urgency",
  "vertical",
  "preset",
  "decisionClass",
  "appliesTo",
  "chosen",
  "rejected",
  "claims",
  "fulfillments",
] as const);

// task-action-projection:generated:start
const taskActionDescriptorProjection = {
  writeReceiptFields: [
    "outcome",
    "opId",
    "authorizationDecision",
    "revision",
    "code",
    "origin",
    "evidence",
    "visibility",
    "proof",
    "detail",
    "commitSha",
    "unmetCriteria",
    "effects",
    "updatedProjection",
    "rejectionExplanation",
    "nextAction",
    "nextActions",
    "guidance",
    "diagnostic",
    "cut",
  ],
  taskCreateResultFields: [
    "outcome",
    "opId",
    "authorizationDecision",
    "revision",
    "code",
    "origin",
    "evidence",
    "visibility",
    "proof",
    "detail",
    "commitSha",
    "unmetCriteria",
    "effects",
    "updatedProjection",
    "rejectionExplanation",
    "nextAction",
    "nextActions",
    "guidance",
    "diagnostic",
    "cut",
    "taskId",
    "status",
    "packagePath",
    "generatedPaths",
    "presetDigest",
    "scaffoldDigest",
    "presetId",
    "profileId",
    "outputShape",
    "completionGates",
    "dryRun",
  ],
  actions: [
    {
      id: "create",
      input: {
        schema: "entity-action-input/v1",
        fields: [
          { field: "title", cli: { name: "--title", kind: "single", error: "missing_field" } },
          { field: "taskId", cli: { name: "--id", kind: "single" } },
          { field: "idempotencyKey", cli: { name: "--idempotency-key", kind: "single" } },
          { field: "parentTaskId", cli: { name: "--parent", kind: "single" } },
          {
            field: "workKind",
            enum: ["feat", "fix", "refactor", "docs", "test", "chore"],
            cli: { name: "--kind", kind: "single" },
          },
          { field: "riskTier", enum: ["low", "medium", "high"], cli: { name: "--risk-tier", kind: "single" } },
          { field: "urgency", enum: ["low", "medium", "high"], cli: { name: "--urgency", kind: "single" } },
          {
            field: "fromFile",
            cli: {
              conflictsWith: ["--json-input"],
              name: "--from-file",
              kind: "single",
              jsonFields: ["title"],
              jsonAllowedFields: [
                "title",
                "taskId",
                "idempotencyKey",
                "parentTaskId",
                "workKind",
                "riskTier",
                "urgency",
                "verticalId",
                "presetId",
                "profileId",
                "moduleKey",
                "registerModule",
                "slug",
                "surfaces",
                "taskClass",
                "locale",
                "fromLegacyId",
                "createMode",
              ],
              jsonEnums: {
                workKind: ["feat", "fix", "refactor", "docs", "test", "chore"],
                riskTier: ["low", "medium", "high"],
                urgency: ["low", "medium", "high"],
                taskClass: ["standard", "milestone", "epic", "long_running"],
                locale: ["en-US", "zh-CN"],
                createMode: ["migration", "import", "admin"],
              },
            },
          },
          {
            field: "jsonInput",
            cli: {
              format: "<json|@->",
              conflictsWith: ["--from-file"],
              name: "--json-input",
              kind: "single",
              jsonFields: ["title"],
              jsonAllowedFields: [
                "title",
                "taskId",
                "idempotencyKey",
                "parentTaskId",
                "workKind",
                "riskTier",
                "urgency",
                "verticalId",
                "presetId",
                "profileId",
                "moduleKey",
                "registerModule",
                "slug",
                "surfaces",
                "taskClass",
                "locale",
                "fromLegacyId",
                "createMode",
              ],
              jsonEnums: {
                workKind: ["feat", "fix", "refactor", "docs", "test", "chore"],
                riskTier: ["low", "medium", "high"],
                urgency: ["low", "medium", "high"],
                taskClass: ["standard", "milestone", "epic", "long_running"],
                locale: ["en-US", "zh-CN"],
                createMode: ["migration", "import", "admin"],
              },
            },
          },
          { field: "verticalId", cli: { name: "--vertical", kind: "single" } },
          { field: "presetId", cli: { name: "--preset", kind: "single" } },
          { field: "profileId", cli: { name: "--profile", kind: "single" } },
          { field: "moduleKey", cli: { name: "--module", kind: "single" } },
          { field: "registerModuleKey", cli: { name: "--register-module", kind: "single" } },
          { field: "moduleTitle", cli: { name: "--module-title", kind: "single" } },
          { field: "modulePrefix", cli: { name: "--module-prefix", kind: "single" } },
          { field: "moduleScope", cli: { name: "--module-scope", kind: "single" } },
          {
            field: "slug",
            regex: "^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$",
            cli: { name: "--slug", kind: "single" },
          },
          { field: "surfaces", type: "string-array", cli: { name: "--surface", kind: "repeated" } },
          {
            field: "taskClass",
            enum: ["standard", "milestone", "epic", "long_running"],
            cli: { name: "--task-class", kind: "single" },
          },
          { field: "dryRun", type: "boolean", cli: { name: "--dry-run", kind: "boolean" } },
          { field: "locale", enum: ["en-US", "zh-CN"], cli: { name: "--locale", kind: "single" } },
          { field: "fromLegacyId", cli: { name: "--from-legacy", kind: "single" } },
          { field: "migration", type: "boolean", cli: { name: "--migration", kind: "boolean" } },
          { field: "import", type: "boolean", cli: { name: "--import", kind: "boolean" } },
          { field: "admin", type: "boolean", cli: { name: "--admin", kind: "boolean" } },
          { field: "registerModule", type: "json-object" },
          { field: "createMode", enum: ["migration", "import", "admin"] },
          { field: "commandType", enum: ["CreateReplayTask"] },
        ],
        exactlyOneOf: [],
      },
      explain: "Create a canonical replay/v1 Task and its declared scaffold artifacts.",
      execution: {
        ingress: "task-create",
        topology: "center-forward-write",
        lifecycle: {
          transitionId: "create_replay_task",
          commandType: "CreateReplayTask",
          targetIdField: "executionId",
          coordination: "execute",
        },
      },
    },
    {
      id: "start",
      input: {
        schema: "entity-action-input/v1",
        fields: [
          { field: "taskId", required: true },
          { field: "expectedVersion", type: "number" },
          { field: "executionId", cli: { name: "--execution-id", kind: "single" } },
          {
            field: "ttlMs",
            type: "number",
            regex: "^[1-9][0-9]*$",
            cli: { projection: "number", name: "--ttl-ms", kind: "single" },
          },
          { field: "dryRun", type: "boolean", cli: { name: "--dry-run", kind: "boolean" } },
          { field: "commandType", enum: ["StartExecution"] },
        ],
        exactlyOneOf: [],
      },
      explain: "Acquire or idempotently reuse the authenticated actor's execution lease.",
      execution: {
        ingress: "task-start",
        topology: "center-forward-write",
        lifecycle: {
          transitionId: "start_execution",
          commandType: "StartExecution",
          targetIdField: "executionId",
          coordination: "reserve",
        },
      },
    },
    {
      id: "transition",
      input: {
        schema: "entity-action-input/v1",
        fields: [
          { field: "taskId", required: true },
          { field: "expectedVersion", type: "number" },
          {
            field: "status",
            required: true,
            enum: ["planned", "active", "blocked", "in_review", "done", "cancelled"],
          },
          { field: "reason", cli: { name: "--reason", kind: "single" } },
          { field: "force", type: "boolean", cli: { name: "--force", kind: "boolean" } },
          { field: "commandType", enum: ["TransitionTask"] },
        ],
        exactlyOneOf: [],
      },
      explain: "Move the canonical Task status while preserving its independent graph cursor.",
      execution: {
        ingress: "task-transition",
        topology: "ledger-write",
        lifecycle: {
          transitionId: "transition_task",
          commandType: "TransitionTask",
          targetIdField: "executionId",
          coordination: "execute",
        },
      },
    },
    {
      id: "submit",
      input: {
        schema: "entity-action-input/v1",
        fields: [
          { field: "taskId", required: true },
          { field: "expectedVersion", type: "number" },
          { field: "executionId", cli: { name: "--execution-id", kind: "single" } },
          { field: "amend", type: "boolean", cli: { name: "--amend", kind: "boolean" } },
          { field: "completionClaim" },
          { field: "deliverables", type: "string-array" },
          { field: "outputs", type: "string-array" },
          { field: "verificationNotes", type: "string-array" },
          { field: "knownGaps", type: "string-array" },
          { field: "residualRisks", type: "string-array" },
          { field: "commitSha" },
          {
            field: "fromFile",
            cli: {
              conflictsWith: ["--json-input"],
              name: "--from-file",
              kind: "single",
              jsonFields: [
                "completionClaim",
                "deliverables",
                "outputs",
                "verificationNotes",
                "knownGaps",
                "residualRisks",
                "commitSha",
              ],
              jsonAllowedFields: [
                "completionClaim",
                "deliverables",
                "outputs",
                "verificationNotes",
                "knownGaps",
                "residualRisks",
                "commitSha",
              ],
            },
          },
          {
            field: "jsonInput",
            cli: {
              format: "<json|@->",
              conflictsWith: ["--from-file"],
              name: "--json-input",
              kind: "single",
              jsonFields: [
                "completionClaim",
                "deliverables",
                "outputs",
                "verificationNotes",
                "knownGaps",
                "residualRisks",
                "commitSha",
              ],
              jsonAllowedFields: [
                "completionClaim",
                "deliverables",
                "outputs",
                "verificationNotes",
                "knownGaps",
                "residualRisks",
                "commitSha",
              ],
            },
          },
          { field: "verb", enum: ["submit"] },
          { field: "commandType", enum: ["SubmitExecution"] },
        ],
        exactlyOneOf: [["fromFile", "jsonInput"]],
      },
      explain: "Publish the initial submission or amend the current submitted execution without replacing its history.",
      execution: {
        ingress: "task-submit",
        topology: "ledger-write",
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
          { field: "taskId", required: true },
          { field: "expectedVersion", type: "number" },
          { field: "executionId", cli: { name: "--execution-id", kind: "single" } },
          { field: "reviewId", required: true, cli: { name: "--review-id", kind: "single" } },
          { field: "verdict", enum: ["approved", "changes_requested", "dismissed"] },
          { field: "reason" },
          { field: "evidenceChecked", type: "string-array" },
          {
            field: "fromFile",
            cli: {
              conflictsWith: ["--json-input"],
              name: "--from-file",
              kind: "single",
              jsonFields: ["verdict", "reason", "evidenceChecked"],
              jsonAllowedFields: ["verdict", "reason", "evidenceChecked"],
              jsonEnums: { verdict: ["approved", "changes_requested", "dismissed"] },
            },
          },
          {
            field: "jsonInput",
            cli: {
              format: "<json|@->",
              conflictsWith: ["--from-file"],
              name: "--json-input",
              kind: "single",
              jsonFields: ["verdict", "reason", "evidenceChecked"],
              jsonAllowedFields: ["verdict", "reason", "evidenceChecked"],
              jsonEnums: { verdict: ["approved", "changes_requested", "dismissed"] },
            },
          },
          { field: "commandType", enum: ["RecordReview"] },
        ],
        exactlyOneOf: [["fromFile", "jsonInput"]],
      },
      explain: "Record an independent, content-pinned review for the submitted execution.",
      execution: {
        ingress: "task-review-execution",
        topology: "local-arbiter",
        lifecycle: {
          transitionId: "record_execution_review",
          commandType: "RecordReview",
          targetIdField: "executionId",
          coordination: "execute",
        },
      },
    },
    {
      id: "consent",
      input: {
        schema: "entity-action-input/v1",
        fields: [
          { field: "taskId", required: true },
          { field: "expectedVersion", type: "number" },
          { field: "executionId", cli: { name: "--execution-id", kind: "single" } },
          { field: "reviewId", cli: { name: "--review-id", kind: "single" } },
          {
            field: "consentId",
            required: true,
            cli: { name: "--consent-id", kind: "single", error: "invalid_field" },
          },
          { field: "reviewDigest" },
          { field: "contentDigest" },
          {
            field: "fromFile",
            cli: {
              conflictsWith: ["--json-input"],
              name: "--from-file",
              kind: "single",
              jsonFields: ["reviewDigest", "contentDigest"],
              jsonAllowedFields: ["reviewDigest", "contentDigest"],
            },
          },
          {
            field: "jsonInput",
            cli: {
              format: "<json|@->",
              conflictsWith: ["--from-file"],
              name: "--json-input",
              kind: "single",
              jsonFields: ["reviewDigest", "contentDigest"],
              jsonAllowedFields: ["reviewDigest", "contentDigest"],
            },
          },
          { field: "commandType", enum: ["RecordReviewConsent"] },
        ],
        exactlyOneOf: [["fromFile", "jsonInput"]],
      },
      explain: "Select a recorded Review with content-pinned owner consent.",
      execution: {
        ingress: "task-review-consent",
        topology: "ledger-write",
        lifecycle: {
          transitionId: "record_review_consent",
          commandType: "RecordReviewConsent",
          targetIdField: "executionId",
          coordination: "execute",
        },
      },
    },
    {
      id: "reconcile",
      input: {
        schema: "entity-action-input/v1",
        fields: [
          { field: "taskId", required: true },
          { field: "expectedVersion", type: "number" },
          { field: "executionId" },
          { field: "witnessId" },
          { field: "commitSha" },
          { field: "iteration", type: "number" },
          {
            field: "paths",
            type: "string-array",
            required: true,
            cli: { name: "--path", kind: "repeated" },
          },
          { field: "commandType", enum: ["ReconcileCodeDoc"] },
        ],
        exactlyOneOf: [],
      },
      explain: "Publish a typed code-doc witness.",
      execution: {
        ingress: "task-code-doc-reconcile",
        topology: "ledger-write",
        lifecycle: {
          transitionId: "reconcile_code_doc",
          commandType: "ReconcileCodeDoc",
          targetIdField: "executionId",
          coordination: "execute",
        },
      },
    },
    {
      id: "repoint",
      input: {
        schema: "entity-action-input/v1",
        fields: [
          { field: "taskId", required: true },
          { field: "expectedVersion", type: "number" },
          { field: "record", required: true, cli: { name: "--record", kind: "single" } },
          { field: "repointId" },
          { field: "commitSha" },
          { field: "paths", type: "string-array", cli: { name: "--path", kind: "repeated" } },
          { field: "reason", required: true, cli: { name: "--reason", kind: "single" } },
          { field: "commandType", enum: ["RepointCodeDoc"] },
        ],
        exactlyOneOf: [],
      },
      explain: "Append an audited code-doc witness correction for a completed task.",
      execution: {
        ingress: "task-code-doc-repoint",
        topology: "ledger-write",
        lifecycle: {
          transitionId: "repoint_code_doc",
          commandType: "RepointCodeDoc",
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
          { field: "taskId", required: true },
          { field: "expectedVersion", type: "number" },
          { field: "executionId", cli: { name: "--execution-id", kind: "single" } },
          { field: "ci", enum: ["passed"], cli: { name: "--ci", kind: "single" } },
          { field: "paths", type: "string-array", cli: { name: "--path", kind: "repeated" } },
          {
            field: "factHolds",
            type: "fact-hold-array",
            regex: "^(?:fact/)?F-[0-9A-HJKMNP-TV-Z]{8}:.+$",
            cli: {
              format: "<fact-id>:<rationale>",
              projection: "fact-hold-array",
              name: "--fact-holds",
              kind: "repeated",
            },
          },
          { field: "verb", enum: ["complete"] },
          { field: "commandType", enum: ["CompleteTask"] },
        ],
        exactlyOneOf: [],
      },
      explain: "Complete the reviewed execution after canonical closeout readiness and gate checks.",
      execution: {
        ingress: "task-complete",
        topology: "ledger-write",
        lifecycle: {
          transitionId: "complete_task",
          commandType: "CompleteTask",
          targetIdField: "executionId",
          coordination: "execute",
        },
      },
    },
  ],
} as GeneratedTaskActionProtocolProjection;
// task-action-projection:generated:end

const allTaskActionProtocolDeclarations = taskActionDescriptorProjection.actions,
  taskCreateAction = allTaskActionProtocolDeclarations.find(({ id }) => id === "create");
if (!taskCreateAction) throw new Error("task.create action projection is missing.");
export function taskCreateEnum(field: string): readonly string[] {
  const values = taskCreateAction?.input.fields.find((candidate) => candidate.field === field)?.enum;
  if (!values) throw new Error(`task.create ${field} enum projection is missing.`);
  return values;
}
const taskCreatePacketFieldNames = taskCreateAction.input.fields.find(({ field }) => field === "fromFile")?.cli
  ?.jsonAllowedFields;
if (!taskCreatePacketFieldNames) throw new Error("task.create packet projection is missing.");
const taskCreatePacketFields = taskCreateAction.input.fields.filter(({ field }) =>
  taskCreatePacketFieldNames.includes(field),
);
export const taskCreateJsonFields = Object.freeze([...taskCreatePacketFieldNames]);
export const generatedTaskActionProtocolDeclarations = Object.freeze(
  allTaskActionProtocolDeclarations.filter(({ id }) => id !== "create"),
);
export const generatedWriteReceiptFields = Object.freeze([...taskActionDescriptorProjection.writeReceiptFields]);
export const generatedTaskCreateResultFields = Object.freeze(
  taskActionDescriptorProjection.taskCreateResultFields.filter((field) => !generatedWriteReceiptFields.includes(field)),
);

const taskCreateCliInputs = Object.freeze(
  taskCreateAction.input.fields.flatMap((field) => {
    if (!field.cli) return [];
    const cli = field.cli,
      error = Object.freeze({ code: cli.error ?? (field.required ? "missing_field" : "invalid_field") });
    return [
      cliInput(cli.name, cli.kind, field.required === true, error, {
        field: field.field,
        ...(field.enum ? { enum: field.enum } : {}),
        ...(field.regex ? { regex: field.regex } : {}),
        ...cli,
      }),
    ];
  }),
);
const consentJsonFieldProjection = generatedTaskActionProtocolDeclarations
  .find(({ id }) => id === "consent")
  ?.input.fields.find(({ field }) => field === "fromFile")?.cli?.jsonAllowedFields;
if (!consentJsonFieldProjection) throw new Error("task.consent packet projection is missing.");
export const consentJsonFields = Object.freeze([...consentJsonFieldProjection]);
export const presetCommands = Object.freeze([
  defineCenterForwardWriteCommand({
    id: "task-create",
    phase: "Preset-A",
    path: ["task", "create"],
    summary: "Create a task package with its complete metadata.",
    method: "repo.task.create",
    inputs: taskCreateCliInputs,
  }),
  defineRepoReadCommand({
    id: "preset-list",
    phase: "Preset-A",
    path: ["preset", "list"],
    summary: "List effective preset packages and blocked shadows.",
    method: "repo.preset.list",
    inputs: [cliInput("--vertical", "single", false, { code: "invalid_field" }, { field: "verticalId" })],
  }),
  defineRepoReadCommand({
    id: "preset-inspect",
    phase: "Preset-A",
    path: ["preset", "inspect", "<id>"],
    summary: "Inspect one resolved preset snapshot.",
    method: "repo.preset.inspect",
    positional: "presetId",
    inputs: [
      cliInput("--profile", "single", false, { code: "invalid_field" }, { field: "profileId" }),
      cliInput("--vertical", "single", false, { code: "invalid_field" }, { field: "verticalId" }),
      cliInput("--locale", "single", false, { code: "invalid_field" }, { field: "locale" }),
    ],
  }),
  defineRepoReadCommand({
    id: "preset-check",
    phase: "Preset-A",
    path: ["preset", "check", "<id>"],
    summary: "Preflight one effective preset package or compare a frozen snapshot.",
    method: "repo.preset.check",
    positional: "presetId",
    inputs: [
      cliInput("--vertical", "single", false, { code: "invalid_field" }, { field: "verticalId" }),
      cliInput(
        "--snapshot-digest",
        "single",
        false,
        { code: "invalid_field" },
        { field: "snapshotDigest", regex: "^sha256:[0-9a-f]{64}$" },
      ),
    ],
  }),
  defineRepoReadCommand({
    id: "preset-validate",
    phase: "Preset-A",
    path: ["preset", "validate"],
    summary: "Validate one self-contained preset package.",
    method: "repo.preset.validate",
    inputs: [cliInput("--source", "single", true, { code: "missing_field" }, { field: "packageSource" })],
  }),
  defineLedgerWriteCommand({
    id: "preset-install",
    phase: "Preset-A",
    path: ["preset", "install"],
    summary: "Install a whole package behind an atomic active pointer.",
    method: "repo.preset.install",
    inputs: [
      cliInput("--source", "single", true, { code: "missing_field" }, { field: "packageSource" }),
      cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "preset-seed",
    phase: "Preset-A",
    path: ["preset", "seed"],
    summary: "Seed bundled packages into user active pointers.",
    method: "repo.preset.seed",
    inputs: [cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" })],
  }),
  defineRepoReadCommand({
    id: "preset-audit",
    phase: "Preset-A",
    path: ["preset", "audit"],
    summary: "Audit the effective preset inventory and its issues.",
    method: "repo.preset.audit",
    inputs: [cliInput("--vertical", "single", false, { code: "invalid_field" }, { field: "verticalId" })],
  }),
  defineLedgerWriteCommand({
    id: "preset-uninstall",
    phase: "Preset-A",
    path: ["preset", "uninstall", "<id>"],
    summary: "Remove only the user active pointer.",
    method: "repo.preset.uninstall",
    positional: "presetId",
    inputs: [cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" })],
  }),
  defineLedgerWriteCommand({
    id: "preset-upgrade",
    phase: "Preset-A",
    path: ["preset", "upgrade", "<task-id>"],
    summary: "Canonically upgrade one task to the current complete preset snapshot.",
    method: "repo.preset.upgrade",
    positional: "taskId",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "vertical-validate",
    phase: "Preset-A",
    path: ["vertical", "validate"],
    summary: "Validate the builtin software/coding declaration and its catalog closure.",
    method: "repo.vertical.validate",
    inputs: [cliInput("--source", "single", false, { code: "invalid_field" }, { field: "verticalSource" })],
  }),
  defineRepoReadCommand({
    id: "template-list",
    phase: "Preset-A",
    path: ["template", "list"],
    summary: "List builtin software/coding template declarations.",
    method: "repo.template.list",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "template-render",
    phase: "Preset-A",
    path: ["template", "render", "<ref>"],
    summary: "Render one builtin template without writing it.",
    method: "repo.template.render",
    positional: "templateRef",
    inputs: [
      cliInput("--locale", "single", false, { code: "invalid_field" }, { field: "locale", enum: ["zh-CN", "en-US"] }),
    ],
  }),
  defineRepoReadCommand({
    id: "script-list",
    phase: "Preset-A",
    path: ["script", "list"],
    summary: "List executable builtin vertical script declarations.",
    method: "repo.script.list",
    inputs: [],
  }),
  defineRepoReadCommand({
    id: "script-inspect",
    phase: "Preset-A",
    path: ["script", "inspect", "<id>"],
    summary: "Inspect one builtin vertical script declaration and execution availability.",
    method: "repo.script.inspect",
    positional: "scriptId",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "script-run",
    phase: "Preset-A",
    path: ["script", "run", "<id>"],
    summary: "Run one declared builtin vertical script through its typed RepoCell host.",
    method: "repo.script.run",
    positional: "scriptId",
    positionalRegex: "^vertical:[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$",
    actionDefaults: { schema: "vertical-script-action/v1", taskId: null, inputs: {}, dryRun: false },
    inputs: [
      cliInput("--task", "single", false, { code: "invalid_field" }, { field: "taskId" }),
      cliInput("--inputs", "single", false, { code: "invalid_field" }, { field: "inputs", codec: "json" }),
      cliInput("--dry-run", "boolean", false, { code: "invalid_field" }, { field: "dryRun" }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "preset-run-start",
    phase: "Preset-B",
    path: ["script", "run", "preset:<id>/<entrypoint>"],
    summary: "Run one declared user preset entrypoint through the resident daemon.",
    method: "repo.preset.run.start",
    positional: "presetTarget",
    positionalFields: ["presetId", "entrypoint"],
    inputs: [
      cliInput("--task", "single", false, { code: "invalid_field" }, { field: "taskId" }),
      cliInput("--inputs", "single", false, { code: "invalid_field" }, { field: "inputs", codec: "json" }),
      cliInput("--idempotency-key", "single", true, { code: "missing_field" }, { field: "idempotencyKey" }),
    ],
  }),
] as const);
const taskCreateRpcFields: RpcShape["fields"] = Object.fromEntries([
  ...taskCreatePacketFields.map((field) => [
    field.field,
    field.type === "json-object"
      ? "json?"
      : field.type?.endsWith("-array")
        ? "array?"
        : field.type === "boolean"
          ? "boolean?"
          : "string?",
  ]),
  ["fromFile", "string?"],
  ["jsonInput", "string?"],
  ["dryRun", "boolean?"],
]);
export const presetMethods = Object.freeze([
  ...presetCommands.map((command) => {
    const positional = "positional" in command ? command.positional : undefined,
      positionalFields = "positionalFields" in command ? command.positionalFields : positional ? [positional] : [],
      derived: RpcShape["fields"] = Object.fromEntries([
        ...positionalFields.map((field) => [field, "string"]),
        ...command.inputs.map((input) => [
          input.field,
          input.kind === "boolean"
            ? "boolean?"
            : input.kind === "repeated"
              ? "array?"
              : "codec" in input && input.codec === "json"
                ? "json?"
                : input.required
                  ? "string"
                  : "string?",
        ]),
      ]),
      fields = { ...(command.id === "task-create" ? taskCreateRpcFields : derived), executor: "json?" as const };
    return {
      id: command.method,
      phase: command.phase,
      method: command.method,
      requiresRepo: true,
      actionKind: command.id,
      commandClass: command.commandClass,
      admission: command.admission,
      params: shape({ repo, payload: shape(fields) }),
    };
  }),
  {
    id: "repo.preset.run.status",
    phase: "Preset-B",
    method: "repo.preset.run.status",
    requiresRepo: true,
    actionKind: "preset-run-status",
    ...repoReadCommandTopology,
    params: shape({ repo, payload: shape({ runId: "string", executor: "json?" }) }),
  },
] as const);
