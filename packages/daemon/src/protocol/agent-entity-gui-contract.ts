import { entityNonEmpty, entitySlug } from "../../../kernel/src/index.ts";
import { EntitySchemaContractError } from "../../../kernel/src/index.ts";
import type { AgentSkillDeclarationV1 } from "../../../kernel/src/index.ts";

function isEntityRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every(entityNonEmpty);
}
function serializeEntity(value: unknown, validate: (input: unknown) => readonly string[]): string {
  const errors = validate(value);
  if (errors.length) throw new EntitySchemaContractError(errors.join("; "));
  return `${JSON.stringify(value, null, 2)}\n`;
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
    fields = ["providerPriority", "backoff"];
  if (Object.keys(value).some((key) => !fields.includes(key)) || !Object.hasOwn(value, "backoff"))
    errors.push('agent declaration field "fallback" must contain backoff and optional providerPriority.');
  const providerPriority = value.providerPriority;
  if (
    providerPriority !== undefined &&
    (!Array.isArray(providerPriority) ||
      !nonEmptyStrings(providerPriority) ||
      new Set(providerPriority).size !== providerPriority.length)
  )
    errors.push('agent declaration field "fallback.providerPriority" must be a unique array of provider identities.');
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
// GUI read envelopes for the identity layers. This module has no runtime imports so the
// schema-closure gate can import it from a checkout with no installed dependencies.
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
const agentCatalogRowFields = Object.freeze([
    "id",
    "name",
    "runtimeType",
    "instance",
    "permissionMode",
    "role",
    "layer",
    "validity",
    "issues",
  ]),
  squadCatalogRowFields = Object.freeze(["id", "name", "leader", "workers", "layer", "validity", "issues"]),
  degradedCatalogRowFields = Object.freeze(["id", "layer", "state", "error"]),
  agentDetailFields = Object.freeze([
    "id",
    "name",
    "runtimeType",
    "instance",
    "permissionMode",
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
    errors.push(...catalogRowErrors(row, rowFields, rowChecks, `${field}[${index}]`)),
  );
  return errors;
}
function catalogRowErrors(
  row: unknown,
  rowFields: readonly string[],
  rowChecks: (row: Record<string, unknown>) => readonly string[],
  prefix: string,
): readonly string[] {
  if (isEntityRecord(row) && Object.hasOwn(row, "state")) {
    const errors = [...entityReadRowErrors(row, degradedCatalogRowFields, prefix)];
    if (!(entityNonEmpty(row.id) && row.layer === "user" && ["invalid", "missing"].includes(String(row.state))))
      errors.push(`${prefix} degraded rows need an id, user layer, and invalid or missing state.`);
    if (
      !isEntityRecord(row.error) ||
      Object.keys(row.error).length !== 2 ||
      !entityNonEmpty(row.error.code) ||
      !entityNonEmpty(row.error.hint)
    )
      errors.push(`${prefix} degraded rows need an exact non-empty error {code, hint}.`);
    return errors;
  }
  return [
    ...entityReadRowErrors(row, rowFields, prefix),
    ...(isEntityRecord(row) ? rowChecks(row) : []),
    ...(isEntityRecord(row) && Array.isArray(row.issues)
      ? row.issues.flatMap(entityIssueRow)
      : [`${prefix} field "issues" must be an array.`]),
  ];
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
