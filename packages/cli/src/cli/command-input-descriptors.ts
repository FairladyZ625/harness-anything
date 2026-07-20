import type { CommandKind, CommandDescriptor } from "./command-registry.ts";
import type { CommandDescriptorIdentity } from "./command-spec/types.ts";

export type JsonSchemaType = "string" | "number" | "boolean" | "array" | "object";
export type ShortcutMerge = "set" | "append";

export interface CommandInputShortcut {
  readonly flag: string;
  readonly path: string;
  readonly merge: ShortcutMerge;
  readonly description: string;
}

export interface CommandInputSchema {
  readonly schema: "json-schema";
  readonly schemaId: string;
  readonly type: "object";
  readonly required: ReadonlyArray<string>;
  readonly properties: Record<string, {
    readonly type: JsonSchemaType | ReadonlyArray<JsonSchemaType>;
    readonly description: string;
    readonly items?: { readonly type: JsonSchemaType } | { readonly type: "object"; readonly properties: Record<string, unknown> };
  }>;
}

export interface CommandInputDescriptor {
  readonly commandKind: CommandKind;
  readonly entity: string;
  readonly action: string;
  readonly input: CommandInputSchema;
  readonly shortcuts: ReadonlyArray<CommandInputShortcut>;
}

const explicitInputDescriptors = {
  "new-task": {
    required: ["title"],
    properties: {
      title: { type: "string", description: "Task title used for package metadata and slug." },
      workKind: { type: "string", description: "Task work kind: feat, fix, refactor, docs, test, or chore." },
      riskTier: { type: "string", description: "Task risk tier: low, medium, or high. Explicit task values override one-time derives-edge seeding." },
      urgency: { type: "string", description: "Task urgency: low, medium, or high. Explicit task values override one-time derives-edge seeding." },
      vertical: { type: "string", description: "Vertical id, usually software/coding." },
      preset: { type: "string", description: "Preset id used to materialize task content." },
      moduleKey: { type: "string", description: "Registered module key." },
      slug: { type: "string", description: "Explicit task package slug." },
      locale: { type: "string", description: "Generated content locale." },
      longRunning: { type: "boolean", description: "Use the long-running task preset." },
      dryRun: { type: "boolean", description: "Preview task creation without writing files." }
    },
    shortcuts: [
      shortcut("--title", "$.title", "set"),
      shortcut("--kind", "$.workKind", "set"),
      shortcut("--risk-tier", "$.riskTier", "set"),
      shortcut("--urgency", "$.urgency", "set"),
      shortcut("--vertical", "$.vertical", "set"),
      shortcut("--preset", "$.preset", "set"),
      shortcut("--module", "$.moduleKey", "set"),
      shortcut("--slug", "$.slug", "set"),
      shortcut("--locale", "$.locale", "set"),
      shortcut("--long-running", "$.longRunning", "set"),
      shortcut("--dry-run", "$.dryRun", "set")
    ]
  },
  "decision-propose": {
    required: ["title", "question", "chosen", "rejected"],
    properties: {
      decisionId: { type: "string", description: "Optional stable decision id." },
      title: { type: "string", description: "Human-readable decision title." },
      question: { type: "string", description: "The decision question being answered." },
      chosen: { type: ["string", "array"], description: "Chosen option text, or an array of chosen option objects.", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, load_bearing: { type: "boolean" } } } },
      rejected: { type: ["string", "array"], description: "Rejected option text, or an array of rejected option objects with why_not.", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, why_not: { type: "string" } } } },
      why_not: { type: "string", description: "Canonical rationale for rejecting a string alternative." },
      whyNot: { type: "string", description: "Legacy camelCase alias for why_not." },
      claim: { type: "string", description: "Optional supporting claim." },
      claims: { type: "array", description: "Supporting claims born with the decision.", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, load_bearing: { type: "boolean" }, fulfillment: { type: "string" } } } },
      fulfillments: { type: "array", description: "Explicit claim fulfillment declarations as claim-id:mode.", items: { type: "string" } },
      riskTier: { type: "string", description: "Decision risk tier: low, medium, or high." },
      urgency: { type: "string", description: "Decision urgency: low, medium, or high." },
      modules: { type: "array", description: "Module keys the decision applies to.", items: { type: "string" } },
      productLines: { type: "array", description: "Product-line keys the decision applies to.", items: { type: "string" } },
      evidenceRelations: { type: "array", description: "Typed evidence relation inputs.", items: { type: "object", properties: { anchor: { type: "string" }, type: { type: "string" }, target: { type: "string" }, rationale: { type: "string" } } } },
      body: { type: "string", description: "Optional decision body markdown." },
      bodyFile: { type: "string", description: "Optional path to decision body markdown; mutually exclusive with body." },
      dryRun: { type: "boolean", description: "Preview the decision write without writing files." }
    },
    shortcuts: [
      shortcut("--title", "$.title", "set"),
      shortcut("--question", "$.question", "set"),
      shortcut("--chosen", "$.chosen", "set"),
      shortcut("--rejected", "$.rejected", "set"),
      shortcut("--why-not", "$.why_not", "set"),
      shortcut("--why-not", "$.whyNot", "set"),
      shortcut("--claim", "$.claim", "set"),
      shortcut("--claim", "$.claims", "append"),
      shortcut("--fulfillment", "$.fulfillments", "append"),
      shortcut("--risk-tier", "$.riskTier", "set"),
      shortcut("--urgency", "$.urgency", "set"),
      shortcut("--module", "$.modules", "append"),
      shortcut("--product-line", "$.productLines", "append"),
      shortcut("--evidence-relation", "$.evidenceRelations", "append"),
      shortcut("--body", "$.body", "set"),
      shortcut("--body-file", "$.bodyFile", "set"),
      shortcut("--dry-run", "$.dryRun", "set")
    ]
  },
  "record-fact": {
    required: ["taskId", "statement"],
    properties: {
      taskId: { type: "string", description: "Task id that owns the fact." },
      statement: { type: "string", description: "Fact statement text." },
      source: { type: "string", description: "Evidence source path or command." },
      observedAt: { type: "string", description: "Observation timestamp." },
      confidence: { type: "string", description: "Fact confidence: low, medium, or high." },
      memoryClass: { type: "string", description: "Memory class: semantic, episodic, or procedural." },
      memoryTags: { type: "array", description: "Memory tags.", items: { type: "string" } },
      dryRun: { type: "boolean", description: "Preview the fact write without writing files." }
    },
    shortcuts: [
      shortcut("--task", "$.taskId", "set"),
      shortcut("--statement", "$.statement", "set"),
      shortcut("--source", "$.source", "set"),
      shortcut("--observed-at", "$.observedAt", "set"),
      shortcut("--confidence", "$.confidence", "set"),
      shortcut("--memory-class", "$.memoryClass", "set"),
      shortcut("--memory-tag", "$.memoryTags", "append"),
      shortcut("--dry-run", "$.dryRun", "set")
    ]
  },
  "task-submit": {
    required: ["completionClaim", "deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks"],
    properties: {
      completionClaim: { type: "string", description: "Required completion claim." },
      deliverables: { type: "array", description: "Submission deliverables.", items: { type: "string" } },
      outputs: { type: "array", description: "Inline OutputEvidence text.", items: { type: "string" } },
      verificationNotes: { type: "array", description: "Verification notes.", items: { type: "string" } },
      knownGaps: { type: "array", description: "Known gaps.", items: { type: "string" } },
      residualRisks: { type: "array", description: "Residual risks.", items: { type: "string" } },
      executionId: { type: "string", description: "Optional active Execution id; inferred from Holder V2 when omitted." },
      leaseToken: { type: "string", description: "Optional lease token; the active local actor may omit it." },
      codeDoc: { type: "object", description: "Optional code-doc reconciliation input." }
    },
    shortcuts: []
  },
  "task-closeout": {
    required: ["completionClaim", "verdict", "findings", "rationale", "ci"],
    properties: {
      completionClaim: { type: "string", description: "Human-authored completion claim submitted with the active Execution." },
      deliverables: { type: "array", description: "Submission deliverables; defaults to an empty list.", items: { type: "string" } },
      outputs: { type: "array", description: "Inline OutputEvidence text; defaults to an empty list.", items: { type: "string" } },
      verificationNotes: { type: "array", description: "Verification notes; defaults to an empty list.", items: { type: "string" } },
      knownGaps: { type: "array", description: "Known gaps; defaults to an empty list.", items: { type: "string" } },
      residualRisks: { type: "array", description: "Residual risks; defaults to an empty list.", items: { type: "string" } },
      executionId: { type: "string", description: "Optional active Execution id; Holder V2 and the sole submitted round are used when omitted." },
      leaseToken: { type: "string", description: "Optional one-time Holder V2 lease token." },
      verdict: { type: "string", description: "Human Review verdict." },
      findings: { type: "string", description: "Human Review findings." },
      rationale: { type: "string", description: "Human Review rationale." },
      evidenceChecked: { type: "array", description: "Inspected OutputEvidence ids.", items: { type: "string" } },
      archiveWarningsAcknowledged: { type: "boolean", description: "Explicit acknowledgement of archive warnings." },
      consentId: { type: "string", description: "Existing human consent id." },
      consentUtterance: { type: "string", description: "Human's exact approval words." },
      consentStandingPolicyDecisionId: { type: "string", description: "Active decision granting standing consent." },
      consentAssertedRationale: { type: "string", description: "Rationale for externally obtained consent." },
      consentActions: { type: "array", description: "Consent actions granted by the human.", items: { type: "string" } },
      ci: { type: "string", description: "Human-supplied CI result: passed or failed." },
      commit: { type: "string", description: "Git ref resolved to a full SHA; defaults to HEAD." },
      paths: { type: "array", description: "Optional repository-relative code-doc anchors.", items: { type: "string" } },
      prRef: { type: "string", description: "Optional pull request reference." },
      forceCodeDoc: { type: "boolean", description: "Replace an existing code-doc reconciliation through the original force gate." },
      reviewerId: { type: "string", description: "Completion reviewer id." }
    },
    shortcuts: [
      shortcut("--execution-id", "$.executionId", "set"),
      shortcut("--lease-token", "$.leaseToken", "set"),
      shortcut("--commit", "$.commit", "set"),
      shortcut("--reviewer", "$.reviewerId", "set")
    ]
  },
  "task-review-execution": {
    required: ["verdict", "findings", "rationale"],
    properties: {
      executionId: { type: "string", description: "Submitted Execution id; inferred only when exactly one submitted round exists." },
      verdict: { type: "string", description: "Review verdict: approved, changes_requested, or dismissed." },
      findings: { type: "string", description: "Reviewer findings." },
      rationale: { type: "string", description: "Reviewer semantic rationale." },
      evidenceChecked: { type: "array", description: "Inspected OutputEvidence ids.", items: { type: "string" } },
      archiveWarningsAcknowledged: { type: "boolean", description: "Explicit acknowledgement of archive warnings." },
      consentId: { type: "string", description: "Existing content-pinned human consent id." },
      consentUtterance: { type: "string", description: "Human's exact approval words; never defaulted." },
      consentStandingPolicyDecisionId: { type: "string", description: "Existing active decision used as standing authorization." },
      consentAssertedRationale: { type: "string", description: "Explicit rationale for externally obtained, unverified approval." },
      consentActions: { type: "array", description: "Explicit human consent actions.", items: { type: "string" } }
    },
    shortcuts: [
      shortcut("--execution-id", "$.executionId", "set"),
      shortcut("--verdict", "$.verdict", "set"),
      shortcut("--findings", "$.findings", "set"),
      shortcut("--rationale", "$.rationale", "set"),
      shortcut("--evidence-checked", "$.evidenceChecked", "append"),
      shortcut("--acknowledge-archive-warnings", "$.archiveWarningsAcknowledged", "set"),
      shortcut("--consent", "$.consentId", "set"),
      shortcut("--consent-utterance", "$.consentUtterance", "set"),
      shortcut("--consent-standing-policy", "$.consentStandingPolicyDecisionId", "set"),
      shortcut("--consent-asserted", "$.consentAssertedRationale", "set"),
      shortcut("--consent-action", "$.consentActions", "append")
    ]
  },
  "runtime-event-append": {
    required: ["sessionId", "eventKind"],
    properties: {
      sessionId: { type: "string", description: "Runtime session id." },
      eventKind: { type: "string", description: "Runtime event kind." },
      runtime: { type: "string", description: "Runtime id." },
      eventId: { type: "string", description: "Optional event id." },
      recordedAt: { type: "string", description: "Event timestamp." },
      taskId: { type: "string", description: "Related task id." },
      turnId: { type: "string", description: "Related turn id." },
      stepId: { type: "string", description: "Related step id." },
      toolName: { type: "string", description: "Tool name for tool events." },
      approval: { type: "string", description: "Approval decision." },
      interrupt: { type: "string", description: "Interrupt action." },
      result: { type: "string", description: "Result status." },
      summary: { type: "string", description: "Short event summary." },
      totalTokens: { type: "number", description: "Total token count." }
    },
    shortcuts: [
      shortcut("--session", "$.sessionId", "set"),
      shortcut("--kind", "$.eventKind", "set"),
      shortcut("--runtime", "$.runtime", "set"),
      shortcut("--id", "$.eventId", "set"),
      shortcut("--at", "$.recordedAt", "set"),
      shortcut("--task", "$.taskId", "set"),
      shortcut("--turn", "$.turnId", "set"),
      shortcut("--step", "$.stepId", "set"),
      shortcut("--tool", "$.toolName", "set"),
      shortcut("--approval", "$.approval", "set"),
      shortcut("--interrupt", "$.interrupt", "set"),
      shortcut("--result", "$.result", "set"),
      shortcut("--summary", "$.summary", "set"),
      shortcut("--total-tokens", "$.totalTokens", "set")
    ]
  }
} as const satisfies Partial<Record<CommandKind, {
  readonly required: ReadonlyArray<string>;
  readonly properties: CommandInputSchema["properties"];
  readonly shortcuts: ReadonlyArray<CommandInputShortcut>;
}>>;

export function commandInputDescriptorFor(command: CommandDescriptor): CommandInputDescriptor {
  const explicit = (explicitInputDescriptors as Partial<Record<CommandKind, {
    readonly required: ReadonlyArray<string>;
    readonly properties: CommandInputSchema["properties"];
    readonly shortcuts: ReadonlyArray<CommandInputShortcut>;
  }>>)[command.kind];
  const entity = entityForCommand(command);
  const action = actionForCommand(command, entity);
  const fallbackShortcuts = command.options.map((option) => shortcut(option.flag, `$.${fieldNameForFlag(option.flag)}`, "set", option.description));
  const fallbackProperties = Object.fromEntries(fallbackShortcuts.map((entry) => [
    jsonPathLeaf(entry.path),
    { type: "string", description: entry.description }
  ])) as CommandInputSchema["properties"];
  return {
    commandKind: command.kind,
    entity,
    action,
    input: {
      schema: "json-schema",
      schemaId: `harness://schema/cli/${command.kind}-input/v1`,
      type: "object",
      required: explicit?.required ?? [],
      properties: explicit?.properties ?? fallbackProperties
    },
    shortcuts: explicit?.shortcuts ?? fallbackShortcuts
  };
}

export function entityForCommand(command: CommandDescriptorIdentity): string {
  const first = commandPath(command)[0] ?? command.kind.split("-")[0] ?? "command";
  if (command.kind === "decision-relation-retire" || command.kind === "decision-relation-replace") return "relation";
  if (command.kind === "new-task" || first === "task") return "task";
  if (command.kind === "record-fact" || first === "fact") return "fact";
  if (first === "event") return "event";
  return first;
}

export function actionForCommand(command: CommandDescriptorIdentity, entity = entityForCommand(command)): string {
  const path = commandPath(command);
  if (path[0] === entity && path[1]) return path.slice(1).join(" ");
  if (command.kind === "new-task") return "create";
  if (command.kind === "record-fact") return "record";
  return path.slice(1).join(" ") || command.kind.replace(`${entity}-`, "");
}

export function commandPath(command: CommandDescriptorIdentity): ReadonlyArray<string> {
  const tokens = command.usage.split(/\s+/u);
  const pathTokens: string[] = [];
  for (const token of tokens) {
    if (!token || token.startsWith("[") || token.startsWith("(") || token.startsWith("<") || token.startsWith("--") || token.includes("|")) break;
    pathTokens.push(token);
  }
  return pathTokens;
}

function shortcut(flag: string, path: string, merge: ShortcutMerge, description = ""): CommandInputShortcut {
  return { flag, path, merge, description };
}

function fieldNameForFlag(flag: string): string {
  return flag.replace(/^--/u, "").replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function jsonPathLeaf(path: string): string {
  return path.replace(/^\$\./u, "").split(".").at(-1) ?? path;
}
