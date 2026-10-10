import { samePrincipal } from "@harness-anything/kernel";
import { requireSquadRuntimeOwner, requireSquadRuntimeAdmission } from "./squad-runtime-ingress.ts";
import { admitHandoffDispatch } from "./runtime-handoff-store.ts";
import { createHash } from "node:crypto";
import {
  canonicalEventWritePlan,
  currentSubmittedExecutions,
  runtimeEventContentClaims,
  stableStringify,
  submissionDigest,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel";
import { archiveRuntimeDispatch } from "./doc-sync-actions.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RepoCellBinding, RuntimeIngressAction } from "./repo-cell-types.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";

const auxiliaryEventTypes = Object.freeze([
  "runtime_installation_observed",
  "runtime_dispatch_requested",
  "runtime_squad_run_observed",
  "runtime_dispatch_outcome_unknown",
  "runtime_handoff_exported",
  "runtime_handoff_revoked",
] as const satisfies readonly AgentRuntimeEventV1["type"][]);

export function appendAuxiliaryRuntimeIngress(
  cell: RepoCellActionContext,
  action: RuntimeIngressAction,
  binding: RepoCellBinding,
  trustedHandoff = false,
): JsonObject {
  if (action.kind === "event" && action.type.startsWith("runtime_handoff_") && !trustedHandoff)
    throw cell.cellCodedError("invalid_runtime_event", "Handoff audit events require the authorized handoff action.");
  const remote = typeof binding.source === "object" && binding.source.kind === "node";
  if (action.kind === "archive") {
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
  requireSquadRuntimeOwner(cell, action, binding);
  const existing = cell.store.readEvent(action.opId);
  if (existing) {
    if (
      existing.schema !== "agent-runtime-event/v1" ||
      existing.type !== action.type ||
      stableStringify(existing.payload) !== stableStringify(action.payload)
    )
      throw cell.cellCodedError("op_conflict", `Runtime opId ${action.opId} belongs to another canonical event.`);
    return { ...runtimeIngressReceipt(cell, existing as AgentRuntimeEventV1), replayed: true };
  }
  if (action.dispatchContext !== undefined && action.type !== "runtime_dispatch_requested")
    throw cell.cellCodedError(
      "invalid_runtime_event",
      "Runtime dispatch admission context is only valid on runtime_dispatch_requested.",
    );
  if (action.type === "runtime_dispatch_requested") {
    if (remote && action.dispatchContext === undefined)
      throw cell.cellCodedError("invalid_runtime_event", "Remote runtime dispatch requires center admission context.");
    const dispatch = action.dispatchContext;
    if (remote && dispatch) {
      if (
        dispatch.role !== (action.payload.role ?? null) ||
        dispatch.taskId !== (action.payload.taskId ?? null) ||
        dispatch.executionId !== (action.payload.executionId ?? null)
      )
        throw cell.cellCodedError("runtime_scope_mismatch", "Dispatch context must match its task and execution.");
      if (dispatch.taskId !== null) {
        const snapshot = requireCurrentTaskProjection(
          cell.projection,
          dispatch.taskId,
          "remote runtime dispatch",
        ).snapshot;
        if (dispatch.role === "reviewer") {
          if (
            !currentSubmittedExecutions(snapshot).some(
              (execution) =>
                execution.executionId === dispatch.executionId &&
                stableStringify(action.payload.reviewTarget) ===
                  stableStringify({
                    kind: "task",
                    taskId: dispatch.taskId,
                    executionId: dispatch.executionId,
                    digest: submissionDigest(execution.submission!),
                  }),
            )
          )
            throw cell.cellCodedError(
              "task_not_submitted",
              "Reviewer dispatch requires the current submitted execution.",
            );
        } else {
          const held = cell.projection.currentLease(dispatch.taskId);
          if (
            !held ||
            held.phase !== "held" ||
            held.executionId !== dispatch.executionId ||
            !samePrincipal(held.actor.principal, binding.actor.principal) ||
            stableStringify(held.source) !== stableStringify(binding.source)
          )
            throw cell.cellCodedError(
              "runtime_task_lease_required",
              "Implementation dispatch requires this node's canonical task lease.",
            );
        }
      }
    }
    admitHandoffDispatch(cell, action.payload, binding);
    const sourceId = action.payload.resumedFromDispatchId;
    if (typeof sourceId === "string") {
      const source = cell.projection.readRuntimeDispatchById(sourceId)?.event,
        session = source ? cell.projection.readRuntimeSession(source.payload.runtimeSessionId) : null;
      if (!source || !session?.providerSessionId)
        throw cell.cellCodedError(
          "runtime_dispatch_not_resumable",
          `Dispatch ${sourceId} has no provider session to resume.`,
        );
      if (
        // admitHandoffDispatch already requires an accepted export and the target's active lease.
        (!samePrincipal(source.actor.principal, binding.actor.principal) &&
          !(
            action.payload.handoffCheckpointId !== undefined &&
            source.actor.principal.kind === "machine" &&
            binding.actor.principal.kind === "machine"
          )) ||
        source.payload.taskId !== action.payload.taskId ||
        (action.payload.handoffCheckpointId === undefined &&
          source.payload.executionId !== action.payload.executionId) ||
        (remote &&
          ((source.payload.taskId ?? null) !== dispatch?.taskId ||
            (action.payload.handoffCheckpointId === undefined &&
              (source.payload.executionId ?? null) !== dispatch?.executionId)))
      )
        throw cell.cellCodedError(
          "runtime_resume_binding_mismatch",
          "Resume must retain the source owner, task and execution.",
        );
      if (source.payload.agentId !== action.payload.agentId)
        throw cell.cellCodedError("runtime_resume_agent_mismatch", "Resume must retain the source agent.");
      const successor = cell.projection.readRuntimeDispatchByResumeSource(sourceId);
      if (successor)
        throw cell.cellCodedError(
          "runtime_dispatch_already_resumed",
          `Dispatch ${sourceId} was already resumed as ${successor.event.payload.dispatchId}.`,
        );
    }
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
  requireSquadRuntimeAdmission(cell, action, binding);
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
  } as unknown as JsonObject;
}
