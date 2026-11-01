import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentRuntimeEventV1, CanonicalEventStore, RuntimeResultClaim } from "@harness-anything/kernel";
import { consumeKnownError } from "@harness-anything/kernel";
import {
  archiveDispatchStream,
  readDispatchStream,
  scrubProviderValue,
  type DispatchTerminalOutcome,
} from "./dispatch-stream.ts";
import { archiveRuntimeDispatch, type RuntimeDispatchArchive } from "./doc-sync-actions.ts";
import type { ActiveRuntime } from "./runtime-spawn-types.ts";
import { runtimeSpendCapReason, runtimeSpendCapReasonCode } from "./runtime-spend-cap.ts";
import {
  pushTaskWorkerBranch,
  squadWorkerBranchHasDelivery,
  workerBranchHasDelivery,
  workerGitIdentityForPerson,
} from "./runtime-worker-push.ts";
import { strayWriteWarning } from "./runtime-write-boundary.ts";
import { cacheWriteTokensOfUsage, writeRuntime } from "./runtime-spawn-provider-stream.ts";
import { classifyRuntimeExit } from "./runtime-provider-fault.ts";
import {
  readDispatchRuling,
  readDispatchRulingFromWorker,
  readFileIfPresent,
  rulingReceiptText,
} from "./runtime-ruling.ts";
import { isProviderFailureClassification } from "./runtime-fallback-contract.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "./runtime-spawn-errors.ts";
import { scheduleOutcomeFromRuntime } from "./schedule-runtime-outcome.ts";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { presetSnapshotReader, taskOutputShape } from "./task-worktree.ts";
import { detectHostingProvider } from "./hosting-provider.ts";
import { boundedRuntimeConclusion, currentWorktreeHead } from "./runtime-continuation-context.ts";
import { reviewCutSupersededExplanation } from "./repo-cell-execution-selection.ts";
import { disposeActiveRuntimeObservations } from "./runtime-spawn-active.ts";

export async function publishExit(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  code: number | null,
  resumePublishedExit = false,
): Promise<void> {
  if (context.exiting.has(active.runtimeSessionId)) return;
  context.exiting.add(active.runtimeSessionId);
  disposeActiveRuntimeObservations(active);
  // Every terminal path — success, failure, cancellation, and the daemon-restart loss
  // settlement — flows through here, so the run's own temp directory goes with it. A
  // filesystem refusal (a dying provider can still hold a lock) is recorded below in the
  // terminal body; the next daemon start's settled-session sweep is the retry.
  const tempReclaimFailure =
    context.input.reclaimRuntimeTempDirectory?.(active.instanceId, active.runtimeSessionId) ?? null;
  if (tempReclaimFailure)
    console.error(
      `[runtime-temp] ${active.instanceId}/${active.runtimeSessionId} could not be reclaimed: ${tempReclaimFailure.message}`,
    );
  const cancelled = active.cancelRequested,
    cancelBinding = cancelled && active.cancelBinding ? active.cancelBinding : active.binding,
    terminalBinding = runtimeSessionBinding(active.binding, active.runtimeSessionId),
    squadLeaderControl = active.squadId !== null && active.delegatedBy === null;
  try {
    const persistedTerminal = readDispatchStream(context.input.rootDir, active.dispatchId)?.terminalOutcome;
    // A non-failed terminal snapshot follows successful lease settlement and can replay
    // while the replica still shows an earlier liveness. Failed snapshots can include a
    // rejected lease settlement, so retain their recovery path until exit was published.
    const replaySettlement =
      persistedTerminal &&
      (resumePublishedExit ||
        persistedTerminal.payload.outcome !== "failed" ||
        persistedTerminal.payload.reasonCode === "runtime_archive_failed" ||
        persistedTerminal.payload.reasonCode === "runtime_lease_release_failed" ||
        persistedTerminal.payload.reasonCode === "runtime_settlement_failed");
    if (
      replaySettlement &&
      !(
        active.lossReason !== null &&
        persistedTerminal.payload.outcome === "unknown" &&
        persistedTerminal.payload.reasonCode === "lease_conflict"
      )
    ) {
      context.processes.delete(active.runtimeSessionId);
      active.process.release?.();
      // The stream's terminal append and its ledger settlement are separate steps: a daemon
      // that dies between them replays this branch on adoption and must still reach the
      // single settlement entry, or a claimed Schedule occurrence (or task lease) stays
      // open forever. The settlement is queued ahead of the exit publication in the same
      // write chain, so a ledger that already shows the exit (resumePublishedExit) has
      // already taken the settlement — only a ledger with no trace of the terminal replays
      // it. A fallback chain still holding the attempt leaves settlement to the
      // continuation's own terminal.
      if (
        !resumePublishedExit &&
        readDispatchStream(context.input.rootDir, active.dispatchId)?.fallbackState !== "scheduled"
      )
        await context.input.onAttemptTerminal?.({
          runtimeSessionId: active.runtimeSessionId,
          dispatchId: active.dispatchId,
          task: active.task,
          schedule: active.schedule,
          outcome: active.schedule
            ? scheduleOutcomeFromRuntime(persistedTerminal.payload.outcome, persistedTerminal.body)
            : persistedTerminal.payload.outcome === "succeeded"
              ? "succeeded"
              : "failed",
          reason: persistedTerminal.payload.outcome === "succeeded" ? null : persistedTerminal.reason,
          endedAt: persistedTerminal.payload.endedAt ?? context.input.now(),
          ...(persistedTerminal.processGroupPid === undefined
            ? {}
            : { processGroupPid: persistedTerminal.processGroupPid }),
          ...(persistedTerminal.payload.attempt?.classification === "awaiting_ruling" ? { waitingOnOwner: true } : {}),
          binding: active.binding,
        });
      await publishTerminalOutcome(context, active, terminalBinding, persistedTerminal);
      return;
    }
    if (!cancelled && code === null)
      context.input.stream.publish(active.runtimeSessionId, {
        type: "error",
        code: "provider_disconnected",
      });
    // `finalText` is worker completion evidence, not a provider protocol terminal. ACP may
    // report `end_turn` without a final message; keep that attempt unknown, but do not call
    // the valid provider stream malformed when its session and terminal outcome are present.
    if (!cancelled && (active.providerSessionId === null || (code === 0 && active.providerOutcome === null)))
      context.markProtocolError(active);
    // One read of the worker's own ruling artifact feeds both the settlement classification and
    // the receipt body: the file is worktree-local at exit time, so settlement must not re-read it
    // from the projection.
    const ruling = runtimeRulingRequest(context, active),
      reviewReport = runtimeReviewReport(context, active),
      reviewPacket = runtimeReviewPacket(context, active),
      { outcome: initialOutcome, ...classifiedAttempt } = classifyRuntimeExit(active, code, ruling);
    let outcome = initialOutcome,
      reviewResultMissing = false;
    if (
      (outcome === "unknown" || outcome === "stopped") &&
      code === 0 &&
      (await runtimeDeliveryWitness(context, active))
    )
      outcome = "succeeded";
    const submittedStall =
      !cancelled &&
      active.task !== null &&
      active.role !== "reviewer" &&
      active.permissionMode !== "read-only" &&
      active.stalledAt !== null &&
      active.stalledAt !== undefined &&
      hasAcceptedExecutionSubmission(context, active);
    if (submittedStall) outcome = "succeeded";
    const reviewSuperseded =
      outcome !== "succeeded" && active.role === "reviewer" && active.task && context.input.projection
        ? (() => {
            const read = context.requiredRuntimeProjection(context.input).read(active.task.taskId);
            return read?.snapshot
              ? reviewCutSupersededExplanation(read.snapshot, active.task.executionId)
              : { superseded: false };
          })()
        : { superseded: false };
    const reviewId = `review-${active.dispatchId}`;
    const providerAlreadyFailed = outcome === "failed";
    // A reviewer owes a registered review, not merely a report or a clean provider exit. Check
    // the event on the node that owns the projection so normal exit without registration cannot
    // look complete. Remote edges have no local projection and keep their existing unknown path.
    let reviewRegistered = reviewerReviewRegistered(context, active, reviewId);
    if (
      !cancelled &&
      ruling === null &&
      !reviewSuperseded.superseded &&
      (active.role === "reviewer" ||
        (active.decisionReviewTarget !== null && active.decisionReviewTarget !== undefined)) &&
      context.input.projection &&
      (active.task !== null || (active.decisionReviewTarget !== null && active.decisionReviewTarget !== undefined)) &&
      !reviewRegistered
    ) {
      if (
        !providerAlreadyFailed &&
        active.task !== null &&
        reviewReport !== null &&
        reviewPacket !== null &&
        context.input.recoverReviewerReview
      ) {
        try {
          await context.input.recoverReviewerReview({
            taskId: active.task.taskId,
            executionId: active.task.executionId,
            dispatchId: active.dispatchId,
            runtimeSessionId: active.runtimeSessionId,
            // Recovery is a durable Review Action and must carry the terminal runtime
            // identity, even when the dispatch was admitted from a principal-only binding.
            binding: terminalBinding,
            packet: reviewPacket,
            report: reviewReport,
          });
          reviewRegistered = reviewerReviewRegistered(context, active, reviewId);
        } catch (error) {
          consumeKnownError(error);
          const detail = String(scrubProviderValue(error instanceof Error ? error.message : String(error))).slice(
            0,
            512,
          );
          console.error(`[review-recovery] ${active.dispatchId} could not register carried review: ${detail}`);
        }
      }
      if (reviewRegistered) {
        // The carried Review Action is the terminal witness. Keep the provider's successful
        // outcome and continue through the ordinary archive/terminal path.
        if (!providerAlreadyFailed) outcome = "succeeded";
        reviewResultMissing = false;
      } else {
        if (!providerAlreadyFailed) outcome = "failed";
        reviewResultMissing = true;
      }
    }
    const attemptOutcome = {
      ...classifiedAttempt,
      // Provider failures are the classifications a fallback continuation carries forward, and
      // their reason is a raw diagnostic excerpt — shape those into one line plus the dispatch
      // stream reference. Worker-stop and gate-red reasons stay byte-identical to before.
      reason: reviewSuperseded.superseded
        ? reviewSuperseded.reason!
        : reviewResultMissing && !providerAlreadyFailed
          ? `Review ${reviewId} was not registered before reviewer settlement.`
          : isProviderFailureClassification(classifiedAttempt.classification)
            ? attemptOutcomeReason(classifiedAttempt.reason, active.stream.ref)
            : outcome === "succeeded"
              ? "Worker completed the attempt successfully."
              : String(scrubProviderValue(classifiedAttempt.reason)).slice(0, 1024),
    };
    const endedAt = context.input.now(),
      exitHead = active.task ? await currentWorktreeHead(active.cwd) : null,
      lastConclusion = boundedRuntimeConclusion(
        active.finalText === null ? null : String(scrubProviderValue(active.finalText)),
      );
    active.stream.appendAttemptOutcome(attemptOutcome, endedAt);
    const runtimeMetrics = {
      inputTokens: active.inputTokens,
      cacheReadTokens: active.cacheReadTokens,
      ...(cacheWriteTokensOfUsage(active.rawUsage) === null ? {} : { cacheWriteTokens: active.cacheWriteTokens }),
      outputTokens: active.outputTokens,
      totalTokens: active.inputTokens + active.outputTokens,
      toolCallCount: active.toolCallCount,
      usageUnavailable: !active.usageReported,
    };
    active.stream.appendRuntimeMetrics?.(
      { ...runtimeMetrics, compacted: active.compacted, raw: active.rawUsage },
      endedAt,
    );
    // The kernel event's runtimeMetrics copy stays the three-count shape its domain
    // whitelist pins (validRuntimeDispatchMetrics): kernel consumers do not price, so the
    // separate cache-write counter travels only in the stream records, where the token
    // usage read side picks it up.
    const { cacheWriteTokens: _cacheWriteTokens, ...kernelMetrics } = runtimeMetrics;
    let body = context.runtimeResultText(active, code, outcome);
    if (submittedStall)
      body +=
        `\n\nTask ${active.task!.taskId} execution ${active.task!.executionId} has an accepted submission; ` +
        "the submitted cut is delivered. The runtime stalled during post-submit wrap-up. The owner/CEO should " +
        "open or link the PR and finish any missing delivery report or handoff before review.";
    if (reviewResultMissing) body = `${body}\n\nReview ${reviewId} was not registered before reviewer settlement.`;
    if (
      !active.finalText?.trim() &&
      (active.toolCallObserved ||
        Number(active.toolCallCount ?? 0) > 0 ||
        Number(active.workspaceActivityCount ?? 0) > 0)
    )
      body = [
        body,
        `Work observed before final text was absent: ${String(active.toolCallCount ?? 0)} tool calls and ` +
          `${String(active.workspaceActivityCount ?? 0)} workspace change events. Dispatch transcript: ${active.stream?.ref ?? "unavailable"}` +
          (reviewReport ? ` Reviewer report: ${reviewReport.path}.` : ""),
      ]
        .filter(Boolean)
        .join("\n\n");
    // The question and its options ride the persisted result. The receipt body is what
    // `ha runtime wait`, the dispatch row and the archived report all render, and a provider's exit
    // diagnostic alone never tells the owner what was asked.
    if (ruling !== null) body = `${body}\n\n${rulingReceiptText(ruling)}`;
    // Settlement carries the reclaim failure in its result text: the outcome itself is
    // unaffected (per-run temp is node hygiene, not part of the delivery cut), but the
    // terminal record must not claim a clean reclamation that did not happen.
    if (tempReclaimFailure) body = `${body}\n\nPer-run temp directory reclaim failed: ${tempReclaimFailure.message}`;
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
    if (
      active.task &&
      context.input.projection &&
      outcome === "succeeded" &&
      active.role !== "reviewer" &&
      active.publicationOwner !== "commander" &&
      !squadLeaderControl
    ) {
      try {
        // Edge publication belongs to submit preparation; settlement must never replace its accepted cut.
        const projection = context.requiredRuntimeProjection(context.input),
          submittedCommitSha = projection
            ?.read(active.task.taskId)
            .snapshot.executions.find((execution) => execution.executionId === active.task?.executionId)
            ?.submission?.commitSha,
          hosting = await detectHostingProvider(context.input.rootDir, undefined, true),
          env = hosting ? await context.prepareDaemonGitEnvironment(active.instanceId, hosting.kind) : undefined,
          push = await pushTaskWorkerBranch({
            cwd: active.cwd,
            canonicalRoot: context.input.rootDir,
            taskId: active.task.taskId,
            identity: workerGitIdentityForPerson(active.binding.actor.principal.personId),
            ...(submittedCommitSha ? { submittedCommitSha } : {}),
            forceWithLease: false,
            classifyRemoteAhead: submittedCommitSha !== undefined,
            env,
          });
        hasDelivery = push.attempted && push.pushedCommit !== null;
        if (push.attempted)
          body = push.ok
            ? `${body}\n\nWorker branch pushed at settlement: ${push.branch} @ ${push.pushedCommit}${
                push.head === push.pushedCommit ? "" : ` (worker HEAD ${push.head})`
              }`
            : push.code === "remote_ahead_of_frozen_cut"
              ? `${body}\n\n${push.detail}`
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
    const exitGuidance = unsubmittedExitGuidance(active, outcome);
    if (exitGuidance) body = `${body}\n\n${exitGuidance}`;
    let reasonCode: string | null =
        active.observationError && !cancelled
          ? "runtime_observation_failed"
          : active.spendCapExceeded && !cancelled
            ? runtimeSpendCapReasonCode
            : reviewSuperseded.superseded
              ? "review_cut_superseded"
              : reviewResultMissing
                ? "review_result_missing"
                : null,
      sha256 = createHash("sha256").update(body).digest("hex"),
      result: RuntimeResultClaim = {
        sha256,
        size: Buffer.byteLength(body),
        mediaType: context.resultMediaType,
      },
      resultRef = `artifact:runtime-result/sha256/${sha256}`;
    const archiveBase = {
      dispatchId: active.dispatchId,
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
      lastConclusion,
      exitHead,
      eventStreamRef: active.stream.ref,
      attemptGroupId: attemptOutcome.attemptGroupId,
      attemptIndex: attemptOutcome.attemptIndex,
      provider: { instance: attemptOutcome.provider.instance, model: attemptOutcome.provider.model },
      classification: attemptOutcome.classification,
      reason: attemptOutcome.reason,
      ...(ruling === null ? {} : { ruling: { path: ruling.path, body: ruling.body } }),
      ...(reviewReport === null ? {} : { reviewReport }),
    };
    // A Decision review dispatch owns no task execution; its archive binds the reviewed Decision.
    const archive: RuntimeDispatchArchive | null = active.task
      ? { ...archiveBase, taskId: active.task.taskId, executionId: active.task.executionId }
      : active.decisionReviewTarget
        ? { ...archiveBase, taskId: null, executionId: null, decisionReview: active.decisionReviewTarget }
        : null;
    if (archive) {
      try {
        const archiveBinding = context.input.remote
          ? terminalBinding
          : await (context.input.authorizeRuntimeArchive?.(archive, terminalBinding) ?? terminalBinding);
        const archived = context.input.remote
          ? await context.input.remote.archive(archive)
          : await writeRuntime(
              context,
              () =>
                archiveRuntimeDispatch({
                  workspaceId: context.input.repoId,
                  rootDir: context.input.rootDir,
                  store: context.requiredRuntimeStore(context.input),
                  projection: context.requiredRuntimeProjection(context.input),
                  binding: archiveBinding,
                  now: context.input.now,
                  archive,
                }),
              archiveBinding,
            );
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
        // A local projection can witness a registered review despite an archive failure.
        // The remote path has no such witness and must report failure or cancellation.
        // Settlement honesty for a local reviewer is whether the review was registered, not whether
        // every archive document was fresh: a reviewer that already recorded its RecordReview
        // (which publishes the report documents itself) keeps its real outcome, and the archive
        // failure is recorded as a note instead of flipping the dispatch to failed.
        const reviewRegistered =
          !context.input.remote &&
          active.role === "reviewer" &&
          (active.task !== null
            ? context
                .requiredRuntimeProjection(context.input)
                .read(active.task.taskId)
                .snapshot.reviews.some(
                  (review) =>
                    review.reviewId === `review-${active.dispatchId}` ||
                    review.actor.executor?.id === `runtime-session:${active.runtimeSessionId}`,
                )
            : active.decisionReviewTarget !== null &&
              decisionReviewRegistered(context, active.decisionReviewTarget, active.dispatchId));
        if (!reviewRegistered && !reviewSuperseded.superseded) {
          outcome = cancelled ? "cancelled" : "failed";
          reasonCode = reviewResultMissing ? "review_result_missing" : "runtime_archive_failed";
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
        active.cancelOpId ?? randomUUID(),
        cancelBinding,
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
    const processGroupPid =
      Number.isSafeInteger(active.process.pid) && active.process.pid > 1 && active.process.pid !== process.pid
        ? active.process.pid
        : undefined;
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
            : reviewSuperseded.superseded
              ? "superseded"
              : "failed",
        reason: outcome === "succeeded" ? null : attemptOutcome.reason,
        endedAt,
        ...(ruling === null ? {} : { waitingOnOwner: true }),
        // active.binding is the actor that owns this dispatch's settlement fence: direct task
        // dispatches store the handed-off RuntimeSession binding, while Schedule and squad paths
        // retain their coordinator binding.
        binding: active.binding,
        ...(processGroupPid === undefined ? {} : { processGroupPid }),
      })
      .catch((error: unknown) => {
        // A Schedule's claim settlement is the occurrence's single-flight witness, so its terminal
        // outcome must not become visible while the settlement can still be retried. A Fleet edge
        // writes the two through separate center requests, so publishing the outcome here could
        // outrun a settlement this catch swallowed. Leaving no terminal snapshot keeps the durable
        // dispatch stream replayable: the next adoption settles the claim before publishing the
        // outcome. A definitive center rejection (`retryable: false`) cannot progress by replaying
        // this terminal, so it keeps the honest-failed publication and leaves the occurrence to the
        // center's Schedule scheduler.
        if (active.schedule && (error as { readonly retryable?: unknown }).retryable !== false) throw error;
        consumeKnownError(error);
        const settlementCode = runtimeErrorCode(error) || "runtime_settlement_failed";
        // A remote owner rejection is an authorization boundary, not a worker failure. Leave the
        // dispatch unresolved so recovery can re-adopt it under the original owner. Likewise, an
        // unproven process group must stay unknown: publishing a failed outcome would make the
        // lease appear safely settled while the writer may still be alive.
        if (context.input.remote && active.task) {
          // A Fleet Edge cannot prove a terminal lease settlement from the center-side stream while
          // the owner, credential, transport, or process proof is unresolved. Keep the worker's
          // terminal result unknown so replay can retry the authoritative release after recovery.
          outcome = "unknown";
          if (["lease_conflict", "runtime_lease_release_failed"].includes(settlementCode)) reasonCode = settlementCode;
        } else if (settlementCode === "runtime_process_group_unproven") {
          // An exited host does not prove its process group stopped: a child may still write.
          // Keep the runtime unknown and the lease held until an OS stop proof is available.
          // A reasonCode would restate `unknown` as `failed` in runtimeSessionOutcomeFromEvidence.
          outcome = "unknown";
        } else {
          reasonCode = settlementCode;
          outcome = "failed";
          body = `${body}\n\nRuntime terminal settlement failed (${settlementCode}): ${runtimeErrorMessage(error)}`;
          sha256 = createHash("sha256").update(body).digest("hex");
          result = { sha256, size: Buffer.byteLength(body), mediaType: context.resultMediaType };
          resultRef = `artifact:runtime-result/sha256/${sha256}`;
        }
      });
    const terminalOutcome: DispatchTerminalOutcome = {
      payload: {
        runtimeSessionId: active.runtimeSessionId,
        outcome,
        exitCode: cancelled ? null : code,
        resultRef,
        result,
        ...(reasonCode ? { reasonCode } : {}),
        dispatchId: active.dispatchId,
        endedAt,
        runtimeMetrics: kernelMetrics,
        attempt: {
          classification: attemptOutcome.classification,
          reason: attemptOutcome.reason,
          ...(() => {
            const fallbackState = readDispatchStream(context.input.rootDir, active.dispatchId)?.fallbackState;
            return fallbackState === "scheduled" || fallbackState === "exhausted" ? { fallbackState } : {};
          })(),
          ...(attemptOutcome.faultClass ? { faultClass: attemptOutcome.faultClass } : {}),
          ...(attemptOutcome.resetAt ? { resetAt: attemptOutcome.resetAt } : {}),
        },
      },
      body,
      reason: attemptOutcome.reason,
      ...(processGroupPid === undefined ? {} : { processGroupPid }),
    };
    active.stream.appendTerminalOutcome(terminalOutcome, endedAt);
    await publishTerminalOutcome(context, active, terminalBinding, terminalOutcome);
  } finally {
    context.exiting.delete(active.runtimeSessionId);
  }
}

async function publishTerminalOutcome(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  terminalBinding: ActiveRuntime["binding"],
  terminal: DispatchTerminalOutcome,
): Promise<void> {
  const { payload, body } = terminal;
  await context.publishRuntimeEvent(
    "runtime_session_exited",
    { runtimeSessionId: active.runtimeSessionId },
    randomUUID(),
    terminalBinding,
  );
  const outcomeEvent = await context.publishRuntimeEvent(
    "runtime_session_outcome_observed",
    payload,
    randomUUID(),
    terminalBinding,
    body,
  );
  if (outcomeEvent.event) context.input.onRuntimeOutcome?.(outcomeEvent.event, active.schedule);
  if (
    outcomeEvent.event &&
    active.role === "reviewer" &&
    active.task &&
    payload.outcome === "failed" &&
    (payload.attempt?.classification === "dispatch_stalled" ||
      (payload.reasonCode === "review_result_missing" &&
        (payload.attempt?.classification === "worker_stop" ||
          payload.attempt?.classification === "completed_without_final_text")))
  )
    context.input.onStalledReviewer?.({
      dispatchId: active.dispatchId,
      task: active.task,
      binding: active.binding,
    });
  context.input.recordLifecycle?.({
    event: "runtime_exit",
    runtimeSessionId: active.runtimeSessionId,
    dispatchId: active.dispatchId,
    pid: active.process.pid,
    exitCode: active.lossExitCode ?? payload.exitCode,
    signal: active.lossSignal,
    outcome: active.lossReason ? "lost" : payload.outcome,
    reason: active.lossReason ?? (payload.outcome === "succeeded" ? null : terminal.reason),
  });
  context.input.stream.publish(active.runtimeSessionId, { type: "exit", outcome: payload.outcome });
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
          outcome: payload.outcome,
          exitCode: payload.exitCode,
        },
        now: context.input.now,
      }),
    );
}

function unsubmittedDeliveryRecovery(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped",
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

/** An undelivered stop names the task it left unsubmitted and hands back the reopen entry, so the
 * receipt reads as "exited without delivering" plus the way to continue rather than a success shape
 * the owner must discover is hollow (dec_614F7BBB18C8687E7EFC72173D CH1). Reviewers re-dispatch
 * through review dispatches and squad turns through their coordinator, so only direct task exits. */
function unsubmittedExitGuidance(
  active: ActiveRuntime,
  outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped",
): string | null {
  if (outcome !== "stopped" || !active.task || active.role === "reviewer" || active.squadId !== null) return null;
  return (
    `Task ${active.task.taskId} is not submitted: the worker exited without a submitted delivery. ` +
    `Reopen the execution to re-dispatch with: ha task start ${active.task.taskId}`
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

/**
 * The ruling a worker left in its task package, read at the single settlement entry. Only a
 * task-bound dispatch has a package to read. The worker's own filesystem is authoritative: a
 * worktree artifact is a new local file that no doc sync has published yet, so the projection
 * fallback below can only serve an artifact the worker itself published. An edge settles by the
 * same ordinary classification it always had.
 */
function runtimeRulingRequest(context: RuntimeSpawnerContext, active: ActiveRuntime) {
  if (!active.task || !context.input.projection) return null;
  const projection = context.requiredRuntimeProjection(context.input),
    packagePath = projection.read(active.task.taskId).packagePath;
  if (typeof packagePath !== "string") return null;
  return (
    readDispatchRulingFromWorker({
      cwd: active.cwd,
      rootDir: context.input.rootDir,
      packagePath,
      dispatchId: active.dispatchId,
    }) ??
    readDispatchRuling(
      (relative) => projection.readDocument(relative).document?.body ?? null,
      packagePath,
      active.dispatchId,
    )
  );
}

function runtimeReviewReport(context: RuntimeSpawnerContext, active: ActiveRuntime) {
  if (active.role !== "reviewer") return null;
  if (context.input.remote) return null;
  const packagePath = active.task
    ? context.requiredRuntimeProjection(context.input).read(active.task.taskId).packagePath
    : active.decisionReviewTarget
      ? `decisions/decision-${active.decisionReviewTarget.decisionId}`
      : null;
  if (typeof packagePath !== "string") return null;
  const reportPath = `${packagePath}/artifacts/reports/${active.dispatchId}.md`,
    packageRelative = reportPath.split("/");
  const candidates = [
    path.join(active.cwd, "harness", ...packageRelative),
    path.join(active.cwd, ...packageRelative),
    path.join(active.cwd, "artifacts", "reports", `${active.dispatchId}.md`),
    path.join(context.input.rootDir, "harness", ...packageRelative),
  ];
  for (const candidate of new Set(candidates)) {
    const body = readFileIfPresent(candidate, 2 * 1024 * 1024);
    if (body !== null && body.trim() !== "") return { path: reportPath, body };
  }
  return null;
}

function runtimeReviewPacket(context: RuntimeSpawnerContext, active: ActiveRuntime) {
  if (active.role !== "reviewer" || active.task === null || context.input.remote) return null;
  const packagePath = context.requiredRuntimeProjection(context.input).read(active.task.taskId).packagePath;
  if (typeof packagePath !== "string") return null;
  const packetPath = `${packagePath}/artifacts/reports/${active.dispatchId}.json`,
    packageRelative = packetPath.split("/"),
    candidates = [
      path.join(active.cwd, "harness", ...packageRelative),
      path.join(active.cwd, ...packageRelative),
      path.join(active.cwd, "artifacts", "reports", `${active.dispatchId}.json`),
      path.join(context.input.rootDir, "harness", ...packageRelative),
    ];
  for (const candidate of new Set(candidates)) {
    const body = readFileIfPresent(candidate, 2 * 1024 * 1024);
    if (body !== null && body.trim() !== "") return { path: packetPath, body };
  }
  return null;
}

function reviewerReviewRegistered(context: RuntimeSpawnerContext, active: ActiveRuntime, reviewId: string): boolean {
  if (active.task !== null)
    return (
      context.input.projection !== undefined &&
      context
        .requiredRuntimeProjection(context.input)
        .read(active.task.taskId)
        .snapshot.reviews.some(
          (review) =>
            review.reviewId === reviewId || review.actor.executor?.id === `runtime-session:${active.runtimeSessionId}`,
        )
    );
  return active.decisionReviewTarget !== null && active.decisionReviewTarget !== undefined
    ? decisionReviewRegistered(context, active.decisionReviewTarget, active.dispatchId)
    : false;
}

/** The registration witness for a dispatched Decision review: the Decision carries a review by
 * this dispatch at the reviewed content digest. */
function decisionReviewRegistered(
  context: RuntimeSpawnerContext,
  target: { readonly decisionId: string; readonly digest: string },
  dispatchId: string,
): boolean {
  return (
    context
      .requiredRuntimeProjection(context.input)
      .readDecision(target.decisionId)
      .decision?.reviews.some(
        (review) => review.reviewId === `review-${dispatchId}` && review.reviewContentDigest === target.digest,
      ) === true
  );
}

async function runtimeDeliveryWitness(context: RuntimeSpawnerContext, active: ActiveRuntime): Promise<boolean> {
  if (active.decisionReviewTarget) return true;
  // Taskless runs have no declared repository or task-package output. Their positive delivery is
  // the provider's completed turn and final result, both durably replayed from the worker stream
  // when a successor daemon adopts the runtime.
  if (!active.task) return active.providerOutcome === "succeeded" && active.finalText !== null;
  // A read-only analysis attach delivers its dispatch report into the task package; that report is
  // a durable witness. A final provider message alone is not, so without the report the remaining
  // witnesses below decide.
  if (active.permissionMode === "read-only" && active.role !== "reviewer" && context.input.projection) {
    const projection = context.requiredRuntimeProjection(context.input),
      packagePath = projection.read(active.task.taskId).packagePath;
    if (
      typeof packagePath === "string" &&
      projection.readDocument(`${packagePath}/artifacts/reports/${active.dispatchId}.md`).document !== null
    )
      return true;
  }
  // A reviewer's positive delivery is the registered review, never branch commits: a report file
  // can exist (and be committed) while the review itself was never registered. Only the node
  // holding the task projection can witness registration; an edge settles unknown rather than
  // guessing from its branch.
  if (active.role === "reviewer")
    return context.input.projection
      ? context
          .requiredRuntimeProjection(context.input)
          .read(active.task.taskId)
          .snapshot.reviews.some(
            (review) =>
              review.reviewId === `review-${active.dispatchId}` ||
              review.actor.executor?.id === `runtime-session:${active.runtimeSessionId}`,
          )
      : false;
  // A squad leader turn owes no repository artifacts: children deliver the commits and the leader's
  // delivery is its decision, carried in the provider's structured result and re-verified by the
  // coordinator parsing it. The same evidence class as a taskless run witnesses the turn.
  if (active.squadId !== null && active.delegatedBy === null)
    return active.providerOutcome === "succeeded" && active.finalText !== null;
  // Branch commits witness delivery only where no submission is readable: a squad worker delivers
  // commits to its commander rather than a submission (the commander-cut `<branch>--squad-…` checkout
  // never equals the task id, and a squad-context dispatch on the task branch falls through to the
  // same branch witness), and a remote edge has no canonical projection to read a submission from.
  // At the center a direct dispatch delivers only its accepted submission — mid-work branch commits
  // are not a delivery facet (dec_614F7BBB18C8687E7EFC72173D RJ1: a normal exit without a submitted
  // delivery must not settle succeeded).
  if (active.squadId !== null && (await squadWorkerBranchHasDelivery({ cwd: active.cwd }))) return true;
  if (
    (active.squadId !== null || !context.input.projection) &&
    (await workerBranchHasDelivery({
      cwd: active.cwd,
      canonicalRoot: context.input.rootDir,
      taskId: active.task.taskId,
    }))
  )
    return true;
  // Remote-edge settlement has no local canonical projection. Its repo-root fixtures also have no
  // repository-diff witness; absence must settle unknown rather than abort terminal publication.
  return hasAcceptedExecutionSubmission(context, active);
}

function hasAcceptedExecutionSubmission(context: RuntimeSpawnerContext, active: ActiveRuntime): boolean {
  if (!active.task || !context.input.projection) return false;
  const snapshot = context.requiredRuntimeProjection(context.input).read(active.task.taskId).snapshot,
    submission = snapshot.executions.find(
      (execution) => execution.executionId === active.task?.executionId,
    )?.submission;
  // Submission is the accepted delivery witness. The submit boundary already validates the
  // preset contract and durably records the accepted submission; settlement must not derive its
  // meaning again from outputShape or require a commitSha.
  return submission !== null && submission !== undefined;
}

export function runtimeResultText(
  context: RuntimeSpawnerContext,
  active: ActiveRuntime,
  code: number | null,
  outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped",
): string {
  const text = runtimeResultBody(active, code, outcome),
    stray = active.strayWritePaths ?? [];
  if (stray.length === 0) return text;
  return `${strayWriteWarning(stray, { rootDir: context.input.rootDir, workerRoot: active.cwd })}\n\n${text}`;
}

function runtimeResultBody(
  active: ActiveRuntime,
  code: number | null,
  outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped",
): string {
  if (active.spendCapExceeded && outcome !== "cancelled") return runtimeSpendCapReason(active);
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
