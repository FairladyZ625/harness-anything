import { createHash } from "node:crypto";
import {
  canonicalEventWritePlan,
  runtimeEventContentClaims,
  stableStringify,
  type AgentRuntimeEventV1,
} from "../../kernel/src/index.ts";
import { archiveRuntimeDispatch } from "./doc-sync-actions.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RepoCellBinding, RuntimeIngressAction } from "./repo-cell-types.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";

const auxiliaryEventTypes = Object.freeze([
  "runtime_installation_observed",
  "runtime_dispatch_requested",
  "runtime_dispatch_outcome_unknown",
] as const satisfies readonly AgentRuntimeEventV1["type"][]);

export function appendAuxiliaryRuntimeIngress(
  cell: RepoCellActionContext,
  action: RuntimeIngressAction,
  binding: RepoCellBinding,
): JsonObject {
  const scope = binding.assignmentScope;
  if (!scope)
    throw cell.cellCodedError("assignment_required", "Runtime Fleet ingress requires an authenticated assignment.");
  if (action.kind === "archive") {
    if (
      scope.scope.kind !== "task" ||
      action.archive.taskId !== scope.scope.taskId ||
      action.archive.executionId !== scope.scope.executionId
    )
      throw cell.cellCodedError(
        "assignment_scope_mismatch",
        "Runtime archive task and execution must match the authenticated assignment.",
      );
    return archiveRuntimeDispatch({
      workspaceId: cell.input.repoId,
      rootDir: cell.rootDir,
      store: cell.store,
      projection: cell.projection,
      binding,
      now: cell.now,
      archive: action.archive,
    }) as unknown as JsonObject;
  }
  if (!auxiliaryEventTypes.includes(action.type as (typeof auxiliaryEventTypes)[number]))
    throw cell.cellCodedError(
      "invalid_runtime_event",
      "RuntimeSession events must execute through the Entity Action catalog.",
    );
  if (action.resultBody !== undefined && action.type !== "runtime_dispatch_requested")
    throw cell.cellCodedError("invalid_runtime_event", "Only a runtime dispatch can carry auxiliary content bytes.");
  const existing = cell.store.readEvent(action.opId);
  if (existing) {
    if (
      existing.schema !== "agent-runtime-event/v1" ||
      existing.type !== action.type ||
      stableStringify(existing.payload) !== stableStringify(action.payload)
    )
      throw cell.cellCodedError("op_conflict", `Runtime opId ${action.opId} belongs to another canonical event.`);
    return runtimeIngressReceipt(cell, existing as AgentRuntimeEventV1);
  }
  if (action.type === "runtime_dispatch_requested") {
    const key = cell.requiredCellText(action.payload.idempotencyKey, "idempotencyKey"),
      hash = createHash("sha256").update(`${cell.input.repoId}\0${key}`).digest("hex");
    if (
      action.payload.dispatchId !== `dispatch_${hash.slice(0, 24)}` ||
      action.payload.runtimeSessionId !== `runtime_${hash.slice(24, 48)}` ||
      action.opId !== `runtime-spawn-${hash.slice(0, 32)}`
    )
      throw cell.cellCodedError(
        "invalid_runtime_event",
        "Runtime dispatch identity is not derived from its repository idempotency key.",
      );
  }
  const value = {
    schema: "agent-runtime-event/v1",
    eventId: `event-${createHash("sha256").update(action.opId).digest("hex")}`,
    workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
    opId: action.opId,
    type: action.type,
    actor: binding.actor,
    source: binding.source,
    occurredAt: cell.now(),
    payload: action.payload,
  } as AgentRuntimeEventV1;
  const claims = runtimeEventContentClaims(value),
    blobs =
      action.resultBody === undefined
        ? []
        : claims.length === 1
          ? [{ ...claims[0]!, body: action.resultBody }]
          : (() => {
              throw cell.cellCodedError(
                "invalid_runtime_event",
                "Runtime dispatch content does not match a declared artifact.",
              );
            })();
  cell.store.append({
    event: value,
    plan: canonicalEventWritePlan(value, "agent-runtime/v1", value.opId),
    blobs,
  });
  cell.projection.apply(value);
  return runtimeIngressReceipt(cell, value);
}

export function runtimeIngressReceipt(cell: RepoCellActionContext, value: AgentRuntimeEventV1): JsonObject {
  const publication = cell.store.publication(value),
    visible = publication.cut.opId === value.opId && publication.cut.revision === value.workspaceRevision;
  return {
    schema: "command-receipt/v2",
    ok: visible,
    command: "runtime-ingress",
    outcome: visible ? "applied" : "pending",
    opId: value.opId,
    revision: value.workspaceRevision,
    evidence: `event-object:${value.opId}`,
    visibility: "center",
    proof: {
      committedRevision: value.workspaceRevision,
      appliedCut: publication.cut.revision,
      durable: visible,
      canonicalVisible: visible,
      worktreeVisible: null,
    },
    event: value,
    nextAction: visible ? null : `Query receipt ${value.opId}.`,
  } as unknown as JsonObject;
}
