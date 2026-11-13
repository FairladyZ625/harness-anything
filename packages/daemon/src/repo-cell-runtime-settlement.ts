import {
  applyTransition,
  canonicalEventWritePlan,
  compileTaskLifecycleWrite,
  lifecycleDocumentFetchPaths,
  normalizeTaskLifecycleCommand,
  previewDispatchLifecycleOutcome,
  type CanonicalEventWriteBundle,
  isSamePerson,
  stableStringify,
} from "@harness-anything/kernel";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { authorizeRuntimeRepoAction } from "./repo-cell-authorization.ts";
import { commitRuntimeSessionBundle, type RuntimeSessionBundle } from "./entity-action-runtime-session.ts";
import { publicationKillpoints } from "./entity-action-relation.ts";
import { readCompletionContext } from "./task-completion-read.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

/** Accept the runtime outcome and its owned task settlement in the same center transaction. */
export async function commitRuntimeSettlement(
  cell: RepoCellActionContext,
  bundle: RuntimeSessionBundle,
  binding: RepoCellBinding,
) {
  const event = bundle.event;
  if (event.type !== "runtime_session_outcome_observed") throw new Error("runtime outcome required");
  const commit = (value: RuntimeSessionBundle) =>
    commitRuntimeSessionBundle(cell.store, cell.projection, value, binding.authorizationDecision!, () =>
      publicationKillpoints(cell.input.killpoint),
    );
  const dispatch = cell.projection.readRuntimeDispatch(event.payload.runtimeSessionId);
  if (!dispatch) return commit(bundle);
  const group = cell.projection.readDispatchLifecycle({
    by: "group",
    attemptGroupId: dispatch.payload.attemptGroupId ?? dispatch.payload.dispatchId,
  });
  if (group.status !== "ready" || group.rows.length !== 1)
    throw cell.cellCodedError("runtime_event_missing", "Dispatch lifecycle group is not ready for settlement.");
  const current = group.rows[0]!;
  if (current.attempt.runtimeSessionId !== event.payload.runtimeSessionId)
    throw cell.cellCodedError("runtime_terminal_superseded", "The dispatch attempt is no longer current.");
  const preview = previewDispatchLifecycleOutcome(current, event);
  if (preview.kind !== "applied")
    throw cell.cellCodedError("runtime_event_rejected", "Dispatch lifecycle rejected the terminal outcome.");
  if (current.policy.attemptSettled && !current.policy.fallbackPending) return commit(bundle);
  if (current.attempt.stopProof !== "proven_stopped")
    throw cell.cellCodedError("runtime_process_group_unproven", "Dispatch settlement requires accepted stop proof.");
  const task = current.attempt.task;
  if (!task || task.role !== "implementer" || preview.groupPhase === "waiting_backoff") return commit(bundle);
  const read = cell.projection.read(task.taskId),
    lease = read.snapshot.lease;
  if (!cell.projectionReady(read) || !read.snapshot.task || !read.packagePath)
    throw cell.cellCodedError("projection_pending", "Task settlement projection is not ready.");
  if (
    !lease ||
    (task.executionId === lease.executionId && task.leaseVersion !== null && lease.version !== task.leaseVersion) ||
    (task.executionId !== lease.executionId &&
      lease.actor.executor?.id !== `runtime-session:${event.payload.runtimeSessionId}`) ||
    !isSamePerson(lease.actor, binding.actor) ||
    stableStringify(lease.source) !== stableStringify(binding.source)
  )
    return commit(bundle);
  for (let cursor: string | undefined; ; ) {
    const page = cell.projection.readDispatchLifecycle({
      by: "active",
      limit: storageReadPolicy.defaultValue.listDefaults.dispatchLifecycleLimit,
      ...(cursor ? { cursor } : {}),
    });
    if (page.status !== "ready") throw cell.cellCodedError("projection_pending", "Active dispatches are not ready.");
    if (
      page.rows.some(
        (row) =>
          row.attemptGroupId !== current.attemptGroupId &&
          !row.policy.groupSettled &&
          !row.policy.canResolveRuling &&
          row.attempt.task?.taskId === task.taskId &&
          row.attempt.task.executionId === task.executionId &&
          row.attempt.task.leaseVersion === task.leaseVersion,
      )
    )
      return commit(bundle);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const preceding: CanonicalEventWriteBundle[] = [],
    documents = new Map<string, { path: string; body: string; blobSha256: string }>();
  let snapshot = read.snapshot,
    revision = cell.store.readHead()?.revision ?? 0;
  const prepare = async (
    intent: Extract<
      Parameters<typeof normalizeTaskLifecycleCommand>[1],
      { type: "ReleaseRuntimeLease" | "TransitionTask" }
    >,
    action: RepoTaskAction,
  ) => {
    const authorized = await authorizeRuntimeRepoAction({
        repoId: cell.input.repoId,
        action,
        binding,
        actionId: `runtime-settlement:${event.opId}:${action.kind}`,
        revision,
        now: cell.now(),
        projection: cell.projection,
      }),
      command = cell.withServerMeta(
        normalizeTaskLifecycleCommand(
          {
            workspaceId: cell.input.repoId,
            actor: authorized.actor,
            source: authorized.source,
            expectedRevision: snapshot.revision,
          },
          intent,
        ),
        null,
        revision,
        cell.now(),
      );
    const transition = applyTransition(snapshot, command, {});
    for (const path of lifecycleDocumentFetchPaths(transition.event, read.packagePath!)) {
      if (documents.has(path)) continue;
      const document = cell.projection.readDocument(path);
      if (!cell.projectionReady(document))
        throw cell.cellCodedError("content_not_ready", `Document ${path} is not ready.`);
      if (document.document) documents.set(path, document.document);
    }
    const compiled = compileTaskLifecycleWrite({
      event: transition.event,
      snapshot: transition.snapshot,
      packagePath: read.packagePath,
      currentDocuments: [...documents.values()],
      completionContext: readCompletionContext(
        cell.projection,
        task.taskId,
        transition.snapshot,
        read.status,
        cell.rootDir,
      ),
    });
    for (const [index, claim] of (compiled.event.payload.documentClaims ?? []).entries())
      documents.set(claim.path, {
        path: claim.path,
        body: String(compiled.blobs[index]!.body),
        blobSha256: claim.sha256,
      });
    preceding.push(compiled);
    snapshot = transition.snapshot;
    revision = transition.event.workspaceRevision;
  };
  const reason = `Runtime session ${event.payload.runtimeSessionId} reached a terminal dispatch state.`;
  await prepare(
    {
      type: "ReleaseRuntimeLease",
      taskId: task.taskId,
      executionId: lease.executionId,
      leaseVersion: lease.version,
      reason,
    },
    { kind: "task-release", taskId: task.taskId, reason },
  );
  if (preview.ruling !== null && snapshot.task?.status === "active") {
    const reason = `Worker is waiting for owner ruling: ${event.payload.attempt?.reason ?? "runtime escalation"}`;
    await prepare(
      { type: "TransitionTask", taskId: task.taskId, status: "blocked", reason, force: false },
      { kind: "task-transition", taskId: task.taskId, status: "blocked", reason },
    );
  }
  const outcome = {
    ...event,
    workspaceRevision: (preceding.at(-1)?.event.workspaceRevision ?? event.workspaceRevision) + 1,
  };
  return commit({
    ...bundle,
    event: outcome,
    plan: canonicalEventWritePlan(outcome, "agent-runtime/v1", outcome.opId),
    preceding,
  });
}
