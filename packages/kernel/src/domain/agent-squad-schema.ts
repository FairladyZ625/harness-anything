import {
  EntitySchemaContractError,
  ENTITY_ID_PATTERN,
  parseEntityJsonSchema,
  serializeEntityJsonSchema,
  validateEntityJsonSchema,
  type EntityDocumentJsonSchema,
} from "./entity-json-schema.ts";
import { runtimeEffortValues, type RuntimeEffort } from "./runtime-effort.ts";

export { runtimeEffortValues, type RuntimeEffort };

export interface AgentSkillDeclarationV1 {
  readonly id: string;
  readonly path: string;
}
export type AgentRole = "worker" | "commander" | "reviewer";
export type AgentPermissionMode = "bypass" | "workspace-write" | "read-only";
export const agentStates = ["configured", "active", "retired"] as const;
export type AgentState = (typeof agentStates)[number];
export interface AgentRuntimeTargetV1 {
  readonly type: string;
  readonly model?: string;
  readonly effort?: RuntimeEffort;
}
export interface AgentDeclarationV1 {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly runtimes: readonly AgentRuntimeTargetV1[];
  readonly instance?: string;
  /** Ordered soft preference among the instances one runtimes row admits; unlike `instance` it
   *  never fails a dispatch when a more preferred instance is unavailable on this node. */
  readonly preferredInstances?: readonly string[];
  readonly permissionMode?: AgentPermissionMode;
  readonly role?: AgentRole;
  readonly skills?: readonly AgentSkillDeclarationV1[];
  readonly prompts?: readonly string[];
  readonly preset?: string;
}
export interface SquadDeclarationV1 {
  readonly id: string;
  readonly name: string;
  readonly leader: string;
  readonly workers: readonly string[];
  /** Whole-run limit: the initial planning turn plus every callback and retry turn. */
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
  required: Object.freeze(["schema", "id", "name", "instructions", "runtimes"]),
  properties: Object.freeze({
    schema: { type: "string", const: "agent-declaration/v1", description: "Schema discriminator." },
    id: { ...slug("Stable Agent identity."), "x-error": "must be a lowercase entity slug." },
    name: nonEmptyString("Display name."),
    instructions: nonEmptyString("Agent instructions."),
    runtimes: {
      type: "array",
      "x-unique-by": "type",
      description:
        "Runtime kinds this Agent may dispatch to, each bound to the model used on that kind. " +
        "An empty array means any compatible runtime kind.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: {
            ...slug("Runtime kind identifier."),
            "x-error": "must be a non-empty lowercase runtime identifier such as claude, codex, or opencode.",
          },
          model: {
            ...nonEmptyString("Model used on this runtime kind; omit to use the instance default."),
            "x-error": "must be a non-empty string.",
          },
          effort: {
            type: "string",
            enum: runtimeEffortValues,
            description: "Reasoning effort for this runtime kind; omit to use the instance default.",
            "x-error": `must be ${runtimeEffortValues.join(", ")}.`,
          },
        },
      },
    },
    instance: {
      ...slug("Optional node-local runtime instance selection."),
      "x-error": "must be a lowercase instance id.",
    },
    preferredInstances: {
      type: "array",
      uniqueItems: true,
      description:
        "Ordered instance preference for the runtimes rows this Agent declares. A preferred instance " +
        "is used when it is enabled, compatible, and ready on this node; otherwise dispatch falls " +
        "back to the remaining compatible instances by runtime row, then repository allowed-instance " +
        "order. Unlike `instance`, this never blocks a dispatch on this node.",
      items: {
        ...slug("Preferred runtime instance id."),
        "x-error": "must be lowercase instance ids.",
      },
      "x-error": "must be an ordered array of unique lowercase instance ids.",
    },
    permissionMode: {
      type: "string",
      enum: ["bypass", "workspace-write", "read-only"],
      description: "Default unattended permission mode.",
      "x-error": "must be bypass, workspace-write, or read-only.",
    },
    role: {
      type: "string",
      enum: ["worker", "commander", "reviewer"],
      description: "Prompt discipline role.",
      "x-error": "must be worker, commander, or reviewer.",
    },
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
      description: "Maximum leader turns in one Squad run, including the initial, callback, and retry turns.",
      "x-error": "must be a positive integer.",
    },
    roster: nonEmptyString(
      "Human-readable roster. Synthesis report paths for Squad runs must contain {squadRunId}, for example artifacts/reports/{squadRunId}.md.",
    ),
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
const runtimeKindIdentifierPattern = new RegExp(ENTITY_ID_PATTERN, "u");
export function entitySlug(value: unknown): value is string {
  return typeof value === "string" && runtimeKindIdentifierPattern.test(value);
}
export function entityNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

/** A compile hook only ever sees text a prepared Agent or Squad action already validated upstream. */
export function requiredPreparedText(entity: "Agent" | "Squad", value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Prepared ${entity} ${field} is required.`);
  return value;
}
