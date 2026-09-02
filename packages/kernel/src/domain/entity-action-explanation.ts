import { validateActorIdentity } from "./actor-identity.ts";
import { parseEntityRef, type EntityRef } from "./entity-ref.ts";
import {
  artifactEntityActionCatalog,
  getEntityKindContract,
  type EntityActionContract,
  type EntityActionInputField,
} from "./entity-kind-registry.ts";
import { isEntityActionUnmetCriterion, type EntityActionUnmetCriterionV1 } from "./receipt-domain-registry.ts";
import type { AuthorizationDecision } from "./receipt-frame.ts";

export const ENTITY_ACTION_EXPLANATION_SCHEMA = Object.freeze({
  id: "entity-action-explanation/v1" as const,
});
export const ENTITY_ACTION_EXPLAIN_REQUEST_SCHEMA = Object.freeze({
  id: "entity-action-explain-request/v1" as const,
});

export class EntityActionExplanationContractError extends Error {
  readonly code = "invalid_entity_action_explanation";
}

export const entityActionCriterionStatuses = Object.freeze([
  "met",
  "unmet",
  "invocation-required",
  "not-evaluated",
] as const);
export type EntityActionCriterionStatus = (typeof entityActionCriterionStatuses)[number];
export const entityActionExplanationFailureCodes = Object.freeze([
  "invalid_entity_ref",
  "entity_not_found",
  "unsupported_explain_target",
  "projection_pending",
] as const);
export type EntityActionExplanationFailureCode = (typeof entityActionExplanationFailureCodes)[number];

export interface EntityActionExplainRequestV1 {
  readonly schema: typeof ENTITY_ACTION_EXPLAIN_REQUEST_SCHEMA.id;
  readonly entityKind: string | null;
  readonly refs: readonly string[];
  readonly mode: "object" | "catalog";
}

export interface EntityActionCriterionExplanationV1 {
  readonly ref: string;
  readonly failureCode: string;
  readonly explain: string;
  readonly status: EntityActionCriterionStatus;
  readonly nextActions: readonly string[];
}

export interface EntityActionExplanationV1 {
  readonly action: {
    readonly kind: string;
    readonly id: string;
    readonly catalogRef: string;
    readonly contractVersion: string;
    readonly explain: string;
    readonly syntax: {
      readonly usage: string;
      readonly inputs: readonly EntityActionInputField[];
    };
  };
  readonly target: null | {
    readonly ref: EntityRef;
    readonly revision: number;
  };
  readonly available: boolean | null;
  readonly criteria: readonly EntityActionCriterionExplanationV1[];
  readonly unmetCriteria: readonly EntityActionUnmetCriterionV1[];
  readonly authorizationDecision: AuthorizationDecision | null;
  readonly nextActions: readonly string[];
  readonly evaluatedAtCut: string | null;
}

export interface EntityActionExplanationFailureV1 {
  readonly code: EntityActionExplanationFailureCode;
  readonly message: string;
  readonly nextActions: readonly string[];
}

export interface EntityActionExplanationSubjectV1 {
  readonly kind: string | null;
  readonly ref: EntityRef | null;
  readonly revision: number | null;
  readonly actions: readonly EntityActionExplanationV1[];
  readonly failure: EntityActionExplanationFailureV1 | null;
}

export interface EntityActionExplanationSetV1 {
  readonly schema: typeof ENTITY_ACTION_EXPLANATION_SCHEMA.id;
  readonly mode: "catalog" | "object" | "failure";
  readonly subjects: readonly EntityActionExplanationSubjectV1[];
  readonly evaluatedAtCut: string | null;
}

export function validateEntityActionExplainRequest(value: unknown): readonly string[] {
  if (!explanationRecord(value) || !explanationExact(value, ["schema", "entityKind", "refs", "mode"]))
    return ["Entity Action explain request fields are incomplete or unknown"];
  const errors: string[] = [];
  if (value.schema !== ENTITY_ACTION_EXPLAIN_REQUEST_SCHEMA.id)
    errors.push("Entity Action explain request schema is invalid");
  if (value.mode !== "object" && value.mode !== "catalog") errors.push("Entity Action explain request mode is invalid");
  if (
    value.mode === "catalog" &&
    (!explanationNonEmpty(value.entityKind) || !explanationCatalog(String(value.entityKind)))
  )
    errors.push("Entity Action catalog explain kind is unsupported");
  if (value.mode === "object" && value.entityKind !== null)
    errors.push("Entity Action object explain derives kind from refs");
  if (!Array.isArray(value.refs) || value.refs.some((ref) => typeof ref !== "string" || ref.length === 0))
    errors.push("Entity Action explain request refs must be non-empty strings");
  else if (value.mode === "object" && (value.refs.length < 1 || value.refs.length > 500))
    errors.push("Entity Action object explain requires 1..500 refs");
  else if (value.mode === "catalog") {
    const selector = value.refs[0];
    if (value.refs.length > 1 || (selector !== undefined && selector !== value.entityKind))
      errors.push("Entity Action catalog explain accepts at most one matching kind selector");
  }
  return errors;
}

export function validateEntityActionExplanationSet(value: unknown): readonly string[] {
  if (!explanationRecord(value) || !explanationExact(value, ["schema", "mode", "subjects", "evaluatedAtCut"]))
    return ["Entity Action explanation set fields are incomplete or unknown"];
  const errors: string[] = [];
  if (value.schema !== ENTITY_ACTION_EXPLANATION_SCHEMA.id) errors.push("Entity Action explanation schema is invalid");
  if (!(["catalog", "object", "failure"] as readonly unknown[]).includes(value.mode))
    errors.push("Entity Action explanation mode is invalid");
  if (!Array.isArray(value.subjects) || value.subjects.length === 0)
    errors.push("Entity Action explanation subjects must be non-empty");
  else
    for (const [index, subject] of value.subjects.entries())
      errors.push(
        ...validateSubject(subject, value.mode, value.evaluatedAtCut).map((issue) => `subjects[${index}]: ${issue}`),
      );
  if (value.mode === "catalog" && Array.isArray(value.subjects) && value.subjects.length !== 1)
    errors.push("Catalog explanation requires exactly one Entity subject");
  if (
    value.mode !== "catalog" &&
    Array.isArray(value.subjects) &&
    (value.subjects.length < 1 || value.subjects.length > 500)
  )
    errors.push("Object and failure explanations require 1..500 subjects");
  if (value.evaluatedAtCut !== null && !canonicalCut(value.evaluatedAtCut))
    errors.push("Entity Action explanation evaluatedAtCut is invalid");
  if (value.mode === "catalog" && value.evaluatedAtCut !== null)
    errors.push("Catalog explanation must not claim an evaluated cut");
  if (value.mode !== "catalog" && !canonicalCut(value.evaluatedAtCut))
    errors.push("Object and failure explanations require an evaluated cut");
  if (value.mode === "failure" && Array.isArray(value.subjects) && !value.subjects.some(hasFailure))
    errors.push("Failure explanation must contain at least one typed failure");
  if (value.mode === "object" && Array.isArray(value.subjects) && value.subjects.some(hasFailure))
    errors.push("Object explanation cannot contain a typed failure");
  return errors;
}

export function serializeEntityActionExplanationSet(value: unknown): string {
  const issues = validateEntityActionExplanationSet(value);
  if (issues.length > 0)
    throw new EntityActionExplanationContractError(`Invalid Entity Action explanation: ${issues.join("; ")}`);
  return JSON.stringify(value);
}

function validateSubject(value: unknown, mode: unknown, cut: unknown): readonly string[] {
  if (!explanationRecord(value) || !explanationExact(value, ["kind", "ref", "revision", "actions", "failure"]))
    return ["subject fields are incomplete or unknown"];
  const errors: string[] = [];
  if (value.kind !== null && !explanationNonEmpty(value.kind)) errors.push("subject kind is invalid");
  if (value.ref !== null) {
    const parsed = explanationNonEmpty(value.ref) ? parseEntityRef(value.ref) : null;
    if (parsed === null || parsed.kind !== value.kind) errors.push("subject ref is invalid or does not match its kind");
    if (value.failure === null && parsed?.externalHarness) errors.push("successful object subject must be local");
  }
  if (value.revision !== null && !positiveInteger(value.revision)) errors.push("subject revision is invalid");
  if (!Array.isArray(value.actions)) errors.push("subject actions must be an array");
  else {
    for (const [index, action] of value.actions.entries())
      errors.push(...validateAction(action, mode, cut, value).map((issue) => `actions[${index}]: ${issue}`));
    if (value.failure === null) {
      const ids = value.actions.map((action) =>
          explanationRecord(action) && explanationRecord(action.action) ? action.action.id : undefined,
        ),
        canonicalIds =
          typeof value.kind === "string" ? (explanationCatalog(value.kind)?.actions.map(({ id }) => id) ?? null) : null;
      if (canonicalIds === null || JSON.stringify(ids) !== JSON.stringify(canonicalIds))
        errors.push("successful Entity subject actions must follow its canonical catalog order");
    }
  }
  if (value.failure !== null) errors.push(...validateFailure(value.failure));
  if (
    value.kind === null &&
    (!explanationRecord(value.failure) || value.failure.code !== "invalid_entity_ref" || value.ref !== null)
  )
    errors.push("only an invalid EntityRef failure may have no kind");
  if (mode === "catalog") {
    const catalog = typeof value.kind === "string" ? explanationCatalog(value.kind) : null;
    if (
      catalog === null ||
      catalog === undefined ||
      value.ref !== null ||
      value.revision !== null ||
      value.failure !== null
    )
      errors.push("catalog subject must be one static registered Entity Action catalog");
    if (!Array.isArray(value.actions) || value.actions.length !== (catalog?.actions.length ?? -1))
      errors.push("catalog subject must contain every canonical Entity Action");
  } else if (
    value.failure === null &&
    (typeof value.kind !== "string" ||
      !explanationCatalog(value.kind) ||
      value.ref === null ||
      !positiveInteger(value.revision))
  )
    errors.push("successful object subject requires a registered executable Entity ref and revision");
  if (value.failure !== null && Array.isArray(value.actions) && value.actions.length !== 0)
    errors.push("failed subject cannot contain evaluated actions");
  return errors;
}

function validateAction(
  value: unknown,
  mode: unknown,
  setCut: unknown,
  subject: Readonly<Record<string, unknown>>,
): readonly string[] {
  if (
    !explanationRecord(value) ||
    !explanationExact(value, [
      "action",
      "target",
      "available",
      "criteria",
      "unmetCriteria",
      "authorizationDecision",
      "nextActions",
      "evaluatedAtCut",
    ])
  )
    return ["action row fields are incomplete or unknown"];
  const errors: string[] = [];
  if (!validActionDescriptor(value.action)) errors.push("action descriptor is invalid");
  if (!Array.isArray(value.criteria)) errors.push("criteria must be an array");
  else
    for (const [index, criterion] of value.criteria.entries())
      errors.push(...validateCriterion(criterion).map((issue) => `criteria[${index}]: ${issue}`));
  const canonicalAction = actionContract(value.action);
  if (
    canonicalAction &&
    Array.isArray(value.criteria) &&
    JSON.stringify(value.criteria.map(staticCriterion)) !== JSON.stringify(canonicalAction.criteria)
  )
    errors.push("criteria must preserve the canonical Action contract identity and order");
  if (
    !Array.isArray(value.unmetCriteria) ||
    value.unmetCriteria.some((criterion) => !isEntityActionUnmetCriterion(criterion))
  )
    errors.push("unmetCriteria is invalid");
  else if (Array.isArray(value.criteria)) {
    const projected = value.criteria
      .filter((criterion) => explanationRecord(criterion) && criterion.status === "unmet")
      .map((criterion) => ({ ref: criterion.ref, failureCode: criterion.failureCode, explain: criterion.explain }));
    if (JSON.stringify(value.unmetCriteria) !== JSON.stringify(projected))
      errors.push("unmetCriteria must be the exact unmet criteria projection");
  }
  if (!explanationStringList(value.nextActions) || new Set(value.nextActions).size !== value.nextActions.length)
    errors.push("nextActions must be a stable unique string list");
  if (mode === "catalog") {
    if (
      value.target !== null ||
      value.available !== null ||
      value.authorizationDecision !== null ||
      value.evaluatedAtCut !== null ||
      (Array.isArray(value.unmetCriteria) && value.unmetCriteria.length !== 0) ||
      (Array.isArray(value.nextActions) && value.nextActions.length !== 0) ||
      (Array.isArray(value.criteria) &&
        value.criteria.some(
          (criterion) =>
            !explanationRecord(criterion) ||
            criterion.status !== "not-evaluated" ||
            !Array.isArray(criterion.nextActions) ||
            criterion.nextActions.length !== 0,
        ))
    )
      errors.push("catalog action dynamic fields must be null or not-evaluated");
  } else {
    if (
      !validExplanationTarget(value.target) ||
      typeof value.available !== "boolean" ||
      !canonicalCut(value.evaluatedAtCut)
    )
      errors.push("object action target, availability, or cut is invalid");
    if (!validExplanationAuthorizationDecision(value.authorizationDecision))
      errors.push("authorizationDecision is invalid");
    else if (
      Array.isArray(value.criteria) &&
      value.available !==
        (value.authorizationDecision.outcome === "allowed" &&
          value.criteria.every((criterion) => explanationRecord(criterion) && criterion.status !== "unmet"))
    )
      errors.push("available must equal authorization plus object/actor/cut capability criteria");
    else if (
      explanationRecord(value.target) &&
      (value.authorizationDecision.subject !== value.target.ref ||
        value.authorizationDecision.evaluatedAtCut !== value.evaluatedAtCut)
    )
      errors.push("authorizationDecision must match the action target and cut");
    if (
      Array.isArray(value.criteria) &&
      value.criteria.some((criterion) => explanationRecord(criterion) && criterion.status === "not-evaluated")
    )
      errors.push("object criteria cannot remain not-evaluated");
    if (
      explanationRecord(value.target) &&
      (value.target.ref !== subject.ref ||
        value.target.revision !== subject.revision ||
        value.evaluatedAtCut !== setCut)
    )
      errors.push("object action witness must match its subject and set cut");
  }
  return errors;
}

function validActionDescriptor(value: unknown): boolean {
  const canonical = actionContract(value);
  return (
    explanationRecord(value) &&
    explanationExact(value, ["kind", "id", "catalogRef", "contractVersion", "explain", "syntax"]) &&
    explanationNonEmpty(value.kind) &&
    explanationNonEmpty(value.id) &&
    explanationNonEmpty(value.catalogRef) &&
    /^\d+\.\d+$/u.test(String(value.contractVersion)) &&
    explanationNonEmpty(value.explain) &&
    explanationRecord(value.syntax) &&
    explanationExact(value.syntax, ["usage", "inputs"]) &&
    explanationNonEmpty(value.syntax.usage) &&
    Array.isArray(value.syntax.inputs) &&
    value.syntax.inputs.every(validInputField) &&
    canonical !== null &&
    value.catalogRef === explanationCatalog(String(value.kind))?.ref &&
    value.contractVersion === `${canonical.version.major}.${canonical.version.minor}` &&
    value.explain === canonical.explain &&
    JSON.stringify(value.syntax.inputs) === JSON.stringify(canonical.input.fields)
  );
}

function actionContract(value: unknown): EntityActionContract | null {
  if (!explanationRecord(value) || typeof value.kind !== "string" || typeof value.id !== "string") return null;
  return explanationCatalog(value.kind)?.actions.find(({ id }) => id === value.id) ?? null;
}

function explanationCatalog(kind: string) {
  const registered = getEntityKindContract(kind)?.actionCatalog;
  if (registered) return registered;
  if (!/^[a-z0-9][a-z0-9/-]*\/[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/u.test(kind)) return null;
  return artifactEntityActionCatalog(kind, {
    field: "entityId",
    pattern: "^[A-Z][A-Z0-9]{0,15}-[a-f0-9]{16}$",
    refTemplate: `${kind}/{id}`,
  });
}

function staticCriterion(value: unknown): unknown {
  return explanationRecord(value) ? { ref: value.ref, failureCode: value.failureCode, explain: value.explain } : value;
}

function validInputField(value: unknown): boolean {
  if (!explanationRecord(value)) return false;
  const allowed = ["field", "type", "required", "enum", "regex", "cli"];
  if (!Object.keys(value).every((field) => allowed.includes(field))) return false;
  if (
    !explanationNonEmpty(value.field) ||
    !["string", "number", "boolean", "string-array", "fact-hold-array", "json-object", "json-object-array"].includes(
      String(value.type),
    ) ||
    typeof value.required !== "boolean" ||
    (value.enum !== undefined && !explanationStringList(value.enum)) ||
    (value.regex !== undefined && typeof value.regex !== "string")
  )
    return false;
  if (value.cli === undefined) return true;
  if (!explanationRecord(value.cli)) return false;
  const cliAllowed = ["name", "kind", "error", "jsonFields", "conflictsWith", "format", "projection"];
  return (
    Object.keys(value.cli).every((field) => cliAllowed.includes(field)) &&
    explanationNonEmpty(value.cli.name) &&
    ["single", "repeated", "boolean"].includes(String(value.cli.kind)) &&
    explanationRecord(value.cli.error) &&
    explanationExact(value.cli.error, ["code", "nextAction"]) &&
    explanationNonEmpty(value.cli.error.code) &&
    explanationNonEmpty(value.cli.error.nextAction) &&
    (value.cli.jsonFields === undefined || explanationStringList(value.cli.jsonFields)) &&
    (value.cli.conflictsWith === undefined || explanationStringList(value.cli.conflictsWith)) &&
    (value.cli.format === undefined || explanationNonEmpty(value.cli.format)) &&
    (value.cli.projection === undefined || ["number", "fact-hold-array"].includes(String(value.cli.projection)))
  );
}

function validateCriterion(value: unknown): readonly string[] {
  if (!explanationRecord(value) || !explanationExact(value, ["ref", "failureCode", "explain", "status", "nextActions"]))
    return ["criterion fields are incomplete or unknown"];
  return explanationNonEmpty(value.ref) &&
    explanationNonEmpty(value.failureCode) &&
    explanationNonEmpty(value.explain) &&
    (entityActionCriterionStatuses as readonly unknown[]).includes(value.status) &&
    explanationStringList(value.nextActions)
    ? []
    : ["criterion values are invalid"];
}

function validExplanationTarget(value: unknown): boolean {
  return (
    explanationRecord(value) &&
    explanationExact(value, ["ref", "revision"]) &&
    explanationNonEmpty(value.ref) &&
    parseEntityRef(String(value.ref)) !== null &&
    positiveInteger(value.revision)
  );
}

function validateFailure(value: unknown): readonly string[] {
  return explanationRecord(value) &&
    explanationExact(value, ["code", "message", "nextActions"]) &&
    (entityActionExplanationFailureCodes as readonly unknown[]).includes(value.code) &&
    explanationNonEmpty(value.message) &&
    explanationStringList(value.nextActions)
    ? []
    : ["typed failure is invalid"];
}

function validExplanationAuthorizationDecision(value: unknown): value is AuthorizationDecision {
  if (
    !explanationRecord(value) ||
    !explanationExact(value, [
      "policyRef",
      "actor",
      "subject",
      "bindingsUsed",
      "outcome",
      "reasonCodes",
      "nextActions",
      "evaluatedAtCut",
    ])
  )
    return false;
  return (
    /^\S+@[1-9][0-9]*$/u.test(String(value.policyRef)) &&
    validateActorIdentity(value.actor).length === 0 &&
    explanationNonEmpty(value.subject) &&
    parseEntityRef(String(value.subject)) !== null &&
    Array.isArray(value.bindingsUsed) &&
    (value.outcome === "allowed" || value.outcome === "denied") &&
    explanationStringList(value.reasonCodes) &&
    explanationStringList(value.nextActions) &&
    canonicalCut(value.evaluatedAtCut) &&
    (value.outcome !== "denied" || (value.reasonCodes.length > 0 && value.nextActions.length > 0))
  );
}

function hasFailure(value: unknown): boolean {
  return explanationRecord(value) && value.failure !== null;
}

function explanationRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function explanationExact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return (
    fields.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => fields.includes(field))
  );
}

function explanationNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function explanationStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(explanationNonEmpty);
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function canonicalCut(value: unknown): value is string {
  return typeof value === "string" && /^canonical:(?:0|[1-9][0-9]*)$/u.test(value);
}
