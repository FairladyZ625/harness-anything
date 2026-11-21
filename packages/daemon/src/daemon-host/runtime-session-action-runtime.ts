import {
  attributeEntityActionCriterion,
  getExecutableEntityAction,
  MIGRATION_IMPORT_SOURCE,
  type TaskProjection,
  type AgentRuntimeEventV1,
  stableStringify,
  runtimeSessionAcceptsLivenessEvent,
  sha256Text,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import {
  deriveActionResult,
  type EntityActionCatalogPreparer,
} from "@harness-anything/application/internal/commands/entity-action-catalog-executor.ts";
import { steerReceiptOpId } from "./dispatch-steer-state.ts";
import type { RepoCellActionContext } from "./repo-cell-types.ts";
import type { RepoCellBinding, RepoTaskAction, RuntimeIngressAction } from "./repo-cell-types.ts";

export function runtimeSessionActionPreparer(projection: () => TaskProjection): EntityActionCatalogPreparer {
  return (contract, action, binding: RepoCellBinding) => {
    if (action.reasonCode === "ruling_resolved" && binding.executionPrincipal)
      invalidRuntimeSessionAction("execution_credential_rejected", "A runtime cannot answer its own owner ruling.");
    const runtimeSessionId = requiredRuntimeActionText(action.runtimeSessionId, "runtimeSessionId"),
      dispatch = projection().readRuntimeDispatch(runtimeSessionId),
      dispatchSource = dispatch?.source,
      ingressSource = binding.source,
      localOwner = dispatchSource === "local" && ingressSource === "local";
    // Genesis replay imports a frozen source generation: its sessions have a creation event but no
    // dispatch. Only a terminal event from the same person on the local center can settle one; the
    // creation record is the ownership fence, so a remote node can never claim the session.
    if (!dispatch && importedSessionTerminalSettlement(projection(), runtimeSessionId, action, binding)) return action;
    const recovery = binding.orphanRecovery,
      recoveryMatches =
        recovery !== undefined &&
        recovery.dispatchId === dispatch?.payload.dispatchId &&
        recovery.audit.originalPersonId === dispatch.actor.principal.personId &&
        recovery.audit.adminPersonId === binding.actor.principal.personId &&
        binding.actor.executor === null &&
        stableStringify(dispatchSource) === stableStringify(ingressSource) &&
        (action.kind === "runtime_session_exited" ||
          action.kind === "runtime_session_cancelled" ||
          action.kind === "runtime_session_outcome_observed");
    if (action.orphanRecovery !== undefined)
      invalidRuntimeSessionAction(
        "execution_scope_mismatch",
        "Orphan recovery evidence must come from the center writer.",
      );
    const controlRequest =
      action.kind === "runtime_session_liveness_changed" &&
      typeof action.controlRequest === "object" &&
      action.controlRequest !== null &&
      !Array.isArray(action.controlRequest)
        ? (action.controlRequest as { readonly targetNodeId?: unknown })
        : null;
    if (
      action.kind === "runtime_session_liveness_changed" &&
      (action.controlRequest !== undefined || action.controlReceipt !== undefined) &&
      (action.processGroupPid !== undefined || action.providerUnreachable !== undefined)
    )
      invalidRuntimeSessionAction(
        "invalid_runtime_event",
        "Control carrier events cannot mutate processGroupPid or providerUnreachable.",
      );
    if (
      action.kind === "runtime_session_liveness_changed" &&
      action.controlRequest !== undefined &&
      !binding.trustedRemoteControl
    )
      invalidRuntimeSessionAction(
        "invalid_runtime_event",
        "Remote runtime control requests require the authorized runtime control action.",
      );
    const remoteControlAuthorized =
      binding.trustedRemoteControl === true &&
      controlRequest !== null &&
      dispatch !== null &&
      typeof dispatchSource === "object" &&
      dispatchSource !== null &&
      dispatchSource.kind === "node" &&
      typeof controlRequest.targetNodeId === "string" &&
      dispatchSource.nodeId === controlRequest.targetNodeId &&
      binding.actor.executor === null &&
      !binding.executionPrincipal &&
      dispatch.actor.principal.personId === binding.actor.principal.personId;
    if (!localOwner && !recoveryMatches && !remoteControlAuthorized) {
      if (
        !dispatch ||
        typeof dispatchSource !== "object" ||
        dispatchSource.kind !== "node" ||
        typeof ingressSource !== "object" ||
        ingressSource.kind !== "node" ||
        dispatch.actor.principal.personId !== binding.actor.principal.personId ||
        dispatchSource.nodeId !== ingressSource.nodeId
      )
        invalidRuntimeSessionAction(
          "execution_scope_mismatch",
          "RuntimeSession events must come from the node and owner that own the session dispatch.",
          contract.id,
          "runtime-session/node-fence",
        );
      const claimedTask =
        action.kind === "runtime_session_task_bound"
          ? { taskId: action.taskId, executionId: action.executionId }
          : action.kind === "runtime_session_started" &&
              typeof action.taskBinding === "object" &&
              action.taskBinding !== null &&
              "taskId" in action.taskBinding &&
              "executionId" in action.taskBinding
            ? { taskId: action.taskBinding.taskId, executionId: action.taskBinding.executionId }
            : null;
      if (
        claimedTask !== null &&
        (claimedTask.taskId !== dispatch.payload.taskId || claimedTask.executionId !== dispatch.payload.executionId)
      )
        invalidRuntimeSessionAction(
          "execution_scope_mismatch",
          "RuntimeSession task and execution binding must match the canonical dispatch.",
          contract.id,
          "runtime-session/task-binding",
        );
    }
    if (!dispatch)
      invalidRuntimeSessionAction(
        "execution_scope_mismatch",
        "RuntimeSession events require a canonical dispatch owned by their ingress source.",
        contract.id,
        "runtime-session/node-fence",
      );
    return {
      ...action,
      dispatchId: dispatch.payload.dispatchId,
      ...(recoveryMatches && action.kind === "runtime_session_outcome_observed"
        ? { orphanRecovery: recovery.audit }
        : {}),
    };
  };
}

/**
 * A genesis-replayed RuntimeSession has no dispatch; its creation event is the only ownership
 * record. This admits only a terminal settlement, only from the local center, and only for the
 * person the session was imported for. Ordinary dispatch-backed sessions never reach it, and a
 * remote node's source can never match.
 */
function importedSessionTerminalSettlement(
  projection: TaskProjection,
  runtimeSessionId: string,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): boolean {
  if (action.kind !== "runtime_session_exited" && action.kind !== "runtime_session_outcome_observed") return false;
  if (binding.source !== "local") return false;
  const started = projection
    .readRuntimeSessionEvents(runtimeSessionId, 0, 1)
    .find((event) => event.type === "runtime_session_started");
  return (
    started?.source === MIGRATION_IMPORT_SOURCE &&
    started.actor.principal.personId === binding.actor.principal.personId &&
    (started.actor.executor?.id ?? null) === (binding.actor.executor?.id ?? null)
  );
}

/** Commit one RuntimeSession catalog Action while the caller owns the RepoCell writer queue. */
export async function commitRuntimeSessionAction(
  cell: RepoCellActionContext,
  action: Extract<RuntimeIngressAction, { readonly kind: "event" }>,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const catalogAction = {
      kind: action.type,
      ...action.payload,
      ...(action.resultBody === undefined ? {} : { resultBody: action.resultBody }),
    },
    contract = getExecutableEntityAction(catalogAction.kind);
  if (!contract || contract.target.kind !== "runtime-session")
    throw Object.assign(new Error(`${catalogAction.kind} is not a RuntimeSession catalog Action.`), {
      code: "invalid_store",
    });
  // F15 & F5 & F18: Every controlReceipt must fence against its persisted original control request
  // (repo, session, owner node, dispatchId, controlRequestId, requestOpId) and enforce a single
  // terminal receipt per requestOpId. When the session already has a provider binding (guaranteed
  // for every remote steer), persist the receipt on runtime_session_provider_bound with the
  // existing binding so it survives post-exit late delivery with zero liveness/lifecycle mutation
  // and full N-1 (bb7e55c90) reducer compatibility.
  let effectiveAction: RepoTaskAction = catalogAction,
    effectiveContract = contract;
  if (
    (action.type === "runtime_session_liveness_changed" || action.type === "runtime_session_provider_bound") &&
    action.payload.controlReceipt !== undefined
  ) {
    try {
      const fenced = fenceControlReceipt(cell, action, binding, catalogAction, contract);
      if (fenced.disposition === "no_changes") return fenced.receipt;
      effectiveAction = fenced.catalogAction;
      effectiveContract = fenced.contract;
    } catch (error) {
      return deriveActionResult(contract, catalogAction, cell.failed(action.opId, error, contract, catalogAction));
    }
  }
  try {
    return await cell.entityActionExecutor.run(effectiveAction, binding, action.opId, cell.entityActionRuntimes);
  } catch (error) {
    return deriveActionResult(
      effectiveContract,
      effectiveAction,
      cell.failed(action.opId, error, effectiveContract, effectiveAction),
    );
  }
}

function fenceControlReceipt(
  cell: RepoCellActionContext,
  action: Extract<RuntimeIngressAction, { readonly kind: "event" }>,
  binding: RepoCellBinding,
  catalogAction: RepoTaskAction,
  contract: NonNullable<ReturnType<typeof getExecutableEntityAction>>,
):
  | {
      readonly disposition: "proceed";
      readonly catalogAction: RepoTaskAction;
      readonly contract: NonNullable<ReturnType<typeof getExecutableEntityAction>>;
    }
  | { readonly disposition: "no_changes"; readonly receipt: WriteReceipt } {
  const runtimeSessionId = requiredRuntimeActionText(action.payload.runtimeSessionId, "runtimeSessionId"),
    rawReceipt = action.payload.controlReceipt;
  if (rawReceipt === null || typeof rawReceipt !== "object" || Array.isArray(rawReceipt))
    invalidRuntimeSessionAction("invalid_control_receipt", "Control receipt payload must be an object.");
  type RuntimeControlReceiptPayload = NonNullable<
    Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_liveness_changed" }>["payload"]["controlReceipt"]
  >;
  const receipt = rawReceipt as Partial<RuntimeControlReceiptPayload>;
  if (
    receipt.action !== "steer" ||
    typeof receipt.controlRequestId !== "string" ||
    !receipt.controlRequestId.trim() ||
    typeof receipt.requestOpId !== "string" ||
    !receipt.requestOpId.trim() ||
    (receipt.status !== "applied" && receipt.status !== "rejected")
  )
    invalidRuntimeSessionAction("invalid_control_receipt", "Control receipt is missing required request correlation.");
  if (binding.executionPrincipal)
    invalidRuntimeSessionAction("execution_credential_rejected", "A runtime worker cannot forge a control receipt.");
  const dispatch = cell.projection.readRuntimeDispatch(runtimeSessionId);
  if (
    !dispatch ||
    typeof dispatch.source !== "object" ||
    dispatch.source === null ||
    dispatch.source.kind !== "node" ||
    typeof binding.source !== "object" ||
    binding.source === null ||
    binding.source.kind !== "node" ||
    dispatch.source.nodeId !== binding.source.nodeId ||
    dispatch.actor.principal.personId !== binding.actor.principal.personId
  )
    invalidRuntimeSessionAction(
      "execution_scope_mismatch",
      "Control receipt must come from the node and owner that own the session dispatch.",
    );
  const original = cell.store.readEvent(receipt.requestOpId);
  if (!original || original.schema !== "agent-runtime-event/v1")
    invalidRuntimeSessionAction(
      "control_request_not_found",
      `Control receipt references unknown control request ${receipt.requestOpId}.`,
    );
  const origSteer =
    original.type === "runtime_steer_requested"
      ? {
          runtimeSessionId: original.payload.runtimeSessionId,
          controlRequestId: original.payload.controlRequestId,
          targetNodeId: original.payload.targetNodeId,
          dispatchId: original.payload.dispatchId,
        }
      : original.type === "runtime_session_liveness_changed" && original.payload.controlRequest?.action === "steer"
        ? {
            runtimeSessionId: original.payload.runtimeSessionId,
            controlRequestId: original.payload.controlRequest.controlRequestId,
            targetNodeId: original.payload.controlRequest.targetNodeId,
            dispatchId: original.payload.controlRequest.dispatchId,
          }
        : null;
  if (
    !origSteer ||
    origSteer.runtimeSessionId !== runtimeSessionId ||
    origSteer.controlRequestId !== receipt.controlRequestId ||
    origSteer.targetNodeId !== dispatch.source.nodeId ||
    origSteer.dispatchId !== dispatch.payload.dispatchId ||
    (receipt.dispatchId !== undefined && receipt.dispatchId !== origSteer.dispatchId)
  )
    invalidRuntimeSessionAction(
      "invalid_control_receipt",
      `Control receipt does not match persisted steer request ${receipt.requestOpId}.`,
    );
  const canonicalReceiptOpId = steerReceiptOpId(cell.input.repoId, runtimeSessionId, receipt.requestOpId);
  if (action.opId !== canonicalReceiptOpId)
    invalidRuntimeSessionAction(
      "invalid_control_receipt",
      "Control receipt opId must match the canonical single-receipt identity for its control request.",
    );
  const existing = cell.store.readEvent(canonicalReceiptOpId);
  if (existing !== null) {
    const existingReceipt =
      existing.schema === "agent-runtime-event/v1" &&
      (existing.type === "runtime_session_liveness_changed" || existing.type === "runtime_session_provider_bound")
        ? existing.payload.controlReceipt
        : undefined;
    const sameOutcome =
      existingReceipt !== undefined &&
      existingReceipt.action === receipt.action &&
      existingReceipt.controlRequestId === receipt.controlRequestId &&
      existingReceipt.requestOpId === receipt.requestOpId &&
      existingReceipt.status === receipt.status &&
      (existingReceipt.dispatchId ?? origSteer.dispatchId) === (receipt.dispatchId ?? origSteer.dispatchId) &&
      existingReceipt.steerVersion === receipt.steerVersion &&
      (existingReceipt.reasonCode ?? null) === (receipt.reasonCode ?? null);
    if (!sameOutcome)
      invalidRuntimeSessionAction(
        "control_receipt_conflict",
        `Control request ${receipt.requestOpId} already recorded a conflicting terminal receipt.`,
      );
    return {
      disposition: "no_changes",
      receipt: {
        outcome: "no_changes",
        code: "no_changes",
        origin: "runtime-session",
        opId: canonicalReceiptOpId,
        revision: existing.workspaceRevision,
        evidence: `event-object:${canonicalReceiptOpId}`,
        visibility: "center",
        status: "settled_no_write",
      } as WriteReceipt,
    };
  }
  const session = cell.projection.readRuntimeSession(runtimeSessionId);
  // F5 & F18: Prefer runtime_session_provider_bound when the session already has a provider
  // binding. That carrier preserves session.liveness / attachable / lastObservedAt / attempt.process
  // identically and remains accepted by N-1 (bb7e55c90) reduceRuntimeSession even after exit.
  if (session !== null && session.providerSessionId !== null && session.transcriptRef !== null) {
    const providerBoundContract = getExecutableEntityAction("runtime_session_provider_bound");
    if (providerBoundContract) {
      return {
        disposition: "proceed",
        contract: providerBoundContract,
        catalogAction: {
          kind: "runtime_session_provider_bound",
          runtimeSessionId,
          providerSessionId: session.providerSessionId,
          transcriptRef: session.transcriptRef,
          controlReceipt: rawReceipt,
        },
      };
    }
  }
  if (session !== null && !runtimeSessionAcceptsLivenessEvent(session)) {
    return {
      disposition: "no_changes",
      receipt: {
        outcome: "no_changes",
        code: "no_changes",
        origin: "runtime-session",
        opId: canonicalReceiptOpId,
        revision: cell.store.readHead()?.revision ?? 0,
        evidence: `session-exited:${runtimeSessionId}:${canonicalReceiptOpId}`,
        visibility: "center",
        status: "settled_no_write",
      } as WriteReceipt,
    };
  }
  if (action.type === "runtime_session_liveness_changed") {
    return {
      disposition: "proceed",
      contract,
      catalogAction: {
        kind: "runtime_session_liveness_changed",
        runtimeSessionId,
        liveness: session?.liveness ?? "unknown",
        controlReceipt: rawReceipt,
      },
    };
  }
  return { disposition: "proceed", contract, catalogAction };
}

/** The first atomic admission has not returned to its node, so no provider can have launched.
 * Settle at the accepting writer when credential creation fails, before an execution identity exists.
 */
export async function settleUnlaunchedRuntimeSession(
  cell: RepoCellActionContext,
  execution: { readonly runtimeSessionId: string; readonly dispatchId: string },
  opId: string,
  binding: RepoCellBinding,
): Promise<void> {
  const { runtimeSessionId, dispatchId } = execution,
    terminalBinding: RepoCellBinding = {
      ...binding,
      actor: { ...binding.actor, executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` } },
    },
    body = "Runtime dispatch failed before execution credential issuance.",
    sha256 = sha256Text(body);
  for (const action of [
    { kind: "event", type: "runtime_session_exited", opId: `${opId}-launch-exited`, payload: { runtimeSessionId } },
    {
      kind: "event",
      type: "runtime_session_outcome_observed",
      opId: `${opId}-launch-failed`,
      payload: {
        runtimeSessionId,
        dispatchId,
        outcome: "failed",
        exitCode: null,
        resultRef: `artifact:runtime-result/sha256/${sha256}`,
        result: { sha256, size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" },
      },
      resultBody: body,
    },
  ] as const) {
    const receipt = await commitRuntimeSessionAction(cell, action, terminalBinding);
    if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes")
      throw cell.cellCodedError(receipt.code ?? "runtime_event_rejected", String(receipt.evidence));
  }
}

function requiredRuntimeActionText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  invalidRuntimeSessionAction("invalid_runtime_event", `${field} is required.`);
}

function invalidRuntimeSessionAction(code: string, message: string, actionId?: string, criterionRef?: string): never {
  const error = Object.assign(new Error(message), { code });
  throw actionId && criterionRef ? attributeEntityActionCriterion(error, actionId, criterionRef) : error;
}

/** Shared occurrence source check; Squad observations also require the local principal. */
export function requireRuntimeDispatchOwner(
  dispatch: Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }> | null,
  binding: RepoCellBinding,
  strictLocalPrincipal = false,
): void {
  const local = dispatch?.source === "local" && binding.source === "local";
  if (
    !dispatch ||
    (!local && stableStringify(dispatch.source) !== stableStringify(binding.source)) ||
    ((!local || strictLocalPrincipal) && dispatch.actor.principal.personId !== binding.actor.principal.personId)
  )
    invalidRuntimeSessionAction(
      "execution_scope_mismatch",
      "Runtime publication must come from the canonical dispatch owner and source.",
    );
}

/** Historical task attribution shared by dispatch archives and run observations. */
export function runtimeDispatchTaskMatches(input: {
  readonly projection: Pick<TaskProjection, "readRuntimeSession" | "readLeaseIntervals">;
  readonly dispatch: Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }> | null | undefined;
  readonly binding: RepoCellBinding;
  readonly runtimeSessionId: string;
  readonly taskId: string;
  readonly executionId: string | null;
}): boolean {
  const { projection, dispatch, binding, runtimeSessionId, taskId, executionId } = input;
  return (
    projection
      .readRuntimeSession(runtimeSessionId)
      ?.taskBindings.some((scope) => scope.taskId === taskId && scope.executionId === executionId) === true ||
    projection
      .readLeaseIntervals(taskId)
      .some(
        (interval) =>
          interval.executionId === executionId &&
          interval.holder.actor.executor?.id === `runtime-session:${runtimeSessionId}` &&
          interval.holder.actor.principal.personId === binding.actor.principal.personId,
      ) ||
    (dispatch?.payload.taskId === taskId &&
      dispatch.payload.executionId === executionId &&
      stableStringify(dispatch.source) === stableStringify(binding.source))
  );
}
