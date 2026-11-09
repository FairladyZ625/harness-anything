import type { EntityJsonSchemaNode } from "./entity-json-schema.ts";

/** A project declaration; omitting agent applies the rule to every runtime in this repository. */
export type CommandInterception =
  | {
      readonly id: string;
      readonly pattern: string;
      readonly agent?: string;
    }
  | {
      readonly id: string;
      /** One exact command admitted to Claude workspace-write for this repository and optional Agent. */
      readonly approvedCommand: string;
      readonly agent?: string;
    };
export const commandInterceptionsSchema = {
  type: "array",
  "x-unique-by": "id",
  items: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      pattern: { type: "string", minLength: 1 },
      approvedCommand: { type: "string", minLength: 1 },
      agent: { type: "string", minLength: 1 },
    },
    required: ["id"],
    additionalProperties: false,
  },
} as const satisfies EntityJsonSchemaNode;

/** JSON Schema checks shape; the authoring boundary checks the exclusive variant and executable syntax. */
export function commandInterceptionIssues(rules: readonly CommandInterception[]): readonly string[] {
  return rules.flatMap((rule) => {
    const hasPattern = "pattern" in rule,
      hasApprovedCommand = "approvedCommand" in rule,
      label = `settings.runtime.commandInterceptions.${rule.id}`;
    if (hasPattern === hasApprovedCommand) return [`${label}: exactly one of pattern or approvedCommand is required.`];
    if ("approvedCommand" in rule) {
      const command = rule.approvedCommand;
      return validApprovedCommand(command) ? [] : [`${label}: runtime_approved_command_invalid.`];
    }
    try {
      new RegExp(rule.pattern, "u");
      return [];
    } catch (error) {
      return [`${label}: ${String(error)}`];
    }
  });
}

function validApprovedCommand(command: string): boolean {
  if (!command.trim() || command.length > 4096 || /[\u0000-\u001f\u007f*]/u.test(command)) return false;
  let quote: "single" | "double" | null = null,
    escaped = false;
  for (const character of command) {
    if (quote === "single") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (character === "$" || character === "`" || character === "\\") return false;
      if (character === '"') quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if ([";", "&", "|", "<", ">", "`", "(", ")", "$", "\\", "*", "?", "[", "]", "{", "}"].includes(character))
      return false;
  }
  return quote === null && !escaped;
}
