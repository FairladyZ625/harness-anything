import {
  EntitySchemaContractError,
  ENTITY_ID_PATTERN,
  parseEntityJsonSchema,
  serializeEntityJsonSchema,
  validateEntityJsonSchema,
  type EntityDocumentJsonSchema,
} from "./entity-json-schema.ts";
import { isRecord } from "./write-chain.contract.ts";

export const policyPredicateNames = Object.freeze([
  "isOwner",
  "isSameExecutionOwner",
  "holdsExecutionLease",
  "reclaimsOrphanedLease",
  "dispatchesExecution",
  "delegatedByRuntimeSession",
  "hasCommandClass",
  "reviewIndependence",
  "isNotProposalAgent",
  "sameWriteSource",
] as const);
export type PolicyPredicateName = (typeof policyPredicateNames)[number];

export const reviewIndependenceLevels = Object.freeze(["L1", "L2"] as const);
export type ReviewIndependenceLevel = (typeof reviewIndependenceLevels)[number];

type PolicyPredicate =
  | { readonly predicate: "isOwner" }
  | { readonly predicate: "isSameExecutionOwner" }
  | { readonly predicate: "holdsExecutionLease" }
  | { readonly predicate: "reclaimsOrphanedLease" }
  | { readonly predicate: "dispatchesExecution" }
  | { readonly predicate: "delegatedByRuntimeSession" }
  | { readonly predicate: "hasCommandClass"; readonly commandClass: string }
  | { readonly predicate: "reviewIndependence"; readonly level: ReviewIndependenceLevel }
  | { readonly predicate: "isNotProposalAgent" }
  | { readonly predicate: "sameWriteSource" };

export type PolicyPredicateExpression = PolicyPredicate;

export interface PolicyPredicateClause {
  readonly allOf: readonly PolicyPredicateExpression[];
}

export interface PolicyActionRule {
  readonly action: string;
  readonly scope?: string;
  /** Disjunctive normal form: one allOf clause must hold. */
  readonly anyOf: readonly PolicyPredicateClause[];
}

export interface PolicyDeclarationV1 {
  readonly schema: "policy/v1";
  readonly id: string;
  readonly version: number;
  readonly predicates: readonly PolicyPredicateExpression[];
  readonly actions: readonly string[];
  readonly rules?: readonly PolicyActionRule[];
}

const nonEmpty = (description: string) => ({ type: "string" as const, minLength: 1, description });
const slug = (description: string) => ({
  type: "string" as const,
  pattern: ENTITY_ID_PATTERN,
  description,
});
const predicateSchema = {
  type: "object" as const,
  additionalProperties: false as const,
  required: ["predicate"] as const,
  properties: {
    predicate: {
      type: "string" as const,
      enum: policyPredicateNames,
      description: "One of the kernel authorization predicates.",
    },
    commandClass: nonEmpty("Command class required by hasCommandClass."),
    level: {
      type: "string" as const,
      enum: reviewIndependenceLevels,
      description: "Review independence level (L1 executor axis, L2 principal axis).",
    },
  },
};
const predicateClauseSchema = {
  type: "object" as const,
  additionalProperties: false as const,
  required: ["allOf"] as const,
  properties: {
    allOf: {
      type: "array" as const,
      minItems: 1,
      items: predicateSchema,
      description: "Predicate expressions that must all hold in this authorization branch.",
    },
  },
};

export const POLICY_DECLARATION_V1_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "policy/v1",
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["schema", "id", "version", "predicates", "actions"]),
  properties: Object.freeze({
    schema: { type: "string", const: "policy/v1", description: "Schema discriminator." },
    id: { ...slug("Stable Policy identity."), "x-error": "must be a lowercase entity slug." },
    version: {
      type: "number",
      integer: true,
      minimum: 1,
      description: "Monotonically increasing Policy version.",
    },
    predicates: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      description: "Kernel predicate expressions available to this Policy.",
      items: predicateSchema,
    },
    actions: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      description: "Action identifiers to which this Policy applies.",
      items: nonEmpty("Applicable Action identifier."),
    },
    rules: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      description: "Per-Action predicate expressions evaluated by the AuthorizationPort.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "anyOf"],
        properties: {
          action: nonEmpty("Action identifier covered by this rule."),
          scope: nonEmpty("Optional lifecycle scope for an Action with multiple authorization stages."),
          anyOf: {
            type: "array",
            minItems: 1,
            items: predicateClauseSchema,
            description: "Authorization branches; at least one allOf branch must hold.",
          },
        },
      },
    },
  }),
}) as EntityDocumentJsonSchema<PolicyDeclarationV1>;

export class PolicyEntityContractError extends EntitySchemaContractError {
  constructor(message: string) {
    super(message);
    this.name = "PolicyEntityContractError";
  }
}

export function validatePolicyDeclarationV1(value: unknown): readonly string[] {
  const errors = [...validateEntityJsonSchema(POLICY_DECLARATION_V1_SCHEMA, value, "policy declaration")];
  if (errors.length || !isRecord(value)) return errors;
  const policy = value as Partial<PolicyDeclarationV1>,
    actions = Array.isArray(policy.actions) ? policy.actions : [],
    rules = Array.isArray(policy.rules) ? policy.rules : [],
    actionSet = new Set(actions),
    predicateDeclarations = Array.isArray(policy.predicates) ? policy.predicates : [],
    declared = new Set(predicateDeclarations.map(predicateKey));
  if (rules.some((rule) => !isRecord(rule) || typeof rule.action !== "string" || !actionSet.has(rule.action)))
    errors.push("every policy rule must target an applicable Action");
  if (
    new Set(
      rules.map((rule) =>
        isRecord(rule) ? `${String(rule.action)}\0${typeof rule.scope === "string" ? rule.scope : ""}` : undefined,
      ),
    ).size !== rules.length
  )
    errors.push("policy rules must contain one rule per Action and scope");
  if (actions.some((action) => !rules.some((rule) => isRecord(rule) && rule.action === action)))
    errors.push("every applicable Action must have at least one policy rule");
  const usedPredicates = rulePredicates(rules);
  for (const expression of [...predicateDeclarations, ...usedPredicates])
    errors.push(...validatePredicateExpression(expression));
  if (usedPredicates.some((expression) => !declared.has(predicateKey(expression))))
    errors.push("every rule predicate expression must be declared by the Policy");
  if (
    predicateDeclarations.some(
      (expression) => !usedPredicates.some((used) => predicateKey(used) === predicateKey(expression)),
    )
  )
    errors.push("every declared Policy predicate expression must be used by a rule");
  return errors;
}

export function parsePolicyDeclarationV1(value: unknown): PolicyDeclarationV1 {
  const errors = validatePolicyDeclarationV1(value);
  if (errors.length) throw new PolicyEntityContractError(errors.join("; "));
  return parseEntityJsonSchema(POLICY_DECLARATION_V1_SCHEMA, value, "policy declaration");
}

export function serializePolicyDeclarationV1(value: unknown): string {
  return serializeEntityJsonSchema(POLICY_DECLARATION_V1_SCHEMA, parsePolicyDeclarationV1(value), "policy declaration");
}

function validatePredicateExpression(value: unknown): readonly string[] {
  if (!isRecord(value) || typeof value.predicate !== "string") return ["policy predicate expression is invalid"];
  if (!policyPredicateNames.includes(value.predicate as PolicyPredicateName))
    return [`unknown policy predicate: ${value.predicate}`];
  if (value.predicate === "hasCommandClass" && (typeof value.commandClass !== "string" || !value.commandClass.trim()))
    return ["hasCommandClass requires a non-empty commandClass"];
  if (
    value.predicate === "reviewIndependence" &&
    !reviewIndependenceLevels.includes(value.level as ReviewIndependenceLevel)
  )
    return ["reviewIndependence requires level L1 or L2"];
  if (value.predicate !== "hasCommandClass" && value.predicate !== "reviewIndependence") {
    if (Object.keys(value).some((key) => key !== "predicate")) return [`${value.predicate} does not accept arguments`];
  }
  return [];
}

function rulePredicates(rules: readonly unknown[]): readonly unknown[] {
  return rules.flatMap((rule) =>
    isRecord(rule) && Array.isArray(rule.anyOf)
      ? rule.anyOf.flatMap((clause) => (isRecord(clause) && Array.isArray(clause.allOf) ? clause.allOf : []))
      : [],
  );
}

function predicateKey(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}
