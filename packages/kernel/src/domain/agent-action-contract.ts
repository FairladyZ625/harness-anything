import { parseAgentDeclarationV1, type AgentDeclarationV1 } from "./agent-squad-schema.ts";
import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import { attributeEntityActionCriterion, type EntityActionCompileHook } from "./entity-action-execution.ts";
import { assertTransitionDocumentReady, requireTransitionDocumentKind } from "./transition-document-readiness.ts";

export interface AgentActionDraft {
  readonly kind: "entity";
  readonly entityKind: "agent";
  readonly entity: AgentDeclarationV1;
}

export const agentActionIds = Object.freeze(["install", "validate", "list", "inspect"] as const);
export type AgentActionId = (typeof agentActionIds)[number];

const input = (
  fields: readonly EntityActionInputField[],
  exactlyOneOf: readonly (readonly string[])[] = [],
): EntityActionInputContract =>
  Object.freeze({
    schema: "entity-action-input/v1",
    fields: Object.freeze(fields.map((field) => Object.freeze(field))),
    exactlyOneOf: Object.freeze(exactlyOneOf.map((group) => Object.freeze(group))),
  });

const readConcurrency: EntityActionContract["concurrency"] = Object.freeze({
  expectedVersion: Object.freeze({ authority: "canonical-projection-cut", required: false }),
  leasePolicy: Object.freeze({ authority: "not-applicable" }),
  occurrenceClaim: Object.freeze({ authority: "not-applicable" }),
  idempotency: Object.freeze({ authority: "operation-id", input: "idempotencyKey" }),
  artifactOwnership: Object.freeze({ authority: "not-applicable" }),
});

export function createAgentActionCatalog(
  baseAction: (id: AgentActionId) => EntityActionContract,
  actionResultContract: EntityActionContract["returns"],
) {
  const declared = baseAction("install");
  return Object.freeze({
    ref: "kernel/agent-action/v1",
    actions: Object.freeze([
      Object.freeze({
        ...declared,
        input: input(
          [
            { field: "packageSource", type: "string", required: false },
            { field: "declaration", type: "json-object", required: false },
            { field: "declarationSource", type: "string", required: false },
            { field: "generatedOnly", type: "boolean", required: false },
            { field: "validated", type: "boolean", required: false },
            { field: "dryRun", type: "boolean", required: false },
            { field: "expectedVersion", type: "number", required: false },
            { field: "idempotencyKey", type: "string", required: false },
          ],
          [["packageSource", "declaration"]],
        ),
        policy: Object.freeze({ ref: "default@5", action: "agent-install" }),
        criteria: Object.freeze([
          {
            ref: "agent/declaration-schema",
            failureCode: "invalid_manifest",
            explain: "The Agent declaration must satisfy agent-declaration/v1 before publication.",
          },
          {
            ref: "agent/instructions-ready",
            failureCode: "instructions_placeholder",
            explain: "Agent instructions must contain authored content rather than the declaration scaffold.",
          },
          {
            ref: "agent/generated-validation",
            failureCode: "agent_validation_required",
            explain: "Generated Agent output must complete the validate step before installation.",
          },
          {
            ref: "agent/generated-identity",
            failureCode: "agent_id_conflict",
            explain: "Generated Agent installation never replaces an existing Agent identity.",
          },
          {
            ref: "agent/runtime-compatibility",
            failureCode: "agent_runtime_type_unavailable",
            explain: "Generated Agent runtime_type must resolve to an enabled runtime instance.",
          },
          {
            ref: "agent/model-compatibility",
            failureCode: "agent_model_unavailable",
            explain: "Generated Agent model must be supported by a compatible runtime instance.",
          },
          {
            ref: "agent/entity-revision",
            failureCode: "revision_conflict",
            explain: "When supplied, expectedVersion must match the latest Agent entity revision.",
          },
        ]),
        concurrency: Object.freeze({
          expectedVersion: Object.freeze({
            authority: "entity-event/v1 Agent projection revision",
            required: false,
            default: "center-bound-current-revision",
            conflict: "revision_conflict",
          }),
          leasePolicy: Object.freeze({ authority: "not-applicable" }),
          occurrenceClaim: Object.freeze({ authority: "not-applicable" }),
          idempotency: Object.freeze({
            authority: "operation-id",
            input: "idempotencyKey",
            scope: "agent/{id}/install",
            retry: "canonical-event-replay",
          }),
          artifactOwnership: Object.freeze({
            owner: "agent/{id}",
            declaration: "agents/{id}.json",
            policy: "typed-entity/v1",
          }),
        }),
        effects: Object.freeze([{ ref: "entity-event/entity_upserted", projection: "AgentProjection" }]),
        returns: actionResultContract,
        explain: "Install one validated Agent declaration through the canonical entity event stream.",
        execution: Object.freeze({
          ingress: "agent-install",
          compile: compileAgentInstallAction,
          read: false,
          implementation: "compiled-event" as const,
          topology: "center-forward-write" as const,
          targetIdField: "entityId",
        }),
      }),
      Object.freeze({
        ...baseAction("validate"),
        input: input([{ field: "packageSource", type: "string", required: true }]),
        policy: Object.freeze({ ref: "default@5", action: null }),
        criteria: Object.freeze([
          {
            ref: "agent/declaration-schema",
            failureCode: "invalid_manifest",
            explain: "The supplied package contains a valid agent-declaration/v1 manifest.",
          },
          {
            ref: "agent/instructions-ready",
            failureCode: "instructions_placeholder",
            explain: "The supplied package contains authored Agent instructions.",
          },
        ]),
        concurrency: readConcurrency,
        effects: Object.freeze([]),
        returns: actionResultContract,
        explain: "Validate one Agent declaration package without mutation.",
        execution: Object.freeze({
          ingress: "agent-validate",
          compile: null,
          read: true,
          implementation: "catalog-runtime" as const,
        }),
      }),
      Object.freeze({
        ...baseAction("list"),
        input: input([]),
        policy: Object.freeze({ ref: "default@5", action: null }),
        criteria: Object.freeze([]),
        concurrency: readConcurrency,
        effects: Object.freeze([]),
        returns: actionResultContract,
        explain: "List installed Agent declarations from the canonical projection cut.",
        execution: Object.freeze({
          ingress: "agent-list",
          compile: null,
          read: true,
          implementation: "catalog-runtime" as const,
        }),
      }),
      Object.freeze({
        ...baseAction("inspect"),
        input: input([{ field: "agentId", type: "string", required: true }]),
        policy: Object.freeze({ ref: "default@5", action: null }),
        criteria: Object.freeze([
          {
            ref: "agent/entity-present",
            failureCode: "agent_not_found",
            explain: "The requested Agent exists at the canonical cut.",
          },
        ]),
        concurrency: readConcurrency,
        effects: Object.freeze([]),
        returns: actionResultContract,
        explain: "Inspect one Agent declaration and its instructions from the canonical projection cut.",
        execution: Object.freeze({
          ingress: "agent-inspect",
          compile: null,
          read: true,
          implementation: "catalog-runtime" as const,
          targetIdField: "agentId",
        }),
      }),
    ]),
  });
}

export const compileAgentInstallAction: EntityActionCompileHook = (input): AgentActionDraft => {
  let entity: AgentDeclarationV1;
  try {
    entity = parseAgentDeclarationV1(input.action.declaration);
  } catch (error) {
    throw agentCriterionError(error, "agent/declaration-schema", "invalid_manifest");
  }
  try {
    assertTransitionDocumentReady(requireTransitionDocumentKind("agent.install"), entity.instructions);
  } catch (error) {
    throw agentCriterionError(error, "agent/instructions-ready", "instructions_placeholder");
  }
  return { kind: "entity", entityKind: "agent", entity };
};

function agentCriterionError(error: unknown, criterionRef: string, fallbackCode: string): Error {
  const attributed = error instanceof Error ? error : Object.assign(new Error(String(error)), { code: fallbackCode });
  if (!("code" in attributed)) Object.assign(attributed, { code: fallbackCode });
  return attributeEntityActionCriterion(attributed, "install", criterionRef);
}
