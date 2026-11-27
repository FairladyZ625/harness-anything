import { orphanRuntimeStopDisposition } from "@harness-anything/kernel/internal/domain/orphan-runtime-recovery.ts";
import { readOrphanRuntimeRecoveryAuthority } from "./runtime-online-binding.ts";
import {
  observeRuntimeDispatchOwnerGroup,
  readRuntimeDispatchOwner,
  readRuntimeDispatchOwnerEvidence,
  type RuntimeDispatchOwner,
} from "./runtime-dispatch-owner-evidence.ts";
import { auditedOrphanTerminal } from "./runtime-orphan-recovery.ts";
import { createHash } from "node:crypto";
import { runtimeSessionCarrierLiveness, sameWriteSource, sha256Text } from "@harness-anything/kernel";
import { readCanonicalRuntimeResult } from "./runtime-result-read.ts";
import { readFallbackExhaustion } from "./runtime-spawn-fallback.ts";
import { daemonMethodPayloadFields } from "./protocol/daemon-protocol-commands.ts";
import { unknownFieldViolation, type JsonObject } from "./protocol/json-rpc-types.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "../runtime-engine/runtime-spawn-errors.ts";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import { adoptRuntimes, ownedByRuntimeSpawner, assertRuntimeRecoveryReady } from "./runtime-spawn-adoption.ts";
import {
  appendRuntimeWorkerRecord,
  findLiveDispatchStreamPath,
  isValidDispatchStreamId,
  readDispatchStream,
  readDispatchStreamHeader,
  readDispatchStreamSummary,
  type DispatchStreamHeader,
} from "./dispatch-stream.ts";
import { runtimeKindForId } from "../runtime-engine/runtime-inventory.ts";
import {
  observeRecordedProcessGroup,
  probeProcessGroup,
  processGroupRecoveryHint,
} from "./runtime/process-group-reconciler.ts";
import type { ActiveRuntime, RuntimeBinding, RuntimeDispatchOwnerEvidence } from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import { disposeActiveRuntimeObservations } from "./runtime-spawn-active.ts";
import {
  dispatchLifecyclePendingError,
  readDispatchLifecycle,
  readyDispatchLifecycle,
} from "./runtime-dispatch-admission.ts";
import {
  findRuntimeSteerHeader,
  parseRuntimeSteerExpectation,
  resolveRuntimeSteerHeader,
  runtimeSteerMismatch,
  runtimeSteerReceiptTarget,
  runtimeSteerRefusal,
  runtimeSteerTarget,
  type RuntimeSteerExpectation,
  type RuntimeSteerSelector,
} from "./runtime-steer-target.ts";
import {
  buildQueuedSteerReceipt,
  consumeQueuedSteersAfterTurn,
  enqueueQueuedSteer,
  queuedSteerTargetRefusalReason,
  type RuntimeSteerMode,
} from "./runtime-queued-steer.ts";

function isRemoteNodeSource(source: unknown): source is { readonly kind: "node"; readonly nodeId: string } {
  return (
    typeof source === "object" &&
    source !== null &&
    "kind" in source &&
    (source as { readonly kind?: unknown }).kind === "node" &&
    "nodeId" in source &&
    typeof (source as { readonly nodeId?: unknown }).nodeId === "string"
  );
}

export async function cancelRuntime(
  context: RuntimeSpawnerContext,
  payload: JsonObject,
  binding: RuntimeBinding,
): Promise<JsonObject> {
  const allowed = [...new Set([...daemonMethodPayloadFields("repo.agentRuntime.cancel"), "escalation"])],
    unknownField = unknownFieldViolation(payload, allowed);
  if (unknownField)
    throw runtimeSpawnError("invalid_runtime_cancel", `Runtime cancel payload contains an ${unknownField}`);
  const runtimeSessionId = requiredRuntimeSpawnText(payload.runtimeSessionId, "runtimeSessionId"),
    escalation = payload.escalation === true,
    reason = typeof payload.reason === "string" ? payload.reason.trim() : null,
    ruling = payload.ruling === undefined ? null : requiredRuntimeSpawnText(payload.ruling, "ruling").trim(),
    idempotencyKey =
      payload.idempotencyKey === undefined
        ? null
        : requiredRuntimeSpawnText(payload.idempotencyKey, "idempotencyKey").trim(),
    hash = createHash("sha256").update(`${context.input.repoId}\0${runtimeSessionId}`).digest("hex"),
    opId = `runtime-cancel-${hash.slice(0, 32)}`;
  if (ruling === "") throw runtimeSpawnError("invalid_runtime_ruling", "Owner ruling reason must not be empty.");
  if (payload.reason !== undefined && !reason)
    throw runtimeSpawnError("invalid_field", "Recovery reason must not be empty.");
  if (payload.idempotencyKey !== undefined && !idempotencyKey)
    throw runtimeSpawnError("invalid_field", "Runtime cancel idempotencyKey must not be empty.");
  // Authorize against the active handle Map or canonical dispatch via O(1) point lookup (F4).
  // Never scan session liveness history here; PID evidence is read lazily only on recovery paths.
  const runtimeHandles = context.processes;
  let active = runtimeHandles.get(runtimeSessionId);
  const directActiveHeader =
      active && isValidDispatchStreamId(active.dispatchId)
        ? readDispatchStreamHeader(context.input.rootDir, active.dispatchId)
        : null,
    canonicalDispatch: RuntimeDispatchOwner | RuntimeDispatchOwnerEvidence | null =
      directActiveHeader !== null
        ? null
        : context.input.remote?.readRuntimeDispatch
          ? await context.input.remote.readRuntimeDispatch(runtimeSessionId)
          : readRuntimeDispatchOwner(context.requiredRuntimeProjection(context.input), runtimeSessionId);
  let matchingHeader =
    directActiveHeader ??
    (canonicalDispatch?.payload?.dispatchId && isValidDispatchStreamId(canonicalDispatch.payload.dispatchId)
      ? (readDispatchStreamHeader(context.input.rootDir, canonicalDispatch.payload.dispatchId) ?? undefined)
      : undefined);
  const ownerBinding = matchingHeader?.binding ?? canonicalDispatch,
    isCenter = context.input.runtimeNode === undefined && context.input.remote === undefined,
    remoteEdgeTargetNodeId =
      isCenter &&
      ruling === null &&
      !escalation &&
      matchingHeader === undefined &&
      ownerBinding != null &&
      typeof ownerBinding.source === "object" &&
      ownerBinding.source !== null &&
      ownerBinding.source.kind === "node"
        ? ownerBinding.source.nodeId
        : null,
    remoteEdgeCancelOwned =
      remoteEdgeTargetNodeId !== null &&
      binding.actor.executor === null &&
      !(binding as { readonly executionPrincipal?: unknown }).executionPrincipal &&
      ownerBinding!.actor.principal.personId === binding.actor.principal.personId,
    crossNodeCenterRuling =
      context.input.runtimeNode === undefined &&
      ruling !== null &&
      matchingHeader === undefined &&
      binding.source === "local" &&
      binding.actor.executor === null &&
      !(binding as { readonly executionPrincipal?: unknown }).executionPrincipal &&
      ownerBinding != null &&
      typeof ownerBinding.source === "object" &&
      ownerBinding.source !== null &&
      ownerBinding.source.kind === "node",
    owned =
      ownerBinding?.actor?.principal.personId === binding.actor.principal.personId &&
      (crossNodeCenterRuling ||
        (ownedByRuntimeSpawner(ownerBinding, context.input.runtimeNode, matchingHeader) &&
          (matchingHeader !== undefined || sameWriteSource(ownerBinding.source, binding.source))));
  // Owner authorization permits a mechanical stop even while the center is offline.
  // The handle is transport only: publication and resource release still require the center.
  if (owned && active && ruling === null) return stopOwnedRuntime(active);
  const lifecycle = await readDispatchLifecycle(context, { by: "session", runtimeSessionId });
  if (lifecycle.status !== "ready") throw dispatchLifecyclePendingError(lifecycle, context.runtimeSpawnError);
  let attempt = lifecycle.rows[0];
  if (remoteEdgeCancelOwned && remoteEdgeTargetNodeId !== null) {
    const session = context.requiredRuntimeProjection(context.input).readRuntimeSession(runtimeSessionId);
    if (
      attempt?.policy.attemptSettled ||
      (attempt ? attempt.attempt.outcome !== null : session?.outcome !== null && session?.outcome !== undefined)
    ) {
      if (attempt?.policy.fallbackPending && attempt.controlLeafDispatchId === attempt.attempt.dispatchId) {
        const terminal = readFallbackExhaustion(
          context.requiredRuntimeProjection(context.input),
          (ref) => readCanonicalRuntimeResult(context.requiredRuntimeStore(context.input), ref),
          attempt.attempt,
        );
        const settlement = await context.publishRuntimeEvent(
          "runtime_session_outcome_observed",
          terminal.payload,
          opId,
          binding,
          terminal.body,
        );
        return context.controlReceipt(opId, runtimeSessionId, "already-exited", settlement.receipt);
      }
      return context.controlReceipt(
        opId,
        runtimeSessionId,
        "already-exited",
        attempt?.policy.groupSettled ? { outcome: "no_changes", status: "settled_no_write" } : undefined,
      );
    }
    if (!attempt || !session) throw runtimeSpawnError("runtime_not_running", "Runtime session was not found.");
    if (attempt.attempt.stopProof !== "proven_stopped") {
      const controlRequestId = idempotencyKey ?? opId,
        eventOpId = `runtime-cancel-req-${sha256Text(`${context.input.repoId}\0${runtimeSessionId}\0${controlRequestId}`).slice(0, 32)}`,
        existing = context.requiredRuntimeStore(context.input).readEvent(eventOpId);
      if (existing) {
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "runtime-cancel",
          outcome: "no_changes",
          code: "no_changes",
          origin: "runtime-cancel",
          opId: eventOpId,
          revision: existing.workspaceRevision,
          runtimeSessionId,
          detail: "cancel_requested",
          controlRequestId,
          targetNodeId: remoteEdgeTargetNodeId,
          status: "settled_no_write",
          visibility: "center",
          evidence: `event-object:${eventOpId}`,
          summary: `Cancel request ${controlRequestId} was already recorded for remote runtime ${runtimeSessionId} on node ${remoteEdgeTargetNodeId}.`,
        };
      }
      // Expand-contract Step-1 (dec_659E15CF, expiry 2027-02-06): emit additive controlRequest on
      // runtime_session_liveness_changed so N-1 Edge nodes can hydrate PG seeds and replay WAL.
      const published = await context.publishRuntimeEvent(
        "runtime_session_liveness_changed",
        {
          runtimeSessionId,
          liveness: runtimeSessionCarrierLiveness(session),
          controlRequest: {
            action: "cancel",
            controlRequestId,
            targetNodeId: remoteEdgeTargetNodeId,
            ...(reason ? { reason } : {}),
          },
        },
        eventOpId,
        binding,
      );
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "runtime-cancel",
        outcome: published.receipt?.outcome ?? "applied",
        opId: eventOpId,
        ...(typeof published.receipt?.revision === "number" ? { revision: published.receipt.revision } : {}),
        runtimeSessionId,
        detail: "cancel_requested",
        controlRequestId,
        targetNodeId: remoteEdgeTargetNodeId,
        visibility: "center",
        evidence: `event-object:${eventOpId}`,
        summary: `Cancel request ${controlRequestId} recorded for remote runtime ${runtimeSessionId} on node ${remoteEdgeTargetNodeId}.`,
      };
    }
  }
  if (!owned) {
    const session = context.input.remote
      ? await context.input.remote.readRuntimeSession(runtimeSessionId)
      : context.requiredRuntimeProjection(context.input).readRuntimeSession(runtimeSessionId);
    if (attempt ? attempt.attempt.outcome !== null : session?.outcome !== null && session?.outcome !== undefined)
      return context.controlReceipt(opId, runtimeSessionId, "already-exited");
  }
  if (
    matchingHeader === undefined &&
    attempt?.attempt.dispatchId &&
    isValidDispatchStreamId(attempt.attempt.dispatchId)
  ) {
    const attemptHeader = readDispatchStreamHeader(context.input.rootDir, attempt.attempt.dispatchId);
    if (attemptHeader?.runtimeSessionId === runtimeSessionId) matchingHeader = attemptHeader;
  }
  // Only a live stream is a control channel a recovery can adopt. An archived stream is the
  // history of a stopped dispatch: it remains authorization and stop-proof evidence only.
  const targetDispatchId = matchingHeader?.dispatchId ?? canonicalDispatch?.payload?.dispatchId,
    hasLiveDispatch =
      targetDispatchId !== undefined &&
      isValidDispatchStreamId(targetDispatchId) &&
      (ruling !== null || matchingHeader !== undefined) &&
      findLiveDispatchStreamPath(context.input.rootDir, targetDispatchId) !== null;
  let ownerGroup: { readonly evidence: RuntimeDispatchOwnerEvidence | null; readonly pid: number | null } | undefined,
    groupStop: ReturnType<typeof probeProcessGroup> | undefined;
  const readOwnerGroup = async () =>
      (ownerGroup ??= await readOwnerProcessGroup(
        context,
        runtimeSessionId,
        canonicalDispatch,
        ownerBinding,
        matchingHeader,
      )),
    ownerGroupIdentity = (pid: number | null) => ({
      pgid: pid ?? undefined,
      ...(matchingHeader
        ? { dispatch: { rootDir: context.input.rootDir, dispatchId: matchingHeader.dispatchId } }
        : {}),
    }),
    probeOwnerGroup = (pid: number | null) => (groupStop ??= probeProcessGroup(ownerGroupIdentity(pid)));
  let orphanStop: ReturnType<typeof orphanRuntimeStopDisposition> = null;
  if (!owned) {
    const { evidence, pid } =
      reason !== null &&
      !escalation &&
      !context.input.remote &&
      attempt?.attempt.fence.verified &&
      (!attempt.attempt.executionTarget || attempt.attempt.stopProof === "proven_stopped")
        ? await readOwnerGroup()
        : { evidence: null, pid: null };
    const audit =
      reason !== null &&
      evidence &&
      evidence.payload?.dispatchId === attempt?.attempt.dispatchId &&
      ownerBinding?.actor.principal.personId === evidence.actor.principal.personId &&
      sameWriteSource(ownerBinding.source, evidence.source) &&
      (crossNodeCenterRuling || ownedByRuntimeSpawner(evidence, context.input.runtimeNode, matchingHeader))
        ? await readOrphanRuntimeRecoveryAuthority(
            context.input.repoId,
            binding,
            evidence.actor.principal.personId,
            reason,
          )
        : null;
    if (!audit || !evidence?.payload?.dispatchId)
      throw runtimeSpawnError(
        "execution_scope_mismatch",
        "This runtime has no owner dispatch on this node; an orphaned runtime requires repository admin authority and --reason.",
      );
    const hasActiveHandle =
        active !== undefined ||
        context.exiting.has(runtimeSessionId) ||
        context.ownsModelSlot?.(runtimeSessionId) === true,
      localObservation =
        crossNodeCenterRuling || hasActiveHandle
          ? "unknown_unreachable"
          : observeRuntimeDispatchOwnerGroup(context.input.rootDir, evidence.payload.dispatchId, pid);
    orphanStop = orphanRuntimeStopDisposition({
      hasLiveOwner: hasActiveHandle || localObservation === "running",
      stopProven: attempt?.attempt.stopProof === "proven_stopped" || localObservation === "proven_stopped",
      unreachableRuling: ruling !== null && !hasLiveDispatch,
    });
    if (orphanStop === null)
      throw runtimeSpawnError(
        ruling === null ? "runtime_process_group_unproven" : "runtime_ruling_not_allowed",
        "Orphan recovery requires a stopped process group or an unreachable ruling with no live local owner.",
      );
    binding = {
      ...binding,
      source: evidence.source,
      orphanRecovery: { dispatchId: evidence.payload.dispatchId, audit },
    };
  }
  if (owned && ruling !== null) {
    // A ruling is an owner decision for an unreachable runtime only. Check every
    // precondition before recovery, process-group probing, or the active-process
    // branch can perform a physical cancellation or cleanup.
    const hasLocalOwner =
        active !== undefined ||
        context.exiting.has(runtimeSessionId) ||
        context.ownsModelSlot?.(runtimeSessionId) === true,
      recordedGroupPid = crossNodeCenterRuling ? null : (await readOwnerGroup()).pid,
      hasLiveProcessGroup =
        recordedGroupPid !== null && observeRecordedProcessGroup(ownerGroupIdentity(recordedGroupPid)) === "running";
    if (hasLocalOwner || hasLiveDispatch || hasLiveProcessGroup)
      throw runtimeSpawnError(
        "runtime_ruling_not_allowed",
        "Owner ruling requires no local runtime owner, no live dispatch stream, and no observably live process group.",
      );
  }
  // Recovery observes only an admitted attempt with a live local spool. Missing or archived spools go
  // to the same fenced process-group observer below; absence never releases a reservation by itself.
  if (
    owned &&
    matchingHeader &&
    hasLiveDispatch &&
    !active &&
    (attempt?.policy.canAdoptProcess || attempt?.attempt.executionTarget)
  ) {
    await adoptRuntimes(context, undefined, { runtimeSessionId, authorizationBinding: binding });
  }
  const currentLifecycle = await readDispatchLifecycle(context, { by: "session", runtimeSessionId });
  if (currentLifecycle.status !== "ready")
    throw dispatchLifecyclePendingError(currentLifecycle, context.runtimeSpawnError);
  attempt = currentLifecycle.rows[0];
  active = runtimeHandles.get(runtimeSessionId);
  if (owned && active) return stopOwnedRuntime(active);
  async function stopOwnedRuntime(active: ActiveRuntime): Promise<JsonObject> {
    active.cancelBinding = binding;
    // The mechanical stop must retain whether it was requested by the escalation action. Runtime
    // settlement uses this marker to distinguish a worker-owned report from an ordinary owner
    // cancellation that happens to race with a ruling artifact.
    active.cancelOpId = escalation ? `${opId}:escalation` : opId;
    active.cancelRequested = true;
    if (active.process.cloud)
      appendRuntimeWorkerRecord(context.input.rootDir, active.dispatchId, {
        kind: "sandbox_cancel_requested",
        opId: active.cancelOpId,
        occurredAt: context.input.now(),
      });
    if (!active.process.cloud && (escalation || !active.process.terminateTree)) active.process.terminate();
    if (escalation) {
      // The worker may be synchronously waiting for this command's response. Returning only
      // after terminateTree would wait for that CLI child, which waits for us: stop the provider
      // now, let the response flush, and finish the full tree cleanup in the next check phase.
      context.input.schedule(() => context.publishExit(active, null), active.binding);
      return context.controlReceipt(opId, runtimeSessionId, "requested");
    }
    await context.publishExit(active, null);
    return context.controlReceipt(opId, runtimeSessionId);
  }
  const stopAlreadyProven = attempt?.attempt.stopProof === "proven_stopped";
  if (stopAlreadyProven) context.dispatchState?.deactivate(runtimeSessionId);
  if (attempt?.policy.attemptSettled) {
    if (attempt.policy.fallbackPending && attempt.controlLeafDispatchId === attempt.attempt.dispatchId) {
      const terminal = context.input.remote
        ? await context.input.remote.readFallbackExhaustion(attempt.attempt)
        : readFallbackExhaustion(
            context.requiredRuntimeProjection(context.input),
            (ref) => readCanonicalRuntimeResult(context.requiredRuntimeStore(context.input), ref),
            attempt.attempt,
          );
      const settlement = await context.publishRuntimeEvent(
        "runtime_session_outcome_observed",
        terminal.payload,
        opId,
        binding,
        terminal.body,
      );
      const settled = await readDispatchLifecycle(context, {
        by: "dispatch",
        dispatchIds: [attempt.attempt.dispatchId],
      });
      const settledRows = readyDispatchLifecycle(settled, context.runtimeSpawnError);
      const [settledRow] = settledRows;
      if (!settledRow?.policy.groupSettled)
        throw runtimeSpawnError("dispatch_lifecycle_pending", "Fallback exhaustion did not close the dispatch group.");
      return context.controlReceipt(opId, runtimeSessionId, "already-exited", settlement.receipt);
    }
    return context.controlReceipt(
      opId,
      runtimeSessionId,
      "already-exited",
      attempt.policy.groupSettled ? { outcome: "no_changes", status: "settled_no_write" } : undefined,
    );
  }
  // Missing control transport does not prove the process tree stopped.
  if (attempt?.attempt.executionTarget && !stopAlreadyProven)
    throw runtimeSpawnError("stop_unconfirmed", "Cloud sandbox stop is unconfirmed; its lease remains reserved.");
  if (attempt && attempt.attempt.outcome === null) {
    const instanceId = matchingHeader?.instanceId ?? canonicalDispatch?.instanceId;
    const { evidence: ownerEvidence, pid: processGroupPid } = await readOwnerGroup();
    // Remote edge PIDs cannot be probed against center's OS PID table during cross-node ruling.
    const needsRuling =
      orphanStop !== null
        ? orphanStop === "ruled_unreachable"
        : !stopAlreadyProven && (crossNodeCenterRuling || probeOwnerGroup(processGroupPid) !== "proven_stopped");
    if (needsRuling) {
      if (ruling !== null) {
        const rulingBinding = crossNodeCenterRuling ? { ...binding, source: ownerBinding.source } : binding;
        const resultBody = JSON.stringify({
            schema: "runtime-ruling-resolution/v1",
            runtimeSessionId,
            dispatchId: ownerEvidence?.payload.dispatchId ?? null,
            from: attempt.groupPhase,
            to: "closed",
            event: "ruling_resolved",
            disposition: "abandoned_unproven",
            processStop: "unproven",
            actor: binding.actor,
            resolvedAt: context.input.now(),
            reason: ruling,
            ...(binding.orphanRecovery ? { orphanRecovery: binding.orphanRecovery.audit } : {}),
          }),
          resultSha256 = createHash("sha256").update(resultBody).digest("hex");
        await context.publishRuntimeEvent(
          "runtime_session_outcome_observed",
          {
            runtimeSessionId,
            outcome: "unknown",
            exitCode: null,
            resultRef: `artifact:runtime-result/sha256/${resultSha256}`,
            result: {
              sha256: resultSha256,
              size: Buffer.byteLength(resultBody),
              mediaType: "text/plain; charset=utf-8",
            },
            reasonCode: "ruling_resolved",
            ...(ownerEvidence?.payload.dispatchId ? { dispatchId: ownerEvidence.payload.dispatchId } : {}),
            endedAt: context.input.now(),
          },
          `${opId}-ruling-resolved`,
          rulingBinding,
          resultBody,
        );
        return context.controlReceipt(
          binding.orphanRecovery ? `${opId}-ruling-resolved` : opId,
          runtimeSessionId,
          "ruling_resolved",
        );
      }
      // Preserve recovery failures while the stop is unproven; an observed stop above
      // reaches owner cancellation without depending on successful recovery.
      await assertRuntimeRecoveryReady(context, runtimeSessionId);
      throw runtimeSpawnError(
        "runtime_process_group_unproven",
        `Owner process group ${String(processGroupPid ?? "unknown")} could not be proven stopped.${processGroupRecoveryHint()}`,
      );
    }
    context.dispatchState?.deactivate(runtimeSessionId);
    if (typeof instanceId === "string") {
      const failure = context.input.reclaimRuntimeTempDirectory?.(instanceId, runtimeSessionId) ?? null;
      if (failure)
        console.error(
          `[runtime-temp] ${instanceId}/${runtimeSessionId} could not be reclaimed after owner loss: ${failure.message}`,
        );
    }
    binding = { ...binding, source: ownerBinding!.source };
    const terminalBinding = binding.orphanRecovery
      ? binding
      : {
          ...binding,
          actor: {
            principal: binding.actor.principal,
            executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
          },
        };
    const persistedTerminal = matchingHeader
      ? (readDispatchStream(context.input.rootDir, matchingHeader.dispatchId)?.terminalOutcome ??
        readDispatchStreamSummary(context.input.rootDir, matchingHeader.dispatchId)?.terminalOutcome ??
        null)
      : null;
    if (persistedTerminal) {
      await context.publishExit(
        {
          terminal: binding.orphanRecovery
            ? auditedOrphanTerminal(persistedTerminal, binding.orphanRecovery.audit)
            : persistedTerminal,
          attempt: {
            runtimeSessionId,
            dispatchId: attempt.attempt.dispatchId,
            schedule: matchingHeader?.schedule ?? null,
            binding,
          },
          previous: attempt,
          opId,
        },
        null,
      );
      return context.controlReceipt(
        binding.orphanRecovery ? `${opId}-outcome` : opId,
        runtimeSessionId,
        persistedTerminal.payload.outcome === "cancelled" ? "cancelled" : "already-exited",
      );
    }
    if (!stopAlreadyProven) {
      await context.publishRuntimeEvent(
        "runtime_session_exited",
        { runtimeSessionId },
        `${opId}-exited`,
        terminalBinding,
      );
    }
    await context.publishRuntimeEvent("runtime_session_cancelled", { runtimeSessionId }, `${opId}-cancelled`, binding);
    const resultBody = binding.orphanRecovery
        ? JSON.stringify(binding.orphanRecovery.audit)
        : "Runtime session cancelled after its worker process was no longer available.",
      resultSha256 = sha256Text(resultBody);
    const outcomeEvent = await context.publishRuntimeEvent(
      "runtime_session_outcome_observed",
      {
        runtimeSessionId,
        outcome: "cancelled",
        exitCode: null,
        resultRef: `artifact:runtime-result/sha256/${resultSha256}`,
        result: { sha256: resultSha256, size: Buffer.byteLength(resultBody), mediaType: "text/plain; charset=utf-8" },
        reasonCode: "runtime_process_missing",
      },
      `${opId}-outcome`,
      terminalBinding,
      resultBody,
    );
    if (outcomeEvent?.event) context.input.onRuntimeOutcome?.(outcomeEvent.event, matchingHeader?.schedule ?? null);
    await context.input.onAttemptTerminal?.({
      runtimeSessionId,
      dispatchId: attempt.attempt.dispatchId,
      task: null,
      schedule: matchingHeader?.schedule ?? null,
      outcome: "cancelled",
      reason: resultBody,
      endedAt: context.input.now(),
      binding: terminalBinding,
    });
    return context.controlReceipt(binding.orphanRecovery ? `${opId}-outcome` : opId, runtimeSessionId, "cancelled");
  }
  return context.controlReceipt(opId, runtimeSessionId, "already-exited");
}

/** The owner's recorded process group, accepted only from evidence for this owner and dispatch. */
async function readOwnerProcessGroup(
  context: RuntimeSpawnerContext,
  runtimeSessionId: string,
  canonicalDispatch: RuntimeDispatchOwner | RuntimeDispatchOwnerEvidence | null,
  ownerBinding: Pick<RuntimeDispatchOwnerEvidence, "actor" | "source"> | null | undefined,
  matchingHeader: DispatchStreamHeader | undefined,
): Promise<{ readonly evidence: RuntimeDispatchOwnerEvidence | null; readonly pid: number | null }> {
  const evidence =
    canonicalDispatch && "processGroupPid" in canonicalDispatch
      ? canonicalDispatch
      : context.input.remote?.readRuntimeDispatch
        ? await context.input.remote.readRuntimeDispatch(runtimeSessionId)
        : readRuntimeDispatchOwnerEvidence(context.requiredRuntimeProjection(context.input), runtimeSessionId);
  const pid =
    evidence &&
    ownerBinding &&
    evidence.actor.principal.personId === ownerBinding.actor.principal.personId &&
    sameWriteSource(evidence.source, ownerBinding.source) &&
    (matchingHeader === undefined || evidence.payload?.dispatchId === matchingHeader.dispatchId)
      ? evidence.processGroupPid
      : null;
  return { evidence, pid };
}

export async function enforceRuntimeSpendCap(context: RuntimeSpawnerContext, active: ActiveRuntime): Promise<void> {
  const [view] = readyDispatchLifecycle(
    await readDispatchLifecycle(context, { by: "session", runtimeSessionId: active.runtimeSessionId }),
    context.runtimeSpawnError,
  );
  if (!view || view.attempt.dispatchId !== active.dispatchId || view.policy.capacity === "released") return;
  if (!active.spendCapExceeded || active.cancelRequested || context.exiting.has(active.runtimeSessionId)) return;
  if (active.process.terminateTree) await active.process.terminateTree();
  else if (!active.process.cloud) active.process.terminate();
  await consumeDurableOutput(context, active);
  await context.publishExit(active, null);
}

export async function steerRuntime(
  context: RuntimeSpawnerContext,
  payload: JsonObject,
  binding: RuntimeBinding,
  options?: { readonly remoteControlRequestId?: string; readonly remoteControlOpId?: string },
): Promise<JsonObject> {
  const unknownField = unknownFieldViolation(payload, daemonMethodPayloadFields("repo.agentRuntime.steer"));
  if (unknownField)
    throw runtimeSpawnError("invalid_runtime_steer", `Runtime steer payload contains an ${unknownField}`);
  const runtimeSessionIdInput = payload.runtimeSessionId,
    dispatchIdInput = payload.dispatchId,
    taskIdInput = payload.taskId,
    prompt = requiredRuntimeSpawnText(payload.prompt, "prompt"),
    modeInput = payload.mode === undefined ? "auto" : String(payload.mode),
    expected = parseRuntimeSteerExpectation(payload.expected),
    idempotencyKey =
      payload.idempotencyKey === undefined
        ? null
        : requiredRuntimeSpawnText(payload.idempotencyKey, "idempotencyKey").trim();
  if (modeInput !== "auto" && modeInput !== "queue" && modeInput !== "interrupt")
    throw runtimeSpawnError("invalid_runtime_steer", "Runtime steer mode must be auto, queue, or interrupt.");
  const steerMode: RuntimeSteerMode = modeInput,
    explicitMode: RuntimeSteerMode | undefined = payload.mode === undefined ? undefined : steerMode;
  if (payload.idempotencyKey !== undefined && !idempotencyKey)
    throw runtimeSpawnError("invalid_runtime_steer", "Runtime steer idempotencyKey must not be empty.");
  const targetCount =
    (typeof runtimeSessionIdInput === "string" ? 1 : 0) +
    (typeof dispatchIdInput === "string" ? 1 : 0) +
    (typeof taskIdInput === "string" ? 1 : 0);
  if (targetCount !== 1)
    throw runtimeSpawnError(
      "invalid_runtime_steer",
      "Specify exactly one runtime session id, dispatch id, or task id.",
    );
  const { rootDir, repoId } = context.input,
    runtimeHandles = context.processes;

  // Resolve a task-targeted steer to its live runtime or latest task dispatch, or enqueue directly to task:<taskId>.
  let resolvedSelector: RuntimeSteerSelector | null =
    typeof dispatchIdInput === "string"
      ? { dispatchId: dispatchIdInput }
      : typeof runtimeSessionIdInput === "string"
        ? { runtimeSessionId: runtimeSessionIdInput }
        : null;
  let taskLatestDispatch:
    | ReturnType<
        ReturnType<RuntimeSpawnerContext["requiredRuntimeProjection"]>["readLatestRuntimeDispatchesByTaskIds"]
      >[number]
    | null = null;
  if (typeof taskIdInput === "string") {
    const activeForTask = [...runtimeHandles.values()].find((entry) => entry.task?.taskId === taskIdInput);
    if (activeForTask) {
      resolvedSelector = { runtimeSessionId: activeForTask.runtimeSessionId };
    } else if (!context.input.remote) {
      const projection = context.requiredRuntimeProjection(context.input);
      taskLatestDispatch = projection.readLatestRuntimeDispatchesByTaskIds([taskIdInput])[0] ?? null;
      if (taskLatestDispatch) resolvedSelector = { dispatchId: taskLatestDispatch.payload.dispatchId };
      else if (steerMode === "interrupt")
        throw runtimeSpawnError("runtime_not_running", `No running dispatch was found for task ${taskIdInput}.`);
      else if (!projection.readTaskExists(taskIdInput))
        throw runtimeSpawnError("task_not_found", `Task ${taskIdInput} does not exist.`);
      else {
        if (expected) {
          const taskSnap = projection.read(taskIdInput).snapshot,
            currentExecId =
              taskSnap.executions.findLast((entry) => entry.iteration === taskSnap.task?.iteration)?.executionId ??
              null;
          assertTaskTargetExpectationWithoutLocalHeader({
            expected,
            repoId,
            taskId: taskIdInput,
            executionId: currentExecId,
            dispatchId: null,
            controlLeafDispatchId: null,
          });
        }
        const queued = enqueueQueuedSteer(
          context,
          { taskId: taskIdInput, prompt, dispatchId: null, runtimeSessionId: null, agentId: null, idempotencyKey },
          binding,
        );
        return buildQueuedSteerReceipt({
          queued,
          taskId: taskIdInput,
          runtimeSessionId: null,
          dispatchId: null,
        });
      }
    } else {
      throw runtimeSpawnError("runtime_not_running", `No local dispatch was found for task ${taskIdInput}.`);
    }
  }
  const selector = resolvedSelector!,
    activeForSelector =
      "runtimeSessionId" in selector
        ? runtimeHandles.get(selector.runtimeSessionId)
        : [...runtimeHandles.values()].find((entry) => entry.dispatchId === selector.dispatchId);
  let knownDispatchId = activeForSelector?.dispatchId;
  if (!knownDispatchId && !("dispatchId" in selector) && !context.input.remote) {
    const projDispatch =
      context.requiredRuntimeProjection(context.input).readRuntimeDispatch(selector.runtimeSessionId) ??
      context
        .requiredRuntimeProjection(context.input)
        .readLatestRuntimeDispatchBySession?.(selector.runtimeSessionId) ??
      null;
    if (projDispatch) knownDispatchId = projDispatch.payload.dispatchId;
  }
  const localHeader =
    knownDispatchId !== undefined
      ? findRuntimeSteerHeader(rootDir, selector, { knownDispatchId, skipLeafScan: activeForSelector !== undefined })
      : "dispatchId" in selector || context.input.remote !== undefined
        ? findRuntimeSteerHeader(rootDir, selector)
        : null;
  if (!localHeader) {
    const taskLatestIsRemote = taskLatestDispatch !== null && isRemoteNodeSource(taskLatestDispatch.source);
    if (
      (steerMode === "queue" || steerMode === "auto") &&
      typeof taskIdInput === "string" &&
      taskLatestDispatch !== null &&
      !taskLatestIsRemote &&
      !context.input.remote
    ) {
      const targetRole = taskLatestDispatch.payload.role ?? null,
        targetPermissionMode = taskLatestDispatch.payload.launchedPermissionMode ?? null,
        nonConsumableReason = queuedSteerTargetRefusalReason({
          role: targetRole,
          permissionMode: targetPermissionMode,
        });
      if (nonConsumableReason !== null) throw runtimeSpawnError("runtime_steer_unsupported", nonConsumableReason);
      if (expected) {
        const [canonicalView] = readyDispatchLifecycle(
          await readDispatchLifecycle(context, {
            by: "session",
            runtimeSessionId: taskLatestDispatch.payload.runtimeSessionId,
          }),
          context.runtimeSpawnError,
        );
        assertTaskTargetExpectationWithoutLocalHeader({
          expected,
          repoId,
          taskId: taskIdInput,
          executionId: taskLatestDispatch.payload.executionId ?? null,
          dispatchId: taskLatestDispatch.payload.dispatchId,
          controlLeafDispatchId: canonicalView?.controlLeafDispatchId ?? null,
        });
      }
      const queued = enqueueQueuedSteer(
        context,
        {
          taskId: taskIdInput,
          prompt,
          dispatchId: taskLatestDispatch.payload.dispatchId,
          runtimeSessionId: taskLatestDispatch.payload.runtimeSessionId,
          agentId: taskLatestDispatch.payload.agentId ?? null,
          role: targetRole,
          permissionMode: targetPermissionMode,
          idempotencyKey,
        },
        binding,
      );
      const trigger = {
        taskId: taskIdInput,
        previousDispatchId: taskLatestDispatch.payload.dispatchId,
        previousRuntimeSessionId: taskLatestDispatch.payload.runtimeSessionId,
        previousKindId: taskLatestDispatch.payload.kindId,
        previousProviderSessionId: taskLatestDispatch.payload.resumeProviderSessionId ?? null,
        previousAgentId: taskLatestDispatch.payload.agentId ?? null,
        previousRole: targetRole,
        previousInstanceId: taskLatestDispatch.payload.instanceId,
        previousModel: taskLatestDispatch.payload.definitionSnapshot.model ?? null,
        previousPermissionMode: targetPermissionMode,
        previousMcpPolicy: taskLatestDispatch.payload.definitionSnapshot.mcpPolicy ?? null,
        previousFinalText: null,
        binding,
      };
      context.input.schedule(() => consumeQueuedSteersAfterTurn(context, trigger).then(() => undefined), binding);
      return buildQueuedSteerReceipt({
        queued,
        taskId: taskIdInput,
        runtimeSessionId: taskLatestDispatch.payload.runtimeSessionId,
        dispatchId: taskLatestDispatch.payload.dispatchId,
      });
    }
    if (context.input.runtimeNode === undefined && context.input.remote === undefined)
      return requestRemoteEdgeSteer(
        context,
        { selector, prompt, expected, idempotencyKey, mode: explicitMode },
        binding,
      );
    throw runtimeSpawnError("runtime_not_running", "Runtime dispatch was not found.");
  }
  let header = localHeader;
  const runtimeSessionId = header.runtimeSessionId;
  let [view] = readyDispatchLifecycle(
    await readDispatchLifecycle(context, { by: "session", runtimeSessionId }),
    context.runtimeSpawnError,
  );
  const // With an expectation, every refusal carries the current target so the caller can re-read.
    refuse = (code: string, message: string): Error =>
      expected
        ? runtimeSteerRefusal(
            code,
            message,
            runtimeSteerTarget(
              rootDir,
              repoId,
              header,
              view?.policy.processAlive ? "running" : view?.attempt.phase === "starting" ? "starting" : "stopped",
              undefined,
              view?.controlLeafDispatchId,
            ),
          )
        : runtimeSpawnError(code, message);
  if (!header.binding || !ownedByRuntimeSpawner(header.binding, context.input.runtimeNode, header))
    throw refuse("execution_scope_mismatch", "This runtime is owned by another node.");
  await assertRuntimeRecoveryReady(context, runtimeSessionId);
  let active = runtimeHandles.get(runtimeSessionId);
  if (!active) {
    await adoptRuntimes(context, undefined, { runtimeSessionId });
    await assertRuntimeRecoveryReady(context, runtimeSessionId);
    active = runtimeHandles.get(runtimeSessionId);
  }
  [view] = readyDispatchLifecycle(
    await readDispatchLifecycle(context, { by: "session", runtimeSessionId }),
    context.runtimeSpawnError,
  );
  // No await from here to the append: the comparison and the write are one section of the writer.
  if (expected) {
    const current =
      view?.controlLeafDispatchId !== undefined
        ? (readDispatchStreamHeader(rootDir, view.controlLeafDispatchId) ??
          resolveRuntimeSteerHeader(rootDir, selector, {
            knownDispatchId: active?.dispatchId,
            skipLeafScan: active !== undefined,
          }))
        : resolveRuntimeSteerHeader(rootDir, selector, {
            knownDispatchId: active?.dispatchId,
            skipLeafScan: active !== undefined,
          });
    // A leaf that moved during adoption is a different target, whatever the caller stated.
    if (current.dispatchId !== header.dispatchId) {
      header = current;
      throw refuse("runtime_steer_target_changed", "The steer target changed while it was being resolved.");
    }
  }
  const boundTaskId = header.taskId ?? (typeof taskIdInput === "string" ? taskIdInput : null),
    activeKindId = active?.kindId ?? header.kindId ?? null,
    providerSupportsLiveSteer = activeKindId ? runtimeKindForId(activeKindId).steerSupported : false,
    processAlive = Boolean(active && view?.policy.processAlive === true),
    targetRole = active?.role ?? header.role ?? null,
    targetPermissionMode = active?.permissionMode ?? header.permissionMode ?? null,
    useQueueMode =
      !context.input.remote &&
      (steerMode === "queue" ||
        (steerMode === "auto" && boundTaskId !== null && (!providerSupportsLiveSteer || !processAlive)));
  if (context.input.remote !== undefined && steerMode === "queue")
    throw refuse(
      "runtime_steer_unsupported",
      "Queue steer is only supported on center-local runtimes in this release; remote edge runtimes support live interrupt steer only.",
    );
  if (useQueueMode) {
    if (boundTaskId === null)
      throw refuse(
        "runtime_steer_unavailable",
        "Queue steer requires a task-bound runtime with a canonical task inbox.",
      );
    const nonConsumableReason = queuedSteerTargetRefusalReason({
      role: targetRole,
      permissionMode: targetPermissionMode,
    });
    if (nonConsumableReason !== null) throw refuse("runtime_steer_unsupported", nonConsumableReason);
    const queueTarget = runtimeSteerTarget(
      rootDir,
      repoId,
      header,
      processAlive ? "running" : view?.attempt.phase === "starting" ? "starting" : "stopped",
      undefined,
      view?.controlLeafDispatchId,
    );
    const mismatch = expected ? runtimeSteerMismatch(expected, queueTarget) : null;
    if (mismatch)
      throw runtimeSteerRefusal(
        "runtime_steer_target_changed",
        `The steer target no longer matches expected.${mismatch.field}.`,
        queueTarget,
        mismatch.field,
        mismatch.expected,
      );
    const queued = enqueueQueuedSteer(
      context,
      {
        taskId: boundTaskId,
        prompt,
        dispatchId: header.dispatchId,
        runtimeSessionId,
        agentId: active?.agent?.id ?? header.agentId ?? null,
        role: targetRole,
        permissionMode: targetPermissionMode,
        idempotencyKey,
      },
      binding,
    );
    if (!processAlive) {
      const trigger = {
        taskId: boundTaskId,
        previousDispatchId: header.dispatchId,
        previousRuntimeSessionId: runtimeSessionId,
        previousKindId: activeKindId,
        previousProviderSessionId: active?.providerSessionId ?? header.resumeProviderSessionId ?? null,
        previousAgentId: active?.agent?.id ?? header.agentId ?? null,
        previousRole: targetRole,
        previousInstanceId: active?.instanceId ?? header.instanceId,
        previousModel: active?.model ?? header.model ?? null,
        previousPermissionMode: targetPermissionMode,
        previousMcpPolicy: active?.mcpPolicy ?? header.mcpPolicy ?? null,
        previousFinalText: active?.finalText ?? null,
        binding,
      };
      context.input.schedule(() => consumeQueuedSteersAfterTurn(context, trigger).then(() => undefined), binding);
    }
    return buildQueuedSteerReceipt({
      queued,
      taskId: boundTaskId,
      runtimeSessionId,
      dispatchId: header.dispatchId,
      steerTarget: runtimeSteerReceiptTarget(queueTarget) as unknown as JsonObject,
    });
  }
  if (active && !runtimeKindForId(active.kindId).steerSupported)
    throw refuse("runtime_steer_unsupported", `${active.kindId} does not support runtime steering.`);
  if (!view?.policy.canSteer)
    throw refuse("runtime_steer_unavailable", "The canonical lifecycle has no running control target.");
  if (!active) throw refuse("runtime_steer_unavailable", "Runtime control transport is unavailable.");
  if (
    (options?.remoteControlRequestId !== undefined || options?.remoteControlOpId !== undefined) &&
    active.steerReceiptCapable === false
  )
    throw refuse(
      "runtime_steer_unsupported",
      "Adopted legacy worker does not support correlated remote steer receipts.",
    );
  if (!active.providerSessionId)
    throw refuse("runtime_steer_unavailable", "Provider has not established a resumable session yet.");
  const remoteDedupKey = options?.remoteControlOpId ?? options?.remoteControlRequestId ?? null,
    seenOpIds = remoteDedupKey ? new Set<string>() : undefined,
    target = runtimeSteerTarget(
      rootDir,
      repoId,
      header,
      "running",
      seenOpIds,
      header.taskId !== null ? view.controlLeafDispatchId : undefined,
    ),
    opId = remoteDedupKey
      ? `runtime-steer-remote-${sha256Text(`${repoId}\0${runtimeSessionId}\0${remoteDedupKey}`).slice(0, 32)}`
      : `runtime-steer-${createHash("sha256").update(`${repoId}\0${runtimeSessionId}\0${context.input.now()}\0${prompt}`).digest("hex").slice(0, 32)}`;
  if (seenOpIds?.has(opId)) {
    return {
      schema: "command-receipt/v2",
      ok: true,
      command: "runtime-steer",
      outcome: "no_changes",
      code: "no_changes",
      origin: "runtime-steer",
      opId,
      runtimeSessionId,
      dispatchId: header.dispatchId,
      status: "settled_no_write",
      visibility: "center",
      evidence: `dispatch-stream:${header.dispatchId}:steer_requested:${opId}`,
      summary: `Remote steer request ${options?.remoteControlRequestId ?? opId} was already appended to ${header.dispatchId}.`,
      steerTarget: runtimeSteerReceiptTarget(target),
    };
  }
  const mismatch = expected ? runtimeSteerMismatch(expected, target) : null;
  if (mismatch)
    throw runtimeSteerRefusal(
      "runtime_steer_target_changed",
      `The steer target no longer matches expected.${mismatch.field}.`,
      target,
      mismatch.field,
      mismatch.expected,
    );
  const interruptQueued =
    steerMode === "interrupt" && boundTaskId !== null && !context.input.remote && context.input.store
      ? enqueueQueuedSteer(
          context,
          {
            taskId: boundTaskId,
            prompt,
            dispatchId: header.dispatchId,
            runtimeSessionId,
            agentId: active.agent?.id ?? header.agentId ?? null,
            idempotencyKey,
            lane: "interrupt",
          },
          binding,
        )
      : null;
  const version = target.version + 1;
  // The dispatch stream is the control channel: the worker host owning the provider follows
  // this file, so a host adopted after a daemon restart is steered like one this daemon spawned.
  appendRuntimeWorkerRecord(rootDir, header.dispatchId, {
    kind: "steer_requested",
    opId,
    runtimeSessionId,
    version,
    occurredAt: context.input.now(),
    actor: binding.actor,
    source: binding.source,
    prompt,
    ...(options?.remoteControlRequestId ? { controlRequestId: options.remoteControlRequestId } : {}),
    ...(options?.remoteControlOpId ? { requestOpId: options.remoteControlOpId } : {}),
  });
  active.process.cloud?.steer({
    opId,
    version,
    prompt,
    ...(options?.remoteControlRequestId ? { controlRequestId: options.remoteControlRequestId } : {}),
    ...(options?.remoteControlOpId ? { requestOpId: options.remoteControlOpId } : {}),
  });
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-steer",
    outcome: "applied",
    ...(steerMode === "interrupt" ? { mode: "interrupt" } : {}),
    ...(interruptQueued ? { inboxId: interruptQueued.inboxId, inboxItemId: interruptQueued.inboxItemId } : {}),
    opId,
    runtimeSessionId,
    dispatchId: header.dispatchId,
    // A steer's only durable effect is the dispatch-stream record written above; it appends no
    // ledger event, so it has no command outcome to accept. Declaring the determinate no-write
    // here keeps the receipt applied instead of being re-judged as acceptance_unknown, which
    // shipped `ok:true` with `outcome:indeterminate` and failed the GUI receipt exit.
    status: "settled_no_write",
    visibility: "center",
    evidence: `dispatch-stream:${header.dispatchId}:steer_requested:${opId}`,
    // `applied` is the stream append, not the provider's turn: the worker host applies it later.
    summary: `Steer request appended to ${header.dispatchId} at steer version ${String(version)}; the provider has not confirmed it yet.`,
    steerTarget: runtimeSteerReceiptTarget({ ...target, version }),
  };
}

async function requestRemoteEdgeSteer(
  context: RuntimeSpawnerContext,
  input: {
    readonly selector: RuntimeSteerSelector;
    readonly prompt: string;
    readonly expected: RuntimeSteerExpectation | null;
    readonly idempotencyKey: string | null;
    readonly mode?: RuntimeSteerMode;
  },
  binding: RuntimeBinding,
): Promise<JsonObject> {
  const { repoId } = context.input,
    projection = context.requiredRuntimeProjection(context.input),
    dispatchEvent =
      "dispatchId" in input.selector
        ? (projection.readRuntimeDispatchById(input.selector.dispatchId)?.event ?? null)
        : (projection.readRuntimeDispatch(input.selector.runtimeSessionId) ??
          projection.readLatestRuntimeDispatchBySession?.(input.selector.runtimeSessionId) ??
          null);
  if (!dispatchEvent) throw runtimeSpawnError("runtime_not_running", "Runtime dispatch was not found.");
  if (!isRemoteNodeSource(dispatchEvent.source))
    throw runtimeSpawnError("runtime_not_running", "Runtime dispatch was not found.");
  if (
    binding.actor.executor !== null ||
    Boolean((binding as { readonly executionPrincipal?: unknown }).executionPrincipal) ||
    dispatchEvent.actor.principal.personId !== binding.actor.principal.personId
  )
    throw runtimeSpawnError("execution_scope_mismatch", "This runtime is owned by another node.");
  const targetNodeId = dispatchEvent.source.nodeId,
    runtimeSessionId = dispatchEvent.payload.runtimeSessionId,
    controlRequestId =
      input.idempotencyKey ??
      `runtime-steer-${sha256Text(`${repoId}\0${runtimeSessionId}\0${context.input.now()}\0${input.prompt}`).slice(0, 32)}`,
    eventOpId = `runtime-steer-req-${sha256Text(`${repoId}\0${runtimeSessionId}\0${controlRequestId}`).slice(0, 32)}`;
  // F3: Recover an already-recorded idempotent steer request BEFORE checking expected.version or
  // post-request lifecycle drift, after repo authorization and caller principal ownership hold.
  if (input.idempotencyKey !== null) {
    const existing = context.requiredRuntimeStore(context.input).readEvent(eventOpId);
    if (existing) {
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "runtime-steer",
        outcome: "no_changes",
        code: "no_changes",
        origin: "runtime-steer",
        opId: eventOpId,
        revision: existing.workspaceRevision,
        runtimeSessionId,
        dispatchId: dispatchEvent.payload.dispatchId,
        detail: "steer_requested",
        controlRequestId,
        targetNodeId,
        status: "settled_no_write",
        visibility: "center",
        evidence: `event-object:${eventOpId}`,
        summary: `Steer request ${controlRequestId} was already recorded for remote runtime ${runtimeSessionId} on node ${targetNodeId}.`,
      };
    }
  }
  const [view] = readyDispatchLifecycle(
      await readDispatchLifecycle(context, { by: "session", runtimeSessionId }),
      context.runtimeSpawnError,
    ),
    session = projection.readRuntimeSession(runtimeSessionId),
    kindId = view?.attempt.kindId ?? dispatchEvent.payload.kindId;
  if (input.mode === "queue") {
    const nonConsumableReason = queuedSteerTargetRefusalReason({
      role: dispatchEvent.payload.role ?? null,
      permissionMode: dispatchEvent.payload.launchedPermissionMode ?? null,
    });
    throw runtimeSpawnError(
      "runtime_steer_unsupported",
      nonConsumableReason ??
        `Queue steer is only supported on center-local runtimes in this release; remote edge queue steer on node ${targetNodeId} (${runtimeSessionId}) is not supported (use --mode interrupt or omit --mode for live remote steering).`,
    );
  }
  if (!runtimeKindForId(kindId as never).steerSupported)
    throw runtimeSpawnError("runtime_steer_unsupported", `${kindId} does not support runtime steering.`);
  if (!view?.policy.canSteer || !session || session.outcome !== null)
    throw runtimeSpawnError("runtime_steer_unavailable", "The canonical lifecycle has no running control target.");
  if (!session.providerSessionId)
    throw runtimeSpawnError("runtime_steer_unavailable", "Provider has not established a resumable session yet.");
  if (input.expected) {
    const taskId = dispatchEvent.payload.taskId ?? null,
      executionId = dispatchEvent.payload.executionId ?? null,
      checks: readonly (readonly [string, unknown, unknown])[] = [
        ["repoId", input.expected.repoId, repoId],
        ["taskless", input.expected.taskless, taskId === null],
        ["taskId", input.expected.taskId, taskId],
        ["executionId", input.expected.executionId, executionId],
        ["dispatchId", input.expected.dispatchId, dispatchEvent.payload.dispatchId],
        ["dispatchId", input.expected.dispatchId, view.controlLeafDispatchId],
      ];
    for (const [field, want, actual] of checks)
      if (want !== undefined && want !== actual)
        throw runtimeSpawnError(
          "runtime_steer_target_changed",
          `The steer target no longer matches expected.${field}.`,
        );
    if (input.expected.version !== undefined) {
      const latestApplied = projection.readRuntimeSessionEventsByType(
        runtimeSessionId,
        ["runtime_session_provider_bound", "runtime_session_liveness_changed"],
        { filter: "applied_steer_receipt", order: "desc", limit: 1 },
      )[0];
      const latestReceipt =
        latestApplied?.type === "runtime_session_liveness_changed" ||
        latestApplied?.type === "runtime_session_provider_bound"
          ? latestApplied.payload.controlReceipt
          : undefined;
      const observedVersion =
        latestReceipt?.status === "applied" && typeof latestReceipt.steerVersion === "number"
          ? latestReceipt.steerVersion
          : -1;
      if (observedVersion >= 0 && input.expected.version < observedVersion)
        throw runtimeSpawnError(
          "runtime_steer_target_changed",
          `The steer target version ${String(observedVersion)} has advanced past expected.version=${String(input.expected.version)}.`,
        );
    }
  }
  // Expand-contract Step-1 (dec_659E15CF, expiry 2027-02-06): emit additive controlRequest on
  // runtime_session_liveness_changed so N-1 Edge nodes can hydrate PG seeds and replay WAL.
  const published = await context.publishRuntimeEvent(
    "runtime_session_liveness_changed",
    {
      runtimeSessionId,
      liveness: runtimeSessionCarrierLiveness(session),
      controlRequest: {
        action: "steer",
        controlRequestId,
        targetNodeId,
        dispatchId: view.attempt.dispatchId,
        prompt: input.prompt,
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.expected ? { expected: input.expected } : {}),
      },
    },
    eventOpId,
    binding,
  );
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-steer",
    outcome: published.receipt?.outcome ?? "applied",
    opId: eventOpId,
    ...(typeof published.receipt?.revision === "number" ? { revision: published.receipt.revision } : {}),
    runtimeSessionId,
    dispatchId: view.attempt.dispatchId,
    detail: "steer_requested",
    controlRequestId,
    targetNodeId,
    visibility: "center",
    evidence: `event-object:${eventOpId}`,
    summary: `Steer request ${controlRequestId} recorded for remote runtime ${runtimeSessionId} on node ${targetNodeId}.`,
  };
}

function assertTaskTargetExpectationWithoutLocalHeader(input: {
  readonly expected: RuntimeSteerExpectation;
  readonly repoId: string;
  readonly taskId: string;
  readonly executionId: string | null;
  readonly dispatchId: string | null;
  readonly controlLeafDispatchId: string | null;
}): void {
  const checks: readonly (readonly [string, unknown, unknown])[] = [
    ["repoId", input.expected.repoId, input.repoId],
    ["taskless", input.expected.taskless, false],
    ["taskId", input.expected.taskId, input.taskId],
    ["executionId", input.expected.executionId, input.executionId],
    ["dispatchId", input.expected.dispatchId, input.dispatchId],
    ...(input.controlLeafDispatchId !== null
      ? ([["dispatchId", input.expected.dispatchId, input.controlLeafDispatchId]] as const)
      : []),
  ];
  for (const [field, want, actual] of checks) {
    if (want !== undefined && want !== actual)
      throw runtimeSpawnError("runtime_steer_target_changed", `The steer target no longer matches expected.${field}.`);
  }
  if (input.expected.version !== undefined)
    throw runtimeSpawnError(
      "runtime_steer_target_changed",
      `Cannot confirm expected.version=${String(input.expected.version)} without a local dispatch stream header.`,
    );
}

export async function closeRuntimes(context: RuntimeSpawnerContext): Promise<void> {
  const active = [...context.processes.values()];
  context.processes.clear();
  const disposals: Promise<void>[] = [];
  for (const entry of active) {
    disposals.push(disposeActiveRuntimeObservations(entry));
    entry.process.release?.();
    entry.releaseAuthorization?.();
  }
  await Promise.allSettled(disposals);
}
