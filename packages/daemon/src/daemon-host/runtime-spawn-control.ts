import { orphanRuntimeStopDisposition } from "@harness-anything/kernel/internal/domain/orphan-runtime-recovery.ts";
import { readOrphanRuntimeRecoveryAuthority } from "./runtime-online-binding.ts";
import {
  observeRuntimeDispatchOwnerGroup,
  readRuntimeDispatchOwnerEvidence,
} from "./runtime-dispatch-owner-evidence.ts";
import { auditedOrphanTerminal } from "./runtime-orphan-recovery.ts";
import { createHash } from "node:crypto";
import { sameWriteSource, sha256Text } from "@harness-anything/kernel";
import { daemonMethodPayloadFields } from "./protocol/daemon-protocol-commands.ts";
import { unknownFieldViolation, type JsonObject } from "./protocol/json-rpc-types.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "../runtime-engine/runtime-spawn-errors.ts";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import { adoptRuntimes, ownedByRuntimeSpawner, assertRuntimeRecoveryReady } from "./runtime-spawn-adoption.ts";
import {
  appendRuntimeWorkerRecord,
  readDispatchStream,
  readDispatchStreamHeaders,
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
  parseRuntimeSteerExpectation,
  resolveRuntimeSteerHeader,
  runtimeSteerMismatch,
  runtimeSteerReceiptTarget,
  runtimeSteerRefusal,
  runtimeSteerTarget,
} from "./runtime-steer-target.ts";

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
    hash = createHash("sha256").update(`${context.input.repoId}\0${runtimeSessionId}`).digest("hex"),
    opId = `runtime-cancel-${hash.slice(0, 32)}`;
  if (ruling === "") throw runtimeSpawnError("invalid_runtime_ruling", "Owner ruling reason must not be empty.");
  if (payload.reason !== undefined && !reason)
    throw runtimeSpawnError("invalid_field", "Recovery reason must not be empty.");
  // Authorize against the canonical dispatch, including repeated cancellation after archival.
  const headers = readDispatchStreamHeaders(context.input.rootDir, true),
    matchingHeader = headers.find((header) => header.runtimeSessionId === runtimeSessionId),
    canonicalDispatch =
      matchingHeader !== undefined
        ? null
        : context.input.remote?.readRuntimeDispatch
          ? await context.input.remote.readRuntimeDispatch(runtimeSessionId)
          : readRuntimeDispatchOwnerEvidence(context.requiredRuntimeProjection(context.input), runtimeSessionId),
    ownerBinding = matchingHeader?.binding ?? canonicalDispatch,
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
  const runtimeHandles = context.processes;
  let active = runtimeHandles.get(runtimeSessionId);
  // Owner authorization permits a mechanical stop even while the center is offline.
  // The handle is transport only: publication and resource release still require the center.
  if (owned && active && ruling === null) return stopOwnedRuntime(active);
  const lifecycle = await readDispatchLifecycle(context, { by: "session", runtimeSessionId });
  if (lifecycle.status !== "ready") throw dispatchLifecyclePendingError(lifecycle, context.runtimeSpawnError);
  let attempt = lifecycle.rows[0];
  if (!owned) {
    const session = context.input.remote
      ? await context.input.remote.readRuntimeSession(runtimeSessionId)
      : context.requiredRuntimeProjection(context.input).readRuntimeSession(runtimeSessionId);
    if (attempt ? attempt.attempt.outcome !== null : session?.outcome !== null && session?.outcome !== undefined)
      return context.controlReceipt(opId, runtimeSessionId, "already-exited");
  }
  // Only a live stream is a control channel a recovery can adopt. An archived stream is the
  // history of a stopped dispatch: it remains authorization and stop-proof evidence only.
  const targetDispatchId = matchingHeader?.dispatchId ?? canonicalDispatch?.payload?.dispatchId,
    hasLiveDispatch =
      targetDispatchId !== undefined &&
      (ruling !== null || matchingHeader !== undefined) &&
      readDispatchStreamHeaders(context.input.rootDir).some(({ dispatchId }) => dispatchId === targetDispatchId);
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
      reason !== null && !escalation && !context.input.remote && attempt?.attempt.fence.verified
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
  if (owned && matchingHeader && hasLiveDispatch && !active && attempt?.policy.canAdoptProcess) {
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
    if (escalation || !active.process.terminateTree) active.process.terminate();
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
    return context.controlReceipt(opId, runtimeSessionId, "already-exited");
  }
  // Missing control transport does not prove the process tree stopped.
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
  canonicalDispatch: RuntimeDispatchOwnerEvidence | null,
  ownerBinding: Pick<RuntimeDispatchOwnerEvidence, "actor" | "source"> | null | undefined,
  matchingHeader: DispatchStreamHeader | undefined,
): Promise<{ readonly evidence: RuntimeDispatchOwnerEvidence | null; readonly pid: number | null }> {
  const evidence =
    canonicalDispatch ??
    (context.input.remote?.readRuntimeDispatch
      ? await context.input.remote.readRuntimeDispatch(runtimeSessionId)
      : readRuntimeDispatchOwnerEvidence(context.requiredRuntimeProjection(context.input), runtimeSessionId));
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

export function readRuntimeDispatchOwnerEvidence(
  projection: Pick<TaskProjection, "readRuntimeSession" | "readRuntimeDispatch" | "readRuntimeSessionEventsByType">,
  runtimeSessionId: string,
): RuntimeDispatchOwnerEvidence | null {
  const session = projection.readRuntimeSession(runtimeSessionId);
  if (!session) return null;
  const dispatch = projection.readRuntimeDispatch(runtimeSessionId, session.definitionSnapshotRef);
  if (!dispatch) return null;
  const livenessEvent = projection
    .readRuntimeSessionEventsByType(runtimeSessionId, ["runtime_session_liveness_changed"])
    .findLast(
      (event) =>
        event.type === "runtime_session_liveness_changed" &&
        sameWriteSource(event.source, dispatch.source) &&
        Number.isSafeInteger(event.payload.processGroupPid) &&
        Number(event.payload.processGroupPid) > 1,
    );
  const processGroupPid =
    livenessEvent?.type === "runtime_session_liveness_changed" ? (livenessEvent.payload.processGroupPid ?? null) : null;
  return {
    actor: dispatch.actor,
    source: dispatch.source,
    payload: {
      dispatchId: dispatch.payload.dispatchId,
      ...(dispatch.payload.taskId !== undefined ? { taskId: dispatch.payload.taskId } : {}),
      ...(dispatch.payload.agentId !== undefined ? { agentId: dispatch.payload.agentId } : {}),
      ...(dispatch.payload.agentDeclarationDigest !== undefined
        ? { agentDeclarationDigest: dispatch.payload.agentDeclarationDigest }
        : {}),
      ...(dispatch.payload.skillSnapshotDigest !== undefined
        ? { skillSnapshotDigest: dispatch.payload.skillSnapshotDigest }
        : {}),
    },
    instanceId: dispatch.payload.instanceId,
    processGroupPid,
  };
}

export async function enforceRuntimeSpendCap(context: RuntimeSpawnerContext, active: ActiveRuntime): Promise<void> {
  const [view] = readyDispatchLifecycle(
    await readDispatchLifecycle(context, { by: "session", runtimeSessionId: active.runtimeSessionId }),
    context.runtimeSpawnError,
  );
  if (!view || view.attempt.dispatchId !== active.dispatchId || view.policy.capacity === "released") return;
  if (!active.spendCapExceeded || active.cancelRequested || context.exiting.has(active.runtimeSessionId)) return;
  if (active.process.terminateTree) await active.process.terminateTree();
  else active.process.terminate();
  await consumeDurableOutput(context, active);
  await context.publishExit(active, null);
}

export async function steerRuntime(
  context: RuntimeSpawnerContext,
  payload: JsonObject,
  binding: RuntimeBinding,
): Promise<JsonObject> {
  const unknownField = unknownFieldViolation(payload, daemonMethodPayloadFields("repo.agentRuntime.steer"));
  if (unknownField)
    throw runtimeSpawnError("invalid_runtime_steer", `Runtime steer payload contains an ${unknownField}`);
  const runtimeSessionIdInput = payload.runtimeSessionId,
    dispatchIdInput = payload.dispatchId,
    prompt = requiredRuntimeSpawnText(payload.prompt, "prompt"),
    expected = parseRuntimeSteerExpectation(payload.expected);
  if ((typeof runtimeSessionIdInput === "string") === (typeof dispatchIdInput === "string"))
    throw runtimeSpawnError("invalid_runtime_steer", "Specify exactly one runtime session id or dispatch id.");
  const selector =
      typeof dispatchIdInput === "string"
        ? { dispatchId: dispatchIdInput }
        : { runtimeSessionId: runtimeSessionIdInput as string },
    { rootDir, repoId } = context.input;
  let header = resolveRuntimeSteerHeader(rootDir, selector);
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
            ),
          )
        : runtimeSpawnError(code, message);
  if (!header.binding || !ownedByRuntimeSpawner(header.binding, context.input.runtimeNode, header))
    throw refuse("execution_scope_mismatch", "This runtime is owned by another node.");
  await assertRuntimeRecoveryReady(context, runtimeSessionId);
  const runtimeHandles = context.processes;
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
    const current = resolveRuntimeSteerHeader(rootDir, selector);
    // A leaf that moved during adoption is a different target, whatever the caller stated.
    if (current.dispatchId !== header.dispatchId) {
      header = current;
      throw refuse("runtime_steer_target_changed", "The steer target changed while it was being resolved.");
    }
  }
  if (active && !runtimeKindForId(active.kindId).steerSupported)
    throw refuse("runtime_steer_unsupported", `${active.kindId} does not support runtime steering.`);
  if (!view?.policy.canSteer)
    throw refuse("runtime_steer_unavailable", "The canonical lifecycle has no running control target.");
  if (!active) throw refuse("runtime_steer_unavailable", "Runtime control transport is unavailable.");
  if (!active.providerSessionId)
    throw refuse("runtime_steer_unavailable", "Provider has not established a resumable session yet.");
  const target = runtimeSteerTarget(rootDir, repoId, header, "running"),
    mismatch = expected ? runtimeSteerMismatch(expected, target) : null;
  if (mismatch)
    throw runtimeSteerRefusal(
      "runtime_steer_target_changed",
      `The steer target no longer matches expected.${mismatch.field}.`,
      target,
      mismatch.field,
      mismatch.expected,
    );
  const version = target.version + 1,
    opId = `runtime-steer-${createHash("sha256").update(`${repoId}\0${runtimeSessionId}\0${context.input.now()}\0${prompt}`).digest("hex").slice(0, 32)}`;
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
  });
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-steer",
    outcome: "applied",
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

export function closeRuntimes(context: RuntimeSpawnerContext): void {
  const active = [...context.processes.values()];
  context.processes.clear();
  for (const entry of active) {
    disposeActiveRuntimeObservations(entry);
    entry.process.release?.();
    entry.releaseAuthorization?.();
  }
}
