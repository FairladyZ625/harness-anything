import { samePrincipal } from "@harness-anything/kernel";
import { runtimeDispatchTaskMatches } from "./runtime-session-action-runtime.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TaskProjection } from "@harness-anything/kernel";
import {
  DOC_POLICY_ID,
  classifyTextualArtifactPath,
  docSyncWritePlan,
  documentPath,
  isDocEvent,
  normalizeCommandEnvelope,
  parseDocWriteIntent,
  resolveDocRoute,
  resolveHarnessLayout,
  sha256Bytes,
  type DocWriteIntent,
  type VerticalScriptActionV1,
  type VerticalScriptChangeV1,
} from "@harness-anything/kernel";
import { adjudicateDocIntent } from "./doc-sync-adjudication.ts";
import type { DocSettlementReceipt, Input } from "./doc-sync-command-actions.ts";
import type { DispatchExitClassification } from "./runtime-fallback-contract.ts";
import { detail, directPaths, matches, recycleClaims } from "./doc-sync-details.ts";
import {
  docSyncError,
  postCommit,
  rejectDocSyncAction,
  runtimeArchiveMissionRef,
  runtimeArchiveText,
} from "./doc-sync-files.ts";
import { readDocReceipt } from "./doc-sync-reads.ts";
import { readDispatchStreamHeader } from "./dispatch-stream.ts";

export interface RuntimeDispatchArchive {
  readonly dispatchId: string;
  /** The bound task execution, or null when the dispatch targeted a Decision review. */
  readonly taskId: string | null;
  readonly executionId: string | null;
  /** Present exactly when the dispatch was a Decision review; the occurrence must match it. */
  readonly decisionReview?: { readonly decisionId: string; readonly digest: string };
  readonly agentId?: string;
  readonly agentName?: string;
  readonly delegatedByAgentId?: string;
  readonly delegatedByAgentName?: string;
  readonly squadId?: string;
  readonly parentRuntimeSessionId?: string;
  readonly instanceId: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly fast: boolean;
  readonly cwd: string;
  readonly prompt: string;
  readonly promptSource?: string;
  readonly onExitCommand?: string;
  readonly runtimeSessionId: string;
  readonly providerSessionId: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled";
  readonly exitCode: number | null;
  readonly resultRef: string;
  readonly resultText: string;
  readonly eventStreamRef?: string;
  readonly attemptGroupId: string;
  readonly attemptIndex: number;
  readonly provider: { readonly instance: string; readonly model: string };
  readonly classification: DispatchExitClassification;
  readonly reason: string;
}

export function archiveRuntimeDispatch(
  input: Omit<Input, "action"> & { readonly archive: RuntimeDispatchArchive },
): DocSettlementReceipt {
  const value = input.archive,
    decision = value.decisionReview ?? null,
    taskRead = decision === null && value.taskId !== null ? input.projection.read(value.taskId) : null,
    decisionRead = decision === null ? null : input.projection.readDecision(decision.decisionId);
  if (decision === null && value.taskId === null)
    throw docSyncError(
      "invalid_command",
      `Runtime archive ${value.dispatchId} names neither a task execution nor a Decision review target`,
    );
  if (
    taskRead !== null &&
    (taskRead.watermark !== taskRead.sourceRevision || !taskRead.packagePath || !taskRead.snapshot.task)
  )
    throw docSyncError("content_not_ready", `Task ${value.taskId} is not ready for runtime archive`);
  if (
    decision !== null &&
    decisionRead !== null &&
    (decisionRead.watermark !== decisionRead.sourceRevision || !decisionRead.decision)
  )
    throw docSyncError("content_not_ready", `Decision ${decision.decisionId} is not ready for runtime archive`);
  const packagePath = taskRead?.packagePath ?? `decisions/decision-${decision!.decisionId}`,
    occurrence = input.projection
      .readRuntimeDispatches()
      .find((event) => event.payload.dispatchId === value.dispatchId),
    runtimeExecutorId = `runtime-session:${value.runtimeSessionId}`,
    runtimeActor =
      input.binding.actor.executor?.id === runtimeExecutorId ||
      (typeof input.binding.source === "object" &&
        input.binding.source.kind === "node" &&
        occurrence !== undefined &&
        samePrincipal(occurrence.actor.principal, input.binding.actor.principal) &&
        JSON.stringify(occurrence.source) === JSON.stringify(input.binding.source)),
    matchingDecision =
      decision !== null &&
      occurrence?.payload.reviewTarget?.kind === "decision" &&
      occurrence.payload.reviewTarget.decisionId === decision.decisionId &&
      occurrence.payload.reviewTarget.digest === decision.digest,
    matchingTask =
      decision === null &&
      runtimeDispatchTaskMatches({
        projection: input.projection,
        dispatch: occurrence,
        binding: input.binding,
        runtimeSessionId: value.runtimeSessionId,
        taskId: value.taskId!,
        executionId: value.executionId,
      });
  if (
    occurrence?.payload.runtimeSessionId !== value.runtimeSessionId ||
    occurrence.payload.instanceId !== value.instanceId ||
    !(matchingDecision || matchingTask) ||
    !runtimeActor
  )
    throw docSyncError(
      "runtime_archive_occurrence_mismatch",
      `Runtime archive ${value.dispatchId} does not match its canonical dispatch occurrence`,
    );
  const existingMissionRef = runtimeArchiveMissionRef(input, packagePath, value),
    missionRef = existingMissionRef ?? `${packagePath}/artifacts/missions/${value.dispatchId}.md`,
    reportRef = documentPath(`${packagePath}/artifacts/reports/${value.dispatchId}.md`),
    layout = resolveHarnessLayout(input.rootDir),
    // A reviewer the completion facade dispatches authors its own report at the dispatch report path
    // before the runtime settles. That authored report is the dispatch report; the final message is
    // still reachable through resultRef, so it is not archived over the report and cannot collide.
    reportAuthored =
      input.projection.readDocument(reportRef).document !== null ||
      existsSync(path.join(layout.authoredRoot, ...reportRef.split("/"))),
    dispatch = {
      schema: "runtime-dispatch/v1",
      dispatchId: value.dispatchId,
      ...(decision
        ? {
            reviewTarget: {
              kind: "decision" as const,
              decisionId: decision.decisionId,
              digest: decision.digest,
            },
          }
        : { taskId: value.taskId, executionId: value.executionId }),
      ...(value.agentId ? { agentId: value.agentId, agentName: value.agentName } : {}),
      ...(value.delegatedByAgentId
        ? {
            delegatedByAgentId: value.delegatedByAgentId,
            delegatedByAgentName: value.delegatedByAgentName,
          }
        : {}),
      ...(value.squadId ? { squadId: value.squadId } : {}),
      ...(value.parentRuntimeSessionId ? { parentRuntimeSessionId: value.parentRuntimeSessionId } : {}),
      instanceId: value.instanceId,
      model: value.model,
      reasoningEffort: value.reasoningEffort,
      fast: value.fast,
      cwd: value.cwd,
      missionRef,
      ...(value.onExitCommand ? { onExitCommand: value.onExitCommand } : {}),
      runtimeSessionId: value.runtimeSessionId,
      providerSessionId: value.providerSessionId,
      startedAt: value.startedAt,
      endedAt: value.endedAt,
      outcome: value.outcome,
      exitCode: value.exitCode,
      resultRef: value.resultRef,
      ...(value.eventStreamRef ? { eventStreamRef: value.eventStreamRef } : {}),
      attemptGroupId: value.attemptGroupId,
      attemptIndex: value.attemptIndex,
      provider: value.provider,
      classification: value.classification,
      reason: value.reason,
    },
    documents = [
      ...(existingMissionRef === null
        ? [
            {
              path: missionRef,
              body: runtimeArchiveText(value.prompt),
              mediaType: "text/markdown" as const,
            },
          ]
        : []),
      {
        path: `${packagePath}/artifacts/dispatches/${value.dispatchId}.json`,
        body: `${JSON.stringify(dispatch, null, 2)}\n`,
        mediaType: "text/plain" as const,
      },
      ...(reportAuthored
        ? []
        : [
            {
              path: reportRef,
              body: runtimeArchiveText(value.resultText),
              mediaType: "text/markdown" as const,
            },
          ]),
    ].map((document) => ({
      ...document,
      path: documentPath(document.path),
      bytes: Buffer.from(document.body),
    })),
    reads = documents.map((document) => input.projection.readDocument(document.path)),
    opId = `runtime-archive-${createHash("sha256")
      .update(`${input.workspaceId}\0${value.dispatchId}\0${value.runtimeSessionId}`)
      .digest("hex")}`,
    existing = input.store.readEvent(opId);
  // A reviewer registers its review (which publishes the report documents itself) before its runtime
  // settles. For reviewer dispatches an archive document that is already published with identical
  // content is already archived, not a collision; only divergent pre-existing content still fails.
  const reviewer = readDispatchStreamHeader(input.rootDir, value.dispatchId)?.role === "reviewer",
    classified = documents.map((document, index) => {
      const authored = path.join(layout.authoredRoot, ...document.path.split("/")),
        authoredBody = existsSync(authored) ? readFileSync(authored) : null,
        read = reads[index]!,
        fresh = read.status === "ready" && read.document === null && authoredBody === null;
      let identical = false;
      if (!fresh && reviewer) {
        const digest = sha256Bytes(document.bytes);
        identical =
          (read.status === "ready" && read.document?.blobSha256 === digest) ||
          (authoredBody !== null && sha256Bytes(authoredBody) === digest);
      }
      return { document, fresh, identical };
    });
  if (existing === null) {
    const unrouted =
        !directPaths(
          input.rootDir,
          documents.map(({ path: target }) => target),
        ) || documents.some(({ path: target }) => !resolveDocRoute(target).allowed),
      conflict = classified.find((entry) => !entry.fresh && !entry.identical);
    if (unrouted || conflict)
      throw docSyncError(
        "runtime_archive_collision",
        `Runtime archive ${value.dispatchId} is not a fresh artifact set` +
          (conflict ? ` (${conflict.document.path} already exists)` : ""),
      );
  }
  const pending = classified.filter((entry) => entry.fresh).map((entry) => entry.document);
  if (existing === null && pending.length === 0)
    return {
      outcome: "no_changes",
      opId,
      receiptId: opId,
      code: "already_published",
      origin: "doc-sync",
      summary: `runtime archive ${value.dispatchId}: every document is already published`,
    };
  // On replay the intent must match the recorded event's full change set; the pending filter only
  // applies to a first-time archive that found some of its documents already published.
  const intentDocuments = existing === null ? pending : documents,
    intent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: null,
        baseLedgerSha: input.store.currentCut(),
        changes: intentDocuments.map(({ path: target, bytes, mediaType }) => {
          const sha = sha256Bytes(bytes);
          return {
            path: target,
            baseBlobSha256: null,
            policyId: classifyTextualArtifactPath(target)?.policyId ?? DOC_POLICY_ID,
            candidate: {
              ref: `doc-sync-claims/${sha}`,
              sha256: sha,
              size: bytes.byteLength,
              mediaType,
            },
          };
        }),
      },
      input.workspaceId,
    );
  return publishDocIntent(
    {
      ...input,
      action: { kind: "runtime-archive" },
      runtimeArchive: {
        dispatchId: value.dispatchId,
        runtimeSessionId: value.runtimeSessionId,
        taskId: value.taskId,
        executionId: value.executionId,
        packagePath,
      },
    },
    intent,
    intentDocuments.map(({ bytes }) => bytes),
    null,
    { opId, ignoreBaseLedgerShaOnReplay: true },
  );
}

export function publishVerticalScriptChanges(
  input: Omit<Input, "action">,
  action: VerticalScriptActionV1,
  changes: readonly VerticalScriptChangeV1[],
): DocSettlementReceipt {
  const paths = changes.map(({ path: target }) => documentPath(target));
  if (!directPaths(input.rootDir, paths) || paths.some((target) => !resolveDocRoute(target).allowed))
    throw docSyncError("script_scope_violation", "Script output is outside canonical document routes");
  const reads = paths.map((target) => input.projection.readDocument(target));
  if (
    reads.some(
      (read, index) =>
        read.status !== "ready" || (changes[index]!.disposition === "create") !== (read.document === null),
    )
  )
    throw docSyncError("script_plan_stale", "Script plan disposition no longer matches the canonical projection");
  const bytes = changes.map(({ body }) => Buffer.from(body)),
    lease = action.taskId === null ? null : input.projection.currentLease(action.taskId, input.now()),
    intent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: lease?.executionId ?? null,
        baseLedgerSha: input.store.currentCut(),
        changes: changes.map((change, index) => ({
          path: paths[index],
          baseBlobSha256: reads[index]!.document?.blobSha256 ?? null,
          policyId: classifyTextualArtifactPath(paths[index]!)?.policyId ?? DOC_POLICY_ID,
          candidate: {
            ref: `doc-sync-claims/${sha256Bytes(bytes[index]!)}`,
            sha256: sha256Bytes(bytes[index]!),
            size: bytes[index]!.byteLength,
            mediaType: change.mediaType,
          },
        })),
      },
      input.workspaceId,
    );
  return publishDocIntent({ ...input, action: { kind: "script-run" } }, intent, bytes, lease);
}

export function publishDocIntent(
  input: Input,
  intent: DocWriteIntent,
  claims: readonly (Uint8Array | null)[],
  lease: ReturnType<TaskProjection["currentLeaseForExecution"]>,
  options: {
    readonly retirementReason?: string;
    readonly opId?: string;
    readonly ignoreBaseLedgerShaOnReplay?: boolean;
  } = {},
): DocSettlementReceipt {
  const retirementReason = options.retirementReason;
  const baseRevision = intent.baseLedgerSha.revision,
    command = retirementReason === undefined ? intent : { ...intent, retirementReason },
    envelope = normalizeCommandEnvelope({
      workspaceId: input.workspaceId,
      actor: input.binding.actor,
      source: input.binding.source,
      expectedRevision: baseRevision ?? 0,
      command: command as unknown as Readonly<Record<string, unknown>>,
    }),
    opId = options.opId ?? envelope.opId,
    existing = input.store.readEvent(opId);
  if (existing !== null) {
    if (
      !isDocEvent(existing) ||
      !matches(
        existing,
        intent,
        input.binding.actor,
        input.binding.source,
        retirementReason,
        options.ignoreBaseLedgerShaOnReplay,
      )
    ) {
      recycleClaims(input.rootDir, intent);
      return rejectDocSyncAction(opId, "op_conflict", detail(intent, input.store.currentCut(), "op_conflict", null));
    }
    if (input.projection.readOperation(existing.opId) === null)
      input.projection.apply(existing, docSyncWritePlan(existing));
    const receipt = readDocReceipt(input, existing);
    recycleClaims(input.rootDir, intent);
    return receipt;
  }
  const adjudication = adjudicateDocIntent(
    {
      ...input,
      ...(typeof input.action.taskId === "string" ? { taskId: input.action.taskId } : {}),
    },
    intent,
    claims,
    lease,
    opId,
    retirementReason,
  );
  if (!adjudication.accepted) {
    if (adjudication.code === "projection_pending")
      return {
        outcome: "indeterminate",
        opId,
        receiptId: opId,
        code: "projection_pending",
        origin: "N/A",
      };
    recycleClaims(input.rootDir, intent);
    return {
      ...rejectDocSyncAction(opId, adjudication.code, adjudication.detail),
      authorizationDecision: adjudication.authorizationDecision,
    };
  }
  input.store.append({
    event: adjudication.decision.event,
    plan: adjudication.decision.plan,
    blobs: adjudication.decision.blobs,
  });
  input.projection.apply(adjudication.decision.event, adjudication.decision.plan);
  postCommit(input, "after_sqlite_commit", opId);
  postCommit(input, "before_response_write", opId);
  const applied = readDocReceipt(input, adjudication.decision.event);
  postCommit(input, "after_response_write", opId);
  recycleClaims(input.rootDir, intent);
  return { ...applied, authorizationDecision: adjudication.decision.authorizationDecision };
}
