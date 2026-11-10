import { createHash } from "node:crypto";
import { sameWriteSource, type TaskProjection } from "@harness-anything/kernel";
import { unknownFieldViolation, type JsonObject } from "./protocol/json-rpc-types.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import { adoptRuntimes, ownedByRuntimeSpawner, assertRuntimeRecoveryReady } from "./runtime-spawn-adoption.ts";
import { appendRuntimeWorkerRecord, readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";
import { probeProcessGroup, processGroupRecoveryHint } from "./runtime/process-group-reconciler.ts";
import type { ActiveRuntime, RuntimeBinding, RuntimeDispatchOwnerEvidence } from "./runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import { disposeActiveRuntimeObservations } from "./runtime-spawn-active.ts";
import { dispatchLifecyclePendingError, readDispatchLifecycle } from "./runtime-dispatch-admission.ts";
import {
  parseRuntimeSteerExpectation,
  resolveRuntimeSteerHeader,
  runtimeSteerMismatch,
  runtimeSteerReceiptTarget,
  runtimeSteerRefusal,
  runtimeSteerTarget,
  type RuntimeSteerLiveness,
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
  // Terminal streams retain their owner binding after archival; repeated cancellation still verifies it.
  const headers = readDispatchStreamHeaders(context.input.rootDir, true),
    matchingHeader = headers.find((header) => header.runtimeSessionId === runtimeSessionId),
    canonicalDispatch =
      matchingHeader !== undefined
        ? null
        : context.input.remote?.readRuntimeDispatch
          ? await context.input.remote.readRuntimeDispatch(runtimeSessionId)
          : readLocalRuntimeDispatchOwner(context, runtimeSessionId),
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
        (canonicalDispatch.actor.principal.personId === binding.actor.principal.personId && sameSource)),
    missingOwnedProcess =
      owned &&
      !context.processes.has(runtimeSessionId) &&
      (matchingHeader === undefined ||
        (matchingHeader.binding !== undefined &&
          ownedByRuntimeSpawner(matchingHeader.binding, context.input.runtimeNode, matchingHeader) &&
          !readDispatchStreamSummary(context.input.rootDir, matchingHeader.dispatchId)?.process));
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
        context.processes.has(runtimeSessionId) ||
        context.exiting.has(runtimeSessionId) ||
        context.ownsModelSlot?.(runtimeSessionId) === true,
      dispatchId = matchingHeader?.dispatchId ?? canonicalDispatch?.payload.dispatchId,
      hasReadableDispatch =
        matchingHeader !== undefined ||
        (typeof dispatchId === "string" && readDispatchStreamSummary(context.input.rootDir, dispatchId) !== null),
      hasRecordedProcessGroup =
        canonicalDispatch?.processGroupPid !== null && canonicalDispatch?.processGroupPid !== undefined;
    if (hasLocalOwner || hasReadableDispatch || hasRecordedProcessGroup)
      throw runtimeSpawnError(
        "runtime_ruling_not_allowed",
        "Owner ruling requires no local runtime owner, no readable dispatch stream, and no recorded process group.",
      );
  }
  if (!context.processes.has(runtimeSessionId) && !missingOwnedProcess) {
    const [adoption] = await Promise.allSettled([
      adoptRuntimes(context, undefined, { runtimeSessionId, authorizationBinding: binding }),
    ]);
    if (adoption.status === "rejected" && !context.processes.has(runtimeSessionId)) throw adoption.reason;
  }
  if (!missingOwnedProcess) await assertRuntimeRecoveryReady(context, runtimeSessionId);
  const currentLifecycle = await readDispatchLifecycle(context, { by: "session", runtimeSessionId });
  if (currentLifecycle.status !== "ready")
    throw dispatchLifecyclePendingError(currentLifecycle, context.runtimeSpawnError);
  attempt = currentLifecycle.rows[0];
  const active = context.processes.get(runtimeSessionId);
  if (active) {
    active.cancelBinding = binding;
    // The mechanical stop must retain whether it was requested by the escalation action. Runtime
    // settlement uses this marker to distinguish a worker-owned report from an ordinary owner
    // cancellation that happens to race with a ruling artifact.
    active.cancelOpId = escalation ? `${opId}:escalation` : opId;
    active.cancelRequested = true;
    if (escalation) {
      // The worker may be synchronously waiting for this command's response. Returning only
      // after terminateTree would wait for that CLI child, which waits for us: stop the provider
      // now, let the response flush, and finish the full tree cleanup in the next check phase.
      active.process.terminate();
      setImmediate(() => {
        const terminateTree = active.process.terminateTree;
        if (terminateTree)
          void terminateTree().catch((error: unknown) =>
            console.error("[runtime-escalation] descendant cleanup failed", error),
          );
      });
      void consumeDurableOutput(context, active)
        .then(() => context.publishExit(active, null))
        .catch((error: unknown) => console.error("[runtime-escalation] settlement failed", error));
      return context.controlReceipt(opId, runtimeSessionId, "requested");
    }
    if (active.process.terminateTree) await active.process.terminateTree();
    else active.process.terminate();
    // Cancel holds the write queue: lines flushed during termination drain into work queued behind
    // it, which is dropped once settlement retires the runtime. Settle them from the stream.
    await consumeDurableOutput(context, active);
    await context.publishExit(active, null);
    return context.controlReceipt(opId, runtimeSessionId);
  }
  if (attempt?.policy.attemptSettled || attempt?.attempt.stopProof === "proven_stopped")
    return context.controlReceipt(opId, runtimeSessionId, "already-exited");
  // A missing process record still needs canonical owner evidence; a local header alone
  // cannot prove that the worker or its descendants stopped.
  if (attempt && attempt.attempt.outcome === null) {
    const instanceId = matchingHeader?.instanceId ?? canonicalDispatch?.instanceId;
    let processGroupPid: number | null = null;
    if (matchingHeader !== undefined || attempt.attempt.process !== "exited") {
      const ownerEvidence =
        canonicalDispatch ??
        (context.input.remote?.readRuntimeDispatch
          ? await context.input.remote.readRuntimeDispatch(runtimeSessionId)
          : readLocalRuntimeDispatchOwner(context, runtimeSessionId));
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
    if (matchingHeader?.taskId && matchingHeader.executionId) {
      const settlement = await context.input.onAttemptTerminal?.({
        runtimeSessionId,
        dispatchId: matchingHeader.dispatchId,
        task: {
          taskId: matchingHeader.taskId,
          executionId: matchingHeader.executionId,
          leaseVersion: matchingHeader.leaseVersion ?? null,
        },
        schedule: matchingHeader.schedule ?? null,
        outcome: "cancelled",
        reason: "Runtime session cancelled after its worker process was no longer available.",
        endedAt: context.input.now(),
        binding: terminalBinding,
        ...(processGroupPid === null ? {} : { processGroupPid }),
      });
      if (settlement?.outcome === "lease_unproven") throw runtimeSpawnError(settlement.code, settlement.reason);
    }
    await context.publishRuntimeEvent("runtime_session_cancelled", { runtimeSessionId }, `${opId}-cancelled`, binding);
    await context.publishRuntimeEvent(
      "runtime_session_exited",
      { runtimeSessionId },
      `${opId}-exited`,
      terminalBinding,
    );
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

function readLocalRuntimeDispatchOwner(
  context: RuntimeSpawnerContext,
  runtimeSessionId: string,
): RuntimeDispatchOwnerEvidence | null {
  return readRuntimeDispatchOwnerEvidence(context.requiredRuntimeProjection(context.input), runtimeSessionId);
}

export async function enforceRuntimeSpendCap(context: RuntimeSpawnerContext, active: ActiveRuntime): Promise<void> {
  if (context.processes.get(active.runtimeSessionId) !== active) return;
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
  const runtimeSessionId = header.runtimeSessionId,
    liveness = (): RuntimeSteerLiveness => {
      const owned = context.processes.get(header.runtimeSessionId);
      if (!owned || !runtimePidIsAlive(owned.process.pid)) return "stopped";
      return owned.providerSessionId ? "running" : "starting";
    },
    // With an expectation, every refusal carries the current target so the caller can re-read.
    refuse = (code: string, message: string): Error =>
      expected
        ? runtimeSteerRefusal(code, message, runtimeSteerTarget(rootDir, repoId, header, liveness()))
        : runtimeSpawnError(code, message);
  if (!header.binding || !ownedByRuntimeSpawner(header.binding, context.input.runtimeNode, header))
    throw refuse("execution_scope_mismatch", "This runtime is owned by another node.");
  await assertRuntimeRecoveryReady(context, runtimeSessionId);
  let active = context.processes.get(runtimeSessionId);
  if (!active) {
    await adoptRuntimes(context, undefined, { runtimeSessionId });
    await assertRuntimeRecoveryReady(context, runtimeSessionId);
    active = context.processes.get(runtimeSessionId);
  }
  // No await from here to the append: the comparison and the write are one section of the writer.
  if (expected) {
    const current = resolveRuntimeSteerHeader(rootDir, selector);
    // A leaf that moved during adoption is a different target, whatever the caller stated.
    if (current.dispatchId !== header.dispatchId) {
      header = current;
      throw refuse("runtime_steer_target_changed", "The steer target changed while it was being resolved.");
    }
  }
  if (!active) throw refuse("runtime_not_running", "Runtime is not running.");
  if (!runtimeKindForId(active.kindId).steer)
    throw refuse("runtime_steer_unsupported", `${active.kindId} does not support runtime steering.`);
  if (!active.providerSessionId)
    throw refuse("runtime_steer_unavailable", "Provider has not established a resumable session yet.");
  // A recorded request nobody follows is not an applied steer: the host is the only reader of
  // this stream, and a host that is gone cannot be steered back. Settlement retires the runtime,
  // but the window before it does would otherwise report success into an empty room.
  if (!runtimePidIsAlive(active.process.pid))
    throw refuse("runtime_steer_unavailable", "Runtime control channel is unavailable.");
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
