// Agent and Squad are independent runtime-identity entities, not preset kinds (dec_ED69804189CF05E6D1A8615283D):
// an Agent consumes presets, so it cannot also be catalogued as one. This contract owns their persisted
// declaration form; packages/daemon/src/agent-entities.ts owns the store and command actions.
export interface AgentSkillDeclarationV1 {
  readonly id: string;
  readonly path: string;
}
export interface AgentFallbackDeclarationV1 {
  readonly chain: readonly { readonly instance: string; readonly model?: string }[];
  readonly backoff: { readonly baseMs: number; readonly maxMs: number };
}
export type AgentRole = "worker" | "commander";
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
type EntityContractSchema<T> = Readonly<{ readonly id: string; readonly required: readonly string[] }> & {
  readonly Type: T;
};
function entitySchema<T>(id: string, required: readonly string[]): EntityContractSchema<T> {
  return Object.freeze({ id, required: Object.freeze(required) }) as EntityContractSchema<T>;
}
export const AGENT_DECLARATION_V1_SCHEMA = entitySchema<AgentDeclarationV1>("agent-declaration/v1", [
  "schema",
  "id",
  "name",
  "instructions",
  "runtime_type",
]);
export const SQUAD_DECLARATION_V1_SCHEMA = entitySchema<SquadDeclarationV1>("squad-declaration/v1", [
  "schema",
  "id",
  "name",
  "leader",
  "workers",
  "leaderTurnBudget",
  "roster",
]);
export class AgentEntityContractError extends Error {
  readonly code = "invalid_entity_contract";
  constructor(message: string) {
    super(message);
    this.name = "AgentEntityContractError";
  }
}
const runtimeTypeIdentifier = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export function isRuntimeTypeIdentifier(value: string): boolean {
  return runtimeTypeIdentifier.test(value);
}
export function entitySlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
}
export function entityNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function validateAgentDeclarationV1(value: unknown): readonly string[] {
  if (!isEntityRecord(value)) return ["agent declaration must be a JSON object; expected agent-declaration/v1."];
  const errors: string[] = [],
    fields = [...AGENT_DECLARATION_V1_SCHEMA.required, "role", "model", "skills", "prompts", "preset", "fallback"];
  for (const field of Object.keys(value).filter((field) => !fields.includes(field)))
    errors.push(`agent declaration field "${field}" is unknown; remove it.`);
  for (const field of AGENT_DECLARATION_V1_SCHEMA.required)
    if (!Object.hasOwn(value, field))
      errors.push(
        `agent declaration is missing required field "${field}"; expected id, name, instructions, and runtime_type.`,
      );
  if (value.schema !== "agent-declaration/v1")
    errors.push('agent declaration field "schema" must equal "agent-declaration/v1".');
  if (Object.hasOwn(value, "id") && !entitySlug(value.id))
    errors.push('agent declaration field "id" must be a lowercase entity slug.');
  if (Object.hasOwn(value, "name") && !entityNonEmpty(value.name))
    errors.push('agent declaration field "name" must be a non-empty string.');
  if (Object.hasOwn(value, "instructions") && !entityNonEmpty(value.instructions))
    errors.push('agent declaration field "instructions" must be a non-empty string.');
  if (
    Object.hasOwn(value, "runtime_type") &&
    (typeof value.runtime_type !== "string" || !isRuntimeTypeIdentifier(value.runtime_type))
  )
    errors.push(
      'agent declaration field "runtime_type" must be a non-empty lowercase runtime identifier such as claude, codex, or opencode.',
    );
  if (value.role !== undefined && !["worker", "commander"].includes(String(value.role)))
    errors.push('agent declaration field "role" must be worker or commander.');
  if (value.model !== undefined && !entityNonEmpty(value.model))
    errors.push('agent declaration field "model" must be a non-empty string.');
  if (value.skills !== undefined && !agentSkills(value.skills))
    errors.push(
      'agent declaration field "skills" must be an array of unique {id, path} references with non-empty paths.',
    );
  if (value.prompts !== undefined && !nonEmptyStrings(value.prompts))
    errors.push('agent declaration field "prompts" must be an array of non-empty strings.');
  if (value.preset !== undefined && !entityNonEmpty(value.preset))
    errors.push('agent declaration field "preset" must be a non-empty preset id.');
  if (value.fallback !== undefined) errors.push(...agentFallbackErrors(value.fallback));
  return errors;
}
export function validateSquadDeclarationV1(value: unknown): readonly string[] {
  if (!isEntityRecord(value)) return ["squad declaration must be a JSON object; expected squad-declaration/v1."];
  const errors: string[] = [];
  for (const field of Object.keys(value).filter((field) => !SQUAD_DECLARATION_V1_SCHEMA.required.includes(field)))
    errors.push(`squad declaration field "${field}" is unknown; remove it.`);
  for (const field of SQUAD_DECLARATION_V1_SCHEMA.required)
    if (!Object.hasOwn(value, field))
      errors.push(
        `squad declaration is missing required field "${field}"; expected id, name, leader, workers, leaderTurnBudget, and roster.`,
      );
  if (value.schema !== "squad-declaration/v1")
    errors.push('squad declaration field "schema" must equal "squad-declaration/v1".');
  if (Object.hasOwn(value, "id") && !entitySlug(value.id))
    errors.push('squad declaration field "id" must be a lowercase entity slug.');
  if (Object.hasOwn(value, "name") && !entityNonEmpty(value.name))
    errors.push('squad declaration field "name" must be a non-empty string.');
  if (Object.hasOwn(value, "leader") && !entitySlug(value.leader))
    errors.push('squad declaration field "leader" must be a lowercase Agent id.');
  if (
    Object.hasOwn(value, "workers") &&
    (!Array.isArray(value.workers) ||
      !value.workers.every(entitySlug) ||
      new Set(value.workers as string[]).size !== (value.workers as string[]).length)
  )
    errors.push('squad declaration field "workers" must be an array of unique lowercase Agent ids.');
  if (
    Object.hasOwn(value, "leaderTurnBudget") &&
    (!Number.isSafeInteger(value.leaderTurnBudget) || Number(value.leaderTurnBudget) < 1)
  )
    errors.push('squad declaration field "leaderTurnBudget" must be a positive integer.');
  if (Object.hasOwn(value, "roster") && !entityNonEmpty(value.roster))
    errors.push('squad declaration field "roster" must be a non-empty string.');
  return errors;
}
export function parseAgentDeclarationV1(value: unknown): AgentDeclarationV1 {
  const errors = validateAgentDeclarationV1(value);
  if (errors.length) throw new AgentEntityContractError(errors.join("; "));
  return value as AgentDeclarationV1;
}
export function parseSquadDeclarationV1(value: unknown): SquadDeclarationV1 {
  const errors = validateSquadDeclarationV1(value);
  if (errors.length) throw new AgentEntityContractError(errors.join("; "));
  return value as SquadDeclarationV1;
}
export function serializeAgentDeclarationV1(value: unknown): string {
  return serializeEntity(value, validateAgentDeclarationV1);
}
export function serializeSquadDeclarationV1(value: unknown): string {
  return serializeEntity(value, validateSquadDeclarationV1);
}

function isEntityRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function serializeEntity(value: unknown, validate: (input: unknown) => readonly string[]): string {
  const errors = validate(value);
  if (errors.length) throw new AgentEntityContractError(errors.join("; "));
  return `${JSON.stringify(value, null, 2)}\n`;
}
function nonEmptyStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every(entityNonEmpty);
}
function agentSkills(value: unknown): value is readonly AgentSkillDeclarationV1[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isEntityRecord(item) &&
        Object.keys(item).every((key) => ["id", "path"].includes(key)) &&
        Object.keys(item).length === 2 &&
        entitySlug(item.id) &&
        entityNonEmpty(item.path),
    ) &&
    new Set(value.map((item) => (item as AgentSkillDeclarationV1).id)).size === value.length
  );
}
function agentFallbackErrors(value: unknown): readonly string[] {
  if (!isEntityRecord(value)) return ['agent declaration field "fallback" must be an object.'];
  const errors: string[] = [],
    fields = ["chain", "backoff"];
  if (Object.keys(value).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(value, key)))
    errors.push('agent declaration field "fallback" must contain exactly chain and backoff.');
  if (
    !Array.isArray(value.chain) ||
    value.chain.length === 0 ||
    !value.chain.every(
      (candidate) =>
        isEntityRecord(candidate) &&
        Object.keys(candidate).every((key) => ["instance", "model"].includes(key)) &&
        Object.hasOwn(candidate, "instance") &&
        entityNonEmpty(candidate.instance) &&
        (candidate.model === undefined || entityNonEmpty(candidate.model)),
    )
  )
    errors.push(
      'agent declaration field "fallback.chain" must be a non-empty array of exact {instance, model?} candidates.',
    );
  if (!isEntityRecord(value.backoff)) {
    errors.push('agent declaration field "fallback.backoff" must be an object.');
    return errors;
  }
  const backoff = value.backoff;
  const backoffFields = ["baseMs", "maxMs"];
  if (
    Object.keys(backoff).some((key) => !backoffFields.includes(key)) ||
    backoffFields.some((key) => !Object.hasOwn(backoff, key))
  )
    errors.push('agent declaration field "fallback.backoff" must contain exactly baseMs and maxMs.');
  const { baseMs, maxMs } = backoff;
  if (!Number.isSafeInteger(baseMs) || Number(baseMs) < 0)
    errors.push('agent declaration field "fallback.backoff.baseMs" must be a non-negative integer.');
  if (!Number.isSafeInteger(maxMs) || Number(maxMs) < Number(baseMs))
    errors.push('agent declaration field "fallback.backoff.maxMs" must be an integer greater than or equal to baseMs.');
  return errors;
}
// GUI read envelopes for the identity layers. These validators live in this pure contract
// module (no runtime imports) because the schema-closure gate imports them from a checkout
// with no installed dependencies; packages/daemon/src/agent-entities.ts keeps the reads.
const entityWireSecretKeys = /(?:^|[-_])(?:api[-_]?key|credential|passphrase|password|secret|token)(?:$|[-_])/iu;
const entityIssueRow = (value: unknown): readonly string[] =>
  isEntityRecord(value) && entityNonEmpty(value.code) && entityNonEmpty(value.message)
    ? []
    : ["issues entries must carry non-empty code and message strings."];
function entityReadEnvelopeErrors(value: unknown, schema: string, fields: readonly string[]): readonly string[] {
  if (!isEntityRecord(value)) return [`${schema} must be a JSON object.`];
  const errors: string[] = [];
  if (value.schema !== schema) errors.push(`${schema} must declare its own schema id.`);
  if (value.ok !== true) errors.push(`${schema} must carry ok=true like every GUI read result.`);
  for (const field of Object.keys(value).filter((field) => !fields.includes(field)))
    errors.push(`${schema} field "${field}" is unknown; remove it.`);
  for (const field of fields.filter((field) => !Object.hasOwn(value, field)))
    errors.push(`${schema} is missing required field "${field}".`);
  if (Object.keys(value).some((field) => entityWireSecretKeys.test(field)))
    errors.push(`${schema} carries a forbidden credential-shaped key.`);
  return errors;
}
function entityReadRowErrors(value: unknown, fields: readonly string[], prefix: string): readonly string[] {
  if (!isEntityRecord(value)) return [`${prefix} must be a JSON object.`];
  const errors: string[] = [];
  for (const field of Object.keys(value).filter((field) => !fields.includes(field)))
    errors.push(`${prefix} field "${field}" is unknown; remove it.`);
  for (const field of fields.filter((field) => !Object.hasOwn(value, field)))
    errors.push(`${prefix} is missing required field "${field}".`);
  if (Object.keys(value).some((field) => entityWireSecretKeys.test(field)))
    errors.push(`${prefix} carries a forbidden credential-shaped key.`);
  return errors;
}
const agentCatalogRowFields = Object.freeze(["id", "name", "runtimeType", "role", "layer", "validity", "issues"]),
  squadCatalogRowFields = Object.freeze(["id", "name", "leader", "workers", "layer", "validity", "issues"]),
  agentDetailFields = Object.freeze([
    "id",
    "name",
    "runtimeType",
    "role",
    "instructions",
    "model",
    "skills",
    "prompts",
    "preset",
    "fallback",
  ]),
  squadDetailFields = Object.freeze(["id", "name", "leader", "workers", "leaderTurnBudget", "roster"]);
function catalogErrors(
  value: unknown,
  schema: string,
  field: "agents" | "squads",
  rowFields: readonly string[],
  rowChecks: (row: Record<string, unknown>) => readonly string[],
): readonly string[] {
  const errors = [...entityReadEnvelopeErrors(value, schema, ["schema", "ok", field])];
  if (!isEntityRecord(value) || !Array.isArray(value[field]))
    return [...errors, `${schema} field "${field}" must be an array.`];
  value[field].forEach((row, index) =>
    errors.push(
      ...entityReadRowErrors(row, rowFields, `${field}[${index}]`),
      ...(isEntityRecord(row) ? rowChecks(row) : []),
      ...(isEntityRecord(row) && Array.isArray(row.issues)
        ? row.issues.flatMap(entityIssueRow)
        : [`${field}[${index}] field "issues" must be an array.`]),
    ),
  );
  return errors;
}
function detailErrors(
  value: unknown,
  schema: string,
  field: "agent" | "squad",
  detailFields: readonly string[],
  rowChecks: (row: Record<string, unknown>) => readonly string[],
): readonly string[] {
  const errors = [...entityReadEnvelopeErrors(value, schema, ["schema", "ok", field])];
  if (!isEntityRecord(value) || !isEntityRecord(value[field]))
    return [...errors, `${schema} field "${field}" must be an object.`];
  return [
    ...errors,
    ...entityReadRowErrors(value[field], detailFields, field),
    ...rowChecks(value[field] as Record<string, unknown>),
  ];
}
const catalogRowChecks = (row: Record<string, unknown>): readonly string[] =>
  [
    !(entityNonEmpty(row.id) && entityNonEmpty(row.name)) ? ["catalog rows need non-empty id and name."] : [],
    row.validity !== undefined && !["valid", "blocked"].includes(String(row.validity))
      ? ["catalog row validity must be valid or blocked."]
      : [],
  ].flat();
const agentCatalogRowChecks = (row: Record<string, unknown>): readonly string[] =>
  [
    ...catalogRowChecks(row),
    !["worker", "commander"].includes(String(row.role)) ? "agent catalog row role must be worker or commander." : [],
  ].flat();
const agentDetailChecks = (row: Record<string, unknown>): readonly string[] =>
  [
    !(
      entityNonEmpty(row.id) &&
      entityNonEmpty(row.name) &&
      entityNonEmpty(row.runtimeType) &&
      ["worker", "commander"].includes(String(row.role)) &&
      entityNonEmpty(row.instructions)
    )
      ? ["agent detail needs non-empty id, name, runtimeType, role, and instructions."]
      : [],
    row.model !== null && row.model !== undefined && !entityNonEmpty(row.model)
      ? ["agent detail model must be null or a non-empty model id."]
      : [],
    row.skills !== undefined && !agentSkills(row.skills)
      ? ["agent detail skills must be an array of unique {id, path} references."]
      : [],
    row.prompts !== undefined && !nonEmptyStrings(row.prompts)
      ? ["agent detail prompts must be an array of non-empty strings."]
      : [],
    row.preset !== null && row.preset !== undefined && !entityNonEmpty(row.preset)
      ? ["agent detail preset must be null or a non-empty preset id."]
      : [],
    row.fallback !== null && row.fallback !== undefined ? agentFallbackErrors(row.fallback) : [],
  ].flat();
const squadDetailChecks = (row: Record<string, unknown>): readonly string[] =>
  [
    !(entityNonEmpty(row.id) && entityNonEmpty(row.name) && entitySlug(row.leader) && entityNonEmpty(row.roster))
      ? ["squad detail needs non-empty id, name, roster, and a slug leader."]
      : [],
    !Array.isArray(row.workers) || !nonEmptyStrings(row.workers) || !row.workers.every(entitySlug)
      ? ["squad detail workers must be an array of agent slugs."]
      : [],
    !Number.isSafeInteger(row.leaderTurnBudget) || Number(row.leaderTurnBudget) < 1
      ? ["squad detail leaderTurnBudget must be a positive integer."]
      : [],
  ].flat();
export function validateAgentEntityCatalog(value: unknown): readonly string[] {
  return catalogErrors(value, "agent-entity-catalog/v1", "agents", agentCatalogRowFields, agentCatalogRowChecks);
}
export function validateAgentSkillCatalog(value: unknown): readonly string[] {
  const errors = [...entityReadEnvelopeErrors(value, "agent-skill-catalog/v1", ["schema", "ok", "skills"])];
  if (!isEntityRecord(value) || !Array.isArray(value.skills))
    return [...errors, 'agent-skill-catalog/v1 field "skills" must be an array.'];
  value.skills.forEach((row, index) => {
    errors.push(...entityReadRowErrors(row, ["id", "path", "source"], `skills[${index}]`));
    if (
      isEntityRecord(row) &&
      !(entitySlug(row.id) && entityNonEmpty(row.path) && ["user", "project"].includes(String(row.source)))
    )
      errors.push(`skills[${index}] needs a slug id, non-empty path, and user or project source.`);
  });
  return errors;
}
export function validateSquadEntityCatalog(value: unknown): readonly string[] {
  return catalogErrors(value, "squad-entity-catalog/v1", "squads", squadCatalogRowFields, catalogRowChecks);
}
export function validateAgentEntityDetail(value: unknown): readonly string[] {
  return detailErrors(value, "agent-entity-detail/v1", "agent", agentDetailFields, agentDetailChecks);
}
export function validateSquadEntityDetail(value: unknown): readonly string[] {
  return detailErrors(value, "squad-entity-detail/v1", "squad", squadDetailFields, squadDetailChecks);
}
export const serializeAgentEntityCatalog = (value: unknown): string =>
    serializeEntity(value, validateAgentEntityCatalog),
  serializeAgentSkillCatalog = (value: unknown): string => serializeEntity(value, validateAgentSkillCatalog),
  serializeSquadEntityCatalog = (value: unknown): string => serializeEntity(value, validateSquadEntityCatalog),
  serializeAgentEntityDetail = (value: unknown): string => serializeEntity(value, validateAgentEntityDetail),
  serializeSquadEntityDetail = (value: unknown): string => serializeEntity(value, validateSquadEntityDetail);
const schemaDeclaration = (id: string, name: string, fixtures: readonly string[]) => ({
  id,
  schema: `packages/daemon/src/agent-entities.contract.ts#${name}_SCHEMA`,
  parser: `packages/daemon/src/agent-entities.contract.ts#validate${name
    .split("_")
    .map((part) => part[0]! + part.slice(1).toLowerCase())
    .join("")}`,
  writer: `packages/daemon/src/agent-entities.contract.ts#serialize${name
    .split("_")
    .map((part) => part[0]! + part.slice(1).toLowerCase())
    .join("")}`,
  error: "packages/daemon/src/agent-entities.contract.ts#AgentEntityContractError",
  negativeFixtures: Object.freeze(fixtures.map((fixture) => `packages/daemon/fixtures/contracts/${fixture}`)),
});
export const agentEntitySchemas = Object.freeze([
  schemaDeclaration("agent-declaration/v1", "AGENT_DECLARATION_V1", [
    "agent-declaration-v1-invalid.json",
    "agent-declaration-v1-invalid-skill-shape.json",
    "agent-declaration-v1-invalid-skill-duplicate.json",
  ]),
  schemaDeclaration("squad-declaration/v1", "SQUAD_DECLARATION_V1", ["squad-declaration-v1-invalid.json"]),
]);
export default Object.freeze({
  id: "agent-entities-v1",
  phases: Object.freeze(["Agent-Entities-A"]),
  commands: Object.freeze([]),
  methods: Object.freeze([]),
  gates: Object.freeze([]),
  guards: Object.freeze([]),
  schemas: agentEntitySchemas,
});
