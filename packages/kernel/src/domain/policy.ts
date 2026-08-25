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
  "isExecutorOfExecution",
  "hasCommandClass",
  "reviewIndependence",
] as const);
export type PolicyPredicateName = (typeof policyPredicateNames)[number];

export const reviewIndependenceLevels = Object.freeze(["L1", "L2"] as const);
export type ReviewIndependenceLevel = (typeof reviewIndependenceLevels)[number];

export type PolicyPredicateExpression =
  | { readonly predicate: "isOwner" }
  | { readonly predicate: "isExecutorOfExecution" }
  | { readonly predicate: "hasCommandClass"; readonly commandClass: string }
  | { readonly predicate: "reviewIndependence"; readonly level: ReviewIndependenceLevel };

export interface PolicyActionRule {
  readonly action: string;
  readonly mode: "all" | "any";
  readonly predicates: readonly PolicyPredicateExpression[];
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
        required: ["action", "mode", "predicates"],
        properties: {
          action: nonEmpty("Action identifier covered by this rule."),
          mode: {
            type: "string",
            enum: ["all", "any"],
            description: "Whether all or any rule predicates must hold.",
          },
          predicates: {
            type: "array",
            minItems: 1,
            items: predicateSchema,
            description: "Kernel predicate expressions for the Action.",
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
    actionSet = new Set(actions);
  if (rules.some((rule) => !isRecord(rule) || typeof rule.action !== "string" || !actionSet.has(rule.action)))
    errors.push("every policy rule must target an applicable Action");
  if (new Set(rules.map((rule) => (isRecord(rule) ? rule.action : undefined))).size !== rules.length)
    errors.push("policy rules must contain one rule per Action");
  for (const expression of [...(Array.isArray(policy.predicates) ? policy.predicates : []), ...rulePredicates(rules)])
    errors.push(...validatePredicateExpression(expression));
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
  if (value.predicate === "isOwner" || value.predicate === "isExecutorOfExecution") {
    if (Object.keys(value).length !== 1) return [`${value.predicate} does not accept arguments`];
  }
  return [];
}

function rulePredicates(rules: readonly unknown[]): readonly unknown[] {
  return rules.flatMap((rule) => (isRecord(rule) && Array.isArray(rule.predicates) ? rule.predicates : []));
}
