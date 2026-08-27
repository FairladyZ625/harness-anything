import { createHash } from "node:crypto";
import type { AgentRuntimeEventV1, CanonicalEventStore, RuntimeResultClaim } from "../../kernel/src/index.ts";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { archiveRuntimeDispatch, type RuntimeDispatchArchive } from "./doc-sync-actions.ts";
import { consumeDurableOutput } from "./runtime-spawn-provider-stream.ts";
import type { ActiveRuntime } from "./runtime-spawn-types.ts";
import { pushWorkerBranch } from "./runtime-worker-push.ts";
import { classifyRuntimeExit } from "./runtime-provider-fault.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "./runtime-spawn-errors.ts";

export async function publishExit(context: any, active: ActiveRuntime, code: number | null): Promise<void> {
  if (
    context.exiting.has(active.runtimeSessionId) ||
    (!context.input.remote && context.requiredRuntimeStore(context.input).readEvent(`${active.dispatchOpId}-exited`))
  )
    return;
  context.exiting.add(active.runtimeSessionId);
  const cancelled = active.cancelRequested,
    eventBinding = cancelled && active.cancelBinding ? active.cancelBinding : active.binding;
  try {
    await consumeDurableOutput(context, active);
    if (!cancelled && code === null)
      context.input.stream.publish(active.runtimeSessionId, {
        type: "error",
        code: "provider_disconnected",
      });
    if (
      !cancelled &&
      (active.providerSessionId === null ||
        (code === 0 && (active.finalText === null || active.providerOutcome === null)))
    )
      context.markProtocolError(active);
    const { outcome: initialOutcome, ...classifiedAttempt } = classifyRuntimeExit(active, code),
      attemptOutcome = {
        ...classifiedAttempt,
        reason: String(scrubProviderValue(classifiedAttempt.reason)).slice(0, 1024),
      };
    let outcome = initialOutcome;
    active.stream.appendAttemptOutcome(attemptOutcome, context.input.now());
    let body = context.runtimeResultText(active, code, outcome);
    if (active.task && outcome === "succeeded") {
      try {
        const env = await context.prepareWorkerGitEnvironment(active.instanceId),
          push = await pushWorkerBranch({ cwd: active.cwd, canonicalRoot: context.input.rootDir, env });
        if (push.attempted && !push.ok) body = `${body}\n\nWorker branch push failed (no retry): ${push.detail}`;
      } catch (error) {
        consumeKnownError(error);
        const detail = String(scrubProviderValue(error instanceof Error ? error.message : String(error))).slice(0, 512);
        body = `${body}\n\nWorker branch push failed (no retry): ${detail || "GitHub credential resolution failed."}`;
      }
    }
    let reasonCode: string | null = null,
      sha256 = createHash("sha256").update(body).digest("hex"),
      result: RuntimeResultClaim = {
        sha256,
        size: Buffer.byteLength(body),
        mediaType: context.resultMediaType,
      },
      resultRef = `artifact:runtime-result/sha256/${sha256}`;
    const endedAt = context.input.now(),
      archive: RuntimeDispatchArchive | null = active.task
        ? {
            dispatchId: active.dispatchId,
            taskId: active.task.taskId,
            executionId: active.task.executionId,
            ...(active.agent ? { agentId: active.agent.id, agentName: active.agent.name } : {}),
            ...(active.squadId ? { squadId: active.squadId } : {}),
            ...(active.parentRuntimeSessionId ? { parentRuntimeSessionId: active.parentRuntimeSessionId } : {}),
            ...(active.delegatedBy
              ? {
                  delegatedByAgentId: active.delegatedBy.id,
                  delegatedByAgentName: active.delegatedBy.name,
                }
              : {}),
            instanceId: active.instanceId,
            model: active.model,
            reasoningEffort: active.reasoningEffort,
            cwd: active.cwd,
            prompt: scrubProviderValue(active.prompt) as string,
            ...(active.promptSource ? { promptSource: active.promptSource } : {}),
            ...(active.onExitCommand ? { onExitCommand: active.onExitCommand } : {}),
            runtimeSessionId: active.runtimeSessionId,
            providerSessionId: active.providerSessionId,
            startedAt: active.startedAt,
            endedAt,
            outcome,
            exitCode: cancelled ? null : code,
            resultRef,
            resultText: body,
            eventStreamRef: active.stream.ref,
            attemptGroupId: attemptOutcome.attemptGroupId,
            attemptIndex: attemptOutcome.attemptIndex,
            provider: { instance: attemptOutcome.provider.instance, model: attemptOutcome.provider.model },
            classification: attemptOutcome.classification,
            reason: attemptOutcome.reason,
          }
        : null;
    if (archive)
      try {
        const archived = context.input.remote
          ? await context.input.remote.archive(archive)
          : archiveRuntimeDispatch({
              workspaceId: context.input.repoId,
              rootDir: context.input.rootDir,
              store: context.requiredRuntimeStore(context.input),
              projection: context.requiredRuntimeProjection(context.input),
              binding: active.binding,
              now: context.input.now,
              archive,
            });
        if (archived.outcome !== "applied")
          throw context.runtimeSpawnError(
            "runtime_archive_failed",
            archived.nextAction ?? `Runtime archive ${active.dispatchId} was not applied.`,
          );
      } catch (error) {
        consumeKnownError(error);
        const detail = String(scrubProviderValue(error instanceof Error ? error.message : String(error))).slice(0, 512);
        console.warn(`[runtime-archive] ${active.dispatchId} could not be archived: ${detail}`);
      }
    if (cancelled) {
      await context.publishRuntimeEvent(
        "runtime_session_cancelled",
        { runtimeSessionId: active.runtimeSessionId },
        active.cancelOpId ?? `${active.dispatchOpId}-cancelled`,
        eventBinding,
      );
      await context.publishRuntimeEvent(
        "runtime_session_exited",
        { runtimeSessionId: active.runtimeSessionId },
        `${active.dispatchOpId}-exited`,
        eventBinding,
      );
    }
    context.processes.delete(active.runtimeSessionId);
    active.process.release?.();
    await context
      .settleFallback(active, attemptOutcome, {
        runtimeSessionId: active.runtimeSessionId,
        dispatchId: active.dispatchId,
        task: active.task,
        schedule: active.schedule,
        outcome: outcome === "succeeded" ? "succeeded" : "failed",
        reason: outcome === "succeeded" ? null : attemptOutcome.reason,
        endedAt,
        resultRef,
        binding: active.binding,
      })
      .catch((error: unknown) => {
        consumeKnownError(error);
        const settlementCode = runtimeErrorCode(error) || "runtime_settlement_failed";
        reasonCode = settlementCode;
        outcome = "unknown";
        body = `Runtime terminal settlement failed (${settlementCode}): ${runtimeErrorMessage(error)}`;
        sha256 = createHash("sha256").update(body).digest("hex");
        result = { sha256, size: Buffer.byteLength(body), mediaType: context.resultMediaType };
        resultRef = `artifact:runtime-result/sha256/${sha256}`;
      });
    if (!cancelled)
      await context.publishRuntimeEvent(
        "runtime_session_exited",
        { runtimeSessionId: active.runtimeSessionId },
        `${active.dispatchOpId}-exited`,
        eventBinding,
      );
    context.input.recordLifecycle?.({
      event: "runtime_exit",
      runtimeSessionId: active.runtimeSessionId,
      dispatchId: active.dispatchId,
      pid: active.process.pid,
      exitCode: active.lossExitCode ?? (cancelled ? null : code),
      signal: active.lossSignal,
      outcome: active.lossReason ? "lost" : outcome,
      reason: active.lossReason,
    });
    const outcomeEvent = await context.publishRuntimeEvent(
      "runtime_session_outcome_observed",
      {
        runtimeSessionId: active.runtimeSessionId,
        outcome,
        exitCode: cancelled ? null : code,
        resultRef,
        result,
        ...(reasonCode ? { reasonCode } : {}),
      },
      `${active.dispatchOpId}-outcome`,
      eventBinding,
      body,
    );
    context.input.onRuntimeOutcome?.(outcomeEvent.event, active.schedule);
    context.input.stream.publish(active.runtimeSessionId, { type: "exit", outcome });
    if (active.onExitCommand !== null)
      setImmediate(() =>
        context.launchExitNotification({
          command: active.onExitCommand,
          cwd: active.cwd,
          stream: active.stream,
          payload: {
            schema: "runtime-session-exited/v1" as const,
            runtimeSessionId: active.runtimeSessionId,
            outcome,
            exitCode: cancelled ? null : code,
            nextAction: `ha runtime status ${active.runtimeSessionId} --wait`,
          },
          now: context.input.now,
        }),
      );
  } finally {
    context.exiting.delete(active.runtimeSessionId);
  }
}

export function runtimeResultText(
  context: any,
  active: ActiveRuntime,
  code: number | null,
  outcome: "succeeded" | "failed" | "unknown" | "cancelled",
): string {
  if (active.lossReason)
    return `Runtime session lost: ${active.lossReason}${active.lossSignal ? ` (${active.lossSignal})` : ""}.`;
  if (code === 0 || code === null)
    return scrubProviderValue(
      active.finalText ??
        (outcome === "failed"
          ? (active.failureText ?? "Provider reported failure without a structured diagnostic.")
          : ""),
    ) as string;
  const details = [
    active.failureText,
    active.errorOverflowed
      ? "Provider stderr was omitted because it exceeded the diagnostic limit."
      : active.errorBuffer.trim() || null,
  ]
    .filter((value): value is string => value !== null)
    .map((value) => scrubProviderValue(value) as string);
  if (details.length) return `Provider exited with code ${String(code)}. ${details.join("\n")}`;
  return active.stdoutObserved
    ? `Provider exited with code ${String(code)} without a structured failure or stderr diagnostic.`
    : `Provider exited with code ${String(code)} and produced no output.`;
}

export function applied(
  context: any,
  event: AgentRuntimeEventV1,
  publication: ReturnType<CanonicalEventStore["publication"]>,
  runtimeSessionId: string,
  dispatchId: string,
) {
  const revision = event.workspaceRevision,
    canonicalVisible = publication.cut.opId === event.opId && publication.cut.revision === revision,
    base = {
      schema: "command-receipt/v2",
      ok: true,
      command: "runtime-spawn",
      opId: event.opId,
      runtimeSessionId,
      dispatchId,
      revision,
      evidence: `event-object:${event.opId}`,
      visibility: "center" as const,
      proof: {
        committedRevision: revision,
        appliedCut: publication.cut.revision,
        durable: canonicalVisible,
        canonicalVisible,
        worktreeVisible: null,
      },
    };
  return canonicalVisible
    ? { ...base, outcome: "applied" as const, nextAction: null }
    : {
        ...base,
        outcome: "pending" as const,
        nextAction: `Query receipt ${event.opId}; its canonical publication cut is not exact.`,
      };
}

export function controlReceipt(context: any, opId: string, runtimeSessionId: string, detail = "cancelled") {
  if (context.input.remote)
    return {
      schema: "command-receipt/v2",
      ok: true,
      command: "runtime-cancel",
      outcome: detail === "cancelled" ? ("applied" as const) : ("pending" as const),
      opId,
      runtimeSessionId,
      evidence: `runtime-cancel:${detail}:${runtimeSessionId}`,
      visibility: "center" as const,
      detail,
      nextAction:
        detail === "cancelled"
          ? null
          : `No active edge process exists for ${runtimeSessionId}; query center status before retrying.`,
    };
  const store = context.requiredRuntimeStore(context.input),
    published = store.readEvent(opId),
    revision = published?.workspaceRevision ?? store.readHead()?.revision ?? 0,
    publication = published ? store.publication(published) : null,
    canonicalVisible = published !== null && publication?.cut.opId === opId && publication.cut.revision === revision,
    base = {
      schema: "command-receipt/v2",
      ok: true,
      command: "runtime-cancel",
      opId,
      runtimeSessionId,
      revision,
      evidence: `runtime-cancel:${detail}:${runtimeSessionId}`,
      visibility: "center" as const,
      proof: {
        committedRevision: revision,
        appliedCut: publication?.cut.revision ?? 0,
        durable: canonicalVisible,
        canonicalVisible,
        worktreeVisible: null,
      },
      detail,
    };
  return canonicalVisible
    ? { ...base, outcome: "applied" as const, nextAction: null }
    : {
        ...base,
        outcome: "pending" as const,
        nextAction: [
          "No canonical cancellation event exists for ",
          `${runtimeSessionId}`,
          "; query the runtime before retrying.",
        ].join(""),
      };
}
