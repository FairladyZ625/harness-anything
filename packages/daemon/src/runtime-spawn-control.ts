import { createHash } from "node:crypto";
import { sameWriteSource, type TaskProjection } from "@harness-anything/kernel";
import { unknownFieldViolation, type JsonObject } from "./protocol/json-rpc-types.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import { adoptRuntimes, ownedByRuntimeSpawner, assertRuntimeRecoveryReady } from "./runtime-spawn-adoption.ts";
import { appendRuntimeWorkerRecord, readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { probeProcessGroup, processGroupRecoveryHint } from "./runtime/process-group-reconciler.ts";
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
  const allowed = ["runtimeSessionId", "escalation", "ruling"],
    unknownField = unknownFieldViolation(payload, allowed);
  if (unknownField)
    throw runtimeSpawnError("invalid_runtime_cancel", `Runtime cancel payload contains an ${unknownField}`);
  const runtimeSessionId = requiredRuntimeSpawnText(payload.runtimeSessionId, "runtimeSessionId"),
    escalation = payload.escalation === true,
    ruling = payload.ruling === undefined ? null : requiredRuntimeSpawnText(payload.ruling, "ruling").trim(),
    hash = createHash("sha256").update(`${context.input.repoId}\0${runtimeSessionId}`).digest("hex"),
    opId = `runtime-cancel-${hash.slice(0, 32)}`;
  if (ruling === "") throw runtimeSpawnError("invalid_runtime_ruling", "Owner ruling reason must not be empty.");
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
    sameSource =
      canonicalDispatch === null ||
      canonicalDispatch === undefined ||
      sameWriteSource(canonicalDispatch.source, binding.source),
    owned =
      ownerBinding !== null &&
      ownerBinding !== undefined &&
      ownerBinding.actor?.principal.personId === binding.actor.principal.personId &&
      ownedByRuntimeSpawner(ownerBinding, context.input.runtimeNode, matchingHeader) &&
      (canonicalDispatch === null ||
        canonicalDispatch === undefined ||
        (canonicalDispatch.actor.principal.personId === binding.actor.principal.personId && sameSource));
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
    throw runtimeSpawnError(
      "execution_scope_mismatch",
      "This runtime has no owner dispatch on this node; cancel it through its owner.",
    );
  }
  if (ruling !== null) {
    // A ruling is an owner decision for an unreachable runtime only. Check every
    // precondition before recovery, process-group probing, or the active-process
    // branch can perform a physical cancellation or cleanup.
    const hasLocalOwner =
        active !== undefined ||
        context.exiting.has(runtimeSessionId) ||
        context.ownsModelSlot?.(runtimeSessionId) === true,
      hasReadableDispatch = matchingHeader !== undefined,
      hasRecordedProcessGroup = canonicalDispatch?.processGroupPid != null;
    if (hasLocalOwner || hasReadableDispatch || hasRecordedProcessGroup)
      throw runtimeSpawnError(
        "runtime_ruling_not_allowed",
        "Owner ruling requires no local runtime owner, no readable dispatch stream, and no recorded process group.",
      );
  }
  // Recovery observes only an admitted attempt with a local spool. Missing spools go to the
  // same fenced process-group observer below; absence never releases a reservation by itself.
  if (matchingHeader && !active && attempt?.policy.capacityDisposition === "busy") {
    await adoptRuntimes(context, undefined, { runtimeSessionId, authorizationBinding: binding });
    await assertRuntimeRecoveryReady(context, runtimeSessionId);
  }
  const currentLifecycle = await readDispatchLifecycle(context, { by: "session", runtimeSessionId });
  if (currentLifecycle.status !== "ready")
    throw dispatchLifecyclePendingError(currentLifecycle, context.runtimeSpawnError);
  attempt = currentLifecycle.rows[0];
  active = runtimeHandles.get(runtimeSessionId);
  if (active) return stopOwnedRuntime(active);
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
      void context
        .publishExit(active, null)
        .catch((error: unknown) => console.error("[runtime-escalation] settlement failed", error));
      return context.controlReceipt(opId, runtimeSessionId, "requested");
    }
    await context.publishExit(active, null);
    return context.controlReceipt(opId, runtimeSessionId);
  }
  if (attempt?.policy.attemptSettled || attempt?.attempt.stopProof === "proven_stopped")
    return context.controlReceipt(opId, runtimeSessionId, "already-exited");
  // Missing control transport does not prove the process tree stopped.
  if (attempt && attempt.attempt.outcome === null) {
    const instanceId = matchingHeader?.instanceId ?? canonicalDispatch?.instanceId;
    const ownerEvidence =
        canonicalDispatch ??
        (context.input.remote?.readRuntimeDispatch
          ? await context.input.remote.readRuntimeDispatch(runtimeSessionId)
          : readRuntimeDispatchOwnerEvidence(context.requiredRuntimeProjection(context.input), runtimeSessionId)),
      processGroupPid =
        ownerEvidence?.actor.principal.personId === ownerBinding.actor.principal.personId &&
        sameWriteSource(ownerEvidence.source, ownerBinding.source) &&
        (matchingHeader === undefined || ownerEvidence.payload.dispatchId === matchingHeader.dispatchId)
          ? ownerEvidence.processGroupPid
          : null;
    if (
      probeProcessGroup({
        pgid: processGroupPid ?? undefined,
        ...(matchingHeader
          ? { dispatch: { rootDir: context.input.rootDir, dispatchId: matchingHeader.dispatchId } }
          : {}),
      }) !== "proven_stopped"
    ) {
      if (ruling !== null) {
        const resultBody = JSON.stringify({
            schema: "runtime-ruling-resolution/v1",
            runtimeSessionId,
            dispatchId: ownerEvidence?.payload.dispatchId ?? null,
            from: "awaiting_ruling",
            to: "closed",
            event: "ruling_resolved",
            disposition: "abandoned_unproven",
            processStop: "unproven",
            actor: binding.actor,
            resolvedAt: context.input.now(),
            reason: ruling,
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
          binding,
          resultBody,
        );
        return context.controlReceipt(opId, runtimeSessionId, "ruling_resolved");
      }
      throw runtimeSpawnError(
        "runtime_process_group_unproven",
        `Owner process group ${String(processGroupPid ?? "unknown")} could not be proven stopped.${processGroupRecoveryHint()}`,
      );
    }
    if (typeof instanceId === "string") {
      const failure = context.input.reclaimRuntimeTempDirectory?.(instanceId, runtimeSessionId) ?? null;
      if (failure)
        console.error(
          `[runtime-temp] ${instanceId}/${runtimeSessionId} could not be reclaimed after owner loss: ${failure.message}`,
        );
    }
    const terminalBinding = {
      ...binding,
      source: ownerBinding.source,
      actor: {
        principal: binding.actor.principal,
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
    };
    await context.publishRuntimeEvent(
      "runtime_session_exited",
      { runtimeSessionId },
      `${opId}-exited`,
      terminalBinding,
    );
    await context.publishRuntimeEvent("runtime_session_cancelled", { runtimeSessionId }, `${opId}-cancelled`, binding);
    const resultBody = "Runtime session cancelled after its worker process was no longer available.",
      resultSha256 = createHash("sha256").update(resultBody).digest("hex");
    await context.publishRuntimeEvent(
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
    return context.controlReceipt(opId, runtimeSessionId, "cancelled");
  }
  return context.controlReceipt(opId, runtimeSessionId, "already-exited");
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
    payload: { dispatchId: dispatch.payload.dispatchId },
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
  const unknownField = unknownFieldViolation(payload, ["runtimeSessionId", "dispatchId", "prompt", "expected"]);
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
  const liveness = () =>
    view?.policy.canSteer
      ? ("running" as const)
      : view?.attempt.phase === "starting"
        ? ("starting" as const)
        : ("stopped" as const);
  const // With an expectation, every refusal carries the current target so the caller can re-read.
    refuse = (code: string, message: string): Error =>
      expected
        ? runtimeSteerRefusal(code, message, runtimeSteerTarget(rootDir, repoId, header, liveness()))
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
  if (!view?.policy.canSteer)
    throw refuse("runtime_steer_unavailable", "The canonical lifecycle has no running control target.");
  if (!active) throw refuse("runtime_steer_unavailable", "Runtime control transport is unavailable.");
  if (!runtimeKindForId(active.kindId).steer)
    throw refuse("runtime_steer_unsupported", `${active.kindId} does not support runtime steering.`);
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
