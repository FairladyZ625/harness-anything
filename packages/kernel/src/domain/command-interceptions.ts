import type { EntityJsonSchemaNode } from "./entity-json-schema.ts";

/** A project declaration; omitting agent applies the rule to every runtime in this repository. */
export interface CommandInterception {
  readonly id: string;
  readonly pattern: string;
  readonly agent?: string;
}

export const commandInterceptionsSchema = {
  type: "array",
  "x-unique-by": "id",
  items: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      pattern: { type: "string", minLength: 1 },
      agent: { type: "string", minLength: 1 },
    },
    required: ["id", "pattern"],
    additionalProperties: false,
  },
} as const satisfies EntityJsonSchemaNode;

/** JSON Schema checks shape; the authoring boundary also checks executable regex syntax. */
export function commandInterceptionPatternIssues(rules: readonly CommandInterception[]): readonly string[] {
  return rules.flatMap((rule) => {
    try {
      new RegExp(rule.pattern, "u");
      return [];
    } catch (error) {
      return [`settings.runtime.commandInterceptions.${rule.id}: ${String(error)}`];
    }
  });
}
