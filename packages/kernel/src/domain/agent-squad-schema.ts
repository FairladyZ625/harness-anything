import {
  EntitySchemaContractError,
  ENTITY_ID_PATTERN,
  parseEntityJsonSchema,
  serializeEntityJsonSchema,
  validateEntityJsonSchema,
  type EntityDocumentJsonSchema,
} from "./entity-json-schema.ts";

export interface AgentSkillDeclarationV1 {
  readonly id: string;
  readonly path: string;
}
export interface AgentFallbackDeclarationV1 {
  readonly chain: readonly { readonly instance: string; readonly model?: string }[];
  readonly backoff: { readonly baseMs: number; readonly maxMs: number };
}
export type AgentRole = "worker" | "commander";
export const agentStates = ["configured", "active", "retired"] as const;
export type AgentState = (typeof agentStates)[number];
export interface AgentDeclarationV1 {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly runtime_type: string;
  readonly role?: AgentRole;
  readonly model?: string;
  readonly skills?: readonly AgentSkillDeclarationV1[];
  readonly prompts?: readonly string[];
  readonly preset?: string;
  readonly fallback?: AgentFallbackDeclarationV1;
}
export interface SquadDeclarationV1 {
  readonly id: string;
  readonly name: string;
  readonly leader: string;
  readonly workers: readonly string[];
  readonly leaderTurnBudget: number;
  readonly roster: string;
}
export type AgentEntityKind = "agent" | "squad";

const nonEmptyString = (description: string) => ({ type: "string" as const, minLength: 1, description });
const slug = (description: string) => ({ type: "string" as const, pattern: ENTITY_ID_PATTERN, description });

export const AGENT_DECLARATION_V1_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "agent-declaration/v1",
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["schema", "id", "name", "instructions", "runtime_type"]),
  properties: Object.freeze({
    schema: { type: "string", const: "agent-declaration/v1", description: "Schema discriminator." },
    id: { ...slug("Stable Agent identity."), "x-error": "must be a lowercase entity slug." },
    name: nonEmptyString("Display name."),
    instructions: nonEmptyString("Agent instructions."),
    runtime_type: {
      ...slug("Required runtime kind."),
      "x-error": "must be a non-empty lowercase runtime identifier such as claude, codex, or opencode.",
    },
    role: {
      type: "string",
      enum: ["worker", "commander"],
      description: "Prompt discipline role.",
      "x-error": "must be worker or commander.",
    },
    model: { ...nonEmptyString("Optional model selection."), "x-error": "must be a non-empty string." },
    skills: {
      type: "array",
      "x-unique-by": "id",
      "x-error": "must be an array of unique {id, path} references with non-empty paths.",
      description: "Skill references.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "path"],
        properties: { id: slug("Skill identity."), path: nonEmptyString("Skill path.") },
      },
    },
    prompts: { type: "array", items: nonEmptyString("Prompt reference."), description: "Prompt references." },
    preset: nonEmptyString("Preset identity."),
    fallback: {
      type: "object",
      additionalProperties: false,
      required: ["chain", "backoff"],
      description: "Attempt-bound provider fallback policy.",
      properties: {
        chain: {
          type: "array",
          minItems: 1,
          description: "Ordered runtime instance and optional model candidates.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["instance"],
            properties: {
              instance: nonEmptyString("Runtime instance identity."),
              model: nonEmptyString("Optional model override for this candidate."),
            },
          },
        },
        backoff: {
          type: "object",
          additionalProperties: false,
          required: ["baseMs", "maxMs"],
          properties: {
            baseMs: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
              description: "Initial attempt backoff in milliseconds.",
            },
            maxMs: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
              description: "Maximum attempt backoff in milliseconds.",
            },
          },
        },
      },
    },
  }),
}) as EntityDocumentJsonSchema<AgentDeclarationV1>;

export const SQUAD_DECLARATION_V1_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "squad-declaration/v1",
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["schema", "id", "name", "leader", "workers", "leaderTurnBudget", "roster"]),
  properties: Object.freeze({
    schema: { type: "string", const: "squad-declaration/v1", description: "Schema discriminator." },
    id: { ...slug("Stable Squad identity."), "x-error": "must be a lowercase entity slug." },
    name: nonEmptyString("Display name."),
    leader: { ...slug("Leader Agent identity."), "x-error": "must be a lowercase Agent id." },
    workers: {
      type: "array",
      uniqueItems: true,
      "x-error": "must be an array of unique lowercase Agent ids.",
      items: slug("Worker Agent identity."),
      description: "Worker Agent identities.",
    },
    leaderTurnBudget: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Maximum leader turns in one Squad run, including the initial turn.",
      "x-error": "must be a positive integer.",
    },
    roster: nonEmptyString("Human-readable roster."),
  }),
}) as EntityDocumentJsonSchema<SquadDeclarationV1>;

export class AgentEntityContractError extends EntitySchemaContractError {
  constructor(message: string) {
    super(message);
    this.name = "AgentEntityContractError";
  }
}

export function validateAgentDeclarationV1(value: unknown): readonly string[] {
  const issues = [...validateEntityJsonSchema(AGENT_DECLARATION_V1_SCHEMA, value, "agent declaration")];
  if (entityRecord(value) && entityRecord(value.fallback) && entityRecord(value.fallback.backoff)) {
    const baseMs = value.fallback.backoff.baseMs,
      maxMs = value.fallback.backoff.maxMs;
    if (Number.isInteger(baseMs) && Number.isInteger(maxMs) && Number(maxMs) < Number(baseMs))
      issues.push('agent declaration field "fallback.backoff.maxMs" must be greater than or equal to baseMs.');
  }
  return issues;
}
export function validateSquadDeclarationV1(value: unknown): readonly string[] {
  return validateEntityJsonSchema(SQUAD_DECLARATION_V1_SCHEMA, value, "squad declaration");
}
export function parseAgentDeclarationV1(value: unknown): AgentDeclarationV1 {
  return parse(AGENT_DECLARATION_V1_SCHEMA, value, "agent declaration");
}
export function parseSquadDeclarationV1(value: unknown): SquadDeclarationV1 {
  return parse(SQUAD_DECLARATION_V1_SCHEMA, value, "squad declaration");
}
export function serializeAgentDeclarationV1(value: unknown): string {
  return serialize(AGENT_DECLARATION_V1_SCHEMA, value, "agent declaration");
}
export function serializeSquadDeclarationV1(value: unknown): string {
  return serialize(SQUAD_DECLARATION_V1_SCHEMA, value, "squad declaration");
}
export function isRuntimeTypeIdentifier(value: string): boolean {
  return new RegExp(ENTITY_ID_PATTERN, "u").test(value);
}
export function entitySlug(value: unknown): value is string {
  return typeof value === "string" && new RegExp(ENTITY_ID_PATTERN, "u").test(value);
}
export function entityNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function entityRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parse<T>(schema: EntityDocumentJsonSchema<T>, value: unknown, label: string): T {
  try {
    return parseEntityJsonSchema(schema, value, label);
  } catch (error) {
    throw new AgentEntityContractError(error instanceof Error ? error.message : String(error));
  }
}
function serialize<T>(schema: EntityDocumentJsonSchema<T>, value: unknown, label: string): string {
  try {
    return serializeEntityJsonSchema(schema, value, label);
  } catch (error) {
    throw new AgentEntityContractError(error instanceof Error ? error.message : String(error));
  }
}
