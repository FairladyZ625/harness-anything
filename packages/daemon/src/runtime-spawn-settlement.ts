import { createHash } from "node:crypto";
import type { AgentRuntimeEventV1, CanonicalEventStore, RuntimeResultClaim } from "@harness-anything/kernel";
import { consumeKnownError } from "@harness-anything/kernel";
import { archiveDispatchStream, readDispatchStream, scrubProviderValue } from "./dispatch-stream.ts";
import { archiveRuntimeDispatch, type RuntimeDispatchArchive } from "./doc-sync-actions.ts";
import type { ActiveRuntime } from "./runtime-spawn-types.ts";
import { pushWorkerBranch, workerBranchHasDelivery } from "./runtime-worker-push.ts";
import { classifyRuntimeExit } from "./runtime-provider-fault.ts";
import { isProviderFailureClassification } from "./runtime-fallback-contract.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "./runtime-spawn-errors.ts";
import { scheduleOutcomeFromRuntime } from "./schedule-runtime-outcome.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { presetSnapshotReader, taskOutputShape } from "./task-worktree.ts";

export async function publishExit(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  code: number | null,
): Promise<void> {
  if (
    context.exiting.has(active.runtimeSessionId) ||
    (!context.input.remote && context.requiredRuntimeStore(context.input).readEvent(`${active.dispatchOpId}-exited`))
  )
    return;
  context.exiting.add(active.runtimeSessionId);
  const cancelled = active.cancelRequested,
    cancelBinding = cancelled && active.cancelBinding ? active.cancelBinding : active.binding,
    terminalBinding = runtimeSessionBinding(active.binding, active.runtimeSessionId),
    squadLeaderControl = active.squadId !== null && active.delegatedBy === null;
  try {
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
    const { outcome: initialOutcome, ...classifiedAttempt } = classifyRuntimeExit(active, code);
    let outcome = initialOutcome,
      reviewResultMissing = false;
    if (outcome === "unknown" && code === 0 && (await runtimeDeliveryWitness(context, active))) outcome = "succeeded";
    if (outcome === "succeeded" && active.decisionReviewTarget) {
      const target = active.decisionReviewTarget,
        reviewRegistered = context
          .requiredRuntimeProjection(context.input)
          .readDecision(target.decisionId)
          .decision?.reviews.some(
            (review) =>
              review.reviewId === `review-${active.dispatchId}` && review.reviewContentDigest === target.digest,
          );
      if (!reviewRegistered) {
        outcome = "failed";
        reviewResultMissing = true;
      }
    }
    const attemptOutcome = {
      ...classifiedAttempt,
      // Provider failures are the classifications a fallback continuation carries forward, and
      // their reason is a raw diagnostic excerpt — shape those into one line plus the dispatch
      // stream reference. Worker-stop and gate-red reasons stay byte-identical to before.
      reason: isProviderFailureClassification(classifiedAttempt.classification)
        ? attemptOutcomeReason(classifiedAttempt.reason, active.stream.ref)
        : outcome === "succeeded"
          ? "Worker completed the attempt successfully."
          : String(scrubProviderValue(classifiedAttempt.reason)).slice(0, 1024),
    };
    active.stream.appendAttemptOutcome(attemptOutcome, context.input.now());
    const runtimeMetrics = {
      inputTokens: active.inputTokens,
      cacheReadTokens: active.cacheReadTokens,
      outputTokens: active.outputTokens,
      totalTokens: active.inputTokens + active.outputTokens,
      toolCallCount: active.toolCallCount,
      usageUnavailable: !active.usageReported,
    };
    active.stream.appendRuntimeMetrics?.(
      { ...runtimeMetrics, compacted: active.compacted, raw: active.rawUsage },
      context.input.now(),
    );
    let body = context.runtimeResultText(active, code, outcome);
    let hasDelivery =
      active.task && outcome === "succeeded" && active.publicationOwner === "commander" && !squadLeaderControl
        ? await workerBranchHasDelivery({
            cwd: active.cwd,
            canonicalRoot: context.input.rootDir,
            taskId: active.task.taskId,
          })
        : false;
    // Squad children deliver local commits for Commander integration; leaders own publication.
    // Keep leader control JSON and child delivery text intact. Direct dispatches retain auto-push.
    if (active.task && outcome === "succeeded" && active.publicationOwner !== "commander" && !squadLeaderControl) {
      try {
        // An edge holds no projection to read a submitted commit from: its settlement publishes the branch head.
        const projection = context.input.projection ? context.requiredRuntimeProjection(context.input) : null,
          submittedCommitSha = projection
            ?.read(active.task.taskId)
            .snapshot.executions.find((execution) => execution.executionId === active.task?.executionId)
            ?.submission?.commitSha,
          env = await context.prepareWorkerGitEnvironment(active.instanceId),
          push = await pushWorkerBranch({
            cwd: active.cwd,
            canonicalRoot: context.input.rootDir,
            taskId: active.task.taskId,
            ...(submittedCommitSha ? { submittedCommitSha } : {}),
            env,
          });
        hasDelivery = push.attempted && push.pushedCommit !== null;
        if (push.attempted)
          body = push.ok
            ? `${body}\n\nWorker branch pushed at settlement: ${push.branch} @ ${push.pushedCommit}${
                push.head === push.pushedCommit ? "" : ` (worker HEAD ${push.head})`
              }`
            : [
                `${body}\n\nWorker branch push failed (no retry):`,
                `${push.branch ?? "unknown branch"} @ ${push.pushedCommit ?? "unknown delivery commit"}${
                  push.head && push.head !== push.pushedCommit ? ` (worker HEAD ${push.head})` : ""
                }: ${push.detail}`,
              ].join(" ");
      } catch (error) {
        consumeKnownError(error);
        const detail = String(scrubProviderValue(error instanceof Error ? error.message : String(error))).slice(0, 512);
        body = `${body}\n\nWorker branch push failed (no retry): ${detail || "GitHub credential resolution failed."}`;
      }
    }
    const submissionRecovery = unsubmittedDeliveryRecovery(context, active, outcome, hasDelivery);
    if (submissionRecovery) body = `${body}\n\n${submissionRecovery}`;
    let reasonCode: string | null = reviewResultMissing ? "review_result_missing" : null,
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
            fast: active.fast,
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
    if (archive) {
      try {
        const archived = context.input.remote
          ? await context.input.remote.archive(archive)
          : archiveRuntimeDispatch({
              workspaceId: context.input.repoId,
              rootDir: context.input.rootDir,
              store: context.requiredRuntimeStore(context.input),
              projection: context.requiredRuntimeProjection(context.input),
              binding: context.input.authorizeRuntimeArchive?.(archive, terminalBinding) ?? terminalBinding,
              now: context.input.now,
              archive,
            });
        if (archived.outcome !== "applied" && archived.outcome !== "no_changes")
          throw context.runtimeSpawnError(
            "runtime_archive_failed",
            `Runtime archive ${active.dispatchId} was not applied: ${archived.outcome}${
              "code" in archived && typeof archived.code === "string" ? ` ${archived.code}` : ""
            }${"detail" in archived && archived.detail ? ` ${JSON.stringify(archived.detail)}` : ""}`,
          );
      } catch (error) {
        consumeKnownError(error);
        const detail = String(scrubProviderValue(error instanceof Error ? error.message : String(error))).slice(0, 512);
        // A required task report is part of the success cut. Keep the terminal
        // event honest when publication fails, while still publishing the exit
        // event so the runtime cannot remain live forever.
        console.error(`[runtime-archive] ${active.dispatchId} could not be archived: ${detail}`);
        // Settlement honesty for a reviewer is whether the review was registered, not whether
        // every archive document was fresh: a reviewer that already recorded its RecordReview
        // (which publishes the report documents itself) keeps its real outcome, and the archive
        // failure is recorded as a note instead of flipping the dispatch to failed.
        const reviewRegistered =
          active.role === "reviewer" &&
          active.task !== null &&
          context
            .requiredRuntimeProjection(context.input)
            .read(active.task.taskId)
            .snapshot.reviews.some((review) => review.reviewId === `review-${active.dispatchId}`);
        if (!reviewRegistered) {
          outcome = "failed";
          reasonCode = "runtime_archive_failed";
        }
        // The worker result is independently durable input to this settlement.
        // Preserve it in the terminal content while appending the reason that
        // prevents this Task execution from claiming success.
        body = `${body}\n\nRuntime archive publication failed: ${detail || "unknown error"}`;
        sha256 = createHash("sha256").update(body).digest("hex");
        result = { sha256, size: Buffer.byteLength(body), mediaType: context.resultMediaType };
        resultRef = `artifact:runtime-result/sha256/${sha256}`;
      }
    }
    if (cancelled) {
      await context.publishRuntimeEvent(
        "runtime_session_cancelled",
        { runtimeSessionId: active.runtimeSessionId },
        active.cancelOpId ?? `${active.dispatchOpId}-cancelled`,
        cancelBinding,
      );
      await context.publishRuntimeEvent(
        "runtime_session_exited",
        { runtimeSessionId: active.runtimeSessionId },
        `${active.dispatchOpId}-exited`,
        terminalBinding,
      );
    }
    context.processes.delete(active.runtimeSessionId);
    active.process.release?.();
    const completedTask = active.task,
      terminalTask =
        completedTask &&
        [...context.processes.values()].some(
          (candidate) =>
            candidate.task?.taskId === completedTask.taskId &&
            candidate.task.executionId === completedTask.executionId &&
            candidate.task.leaseVersion === completedTask.leaseVersion,
        )
          ? null
          : completedTask;
    // Every sibling archives while the generation that authorized it is still held. The final
    // live sibling alone releases that generation, after all earlier siblings made their files visible.
    await context
      .settleFallback(active, attemptOutcome, {
        runtimeSessionId: active.runtimeSessionId,
        dispatchId: active.dispatchId,
        task: terminalTask,
        schedule: active.schedule,
        outcome: active.schedule
          ? scheduleOutcomeFromRuntime(outcome, active.finalText)
          : outcome === "succeeded"
            ? "succeeded"
            : "failed",
        reason: outcome === "succeeded" ? null : attemptOutcome.reason,
        endedAt,
        resultRef,
        // active.binding is the actor that owns this dispatch's settlement fence: direct task
        // dispatches store the handed-off RuntimeSession binding, while Schedule and squad paths
        // retain their coordinator binding.
        binding: active.binding,
      })
      .catch((error: unknown) => {
        consumeKnownError(error);
        const settlementCode = runtimeErrorCode(error) || "runtime_settlement_failed";
        reasonCode = settlementCode;
        outcome = "failed";
        body = `${body}\n\nRuntime terminal settlement failed (${settlementCode}): ${runtimeErrorMessage(error)}`;
        sha256 = createHash("sha256").update(body).digest("hex");
        result = { sha256, size: Buffer.byteLength(body), mediaType: context.resultMediaType };
        resultRef = `artifact:runtime-result/sha256/${sha256}`;
      });
    if (!cancelled)
      await context.publishRuntimeEvent(
        "runtime_session_exited",
        { runtimeSessionId: active.runtimeSessionId },
        `${active.dispatchOpId}-exited`,
        terminalBinding,
      );
    const outcomeEvent = await context.publishRuntimeEvent(
      "runtime_session_outcome_observed",
      {
        runtimeSessionId: active.runtimeSessionId,
        outcome,
        exitCode: cancelled ? null : code,
        resultRef,
        result,
        ...(reasonCode ? { reasonCode } : {}),
        dispatchId: active.dispatchId,
        endedAt,
        runtimeMetrics,
      },
      `${active.dispatchOpId}-outcome`,
      terminalBinding,
      body,
    );
    context.input.onRuntimeOutcome?.(outcomeEvent.event, active.schedule);
    // This lifecycle boundary is the daemon's drain signal, so it follows the terminal outcome
    // write rather than merely the native process exit.
    context.input.recordLifecycle?.({
      event: "runtime_exit",
      runtimeSessionId: active.runtimeSessionId,
      dispatchId: active.dispatchId,
      pid: active.process.pid,
      exitCode: active.lossExitCode ?? (cancelled ? null : code),
      signal: active.lossSignal,
      outcome: active.lossReason ? "lost" : outcome,
      reason: active.lossReason ?? (outcome === "succeeded" ? null : attemptOutcome.reason),
    });
    context.input.stream.publish(active.runtimeSessionId, { type: "exit", outcome });
    if (readDispatchStream(context.input.rootDir, active.dispatchId)?.fallbackState !== "scheduled")
      archiveDispatchStream(context.input.rootDir, active.dispatchId);
    const onExitCommand = active.onExitCommand;
    if (typeof onExitCommand === "string")
      setImmediate(() =>
        context.launchExitNotification({
          command: onExitCommand,
          cwd: active.cwd,
          stream: active.stream,
          payload: {
            schema: "runtime-session-exited/v1" as const,
            runtimeSessionId: active.runtimeSessionId,
            outcome,
            exitCode: cancelled ? null : code,
          },
          now: context.input.now,
        }),
      );
  } finally {
    context.exiting.delete(active.runtimeSessionId);
  }
}

function unsubmittedDeliveryRecovery(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  outcome: "succeeded" | "failed" | "unknown" | "cancelled",
  hasDelivery: boolean,
): string | null {
  if (outcome !== "succeeded" || !active.task || active.role === "reviewer" || !hasDelivery) return null;
  // The owner recovery reads this node's projection; an edge has none, and its center reports the task state.
  if (!context.input.projection) return null;
  const projection = context.requiredRuntimeProjection(context.input),
    read = projection.read(active.task.taskId),
    execution = read.snapshot.executions.find((candidate) => candidate.executionId === active.task?.executionId);
  if (
    execution?.submission ||
    taskOutputShape(read.snapshot.task, presetSnapshotReader(projection)) !== "repository-diff" ||
    !read.packagePath ||
    !projection.readDocument(`${read.packagePath}/closeout.md`).document
  )
    return null;
  return (
    `Task ${active.task.taskId} is not submitted: runtime success and task submission are separate states. ` +
    `The owner can recover this delivered closeout with: ha task submit ${active.task.taskId} --as-owner`
  );
}

function runtimeSessionBinding(binding: ActiveRuntime["binding"], runtimeSessionId: string): ActiveRuntime["binding"] {
  const { authorizationDecision: _spawnDecision, ...current } = binding;
  return {
    ...current,
    actor: {
      principal: binding.actor.principal,
      executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
    },
  };
}

async function runtimeDeliveryWitness(context: RuntimeSpawnerContext, active: ActiveRuntime): Promise<boolean> {
  if (active.decisionReviewTarget) return true;
  // Taskless runs have no declared repository or task-package output. Their positive delivery is
  // the provider's completed turn and final result, both durably replayed from the worker stream
  // when a successor daemon adopts the runtime.
  if (!active.task) return active.providerOutcome === "succeeded" && active.finalText !== null;
  if (
    await workerBranchHasDelivery({
      cwd: active.cwd,
      canonicalRoot: context.input.rootDir,
      taskId: active.task.taskId,
    })
  )
    return true;
  // Remote-edge settlement has no local canonical projection. Its repo-root fixtures also have no
  // repository-diff witness; absence must settle unknown rather than abort terminal publication.
  if (context.input.remote) return false;
  const projection = context.requiredRuntimeProjection(context.input),
    snapshot = projection.read(active.task.taskId).snapshot;
  if (active.role === "reviewer")
    return snapshot.reviews.some((review) => review.reviewId === `review-${active.dispatchId}`);
  const submission = snapshot.executions.find(
      (execution) => execution.executionId === active.task?.executionId,
    )?.submission,
    outputShape = taskOutputShape(snapshot.task, presetSnapshotReader(projection));
  if (!submission) return false;
  if (outputShape === "repository-diff") return submission.commitSha !== null;
  if (outputShape === "task-package-artifact") return (submission.artifacts?.length ?? 0) > 0;
  return false;
}

export function runtimeResultText(
  context: RuntimeSpawnerContext,
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
          ? (boundedFailureText(active) ?? "Provider reported failure without a structured diagnostic.")
          : ""),
    ) as string;
  const details = [boundedFailureText(active), stderrDiagnosticSummary(active)].filter(
    (value): value is string => value !== null,
  );
  if (details.length) return `Provider exited with code ${String(code)}. ${details.join("\n")}`;
  return active.stdoutObserved
    ? `Provider exited with code ${String(code)} without a structured failure or stderr diagnostic.`
    : `Provider exited with code ${String(code)} and produced no output.`;
}

/**
 * The persisted attempt reason is inlined by every consumer — dispatch rows, the fallback
 * continuation mission, settlement receipts — so it is one bounded line plus a reference to
 * the dispatch stream, which keeps the raw provider stderr as worker-host provider_stderr
 * records. It must never carry the provider's multi-line log verbatim.
 */
function attemptOutcomeReason(reason: string, ref: string): string {
  return `${firstDiagnosticLine(reason)}; full diagnostics: ${ref}`;
}

/** Provider frame failure text is receipt prose, not log storage: one scrubbed, bounded excerpt. */
function boundedFailureText(active: ActiveRuntime): string | null {
  return active.failureText === null ? null : String(scrubProviderValue(active.failureText)).slice(0, 1024);
}

/** The raw provider stderr stays in the dispatch stream; the result text carries one line and the reference. */
function stderrDiagnosticSummary(active: ActiveRuntime): string | null {
  if (active.errorOverflowed) return "Provider stderr was omitted because it exceeded the diagnostic limit.";
  const stderr = active.errorBuffer.trim();
  return stderr ? `${firstDiagnosticLine(stderr)}; full stderr: ${active.stream.ref}` : null;
}

/** The first non-empty, trimmed line of a scrubbed diagnostic, bounded for inline consumption. */
function firstDiagnosticLine(value: string): string {
  const scrubbed = String(scrubProviderValue(value));
  return (
    scrubbed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  ).slice(0, 200);
}

export function applied(
  _context: RuntimeSpawnerContext,
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
    ? { ...base, outcome: "applied" as const }
    : {
        ...base,
        outcome: "pending" as const,
        guidance: [{ kind: "retry-receipt", args: { opId: event.opId } }],
      };
}

export function controlReceipt(
  context: RuntimeSpawnerContext,
  opId: string,
  runtimeSessionId: string,
  detail = "cancelled",
): JsonObject {
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
      ...(detail === "cancelled" ? {} : { guidance: [{ kind: "retry-receipt", args: { opId } }] }),
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
    ? { ...base, outcome: "applied" as const }
    : {
        ...base,
        outcome: "pending" as const,
        guidance: [{ kind: "retry-receipt", args: { opId } }],
      };
}
