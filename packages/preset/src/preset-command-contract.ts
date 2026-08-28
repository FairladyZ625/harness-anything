export interface CliInputError {
  readonly code: string;
  readonly nextAction: string;
}
export type CommandAdmissionRoute = "direct" | "via-assignment" | "via-center-forward" | "rejected";
export type CommandAdmission = Readonly<Record<"local" | "remote-center" | "remote-edge", CommandAdmissionRoute>>;
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
    admission: Object.freeze({ local: "direct", "remote-center": center, "remote-edge": edge }),
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
  readonly format?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly lengthUnit?: "characters" | "bytes";
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly unique?: boolean;
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
    input.required ? "required" : "optional",
    input.kind === "repeated" ? "repeatable" : input.kind === "boolean" ? "flag" : "value",
  ];
  if (input.enum) facts.push(`values: ${input.enum.join(", ")}`);
  if (input.jsonFields) facts.push(`JSON required fields: ${input.jsonFields.join(", ") || "none"}`);
  if (input.jsonAllowedFields) facts.push(`JSON accepted fields: ${input.jsonAllowedFields.join(", ")}`);
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
  if (input.requires?.length) facts.push(`requires: ${input.requires.join(", ")}`);
  if (input.requiresAny?.length) facts.push(`requires one of: ${input.requiresAny.join(", ")}`);
  if (input.conflictsWith?.length) facts.push(`mutually exclusive with: ${input.conflictsWith.join(", ")}`);
  if (parameterRelationHint(input.error.nextAction)) facts.push(`relation: ${input.error.nextAction}`);
  return `${input.name} — ${facts.join("; ")}`;
}
export function cliCommandHelp(inputs: readonly CliInputFacet[]): string {
  return inputs.map((input) => `    ${cliInputHelp(input)}`).join("\n");
}
export const taskCreateJsonFields = Object.freeze([
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
  "relations",
  "taskClass",
  "locale",
  "fromLegacyId",
  "createMode",
] as const);
export const taskSubmissionJsonFields = Object.freeze([
  "completionClaim",
  "deliverables",
  "outputs",
  "verificationNotes",
  "knownGaps",
  "residualRisks",
  "commitSha",
] as const);
export const reviewJsonFields = Object.freeze(["verdict", "reason", "evidenceChecked"] as const);
export const consentJsonFields = Object.freeze(["reviewDigest", "contentDigest"] as const);
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
  "relations",
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
    summary: "Create a task package with its complete metadata and initial relations.",
    method: "repo.task.create",
    inputs: [
      cliInput(
        "--title",
        "single",
        false,
        {
          code: "missing_field",
          nextAction: "Add --title <title>, provide it in structured input, or select --from-legacy <id>.",
        },
        { field: "title" },
      ),
      cliInput(
        "--id",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --id only with exactly one of --migration, --import, or --admin." },
        { field: "taskId" },
      ),
      cliInput(
        "--idempotency-key",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use one stable non-empty --idempotency-key." },
        { field: "idempotencyKey" },
      ),
      cliInput(
        "--parent",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use an existing task id for --parent." },
        { field: "parentTaskId" },
      ),
      cliInput(
        "--kind",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use feat, fix, refactor, docs, test, or chore for --kind." },
        { field: "workKind", enum: ["feat", "fix", "refactor", "docs", "test", "chore"] },
      ),
      cliInput(
        "--risk-tier",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use low, medium, or high for --risk-tier." },
        { field: "riskTier", enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--urgency",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use low, medium, or high for --urgency." },
        { field: "urgency", enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--from-file",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use exactly one structured input source: --from-file or --json-input." },
        {
          field: "fromFile",
          jsonFields: ["title"],
          jsonAllowedFields: taskCreateJsonFields,
          conflictsWith: ["--json-input"],
        },
      ),
      cliInput(
        "--json-input",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use exactly one structured input source: --from-file or --json-input." },
        {
          field: "jsonInput",
          jsonFields: ["title"],
          jsonAllowedFields: taskCreateJsonFields,
          conflictsWith: ["--from-file"],
        },
      ),
      cliInput(
        "--vertical",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use software/coding or another installed vertical id." },
        { field: "verticalId" },
      ),
      cliInput(
        "--preset",
        "single",
        false,
        { code: "invalid_field", nextAction: "Run ha preset list --json and choose an available preset id." },
        { field: "presetId" },
      ),
      cliInput(
        "--profile",
        "single",
        false,
        { code: "invalid_field", nextAction: "Choose a profile declared by the selected preset." },
        { field: "profileId" },
      ),
      cliInput(
        "--module",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use a registered module key or provide the complete --register-module field group.",
        },
        { field: "moduleKey" },
      ),
      cliInput(
        "--register-module",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Provide --register-module, --module-title, --module-prefix, and --module-scope together.",
        },
        { field: "registerModuleKey" },
      ),
      cliInput(
        "--module-title",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Provide --register-module, --module-title, --module-prefix, and --module-scope together.",
        },
        { field: "moduleTitle" },
      ),
      cliInput(
        "--module-prefix",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Provide --register-module, --module-title, --module-prefix, and --module-scope together.",
        },
        { field: "modulePrefix" },
      ),
      cliInput(
        "--module-scope",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Provide --register-module, --module-title, --module-prefix, and --module-scope together.",
        },
        { field: "moduleScope" },
      ),
      cliInput(
        "--slug",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use a lowercase kebab-case task slug." },
        { field: "slug", regex: "^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$" },
      ),
      cliInput(
        "--surface",
        "repeated",
        false,
        { code: "invalid_field", nextAction: "Use a non-empty command, flag, file path, or identifier for --surface." },
        { field: "surfaces" },
      ),
      cliInput(
        "--relation",
        "repeated",
        false,
        {
          code: "invalid_field",
          nextAction: "Use --relation <type>:<entity-ref>:<rationale>; for example depends-on:task/task_id:reason.",
        },
        { field: "relations", regex: "^[a-z][a-z-]*:(?:task|decision|fact)/[^:]+:.+$" },
      ),
      cliInput(
        "--task-class",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use standard, milestone, epic, or long_running for --task-class." },
        { field: "taskClass", enum: ["standard", "milestone", "epic", "long_running"] },
      ),
      cliInput(
        "--dry-run",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use --dry-run once." },
        { field: "dryRun" },
      ),
      cliInput(
        "--locale",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use zh-CN or en-US for --locale." },
        { field: "locale", enum: ["zh-CN", "en-US"] },
      ),
      cliInput(
        "--from-legacy",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use one legacy task id for --from-legacy." },
        { field: "fromLegacyId" },
      ),
      cliInput(
        "--migration",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use exactly one of --migration, --import, or --admin with --id." },
        { field: "migration" },
      ),
      cliInput(
        "--import",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use exactly one of --migration, --import, or --admin with --id." },
        { field: "import" },
      ),
      cliInput(
        "--admin",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use exactly one of --migration, --import, or --admin with --id." },
        { field: "admin" },
      ),
    ],
  }),
  defineRepoReadCommand({
    id: "preset-list",
    phase: "Preset-A",
    path: ["preset", "list"],
    summary: "List effective preset packages and blocked shadows.",
    method: "repo.preset.list",
    inputs: [
      cliInput(
        "--vertical",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --vertical with a non-empty value." },
        { field: "verticalId" },
      ),
    ],
  }),
  defineRepoReadCommand({
    id: "preset-inspect",
    phase: "Preset-A",
    path: ["preset", "inspect", "<id>"],
    summary: "Inspect one resolved preset snapshot.",
    method: "repo.preset.inspect",
    positional: "presetId",
    inputs: [
      cliInput(
        "--profile",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --profile with a non-empty value." },
        { field: "profileId" },
      ),
      cliInput(
        "--vertical",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --vertical with a non-empty value." },
        { field: "verticalId" },
      ),
      cliInput(
        "--locale",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --locale with a non-empty value." },
        { field: "locale" },
      ),
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
      cliInput(
        "--vertical",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --vertical with a non-empty value." },
        { field: "verticalId" },
      ),
      cliInput(
        "--snapshot-digest",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use a sha256: preset snapshot digest." },
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
    inputs: [
      cliInput(
        "--source",
        "single",
        true,
        { code: "missing_field", nextAction: "--source is required." },
        { field: "packageSource" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "preset-install",
    phase: "Preset-A",
    path: ["preset", "install"],
    summary: "Install a whole package behind an atomic active pointer.",
    method: "repo.preset.install",
    inputs: [
      cliInput(
        "--source",
        "single",
        true,
        { code: "missing_field", nextAction: "--source is required." },
        { field: "packageSource" },
      ),
      cliInput(
        "--dry-run",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use --dry-run once." },
        { field: "dryRun" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "preset-seed",
    phase: "Preset-A",
    path: ["preset", "seed"],
    summary: "Seed bundled packages into user active pointers.",
    method: "repo.preset.seed",
    inputs: [
      cliInput(
        "--dry-run",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use --dry-run once." },
        { field: "dryRun" },
      ),
    ],
  }),
  defineRepoReadCommand({
    id: "preset-audit",
    phase: "Preset-A",
    path: ["preset", "audit"],
    summary: "Audit the effective preset inventory and its issues.",
    method: "repo.preset.audit",
    inputs: [
      cliInput(
        "--vertical",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --vertical with a non-empty value." },
        { field: "verticalId" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "preset-uninstall",
    phase: "Preset-A",
    path: ["preset", "uninstall", "<id>"],
    summary: "Remove only the user active pointer.",
    method: "repo.preset.uninstall",
    positional: "presetId",
    inputs: [
      cliInput(
        "--dry-run",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use --dry-run once." },
        { field: "dryRun" },
      ),
    ],
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
    inputs: [
      cliInput(
        "--source",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use software/coding; custom verticals are unavailable." },
        { field: "verticalSource" },
      ),
    ],
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
      cliInput(
        "--locale",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use zh-CN or en-US." },
        { field: "locale", enum: ["zh-CN", "en-US"] },
      ),
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
      cliInput(
        "--task",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --task with a non-empty value." },
        { field: "taskId" },
      ),
      cliInput(
        "--inputs",
        "single",
        false,
        { code: "invalid_field", nextAction: "--inputs must be a JSON object of string values." },
        { field: "inputs", codec: "json" },
      ),
      cliInput(
        "--dry-run",
        "boolean",
        false,
        { code: "invalid_field", nextAction: "Use --dry-run once." },
        { field: "dryRun" },
      ),
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
      cliInput(
        "--task",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --task with a non-empty value." },
        { field: "taskId" },
      ),
      cliInput(
        "--inputs",
        "single",
        false,
        { code: "invalid_field", nextAction: "--inputs must be a JSON object." },
        { field: "inputs", codec: "json" },
      ),
      cliInput(
        "--idempotency-key",
        "single",
        true,
        { code: "missing_field", nextAction: "--idempotency-key is required." },
        { field: "idempotencyKey" },
      ),
    ],
  }),
] as const);
const taskCreateRpcFields: RpcShape["fields"] = {
  title: "string?",
  taskId: "string?",
  idempotencyKey: "string?",
  parentTaskId: "string?",
  workKind: "string?",
  riskTier: "string?",
  urgency: "string?",
  fromFile: "string?",
  jsonInput: "string?",
  verticalId: "string?",
  presetId: "string?",
  profileId: "string?",
  moduleKey: "string?",
  registerModule: "json?",
  slug: "string?",
  surfaces: "array?",
  relations: "array?",
  taskClass: "string?",
  dryRun: "boolean?",
  locale: "string?",
  fromLegacyId: "string?",
  createMode: "string?",
};
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
