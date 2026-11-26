import { currentExecutionCuts } from "@harness-anything/kernel/internal/domain/closeout-readiness.ts";
import {
  taskCompletionNext,
  type CompletionReadinessContext,
} from "@harness-anything/kernel/internal/domain/completion-readiness.ts";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel/internal/domain/settings.ts";
import {
  DEFAULT_CLOSEOUT_SETTINGS,
  effectiveCloseoutGates,
  type CloseoutSettingsV1,
} from "@harness-anything/kernel/internal/domain/settings-closeout.ts";
import { taskClasses, type TaskV2 } from "@harness-anything/kernel/internal/domain/task.ts";
import { isTaskProgressEvent } from "@harness-anything/kernel/internal/domain/task-progress-event.ts";
import { stableStringify } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "@harness-anything/kernel/internal/layout/portable-path.ts";
import type {
  CanonicalEventV1,
  CompletionDeliveryStatus,
  RepositorySettingsV1,
  TaskEventV1,
  TaskLifecycleSnapshot,
  TaskProjection,
} from "@harness-anything/kernel";

type CloudAction = Readonly<Record<string, unknown>> & { readonly kind: string };
type CodedErrorFactory = (code: string, message: string) => Error;

const PROGRESS_KIND = "task-progress-append";
const MUTATION_EVENT_TYPES = new Map<string, TaskEventV1["type"]>([
  ["task-amend", "task_amended"],
  ["task-archive", "task_archived"],
  ["task-reopen", "task_reopened"],
  ["task-delete", "task_deleted"],
  ["task-release", "lease_released"],
]);

/** Returns the explicit expected revision requested by the caller, if any. */
export function requestedExpectedRevision(action: CloudAction): number | undefined {
  if (typeof action.expectedRevision === "number") return action.expectedRevision;
  if (typeof action.expectedVersion === "number") return action.expectedVersion;
  return undefined;
}

/**
 * Verifies that a retry carrying an already-accepted `idempotency-key` represents the exact same
 * semantic command. Checks both the in-memory request fingerprint (when available on the same shard
 * instance) and the persisted canonical event (authoritative across shard restarts).
 */
export function verifyReplayPayload(
  event: CanonicalEventV1,
  action: CloudAction,
  opId: string,
  acceptedFingerprint: string | undefined,
  currentFingerprint: string,
  codedError: CodedErrorFactory,
): void {
  const conflict = (): Error =>
    codedError("idempotency_key_reused", `Idempotency key already accepted operation ${opId} for another write.`);
  if (acceptedFingerprint !== undefined && acceptedFingerprint !== currentFingerprint) throw conflict();
  const expectedRevision = requestedExpectedRevision(action);
  if (expectedRevision !== undefined && expectedRevision >= event.workspaceRevision) throw conflict();
  const taskId = trimmedNonEmpty(action.taskId);
  if (taskId === null) throw conflict();

  if (action.kind === PROGRESS_KIND) {
    if (!isTaskProgressEvent(event)) throw conflict();
    if (event.payload.taskId !== taskId) throw conflict();
    if (trimmedNonEmpty(action.text) !== event.payload.text) throw conflict();
    if (
      stableStringify(normalizedProgressEvidence(action.evidence, conflict)) !== stableStringify(event.payload.evidence)
    )
      throw conflict();
    if (action.executionId !== undefined && action.executionId !== event.payload.executionId) throw conflict();
    if (action.baseDocumentSha256 !== undefined && action.baseDocumentSha256 !== event.payload.baseDocumentSha256)
      throw conflict();
    if (event.payload.backfilled === true && action.asOwner !== true) throw conflict();
    if (action.asOwner !== undefined && typeof action.asOwner !== "boolean") throw conflict();
    if (
      stableStringify(event.payload.carriedDocumentClaims ?? null) !==
      stableStringify(action.carriedDocumentClaims ?? null)
    )
      throw conflict();
    return;
  }

  const expectedType = MUTATION_EVENT_TYPES.get(action.kind);
  if (!expectedType || event.schema !== "task-event/v1" || event.type !== expectedType || event.taskId !== taskId)
    throw conflict();
  const mutationEvent = event as Extract<
    TaskEventV1,
    { readonly type: "task_amended" | "task_archived" | "task_reopened" | "task_deleted" | "lease_released" }
  >;
  if (
    stableStringify(mutationEvent.payload.carriedDocumentClaims ?? null) !==
    stableStringify(action.carriedDocumentClaims ?? null)
  )
    throw conflict();

  if (action.kind === "task-amend") {
    verifyAmendReplayPayload(mutationEvent, action, conflict);
    return;
  }
  if (action.kind === "task-archive") {
    const reason = trimmedNonEmpty(action.reason);
    const expectedFields = ["packageDisposition", ...(typeof action.archivedBy === "string" ? ["archivedBy"] : [])];
    if (
      mutationEvent.payload.mutation.command !== "archive" ||
      reason !== mutationEvent.payload.mutation.reason ||
      stableStringify(mutationEvent.payload.mutation.fields) !== stableStringify(expectedFields)
    )
      throw conflict();
    return;
  }
  if (action.kind === "task-reopen") {
    const reason = trimmedNonEmpty(action.reason);
    if (mutationEvent.payload.mutation.command !== "reopen" || reason !== mutationEvent.payload.mutation.reason)
      throw conflict();
    return;
  }
  if (action.kind === "task-delete") {
    const reason = trimmedNonEmpty(action.reason);
    if (
      mutationEvent.payload.mutation.command !== "delete" ||
      action.mode !== "soft" ||
      reason !== mutationEvent.payload.mutation.reason
    )
      throw conflict();
    return;
  }
  if (action.kind === "task-release") {
    const forceTakeover = action.forceTakeover === true,
      trimmedReason = trimmedNonEmpty(action.reason),
      expectedReason = forceTakeover
        ? trimmedReason === null
          ? null
          : `Owner forced lease release: ${trimmedReason}`
        : (trimmedReason ?? "Authenticated holder released the lease.");
    if (
      mutationEvent.payload.mutation.command !== "release" ||
      expectedReason !== mutationEvent.payload.mutation.reason
    )
      throw conflict();
    const releasePayload = mutationEvent.payload as { readonly releasedLease?: { readonly executionId: string } },
      targetExecutionId = releasePayload.releasedLease?.executionId;
    if (action.terminalExecutionId !== undefined && trimmedNonEmpty(action.terminalExecutionId) !== targetExecutionId)
      throw conflict();
    return;
  }
  throw conflict();
}

function verifyAmendReplayPayload(
  event: Extract<
    TaskEventV1,
    { readonly type: "task_amended" | "task_archived" | "task_reopened" | "task_deleted" | "lease_released" }
  >,
  action: CloudAction,
  conflict: () => Error,
): void {
  if (event.payload.mutation.command !== "amend" || !Array.isArray(action.patches) || action.patches.length === 0)
    throw conflict();
  const patches = action.patches;
  if (patches.length !== event.payload.mutation.fields.length) throw conflict();
  let reapplied: TaskV2 = event.payload.task;
  const fields: string[] = [];
  for (const raw of patches) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw conflict();
    const patch = raw as Record<string, unknown>,
      field = trimmedNonEmpty(patch.field),
      value = trimmedNonEmpty(patch.value);
    if (field === null || value === null) throw conflict();
    fields.push(field);
    reapplied = applyAmendPatchForReplay(reapplied, field, value, conflict);
  }
  if (
    stableStringify(fields) !== stableStringify(event.payload.mutation.fields) ||
    stableStringify(reapplied) !== stableStringify(event.payload.task)
  )
    throw conflict();
}

function applyAmendPatchForReplay(task: TaskV2, field: string, value: string, conflict: () => Error): TaskV2 {
  if (field === "title") return { ...task, title: value };
  if (field === "parentTaskId") {
    if (!task.metadata) throw conflict();
    return { ...task, metadata: { ...task.metadata, parentTaskId: value } };
  }
  if (field === "workKind" && ["feat", "fix", "refactor", "docs", "test", "chore"].includes(value)) {
    if (!task.metadata) throw conflict();
    return { ...task, metadata: { ...task.metadata, workKind: value as NonNullable<TaskV2["metadata"]>["workKind"] } };
  }
  if (field === "urgency" && ["low", "medium", "high"].includes(value)) {
    if (!task.metadata) throw conflict();
    return { ...task, metadata: { ...task.metadata, urgency: value as NonNullable<TaskV2["metadata"]>["urgency"] } };
  }
  if (field === "taskClass" && (taskClasses as readonly string[]).includes(value))
    return { ...task, taskClass: value as TaskV2["taskClass"] };
  if (field === "surfaces") {
    if (!task.metadata) throw conflict();
    const surfaces = parseJsonOrConflict(value, conflict);
    if (!Array.isArray(surfaces) || surfaces.some((entry) => typeof entry !== "string" || entry.trim().length === 0))
      throw conflict();
    return { ...task, metadata: { ...task.metadata, surfaces } };
  }
  if (field === "reviewer" && /^[A-Za-z0-9_-]{1,96}$/u.test(value)) return { ...task, reviewer: value };
  if (field === "reviewDispatchIntent") {
    const intent = parseJsonOrConflict(value, conflict);
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw conflict();
    return { ...task, reviewDispatchIntent: intent as TaskV2["reviewDispatchIntent"] };
  }
  if (field === "reviewDispatchFailure") {
    const failure = parseJsonOrConflict(value, conflict);
    if (failure === null) {
      const { reviewDispatchFailure: _cleared, ...withoutFailure } = task;
      return withoutFailure;
    }
    if (!failure || typeof failure !== "object" || Array.isArray(failure)) throw conflict();
    return { ...task, reviewDispatchFailure: failure as TaskV2["reviewDispatchFailure"] };
  }
  throw conflict();
}

function parseJsonOrConflict(value: string, conflict: () => Error): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw conflict();
  }
}

function normalizedProgressEvidence(
  value: unknown,
  conflict: () => Error,
): readonly { readonly type: string; readonly path: string; readonly summary: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw conflict();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw conflict();
    const item = entry as Record<string, unknown>,
      type = trimmedNonEmpty(item.type),
      itemPath = trimmedNonEmpty(item.path),
      summary = trimmedNonEmpty(item.summary);
    if (type === null || itemPath === null || summary === null) throw conflict();
    return { type, path: itemPath, summary };
  });
}

function trimmedNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Minimal write-side completion readiness context for rendering `INDEX.md` inside the cloud writer
 * isolate without importing `@harness-anything/application/queries/*` or performing unkeyed scans.
 */
export function cloudCompletionContext(
  projection: TaskProjection,
  taskId: string,
  snapshot: TaskLifecycleSnapshot,
  status: "ready" | "pending",
  codedError: CodedErrorFactory,
): CompletionReadinessContext {
  const taskRead = projection.read(taskId),
    contractPath = taskRead.packagePath ? `${taskRead.packagePath}/task-contract.json` : null,
    completedArchive =
      taskRead.snapshot.task?.status === "done" && (taskRead.snapshot.task.packageDisposition ?? "active") !== "active",
    contractRead =
      contractPath === null
        ? null
        : (() => {
            const active = projection.readDocument(contractPath);
            return active.document || !completedArchive
              ? active
              : (projection.readDocumentHistory?.(contractPath) ?? active);
          })(),
    contractDocument = contractRead?.document ?? null,
    unavailable: CompletionReadinessContext = {
      closeout: "missing",
      closeoutPath: "",
      eligibleDirtyPaths: [],
      projectionStatus: status,
    },
    availability = taskCompletionNext(snapshot, unavailable);
  if (
    availability.blocker?.code === "projection_unknown" ||
    !snapshot.task ||
    !taskRead.packagePath ||
    !contractDocument ||
    !contractRead ||
    contractRead.watermark < contractRead.sourceRevision
  )
    return {
      closeout: "missing",
      closeoutPath: "",
      eligibleDirtyPaths: [],
      projectionStatus: "pending",
    };
  const closeoutPath = locateCloseoutPath(taskId, taskRead.packagePath, contractDocument.body, codedError),
    projectionStatus = projection.readRelationQuery({
      source: `task/${taskId}`,
      relationType: "produces",
      state: "active",
    }).status,
    closeoutGates = readWriteSideCloseoutGates(projection, snapshot),
    delivery = readWriteSideDeliveryStatus(projection, snapshot, taskRead.packagePath),
    childTaskCount = projection.readTaskChildCounts([taskId])[taskId] ?? 0;
  return {
    closeout: closeoutPath === null ? "missing" : "ready",
    closeoutPath: closeoutPath ?? "",
    closeoutGates,
    delivery,
    eligibleDirtyPaths: [],
    projectionStatus,
    childTaskCount,
  };
}

function locateCloseoutPath(
  taskId: string,
  packagePath: string,
  contractBody: string,
  codedError: CodedErrorFactory,
): string | null {
  let contract: unknown;
  try {
    contract = JSON.parse(contractBody);
  } catch {
    throw codedError("content_not_ready", `Task ${taskId} contract document is invalid.`);
  }
  const documents =
      contract &&
      typeof contract === "object" &&
      !Array.isArray(contract) &&
      Array.isArray((contract as { readonly documents?: unknown }).documents)
        ? (contract as { readonly documents: readonly unknown[] }).documents
        : [],
    descriptor = documents.find(
      (value): value is { readonly slot: string; readonly path: string } =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { readonly slot?: unknown }).slot === "task.closeout" &&
        typeof (value as { readonly path?: unknown }).path === "string",
    );
  if (!descriptor) return null;
  let documentPath: string;
  try {
    documentPath = normalizeRelativeDocumentPath(`${packagePath}/${descriptor.path}`);
  } catch {
    throw codedError("content_not_ready", `Task ${taskId} task.closeout path is invalid.`);
  }
  if (!documentPath.startsWith(`${packagePath}/`))
    throw codedError("content_not_ready", `Task ${taskId} task.closeout leaves its package.`);
  return documentPath;
}

function readWriteSideCloseoutGates(projection: TaskProjection, snapshot: TaskLifecycleSnapshot) {
  const cuts = currentExecutionCuts(snapshot);
  if (cuts.length === 1) return cuts[0]!.submission!.completionContract!.closeoutGates;
  const preset = snapshot.task?.presetSnapshotDigest
      ? (projection.readPresetSnapshot(snapshot.task.presetSnapshotDigest).snapshot as
          | { readonly completion?: { readonly closeoutDefaults?: Parameters<typeof effectiveCloseoutGates>[2] } }
          | undefined)
      : undefined,
    projected = projection.getEntity("settings", "repository")?.value as
      | { readonly closeout?: CloseoutSettingsV1 }
      | undefined;
  return effectiveCloseoutGates(
    projected?.closeout ?? DEFAULT_CLOSEOUT_SETTINGS,
    snapshot.task?.closeoutOverrides,
    preset?.completion?.closeoutDefaults,
  );
}

function readWriteSideDeliveryStatus(
  projection: TaskProjection,
  snapshot: TaskLifecycleSnapshot,
  packagePath: string,
): CompletionDeliveryStatus {
  const projected = projection.getEntity("settings", "repository")?.value as RepositorySettingsV1 | undefined,
    delivery = projected?.delivery ?? INITIAL_SETTINGS_V1.delivery,
    cuts = currentExecutionCuts(snapshot),
    execution = cuts.length === 1 ? cuts[0] : undefined,
    files = execution?.submission?.changedFiles,
    packagePrefix = `harness/${packagePath}/`,
    packageOnly = files !== undefined && files.every((file) => file.startsWith(packagePrefix)),
    preset = snapshot.task?.presetSnapshotDigest
      ? (projection.readPresetSnapshot(snapshot.task.presetSnapshotDigest).snapshot as
          | { readonly profile?: { readonly outputShape?: unknown } }
          | undefined)
      : undefined,
    outputShape = typeof preset?.profile?.outputShape === "string" ? preset.profile.outputShape : null,
    required =
      delivery.requireMerged &&
      execution?.submission?.commitSha != null &&
      !packageOnly &&
      outputShape !== "task-package-artifact",
    mergeSha =
      execution?.schema === "execution/v1"
        ? execution.annotations
            ?.findLast((entry) => /^merge_commit_sha:[0-9a-f]{40}$/u.test(entry.note))
            ?.note.slice(17)
        : undefined;
  return {
    required,
    merged: null,
    targetBranch: delivery.targetBranch,
    ...(delivery.targetRef !== undefined ? { targetRef: delivery.targetRef } : {}),
    ...(mergeSha !== undefined ? { mergeSha } : {}),
  };
}
