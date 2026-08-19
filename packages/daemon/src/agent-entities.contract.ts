// Agent and Squad are independent runtime-identity entities, not preset kinds (dec_ED69804189CF05E6D1A8615283D):
// an Agent consumes presets, so it cannot also be catalogued as one. This contract owns their persisted
// declaration form; packages/daemon/src/agent-entities.ts owns the store and command actions.
export interface AgentDeclarationV1 { readonly id: string; readonly name: string; readonly instructions: string; readonly runtime_type: string; readonly skills?: readonly string[]; readonly prompts?: readonly string[]; readonly preset?: string }
export interface SquadDeclarationV1 { readonly id: string; readonly name: string; readonly leader: string; readonly workers: readonly string[]; readonly roster: string }
export type AgentEntityKind = "agent" | "squad";
type EntityContractSchema<T> = Readonly<{ readonly id: string; readonly required: readonly string[] }> & { readonly Type: T }; function entitySchema<T>(id: string, required: readonly string[]): EntityContractSchema<T> { return Object.freeze({ id, required: Object.freeze(required) }) as EntityContractSchema<T>; }
export const AGENT_DECLARATION_V1_SCHEMA = entitySchema<AgentDeclarationV1>("agent-declaration/v1", ["schema", "id", "name", "instructions", "runtime_type"]);
export const SQUAD_DECLARATION_V1_SCHEMA = entitySchema<SquadDeclarationV1>("squad-declaration/v1", ["schema", "id", "name", "leader", "workers", "roster"]);
export class AgentEntityContractError extends Error { readonly code = "invalid_entity_contract"; constructor(message: string) { super(message); this.name = "AgentEntityContractError"; } }
// runtime_type is an open identifier, not a closed union: the Agent declares which class of runtime it
// needs (claude, codex, opencode, dsh, ...); whether a concrete instance can serve it is decided at spawn.
const runtimeTypeIdentifier = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export function isRuntimeTypeIdentifier(value: string): boolean { return runtimeTypeIdentifier.test(value); }
export function validateAgentDeclarationV1(value: unknown): readonly string[] {
  if (!isEntityRecord(value)) return ["agent declaration must be a JSON object; expected agent-declaration/v1."];
  const errors: string[] = [], fields = [...AGENT_DECLARATION_V1_SCHEMA.required, "skills", "prompts", "preset"];
  for (const field of Object.keys(value).filter((field) => !fields.includes(field))) errors.push(`agent declaration field "${field}" is unknown; remove it.`);
  for (const field of AGENT_DECLARATION_V1_SCHEMA.required) if (!Object.hasOwn(value, field)) errors.push(`agent declaration is missing required field "${field}"; expected id, name, instructions, and runtime_type.`);
  if (value.schema !== "agent-declaration/v1") errors.push('agent declaration field "schema" must equal "agent-declaration/v1".');
  if (Object.hasOwn(value, "id") && !entitySlug(value.id)) errors.push('agent declaration field "id" must be a lowercase entity slug.');
  if (Object.hasOwn(value, "name") && !entityNonEmpty(value.name)) errors.push('agent declaration field "name" must be a non-empty string.');
  if (Object.hasOwn(value, "instructions") && !entityNonEmpty(value.instructions)) errors.push('agent declaration field "instructions" must be a non-empty string.');
  if (Object.hasOwn(value, "runtime_type") && (typeof value.runtime_type !== "string" || !isRuntimeTypeIdentifier(value.runtime_type))) errors.push('agent declaration field "runtime_type" must be a non-empty lowercase runtime identifier such as claude, codex, or opencode.');
  if (value.skills !== undefined && !nonEmptyStrings(value.skills)) errors.push('agent declaration field "skills" must be an array of non-empty strings.');
  if (value.prompts !== undefined && !nonEmptyStrings(value.prompts)) errors.push('agent declaration field "prompts" must be an array of non-empty strings.');
  if (value.preset !== undefined && !entityNonEmpty(value.preset)) errors.push('agent declaration field "preset" must be a non-empty preset id.');
  return errors;
}
export function validateSquadDeclarationV1(value: unknown): readonly string[] {
  if (!isEntityRecord(value)) return ["squad declaration must be a JSON object; expected squad-declaration/v1."];
  const errors: string[] = [];
  for (const field of Object.keys(value).filter((field) => !SQUAD_DECLARATION_V1_SCHEMA.required.includes(field))) errors.push(`squad declaration field "${field}" is unknown; remove it.`);
  for (const field of SQUAD_DECLARATION_V1_SCHEMA.required) if (!Object.hasOwn(value, field)) errors.push(`squad declaration is missing required field "${field}"; expected id, name, leader, workers, and roster.`);
  if (value.schema !== "squad-declaration/v1") errors.push('squad declaration field "schema" must equal "squad-declaration/v1".');
  if (Object.hasOwn(value, "id") && !entitySlug(value.id)) errors.push('squad declaration field "id" must be a lowercase entity slug.');
  if (Object.hasOwn(value, "name") && !entityNonEmpty(value.name)) errors.push('squad declaration field "name" must be a non-empty string.');
  if (Object.hasOwn(value, "leader") && !entitySlug(value.leader)) errors.push('squad declaration field "leader" must be a lowercase Agent id.');
  if (Object.hasOwn(value, "workers") && (!Array.isArray(value.workers) || !value.workers.every(entitySlug) || new Set(value.workers as string[]).size !== (value.workers as string[]).length)) errors.push('squad declaration field "workers" must be an array of unique lowercase Agent ids.');
  if (Object.hasOwn(value, "roster") && !entityNonEmpty(value.roster)) errors.push('squad declaration field "roster" must be a non-empty string.');
  return errors;
}
export function parseAgentDeclarationV1(value: unknown): AgentDeclarationV1 { const errors = validateAgentDeclarationV1(value); if (errors.length) throw new AgentEntityContractError(errors.join("; ")); return value as AgentDeclarationV1; }
export function parseSquadDeclarationV1(value: unknown): SquadDeclarationV1 { const errors = validateSquadDeclarationV1(value); if (errors.length) throw new AgentEntityContractError(errors.join("; ")); return value as SquadDeclarationV1; }
export function serializeAgentDeclarationV1(value: unknown): string { return serializeEntity(value, validateAgentDeclarationV1); }
export function serializeSquadDeclarationV1(value: unknown): string { return serializeEntity(value, validateSquadDeclarationV1); }
function serializeEntity(value: unknown, validate: (input: unknown) => readonly string[]): string { const errors = validate(value); if (errors.length) throw new AgentEntityContractError(errors.join("; ")); return `${JSON.stringify(value, null, 2)}\n`; }
function isEntityRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function entityNonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function nonEmptyStrings(value: unknown): boolean { return Array.isArray(value) && value.every(entityNonEmpty); }
export function entitySlug(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value); }
const schemaDeclaration = (id: string, name: string, fixture: string) => ({ id, schema: `packages/daemon/src/agent-entities.contract.ts#${name}_SCHEMA`, parser: `packages/daemon/src/agent-entities.contract.ts#validate${name.split("_").map((part) => part[0]! + part.slice(1).toLowerCase()).join("")}`, writer: `packages/daemon/src/agent-entities.contract.ts#serialize${name.split("_").map((part) => part[0]! + part.slice(1).toLowerCase()).join("")}`, error: "packages/daemon/src/agent-entities.contract.ts#AgentEntityContractError", negativeFixtures: Object.freeze([`packages/daemon/fixtures/contracts/${fixture}`]) });
export const agentEntitySchemas = Object.freeze([schemaDeclaration("agent-declaration/v1", "AGENT_DECLARATION_V1", "agent-declaration-v1-invalid.json"), schemaDeclaration("squad-declaration/v1", "SQUAD_DECLARATION_V1", "squad-declaration-v1-invalid.json")]);
export default Object.freeze({ id: "agent-entities-v1", phases: Object.freeze(["Agent-Entities-A"]), commands: Object.freeze([]), methods: Object.freeze([]), gates: Object.freeze([]), guards: Object.freeze([]), schemas: agentEntitySchemas });
