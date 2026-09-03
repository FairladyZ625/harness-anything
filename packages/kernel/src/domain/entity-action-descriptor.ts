import type { EntityActionContract, EntityActionInputField } from "./entity-kind-registry.ts";
import { consumeKnownError } from "../error-consumption.ts";

export const RECEIPT_GUIDANCE_KINDS = [
  "repository-diff-contract",
  "task-create-publish",
  "task-create-start",
  "receipt-query",
  "edit-plan",
  "pin-agenda",
  "ledger-managed",
  "retry-receipt",
  "run-command",
  "remove-dry-run",
  "no-action",
] as const;

export type ReceiptGuidanceKind = (typeof RECEIPT_GUIDANCE_KINDS)[number];
export type ReceiptGuidanceArgument = string | number | boolean | readonly string[];
export type ReceiptGuidanceWhen = Readonly<Record<string, ReceiptGuidanceArgument>>;

export interface ReceiptGuidanceContractEntry {
  readonly kind: ReceiptGuidanceKind;
  readonly args: Readonly<Record<string, ReceiptGuidanceArgument>>;
  readonly when?: ReceiptGuidanceWhen;
}

export interface ActionReturnsContract {
  readonly schema: "action-result/v1";
  readonly fields: readonly string[];
  readonly guidance: readonly ReceiptGuidanceContractEntry[];
}

export type ActionPredicate =
  | { readonly fieldEquals: { readonly path: string; readonly value: ReceiptGuidanceArgument } }
  | { readonly all: readonly ActionPredicate[] }
  | { readonly any: readonly ActionPredicate[] }
  | { readonly not: ActionPredicate };

export interface EntityActionStateCoordinate {
  readonly existence?: "missing" | "present";
  readonly status: string | null;
  readonly currentNode: string | null;
  readonly executionState?: string | null;
  readonly reviewVerdict?: string | null;
  readonly readiness?: "ready";
}

export interface EntityActionStateTransition {
  readonly from: readonly EntityActionStateCoordinate[];
  readonly to: readonly { readonly when: ActionPredicate | null; readonly coordinate: EntityActionStateCoordinate }[];
}

export interface EntityActionResultContract {
  readonly schema: "entity-action-result/v1" | "entity-action-result/v2";
  readonly baseSchemaRef?: string;
  readonly fields: readonly EntityActionInputField[];
  readonly obligations?: readonly {
    readonly kind: "repository-diff" | "task-package-artifact";
    readonly when: ActionPredicate;
  }[];
}

export interface EntityActionPublicationContract {
  readonly preview: ActionPredicate | null;
  readonly canonicalVisible: ActionPredicate;
  readonly pendingCanonical: ActionPredicate;
  readonly receiptLookupCapabilityRef: "receipt.show";
}

export interface EntityActionOwnedArtifact {
  readonly slot: string;
  readonly role: string;
  readonly pathTemplate: string;
  readonly owner: "machine" | "doc-sync";
  readonly policyId: string;
  readonly editCapabilityRef: string | null;
  readonly scaffoldRequired: boolean;
}

export interface EntityActionManagedDocument {
  readonly slot: string;
  readonly pathTemplate: string;
  readonly authority: "typed-machine-writer" | "doc-sync";
  readonly directEdit: boolean;
  readonly readinessRequired: boolean;
  readonly scaffoldRequired: boolean;
}

export interface EntityActionFollowUp {
  readonly capabilityRef: string;
  readonly role: "primary" | "recovery" | "agenda" | "artifact";
  readonly when: ActionPredicate | null;
  readonly args: Readonly<Record<string, { readonly resultPath: string } | ReceiptGuidanceArgument>>;
}

export interface EntityActionDescriptorFacets {
  readonly stateTransition: EntityActionStateTransition | null;
  readonly result: EntityActionResultContract;
  readonly failureCodes: readonly {
    readonly code: string;
    readonly source: "input" | "criterion" | "transition" | "publication";
    readonly explain: string;
    readonly nextCapabilityRef: string | null;
  }[];
  readonly publication: EntityActionPublicationContract | null;
  readonly ownedArtifacts: readonly EntityActionOwnedArtifact[];
  readonly managedDocuments: readonly EntityActionManagedDocument[];
  readonly followUps: readonly EntityActionFollowUp[];
}

export const DEFAULT_ENTITY_ACTION_RESULT_CONTRACT: EntityActionResultContract = Object.freeze({
  schema: "entity-action-result/v1",
  fields: Object.freeze([
    { field: "outcome", type: "string" as const, required: true },
    { field: "opId", type: "string" as const, required: true },
    { field: "unmetCriteria", type: "json-object-array" as const, required: false },
    { field: "effects", type: "json-object-array" as const, required: false },
    { field: "updatedProjection", type: "json-object" as const, required: false },
    { field: "rejectionExplanation", type: "json-object" as const, required: false },
    { field: "nextAction", type: "json-object" as const, required: false },
    { field: "nextActions", type: "json-object-array" as const, required: false },
    { field: "guidance", type: "json-object-array" as const, required: false },
  ]),
});
export const DEFAULT_ENTITY_ACTION_RETURNS_CONTRACT: ActionReturnsContract = Object.freeze({
  schema: "action-result/v1",
  fields: Object.freeze(DEFAULT_ENTITY_ACTION_RESULT_CONTRACT.fields.map(({ field }) => field)),
  guidance: Object.freeze([]),
});

function fieldPaths(fields: readonly EntityActionInputField[], prefix: string): readonly string[] {
  return fields.flatMap((field) => {
    const path = `${prefix}.${field.field}`;
    return [path, ...fieldPaths(field.fields ?? [], path)];
  });
}

function predicatePaths(predicate: ActionPredicate): readonly string[] {
  if ("fieldEquals" in predicate) return [predicate.fieldEquals.path];
  if ("all" in predicate) return predicate.all.flatMap(predicatePaths);
  if ("any" in predicate) return predicate.any.flatMap(predicatePaths);
  return predicatePaths(predicate.not);
}

function predicateToWhen(predicate: ActionPredicate): ReceiptGuidanceWhen | undefined {
  if ("fieldEquals" in predicate) {
    return { [predicate.fieldEquals.path.replace(/^(input|result)\./u, "")]: predicate.fieldEquals.value };
  }
  if ("all" in predicate) {
    const entries = predicate.all.map(predicateToWhen);
    if (entries.some((entry) => entry === undefined)) return undefined;
    return Object.assign({}, ...entries);
  }
  return undefined;
}

function resolveFollowUpArgs(args: EntityActionFollowUp["args"]): Readonly<Record<string, ReceiptGuidanceArgument>> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) =>
      typeof value === "object" && value !== null && "resultPath" in value
        ? [key, `{${value.resultPath.replace(/^result\./u, "")}}`]
        : [key, value],
    ),
  );
}

const followUpKinds: Readonly<Record<string, ReceiptGuidanceKind>> = Object.freeze({
  "task.start": "task-create-start",
  "receipt.query": "receipt-query",
  "task.plan.edit": "edit-plan",
  "task.pin": "pin-agenda",
});

export function deriveActionReturnsContract(
  descriptor: Pick<
    EntityActionContract,
    "id" | "result" | "publication" | "ownedArtifacts" | "managedDocuments" | "followUps"
  >,
): ActionReturnsContract {
  const guidance: ReceiptGuidanceContractEntry[] = [];
  for (const obligation of descriptor.result.obligations ?? []) {
    const when = predicateToWhen(obligation.when);
    if (when === undefined) throw new Error(`${descriptor.id}: obligation predicate cannot be rendered as guidance`);
    guidance.push({ kind: `${obligation.kind}-contract` as ReceiptGuidanceKind, args: {}, when });
  }
  if (descriptor.publication !== null && descriptor.publication.preview !== null) {
    const previewWhen = predicateToWhen(descriptor.publication.preview);
    if (previewWhen === undefined)
      throw new Error(`${descriptor.id}: preview predicate cannot be rendered as guidance`);
    guidance.push({ kind: "task-create-publish", args: {}, when: previewWhen });
  }
  const appendFollowUps = (roles: readonly EntityActionFollowUp["role"][]) => {
    for (const followUp of descriptor.followUps.filter(({ role }) => roles.includes(role))) {
      const kind = followUpKinds[followUp.capabilityRef];
      if (!kind) continue;
      const when = followUp.when === null ? undefined : predicateToWhen(followUp.when);
      if (followUp.when !== null && when === undefined)
        throw new Error(`${descriptor.id}: ${followUp.capabilityRef} predicate cannot be rendered as guidance`);
      guidance.push({ kind, args: resolveFollowUpArgs(followUp.args), ...(when === undefined ? {} : { when }) });
    }
  };
  appendFollowUps(["primary"]);
  if (descriptor.publication !== null) {
    const when = predicateToWhen(descriptor.publication.pendingCanonical);
    if (when === undefined) throw new Error(`${descriptor.id}: pending predicate cannot be rendered as guidance`);
    guidance.push({ kind: "receipt-query", args: { opId: "{opId}" }, when });
  }
  for (const artifact of descriptor.ownedArtifacts) {
    if (artifact.editCapabilityRef === null) continue;
    const pathRoots = [...artifact.pathTemplate.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1]!);
    guidance.push({
      kind: `edit-${artifact.role}` as ReceiptGuidanceKind,
      args: Object.fromEntries(pathRoots.map((root) => [root, `{${root}}`])),
    });
  }
  appendFollowUps(["agenda", "artifact"]);
  const managedFields = descriptor.managedDocuments
    .filter((document) => !document.directEdit)
    .map((document) => document.pathTemplate.split("/").at(-1) ?? document.pathTemplate);
  if (managedFields.length > 0) guidance.push({ kind: "ledger-managed", args: { fields: managedFields } });
  const kinds = guidance.map((entry) => entry.kind);
  if (new Set(kinds).size !== kinds.length) throw new Error(`${descriptor.id}: duplicate guidance kind`);
  return {
    schema: "action-result/v1",
    guidance,
    fields: fieldPaths(descriptor.result.fields, "result").map((path) => path.replace(/^result\./u, "")),
  };
}

function predicateMatches(
  predicate: ActionPredicate | null,
  context: Readonly<{ input: Readonly<Record<string, unknown>>; result: Readonly<Record<string, unknown>> }>,
): boolean {
  if (predicate === null) return true;
  if ("fieldEquals" in predicate) {
    const [root, ...segments] = predicate.fieldEquals.path.split(".");
    let value: unknown = root === "input" ? context.input : context.result;
    for (const segment of segments) {
      if (typeof value !== "object" || value === null) return false;
      value = (value as Readonly<Record<string, unknown>>)[segment];
    }
    return value === predicate.fieldEquals.value;
  }
  if ("all" in predicate) return predicate.all.every((part) => predicateMatches(part, context));
  if ("any" in predicate) return predicate.any.some((part) => predicateMatches(part, context));
  return !predicateMatches(predicate.not, context);
}

export function projectActionState(
  descriptor: Pick<EntityActionContract, "id" | "stateTransition">,
  input: Readonly<Record<string, unknown>>,
  result: Readonly<Record<string, unknown>>,
): EntityActionStateCoordinate | null {
  if (descriptor.stateTransition === null) return null;
  const matches = descriptor.stateTransition.to.filter((branch) => predicateMatches(branch.when, { input, result }));
  if (matches.length !== 1)
    throw new Error(`${descriptor.id}: expected exactly one matching to branch, got ${matches.length}`);
  return matches[0]!.coordinate;
}

function projectFields(
  fields: readonly EntityActionInputField[],
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      if (!(field.field in value)) return [];
      const item = value[field.field];
      if (field.fields !== undefined && typeof item === "object" && item !== null && !Array.isArray(item)) {
        return [[field.field, projectFields(field.fields, item as Readonly<Record<string, unknown>>)]];
      }
      return [[field.field, item]];
    }),
  );
}

export function projectActionResult(
  descriptor: Pick<EntityActionContract, "result">,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return projectFields(descriptor.result.fields, value);
}

export function validateEntityActionDescriptor(descriptor: EntityActionContract): readonly string[] {
  const errors: string[] = [];
  const inputPaths = new Set(fieldPaths(descriptor.input.fields, "input"));
  const resultPaths = new Set(fieldPaths(descriptor.result.fields, "result"));
  const declaredPaths = new Set([...inputPaths, ...resultPaths]);
  const validatePredicate = (label: string, predicate: ActionPredicate): void => {
    for (const path of predicatePaths(predicate)) {
      if (!declaredPaths.has(path)) errors.push(`${label} references undeclared path ${path}`);
    }
  };
  const validateResultPredicate = (label: string, predicate: ActionPredicate) => {
    validatePredicate(label, predicate);
    for (const path of predicatePaths(predicate)) {
      if (!path.startsWith("result.")) errors.push(`${label} must reference result paths: ${path}`);
    }
  };
  descriptor.stateTransition?.to.forEach(
    (branch, index) => branch.when === null || validatePredicate(`stateTransition.to[${index}]`, branch.when),
  );
  if (descriptor.publication !== null) {
    if (descriptor.publication.preview !== null)
      validateResultPredicate("publication.preview", descriptor.publication.preview);
    validateResultPredicate("publication.canonicalVisible", descriptor.publication.canonicalVisible);
    validateResultPredicate("publication.pendingCanonical", descriptor.publication.pendingCanonical);
  }
  descriptor.result.obligations?.forEach((item, index) =>
    validateResultPredicate(`result.obligations[${index}]`, item.when),
  );
  descriptor.followUps.forEach((followUp, index) => {
    if (followUp.when !== null) validateResultPredicate(`followUps[${index}]`, followUp.when);
    for (const value of Object.values(followUp.args)) {
      if (typeof value === "object" && value !== null && "resultPath" in value && !resultPaths.has(value.resultPath))
        errors.push(`followUps[${index}] references undeclared path ${value.resultPath}`);
    }
  });
  descriptor.ownedArtifacts.forEach((artifact, index) => {
    for (const match of artifact.pathTemplate.matchAll(/\{([^}]+)\}/gu)) {
      if (!resultPaths.has(`result.${match[1]}`))
        errors.push(`ownedArtifacts[${index}] references undeclared result path result.${match[1]}`);
    }
  });
  const failureCodes = new Set(descriptor.failureCodes.map((entry) => entry.code));
  if (failureCodes.size !== descriptor.failureCodes.length) errors.push("failureCodes contains duplicates");
  for (const { failureCode } of descriptor.criteria)
    if (!failureCodes.has(failureCode)) errors.push(`criterion failure code is undeclared: ${failureCode}`);
  for (const field of descriptor.input.fields)
    if (field.cli !== undefined && !failureCodes.has(field.cli.error.code))
      errors.push(`CLI failure code is undeclared: ${field.cli.error.code}`);
  for (const group of descriptor.input.exactlyOneOf)
    for (const field of group)
      if (!inputPaths.has(`input.${field}`)) errors.push(`exactlyOneOf references undeclared path input.${field}`);
  try {
    deriveActionReturnsContract(descriptor);
  } catch (error) {
    consumeKnownError(error);
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export function assertEntityActionDescriptor(descriptor: EntityActionContract): void {
  const errors = validateEntityActionDescriptor(descriptor);
  if (errors.length) throw new Error(`${descriptor.id}: invalid action descriptor: ${errors.join("; ")}`);
}

export function withDerivedActionReturns(descriptor: EntityActionContract): EntityActionContract {
  const derived = Object.freeze({ ...descriptor, returns: Object.freeze(deriveActionReturnsContract(descriptor)) });
  assertEntityActionDescriptor(derived);
  return Object.freeze(derived);
}
