import type { CommandKind, CommandDescriptor } from "./command-registry.ts";

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
      rejected: { type: ["string", "array"], description: "Rejected option text, or an array of rejected option objects with why_not or whyNot.", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, why_not: { type: "string" }, whyNot: { type: "string" } } } },
      whyNot: { type: "string", description: "Rationale for rejecting the rejected option." },
      claim: { type: "string", description: "Optional supporting claim." },
      claims: { type: "array", description: "Supporting claims born with the decision.", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, load_bearing: { type: "boolean" } } } },
      riskTier: { type: "string", description: "Decision risk tier: low, medium, or high." },
      urgency: { type: "string", description: "Decision urgency: low, medium, or high." },
      proposedBy: { type: "string", description: "Actor ref such as agent:codex." },
      arbiter: { type: "string", description: "Arbiter actor ref such as human:ZeyuLi." },
      modules: { type: "array", description: "Module keys the decision applies to.", items: { type: "string" } },
      productLines: { type: "array", description: "Product-line keys the decision applies to.", items: { type: "string" } },
      evidenceRelations: { type: "array", description: "Typed evidence relation inputs.", items: { type: "object", properties: { anchor: { type: "string" }, type: { type: "string" }, target: { type: "string" }, rationale: { type: "string" } } } },
      body: { type: "string", description: "Optional decision body markdown." },
      dryRun: { type: "boolean", description: "Preview the decision write without writing files." }
    },
    shortcuts: [
      shortcut("--id", "$.decisionId", "set"),
      shortcut("--title", "$.title", "set"),
      shortcut("--question", "$.question", "set"),
      shortcut("--chosen", "$.chosen", "set"),
      shortcut("--rejected", "$.rejected", "set"),
      shortcut("--why-not", "$.whyNot", "set"),
      shortcut("--claim", "$.claim", "set"),
      shortcut("--claim", "$.claims", "append"),
      shortcut("--risk-tier", "$.riskTier", "set"),
      shortcut("--urgency", "$.urgency", "set"),
      shortcut("--proposed-by", "$.proposedBy", "set"),
      shortcut("--arbiter", "$.arbiter", "set"),
      shortcut("--module", "$.modules", "append"),
      shortcut("--product-line", "$.productLines", "append"),
      shortcut("--evidence-relation", "$.evidenceRelations", "append"),
      shortcut("--body", "$.body", "set"),
      shortcut("--dry-run", "$.dryRun", "set")
    ]
  },
  "record-fact": {
    required: ["taskId", "statement", "source"],
    properties: {
      taskId: { type: "string", description: "Task id that owns the fact." },
      factId: { type: "string", description: "Optional stable F-id." },
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
      shortcut("--id", "$.factId", "set"),
      shortcut("--statement", "$.statement", "set"),
      shortcut("--source", "$.source", "set"),
      shortcut("--observed-at", "$.observedAt", "set"),
      shortcut("--confidence", "$.confidence", "set"),
      shortcut("--memory-class", "$.memoryClass", "set"),
      shortcut("--memory-tag", "$.memoryTags", "append"),
      shortcut("--dry-run", "$.dryRun", "set")
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

export function entityForCommand(command: CommandDescriptor): string {
  const first = commandPath(command)[0] ?? command.kind.split("-")[0] ?? "command";
  if (command.kind === "decision-relation-retire" || command.kind === "decision-relation-replace") return "relation";
  if (command.kind === "new-task" || first === "task") return "task";
  if (command.kind === "record-fact" || first === "fact") return "fact";
  if (first === "event") return "event";
  return first;
}

export function actionForCommand(command: CommandDescriptor, entity = entityForCommand(command)): string {
  const path = commandPath(command);
  if (path[0] === entity && path[1]) return path.slice(1).join(" ");
  if (command.kind === "new-task") return "create";
  if (command.kind === "record-fact") return "record";
  return path.slice(1).join(" ") || command.kind.replace(`${entity}-`, "");
}

export function commandPath(command: CommandDescriptor): ReadonlyArray<string> {
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
