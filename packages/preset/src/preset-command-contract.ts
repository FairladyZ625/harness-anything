import { brotliDecompressSync } from "node:zlib";
import type { EntityActionContract, EntityActionInputField } from "../../kernel/src/index.ts";

export interface CliInputError {
  readonly code: string;
}
export type CommandAdmissionRoute = "direct" | "via-assignment" | "via-center-forward" | "rejected";
export type CommandAdmission = Readonly<
  Record<"local" | "remote-proxy" | "remote-center" | "remote-edge", CommandAdmissionRoute>
>;
export interface CommandTopology {
  readonly commandClass: "admin" | "repo-write" | "repo-read" | "arbiter";
  readonly admission: CommandAdmission;
}
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
export interface CliInputFacet {
  readonly name: string;
  readonly kind: "single" | "repeated" | "boolean";
  readonly required: boolean;
  readonly enum?: readonly string[];
  readonly regex?: string;
  readonly error: CliInputError;
  readonly jsonFields?: readonly string[];
  readonly jsonAllowedFields?: readonly string[];
  readonly jsonEnums?: Readonly<Record<string, readonly string[]>>;
  readonly format?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly lengthUnit?: "characters" | "bytes";
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly unique?: boolean;
  readonly requiredWhen?: { readonly field: string; readonly values: readonly string[] };
  readonly allowedWhen?: { readonly field: string; readonly values: readonly string[] };
  readonly requires?: readonly string[];
  readonly requiresAny?: readonly string[];
  readonly conflictsWith?: readonly string[];
}
export type RpcShape = {
  readonly fields: Readonly<
    Record<string, "string" | "number" | "boolean?" | "string?" | "json" | "json?" | "array" | "array?" | RpcShape>
  >;
  readonly open?: boolean;
};
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
export type GeneratedTaskActionInputField = Pick<
  EntityActionInputField,
  "field" | "type" | "required" | "enum" | "regex"
> & { readonly cli?: Omit<NonNullable<EntityActionInputField["cli"]>, "jsonSchema"> };
// prettier-ignore
export interface GeneratedTaskActionProtocolDeclaration {
  readonly id: string;
  readonly input: { readonly schema: "entity-action-input/v1"; readonly fields: readonly GeneratedTaskActionInputField[];
    readonly exactlyOneOf: readonly (readonly string[])[] };
  readonly explain: string;
  readonly execution: Pick<NonNullable<EntityActionContract["execution"]>, "ingress" | "topology"> & {
    readonly lifecycle: Pick<NonNullable<NonNullable<EntityActionContract["execution"]>["lifecycle"]>,
      "transitionId" | "commandType" | "targetIdField" | "coordination"> };
}
interface GeneratedTaskActionProtocolProjection {
  readonly writeReceiptFields: readonly string[];
  readonly taskCreateResultFields: readonly string[];
  readonly actions: readonly GeneratedTaskActionProtocolDeclaration[];
}

// task-action-projection:generated:start
const TASK_ACTION_DESCRIPTOR_PROJECTION_BROTLI = [
  "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",
].join("");
const taskActionDescriptorProjection = JSON.parse(
  brotliDecompressSync(Buffer.from(TASK_ACTION_DESCRIPTOR_PROJECTION_BROTLI, "base64")).toString("utf8"),
) as GeneratedTaskActionProtocolProjection;
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
    const cli = field.cli;
    return [
      cliInput(cli.name, cli.kind, field.required, cli.error, {
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
      const value =
          input.kind === "boolean"
            ? input.name
            : `${input.name} <${input.enum?.join("|") ?? input.name.slice(2)}>${input.kind === "repeated" && input.required ? "..." : ""}`,
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
