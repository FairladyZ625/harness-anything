import { createHash } from "node:crypto";
import {
  canonicalEventWritePlan,
  sha256Bytes,
  stableStringify,
  type AgentRuntimeEventV1,
} from "../../kernel/src/index.ts";
import { archiveRuntimeDispatch } from "./doc-sync-actions.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RepoCellBinding, RuntimeIngressAction } from "./repo-cell-types.ts";

export function appendRuntimeIngress(cell: any, action: RuntimeIngressAction, binding: RepoCellBinding): JsonObject {
  const scope = binding.assignmentScope;
  if (!scope)
    throw cell.cellCodedError("assignment_required", "Runtime Fleet ingress requires an authenticated assignment.");
  if (action.kind === "archive") {
    if (action.archive.taskId !== scope.taskId || action.archive.executionId !== scope.executionId)
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
  if (!cell.runtimeIngressEventTypes.includes(action.type))
    throw cell.cellCodedError("invalid_runtime_event", "Runtime event type is not admitted by the Fleet contract.");
  if (action.type === "runtime_session_exited" || action.type === "runtime_session_outcome_observed") {
    const dispatch = cell.projection
        .readRuntimeDispatches()
        .find((event: any) => event.payload.runtimeSessionId === action.payload.runtimeSessionId),
      dispatchSource = dispatch?.source,
      ingressSource = binding.source;
    if (
      !dispatch ||
      typeof dispatchSource !== "object" ||
      dispatchSource.kind !== "assignment" ||
      typeof ingressSource !== "object" ||
      ingressSource.kind !== "assignment" ||
      dispatchSource.nodeId !== ingressSource.nodeId ||
      dispatchSource.assignmentId !== ingressSource.assignmentId
    )
      throw cell.cellCodedError(
        "assignment_scope_mismatch",
        "Runtime terminal event must come from the assignment that dispatched its session.",
      );
  }
  const existing = cell.store.readEvent(action.opId);
  if (existing) {
    if (
      existing.schema !== "agent-runtime-event/v1" ||
      existing.type !== action.type ||
      stableStringify(existing.payload) !== stableStringify(action.payload)
    )
      throw cell.cellCodedError("op_conflict", `Runtime opId ${action.opId} belongs to another canonical event.`);
    return cell.runtimeIngressReceipt(existing as AgentRuntimeEventV1);
  }
  if (
    action.type === "runtime_session_task_bound" &&
    (action.payload.taskId !== scope.taskId || action.payload.executionId !== scope.executionId)
  )
    throw cell.cellCodedError(
      "assignment_scope_mismatch",
      "Runtime task binding must match the authenticated assignment.",
    );
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
  const blobs =
    action.resultBody === undefined
      ? []
      : (() => {
          if (value.type !== "runtime_session_outcome_observed")
            throw cell.cellCodedError("invalid_runtime_event", "Only runtime outcomes can carry result bytes.");
          const bytes = Buffer.from(action.resultBody);
          if (bytes.byteLength !== value.payload.result.size || sha256Bytes(bytes) !== value.payload.result.sha256)
            throw cell.cellCodedError(
              "content_claim_mismatch",
              "Runtime result bytes do not match the declared result claim.",
            );
          return [{ ...value.payload.result, body: action.resultBody }];
        })();
  cell.store.append({
    event: value,
    plan: canonicalEventWritePlan(value, "agent-runtime/v1", value.opId),
    blobs,
  });
  cell.projection.apply(value);
  return cell.runtimeIngressReceipt(value);
}

export function runtimeIngressReceipt(cell: any, value: AgentRuntimeEventV1): JsonObject {
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
