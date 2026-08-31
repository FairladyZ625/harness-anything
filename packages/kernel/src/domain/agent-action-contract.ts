import { parseAgentDeclarationV1, type AgentDeclarationV1 } from "./agent-squad-schema.ts";
import type {
  EntityActionContract,
  EntityActionInputContract,
  EntityActionInputField,
} from "./entity-kind-registry.ts";
import type { EntityActionCompileHook } from "./entity-action-execution.ts";
import { assertTransitionDocumentReady, requireTransitionDocumentKind } from "./transition-document-readiness.ts";

export interface AgentActionDraft {
  readonly kind: "entity";
  readonly entityKind: "agent";
  readonly entity: AgentDeclarationV1;
}

const input = (
  fields: readonly EntityActionInputField[],
  exactlyOneOf: readonly (readonly string[])[] = [],
): EntityActionInputContract =>
  Object.freeze({
    schema: "entity-action-input/v1",
    fields: Object.freeze(fields.map((field) => Object.freeze(field))),
    exactlyOneOf: Object.freeze(exactlyOneOf.map((group) => Object.freeze(group))),
  });

export function createAgentActionCatalog(
  baseAction: (id: "install") => EntityActionContract,
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
    ]),
  });
}

export const compileAgentInstallAction: EntityActionCompileHook = (input): AgentActionDraft => {
  const entity = parseAgentDeclarationV1(input.action.declaration);
  assertTransitionDocumentReady(requireTransitionDocumentKind("agent.install"), entity.instructions);
  return { kind: "entity", entityKind: "agent", entity };
};
