import { requireSquadRuntimeOwner, requireSquadRuntimeAdmission } from "./squad-runtime-ingress.ts";
import { admitHandoffDispatch } from "./runtime-handoff-store.ts";
import { createHash } from "node:crypto";
import {
  canonicalEventWritePlan,
  currentSubmittedExecutions,
  isSamePerson,
  isReturnedRuntimeContinuation,
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
import { noChanges } from "./entity-action-write-helpers.ts";

const auxiliaryEventTypes = Object.freeze([
  "runtime_installation_observed",
  "runtime_dispatch_requested",
  "runtime_squad_run_observed",
  "runtime_dispatch_outcome_unknown",
  "runtime_handoff_exported",
  "runtime_handoff_revoked",
] as const satisfies readonly AgentRuntimeEventV1["type"][]);

/**
 * The reviewer seat a dispatch key belongs to. Every current seat is a `task-review:` key qualified
 * by the reviewer, so a resume may continue the same seat and nothing else; historical
 * `task-review-lane:` keys keep their own segment so a pre-single-seat reviewer can still resume.
 */
function reviewerSeatKey(dispatchKey: unknown): string | null {
  if (typeof dispatchKey !== "string") return null;
  if (dispatchKey.startsWith("task-review-lane:")) return dispatchKey.split(":").slice(0, 3).join(":");
  if (!dispatchKey.startsWith("task-review:")) return null;
  const segments = dispatchKey.split(":"),
    reviewerAt = segments.indexOf("reviewer"),
    reviewerId = reviewerAt > 0 ? segments[reviewerAt + 1] : undefined;
  return reviewerId ? `task-review:${reviewerId}` : "task-review";
}

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
  if (action.dispatchContext !== undefined && action.type !== "runtime_dispatch_requested")
    throw cell.cellCodedError(
      "invalid_runtime_event",
      "Runtime dispatch admission context is only valid on runtime_dispatch_requested.",
    );
  if (action.type === "runtime_squad_run_observed") {
    const current = cell.projection.readSquadRun(String(action.payload.squadRunId))?.state as
      | Record<string, unknown>
      | undefined;
    if (current && Number(action.payload.runRevision) === Number(current.runRevision)) {
      const currentPayload = Object.fromEntries(Object.keys(action.payload).map((key) => [key, current[key]]));
      if (stableStringify(currentPayload) === stableStringify(action.payload))
        return noChanges({
          opId: action.opId,
          revision: cell.store.readHead()?.revision ?? 0,
          headRevision: cell.projection.readCut().watermark,
          evidence: JSON.stringify({
            schema: "squad-observation-no-changes/v1",
            squadRunId: action.payload.squadRunId,
            runRevision: action.payload.runRevision,
          }),
          origin: "runtime-squad-observation",
        }) as unknown as JsonObject;
    }
  }
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
            held.actor.principal.personId !== binding.actor.principal.personId ||
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
      const returnedContinuation =
        typeof source.payload.taskId === "string" &&
        source.payload.role !== "reviewer" &&
        action.payload.role !== "reviewer" &&
        isReturnedRuntimeContinuation(
          requireCurrentTaskProjection(cell.projection, source.payload.taskId, "runtime resume").snapshot,
          source.payload.executionId,
          action.payload.executionId,
        );
      const reviewerContinuation =
        source.payload.role === "reviewer" &&
        action.payload.role === "reviewer" &&
        source.payload.taskId === action.payload.taskId &&
        source.payload.agentId === action.payload.agentId &&
        reviewerSeatKey(source.payload.dispatchKey) !== null &&
        reviewerSeatKey(source.payload.dispatchKey) === reviewerSeatKey(action.payload.dispatchKey);
      if (
        !isSamePerson(source.actor, binding.actor) ||
        source.payload.taskId !== action.payload.taskId ||
        (action.payload.handoffCheckpointId === undefined &&
          source.payload.executionId !== action.payload.executionId &&
          !returnedContinuation &&
          !reviewerContinuation) ||
        (remote &&
          ((source.payload.taskId ?? null) !== dispatch?.taskId ||
            (action.payload.handoffCheckpointId === undefined &&
              (source.payload.executionId ?? null) !== dispatch?.executionId &&
              !returnedContinuation &&
              !reviewerContinuation)))
      )
        throw cell.cellCodedError(
          "runtime_resume_binding_mismatch",
          "Resume must retain the source owner and task, and the execution unless continuing its returned round.",
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
    const key = cell.requiredCellText(action.payload.dispatchKey, "dispatchKey"),
      hash = createHash("sha256").update(`${cell.input.repoId}\0${key}`).digest("hex");
    if (
      action.payload.dispatchId !== `dispatch_${hash.slice(0, 24)}` ||
      action.payload.runtimeSessionId !== `runtime_${hash.slice(24, 48)}`
    )
      throw cell.cellCodedError(
        "invalid_runtime_event",
        "Runtime dispatch identity is not derived from its repository dispatch key.",
      );
    const existing = cell.projection.readRuntimeDispatchByDispatchKey(key)?.event;
    if (existing) {
      const existingPayload = { ...existing.payload },
        incomingPayload = { ...action.payload };
      delete existingPayload.startedAt;
      delete incomingPayload.startedAt;
      if (
        stableStringify(existingPayload) !== stableStringify(incomingPayload) ||
        stableStringify(existing.actor) !== stableStringify(binding.actor) ||
        stableStringify(existing.source) !== stableStringify(binding.source)
      )
        throw cell.cellCodedError("dispatch_key_conflict", `Dispatch key ${key} already names different content.`);
      return { ...runtimeIngressReceipt(cell, existing), reused: true };
    }
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
