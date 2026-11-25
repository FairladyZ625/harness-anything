import {
  EntitySchemaContractError,
  ENTITY_ID_PATTERN,
  parseEntityJsonSchema,
  serializeEntityJsonSchema,
  validateEntityJsonSchema,
  type EntityDocumentJsonSchema,
} from "./entity-json-schema.ts";
import { runtimeEffortValues, type RuntimeEffort } from "./runtime-effort.ts";
import { runtimeSelectionStrategies, type RuntimeSelectionStrategy } from "./runtime-instance-scheduling.ts";
import type { OntologyPolicyDeclaration } from "./ontology-source.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { canonicalizeContractValue } from "./task.ts";

export { runtimeEffortValues, type RuntimeEffort };

export interface AgentSkillDeclarationV1 {
  readonly id: string;
  readonly path: string;
}
export type AgentRole = "worker" | "commander" | "reviewer";
export type AgentPermissionMode = "bypass" | "workspace-write" | "read-only";
const agentMcpPolicies = ["disabled", "inherit"] as const;
export type AgentMcpPolicy = (typeof agentMcpPolicies)[number];
/** Which host tools and services the dispatch prompt lets this Agent use; distinct from a runtime
 *  instance's `isolation`, which governs only the provider state directory.
 *  `operator` is the only definition of the undeclared default; every surface resolves through it. */
const agentHostAccessValues = ["isolated", "operator", "bypass"] as const;
export type AgentHostAccess = (typeof agentHostAccessValues)[number];
export const DEFAULT_AGENT_HOST_ACCESS: AgentHostAccess = "operator";
export function resolveAgentHostAccess(hostAccess: AgentHostAccess | undefined): {
  readonly hostAccess: AgentHostAccess;
  readonly hostAccessSource: "declared" | "default";
} {
  return hostAccess === undefined
    ? { hostAccess: DEFAULT_AGENT_HOST_ACCESS, hostAccessSource: "default" }
    : { hostAccess, hostAccessSource: "declared" };
}
export const agentStates = ["configured", "active", "retired"] as const;
export type AgentState = (typeof agentStates)[number];
export interface AgentRuntimeTargetV1 {
  readonly type: string;
  readonly model?: string;
  readonly effort?: RuntimeEffort;
}
export type AgentScope = "local" | "shared";
const DEFAULT_AGENT_SCOPE: AgentScope = "shared";

/** Missing scope on historical declarations resolves to shared without mutating stored JSON. */
export function resolveAgentScope(scope: AgentScope | undefined): AgentScope {
  return scope ?? DEFAULT_AGENT_SCOPE;
}

export interface LocalAgentTransferIntent {
  readonly direction: "share" | "unshare";
  readonly operationId: string;
  readonly sourceRevision: number;
  readonly targetScope: AgentScope;
  readonly declarationSha256: string;
}

export interface LocalAgentRecordV1 {
  readonly schema: "local-agent-record/v1";
  readonly id: string;
  readonly revision: number;
  readonly declaration: AgentDeclarationV1;
  readonly pendingTransfer?: LocalAgentTransferIntent;
}

export interface LocalAgentWriteOptions {
  readonly expectedVersion?: number;
  readonly pendingTransfer?: LocalAgentTransferIntent | null;
  /** When true, updates transfer metadata without advancing the declaration revision. */
  readonly preserveRevision?: boolean;
}

export interface LocalAgentStorePort {
  readonly list: () => readonly LocalAgentRecordV1[];
  readonly get: (agentId: string) => LocalAgentRecordV1 | null;
  readonly write: (declaration: AgentDeclarationV1, options?: LocalAgentWriteOptions) => number;
  readonly remove: (agentId: string, options?: { readonly expectedVersion?: number }) => boolean;
}

/** Scope-independent content digest of an Agent declaration so transfer retries match across scopes. */
export function agentDeclarationContentDigest(declaration: AgentDeclarationV1): string {
  const { scope: _scope, ...withoutScope } = declaration;
  return `sha256:${sha256Text(stableStringify(canonicalizeContractValue(withoutScope)))}`;
}

/**
 * Determines whether a local declaration and a shared canonical record represent the same
 * in-flight or interrupted scope transfer (including GUI publish with concurrent draft edits
 * recorded on `pendingTransfer.declarationSha256`).
 */
export function localDeclarationMatchesSharedValue(
  local: AgentDeclarationV1,
  sharedValue: unknown,
  pendingTransfer?: LocalAgentTransferIntent,
): boolean {
  if (typeof sharedValue !== "object" || sharedValue === null || Array.isArray(sharedValue)) return false;
  const {
    lifecycleState: _lifecycleState,
    retirement: _retirement,
    ...sharedDeclaration
  } = sharedValue as Record<string, unknown>;
  let parsedShared: AgentDeclarationV1;
  try {
    parsedShared = parseAgentDeclarationV1(sharedDeclaration);
  } catch {
    return false;
  }
  const sharedDigest = agentDeclarationContentDigest(parsedShared);
  if (agentDeclarationContentDigest(local) === sharedDigest) return true;
  return pendingTransfer !== undefined && pendingTransfer.declarationSha256 === sharedDigest;
}

type UnshareCompensationJudgment = "commit_complete" | "compensate_remove_local" | "retain_local_uncertain";

/**
 * Only an authoritative pre-commit rejection (`op_rejected` with `durable !== true`) proves the
 * shared deletion did not land. Durable pending outcomes, post-commit errors, and transport drops
 * must retain the local copy so the user never loses their only live declaration.
 */
export function judgeUnshareCompensation(
  result: { readonly outcome?: unknown; readonly durable?: unknown } | { readonly error: unknown },
): UnshareCompensationJudgment {
  if ("error" in result) return "retain_local_uncertain";
  if (result.outcome === "applied") return "commit_complete";
  if (result.outcome === "op_rejected" && result.durable !== true) return "compensate_remove_local";
  return "retain_local_uncertain";
}

/** Extracts the requested scope from either top-level `action.scope` or `action.declaration.scope`. */
export function requestedAgentScopeFromAction(action: Readonly<Record<string, unknown>>): AgentScope | undefined {
  if (action.scope === "local" || action.scope === "shared") return action.scope;
  const declaration = action.declaration;
  if (typeof declaration === "object" && declaration !== null && !Array.isArray(declaration)) {
    const scope = (declaration as { readonly scope?: unknown }).scope;
    if (scope === "local" || scope === "shared") return scope;
  }
  return undefined;
}

export interface AgentDeclarationV1 {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly runtimes: readonly AgentRuntimeTargetV1[];
  /** Missing scope is the historical shared declaration, retained for existing team ledgers. */
  readonly scope?: AgentScope;
  readonly selectionStrategy?: RuntimeSelectionStrategy;
  readonly permissionMode?: AgentPermissionMode;
  readonly mcpPolicy?: AgentMcpPolicy;
  readonly hostAccess?: AgentHostAccess;
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
    scope: {
      type: "string",
      enum: ["local", "shared"],
      description: "Whether this declaration is private to this node or published to the project.",
      "x-error": "must be local or shared.",
    },
    selectionStrategy: {
      type: "string",
      enum: runtimeSelectionStrategies,
      description:
        "Same-tier scheduling: sticky reuses the first idle instance; lru balances live load then dispatch recency.",
      "x-error": "must be sticky or lru.",
    },
    permissionMode: {
      type: "string",
      enum: ["bypass", "workspace-write", "read-only"],
      description: "Default unattended permission mode.",
      "x-error": "must be bypass, workspace-write, or read-only.",
    },
    mcpPolicy: {
      type: "string",
      enum: agentMcpPolicies,
      description: "Host MCP server inheritance policy for unattended dispatches.",
      "x-error": "must be disabled or inherit.",
    },
    hostAccess: {
      type: "string",
      enum: agentHostAccessValues,
      description:
        "Host tools and services the dispatch prompt permits; omitted means operator. isolated may not use " +
        "host tools or services outside this repository's own toolchain. operator may use existing host tools " +
        "and services the task needs (for example executing inside an existing VM). bypass lifts both " +
        "boundaries, including creating or starting VMs and Docker containers.",
      "x-error": "must be isolated, operator, or bypass.",
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

/** Canonical declaration reads project the historical fields away without changing the source blob. */
export function withoutLegacyAgentInstanceBindings(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    instance: _instance,
    preferredInstances: _preferredInstances,
    ...shared
  } = value as Readonly<Record<string, unknown>>;
  return shared;
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

// dec_7E44897ECDCAEF2B92EC66A260/CH1: the Squad leader turn budget schema bound.
export const squadLeaderTurnPolicy = {
  id: "squad-leader-turns",
  ownerRef: "squad",
  unit: "leader turns per Squad run",
  bounds:
    "When declared, leaderTurnBudget is an integer from 1 to Number.MAX_SAFE_INTEGER counting the initial, callback and retry leader turns of one run.",
  defaultValue: null,
  version: 1,
  scope: "Squad declaration schema",
  reason: "The declaration schema owns the only admissible range; no default budget is introduced.",
  fixtures: ["packages/kernel/test/contracts/entity-store.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/agent-squad-schema.ts#SQUAD_DECLARATION_V1_SCHEMA.properties.leaderTurnBudget:99331d04107f982fe2caac04edd7dc17",
  ].map((candidateId) => ({ candidateId, route: "SQUAD_DECLARATION_V1_SCHEMA" })),
} as const satisfies OntologyPolicyDeclaration;
// Source identities and values for daemon policy declarations registered by EntityKindContract.
export const daemonAgentPolicySources = [
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-entities.ts#agentReferenceCounts.relations.limit:566e0d0917d2d5e10ead25ab3a9e3260",
    "packages/daemon/src/daemon-host/agent-entities.ts#agentReferenceCounts.relations.limit",
    'projection.readRelationQuery({ source: ref, state: "active", limit: 500 }).rows.length +',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-entities.ts#agentReferenceCounts.relations.limit:566e0d0917d2d5e10ead25ab3a9e3260:2",
    "packages/daemon/src/daemon-host/agent-entities.ts#agentReferenceCounts.relations.limit",
    'projection.readRelationQuery({ target: ref, state: "active", limit: 500 }).rows.length;',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-version-action.ts#runAgentVersionRead.current.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "packages/daemon/src/daemon-host/agent-version-action.ts#runAgentVersionRead.current.limit",
    "current = readAgentHistory(ports, { agentId, limit: 1, summaries: false }).revision;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-version-read.ts#LCS_CELL_BUDGET:28fa4e26dd6bce235155a5348f7a37e6",
    "packages/daemon/src/daemon-host/agent-version-read.ts#LCS_CELL_BUDGET",
    "const LCS_CELL_BUDGET = 250_000;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-version-read.ts#DEFAULT_AGENT_HISTORY_LIMIT:64b7ed26576631e2d231f8cfd439ac41",
    "packages/daemon/src/daemon-host/agent-version-read.ts#DEFAULT_AGENT_HISTORY_LIMIT",
    "export const DEFAULT_AGENT_HISTORY_LIMIT = 50;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-version-read.ts#MAX_AGENT_HISTORY_LIMIT:46d703ff74d2dcbe762a6e1f09a23b17",
    "packages/daemon/src/daemon-host/agent-version-read.ts#MAX_AGENT_HISTORY_LIMIT",
    "export const MAX_AGENT_HISTORY_LIMIT = 500;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-version-read.ts#currentIdentity.page.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "packages/daemon/src/daemon-host/agent-version-read.ts#currentIdentity.page.limit",
    'page = ports.projection.readEventList({ entity: `agent/${agentId}`, type: "entity_upserted", limit: 1 }),',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-version-read.ts#claimOf:3329465408def07b94beb3d97c48482c",
    "packages/daemon/src/daemon-host/agent-version-read.ts#claimOf",
    'if (typeof claim?.sha256 !== "string" || typeof claim.size !== "number")',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-version-read.ts#readAgentHistory:b9975b1b5b28711e5b78257e02621f89",
    "packages/daemon/src/daemon-host/agent-version-read.ts#readAgentHistory",
    "if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGENT_HISTORY_LIMIT)",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-version-read.ts#readAgentVersion.page.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "packages/daemon/src/daemon-host/agent-version-read.ts#readAgentVersion.page.limit",
    "limit: 1,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-version-read.ts#resolveVersion.page.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "packages/daemon/src/daemon-host/agent-version-read.ts#resolveVersion.page.limit",
    "limit: 1,",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-entities.ts#prepareAgentEntityInstall:3e459bfaa2d36e64242be2f723ab493d",
    "packages/daemon/src/daemon-host/agent-entities.ts#prepareAgentEntityInstall",
    "input.action.mcpPolicy === undefined && input.action.clearMcpPolicy !== true && input.action.selectionStrategy === undefined && input.action.scope === undefined",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/agent-entities.ts#readAgentEntityDeclarationSource.withOverride:7ecc7346bcdee21e953d03b1d5ac4275",
    "packages/daemon/src/daemon-host/agent-entities.ts#readAgentEntityDeclarationSource.withOverride",
    "action.mcpPolicy === undefined && action.clearMcpPolicy !== true && action.selectionStrategy === undefined",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/repo-mode.ts#entityActionCommandTopology.admission:a4d055f9412c87a6ddbcd189bb633bf5:2",
    "packages/daemon/src/daemon-host/repo-mode.ts#entityActionCommandTopology.admission",
    'action.kind === "agent-install" && (action.scope === "local" || action.localAgentTransfer === true)',
  ],
] as const;

// Source identities and values for daemon policy declarations registered by EntityKindContract.
export const daemonSquadPolicySources = [
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/squad-coordinator.ts#makeSquadCoordinator.startScheduled.state.permissionMode:2665c47e7dffa0fb0b27e66e0bab7d70",
    "packages/daemon/src/daemon-host/squad-coordinator.ts#makeSquadCoordinator.startScheduled.state.permissionMode",
    'permissionMode: claimed.schedule.mode === "detect" ? "read-only" : null,',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/squad-coordinator.ts#makeSquadCoordinator.spawnWorker:98607b4d1520a1a2a50e4fcbab597776",
    "packages/daemon/src/daemon-host/squad-coordinator.ts#makeSquadCoordinator.spawnWorker",
    'if (childLease?.phase !== "held" || isSameExecution(childLease.actor, state.binding.actor))',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/squad-run-contract.ts#validateSquadRunRead:489f31d305ae5d005ed88b84014bf6a3",
    "packages/daemon/src/daemon-host/squad-run-contract.ts#validateSquadRunRead",
    "return squadRunRecord(value) &&",
  ],
  [
    "policy:packages/application:packages/application/src/queries/squad-run-list.ts#listQuery:fa138dbee2dfc5729a9c0df606ff2726",
    "packages/application/src/queries/squad-run-list.ts#listQuery",
    "if (",
  ],
  [
    "policy:packages/application:packages/application/src/queries/squad-run-list.ts#listQuery.limit:13e34ed06a7f8e0b91c55872c8faef0b",
    "packages/application/src/queries/squad-run-list.ts#listQuery.limit",
    'limit: typeof limit === "number" ? limit : 200,',
  ],
  [
    "policy:packages/application:packages/application/src/queries/squad-run-state.ts#squadState:58d2fa377245fd6d5cb33f221c549339",
    "packages/application/src/queries/squad-run-state.ts#squadState",
    'return row.schema === "squad-run/v1" &&',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/squad-runtime-ingress.ts#requireSquadBusinessAction:9e72d9b485b6f62c246a81196d897364",
    "packages/daemon/src/daemon-host/squad-runtime-ingress.ts#requireSquadBusinessAction",
    "if (",
  ],
] as const;
