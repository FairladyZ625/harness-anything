import { parseAgentDeclarationV1, requiredPreparedText, type AgentDeclarationV1 } from "./agent-squad-schema.ts";
import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import { attributeEntityActionCriterion, type EntityActionCompileHook } from "./entity-action-execution.ts";
import { assertTransitionDocumentReady, requireTransitionDocumentKind } from "./transition-document-readiness.ts";

export type AgentActionDraft =
  | { readonly kind: "entity"; readonly entityKind: "agent"; readonly entity: AgentDeclarationV1 }
  | {
      readonly kind: "entity-delete";
      readonly entityKind: "agent";
      readonly entityId: string;
      readonly baseBlobSha256: string;
      readonly reason: string;
    }
  | {
      readonly kind: "agent-retire";
      readonly entityId: string;
      readonly priorVersion: number;
      readonly retiredAt: string;
      readonly reason: string;
      readonly successor?: string;
    };

export const agentActionIds = Object.freeze(["install", "delete", "retire", "validate", "list", "inspect"] as const);
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
            { field: "dryRun", type: "boolean", required: false },
            { field: "expectedVersion", type: "number", required: false },
            { field: "idempotencyKey", type: "string", required: false },
          ],
          [["packageSource", "declaration"]],
        ),
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
            ref: "agent/runtime-compatibility",
            failureCode: "agent_runtime_type_unavailable",
            explain: "Agent runtimes must resolve to an enabled runtime instance.",
          },
          {
            ref: "agent/model-compatibility",
            failureCode: "agent_model_unavailable",
            explain: "Generated Agent model must be supported by a compatible runtime instance.",
          },
          {
            ref: "agent/lifecycle",
            failureCode: "agent_retired",
            explain: "A retired Agent identity cannot be reinstalled or revived.",
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
        ...baseAction("delete"),
        input: input([
          { field: "agentId", type: "string", required: true },
          { field: "reason", type: "string", required: true },
          { field: "expectedVersion", type: "number", required: true },
          { field: "idempotencyKey", type: "string", required: false },
        ]),
        criteria: Object.freeze([
          {
            ref: "agent/entity-present",
            failureCode: "agent_not_found",
            explain: "The Agent exists at the canonical projection cut before deletion.",
          },
          {
            ref: "agent/entity-revision",
            failureCode: "revision_conflict",
            explain: "expectedVersion matches the latest Agent entity revision.",
          },
        ]),
        concurrency: Object.freeze({
          ...declared.concurrency,
          expectedVersion: Object.freeze({
            authority: "entity-event/v1 Agent projection revision",
            required: true,
            conflict: "revision_conflict",
          }),
          idempotency: Object.freeze({
            authority: "operation-id",
            input: "idempotencyKey",
            scope: "agent/{id}/delete",
            retry: "canonical-event-replay",
          }),
        }),
        effects: Object.freeze([{ ref: "entity-event/entity_deleted", projection: "AgentProjection" }]),
        returns: actionResultContract,
        explain: "Delete one Agent current view while retaining its accepted content object history.",
        execution: Object.freeze({
          ingress: "agent-delete",
          compile: compileAgentDeleteAction,
          read: false,
          implementation: "compiled-event" as const,
          topology: "center-forward-write" as const,
          targetIdField: "entityId",
        }),
      }),
      Object.freeze({
        ...baseAction("retire"),
        input: input([
          { field: "agentId", type: "string", required: true },
          { field: "reason", type: "string", required: true },
          { field: "successor", type: "string", required: false },
          { field: "expectedVersion", type: "number", required: false },
          { field: "idempotencyKey", type: "string", required: false },
        ]),
        criteria: Object.freeze([
          {
            ref: "agent/entity-present",
            failureCode: "agent_not_found",
            explain: "The Agent exists at the canonical projection cut before retirement.",
          },
          {
            ref: "agent/lifecycle",
            failureCode: "agent_not_active",
            explain: "Only an active Agent can transition to retired.",
          },
        ]),
        concurrency: Object.freeze({
          ...declared.concurrency,
          expectedVersion: Object.freeze({
            authority: "entity-event/v1 Agent projection revision",
            required: false,
            conflict: "revision_conflict",
          }),
          idempotency: Object.freeze({
            authority: "operation-id",
            input: "idempotencyKey",
            scope: "agent/{id}/retire",
            retry: "canonical-event-replay",
          }),
        }),
        effects: Object.freeze([{ ref: "entity-event/agent_retired", projection: "AgentProjection" }]),
        returns: actionResultContract,
        explain: "Retire one active Agent through the canonical entity event stream.",
        execution: Object.freeze({
          ingress: "agent-retire",
          compile: compileAgentRetireAction,
          read: false,
          implementation: "compiled-event" as const,
          topology: "center-forward-write" as const,
          targetIdField: "agentId",
        }),
      }),
      Object.freeze({
        ...baseAction("validate"),
        input: input([{ field: "packageSource", type: "string", required: true }]),
        policy: Object.freeze({ ref: "keycloak-policy@1", action: null }),
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
        policy: Object.freeze({ ref: "keycloak-policy@1", action: null }),
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
        policy: Object.freeze({ ref: "keycloak-policy@1", action: null }),
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

export const compileAgentDeleteAction: EntityActionCompileHook = (input): AgentActionDraft => ({
  kind: "entity-delete",
  entityKind: "agent",
  entityId: requiredPreparedText("Agent", input.action.entityId, "entityId"),
  baseBlobSha256: requiredPreparedText("Agent", input.action.baseBlobSha256, "baseBlobSha256"),
  reason: requiredPreparedText("Agent", input.action.reason, "reason"),
});

export const compileAgentRetireAction: EntityActionCompileHook = (input): AgentActionDraft => {
  const entityId = requiredPreparedText("Agent", input.action.agentId, "agentId"),
    reason = requiredPreparedText("Agent", input.action.reason, "reason"),
    priorVersion = input.entityRevision;
  if (!Number.isSafeInteger(priorVersion) || priorVersion === undefined || priorVersion < 1)
    throw Object.assign(new Error(`Agent ${entityId} has no current projection revision.`), {
      code: "agent_not_found",
    });
  if (
    input.action.expectedVersion !== undefined &&
    (!Number.isSafeInteger(input.action.expectedVersion) || Number(input.action.expectedVersion) !== priorVersion)
  )
    throw Object.assign(
      new Error(
        `Agent ${entityId} expected revision ${String(input.action.expectedVersion)} differs from current revision ${String(priorVersion)}.`,
      ),
      {
        code: "revision_conflict",
      },
    );
  const lifecycleState =
    typeof input.currentEntity === "object" && input.currentEntity !== null
      ? ((input.currentEntity as { readonly lifecycleState?: string }).lifecycleState ?? "active")
      : "active";
  if (lifecycleState !== "active")
    throw Object.assign(new Error(`Agent ${entityId} is ${lifecycleState} and cannot be retired.`), {
      code: lifecycleState === "retired" ? "agent_retired" : "agent_not_active",
    });
  const successor =
    typeof input.action.successor === "string" && input.action.successor.trim()
      ? input.action.successor.trim()
      : undefined;
  return {
    kind: "agent-retire",
    entityId,
    priorVersion,
    retiredAt: input.occurredAt,
    reason,
    ...(successor === undefined ? {} : { successor }),
  };
};

function agentCriterionError(error: unknown, criterionRef: string, fallbackCode: string): Error {
  const attributed = error instanceof Error ? error : Object.assign(new Error(String(error)), { code: fallbackCode });
  if (!("code" in attributed)) Object.assign(attributed, { code: fallbackCode });
  return attributeEntityActionCriterion(attributed, "install", criterionRef);
}
