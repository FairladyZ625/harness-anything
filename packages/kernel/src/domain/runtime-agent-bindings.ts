import { ENTITY_ID_PATTERN, type EntityJsonSchemaNode } from "./entity-json-schema.ts";

export interface RuntimeAgentBinding {
  readonly agentId: string;
  readonly instance?: string;
  readonly preferredInstances?: readonly string[];
}

const slug = { type: "string", pattern: ENTITY_ID_PATTERN } as const;

export const runtimeAgentBindingsSchema = {
  type: "array",
  "x-unique-by": "agentId",
  items: {
    type: "object",
    required: ["agentId"],
    additionalProperties: false,
    properties: {
      agentId: slug,
      instance: slug,
      preferredInstances: { type: "array", items: slug, uniqueItems: true },
    },
  },
} as const satisfies EntityJsonSchemaNode;
