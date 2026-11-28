import { DatabaseSync } from "node:sqlite";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import { RAW_ARTIFACT_POLICY_ID as RAW_ARTIFACT_KIND } from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import { contentClaims } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import type { BaseBackupObjectEntry, BaseBackupObjectTier } from "./fleet-basebackup.ts";

/** Default size threshold at or above which historical terminal-task blobs are deferred as cold. */
export const COLD_BLOB_SIZE_THRESHOLD_BYTES = 64 * 1024;

const TERMINAL_TASK_STATUSES = new Set(["done", "cancelled", "archived", "completed", "closed", "abandoned"]);
const TASK_ARTIFACT_PATH_RE = /^tasks\/([^/]+)\/artifacts\//u;
const TASK_ID_PREFIX_RE = /^(task_[A-Za-z0-9_]+)/u;
const HOT_OBJECT_BUCKET: BaseBackupObjectTier = "hot";
const COLD_OBJECT_BUCKET: BaseBackupObjectTier = "cold";

export interface HotSetTrackerOptions {
  readonly coldThresholdBytes?: number;
  /**
   * When true (used by PG seed export, where receiving edges replay events to build `task.sqlite`),
   * text-projected `doc-event/v1` blobs (`policyId !== "raw-artifact/v1"`) stay in the hot set so
   * `hydrateReplicaSeed` can populate `document.body` without needing remote fetches.
   */
  readonly requireTextDocumentsHot?: boolean;
}

interface TrackedObject {
  readonly sha256: string;
  size: number;
  pinnedHot: boolean;
  readonly coldTaskIds: Set<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractTaskIdFromFolder(folder: string, knownTaskIds?: ReadonlyMap<string, string>): string {
  if (knownTaskIds) {
    let bestMatch: string | null = null;
    for (const taskId of knownTaskIds.keys()) {
      if (folder === taskId || folder.startsWith(`${taskId}-`)) {
        if (bestMatch === null || taskId.length > bestMatch.length) bestMatch = taskId;
      }
    }
    if (bestMatch !== null) return bestMatch;
  }
  const match = TASK_ID_PREFIX_RE.exec(folder);
  if (match) return match[1]!;
  return folder;
}

function extractTaskIdFromEvent(event: PersistedCanonicalEventV1): string | null {
  const record = asRecord(event);
  if (record && typeof record.taskId === "string" && record.taskId.length > 0) return record.taskId;
  const payload = asRecord(event.payload);
  if (!payload) return null;
  if (typeof payload.taskId === "string" && payload.taskId.length > 0) return payload.taskId;
  const task = asRecord(payload.task);
  if (task && typeof task.taskId === "string" && task.taskId.length > 0) return task.taskId;
  if (task && typeof task.id === "string" && task.id.length > 0) return task.id;
  return null;
}

function updateTaskStatusFromEvent(event: PersistedCanonicalEventV1, taskStatuses: Map<string, string>): void {
  const taskId = extractTaskIdFromEvent(event);
  if (!taskId) return;
  const type = String(event.type);
  const payload = asRecord(event.payload);
  const taskRecord = asRecord(payload?.task);
  if (taskRecord && typeof taskRecord.status === "string" && taskRecord.status.length > 0) {
    taskStatuses.set(taskId, taskRecord.status);
    return;
  }
  if (type === "task_completed" || type === "task_archived" || type === "task_superseded" || type === "task_deleted") {
    taskStatuses.set(taskId, "done");
    return;
  }
  if (type === "task_cancelled") {
    taskStatuses.set(taskId, "cancelled");
    return;
  }
  if (type === "task_created") {
    const status = typeof payload?.status === "string" ? payload.status : "planned";
    taskStatuses.set(taskId, status);
    return;
  }
  if (
    type === "task_started" ||
    type === "task_reopened" ||
    type === "task_resumed" ||
    type === "task_reworked" ||
    type === "task_claimed"
  ) {
    taskStatuses.set(taskId, "active");
    return;
  }
  if (type === "task_status_changed") {
    const nextStatus =
      typeof payload?.toStatus === "string"
        ? payload.toStatus
        : typeof payload?.nextStatus === "string"
          ? payload.nextStatus
          : typeof payload?.status === "string"
            ? payload.status
            : null;
    if (nextStatus !== null) taskStatuses.set(taskId, nextStatus);
  }
}

/**
 * Resolves the cold-eligible task ID for a content claim if and only if the claim is an
 * artifact/runtime/historical payload tied to a task. Core documents (task_plan, closeout,
 * decisions, facts, agents, squads, schedules, settings, KB, etc.) always return null (= hot).
 */
function coldEligibleTaskIdForDigest(
  event: PersistedCanonicalEventV1,
  targetSha256: string,
  docPath: string | undefined,
  taskStatuses: ReadonlyMap<string, string>,
  requireTextDocumentsHot: boolean,
): string | null {
  const payload = asRecord(event.payload);
  const type = String(event.type);

  // Check explicit document paths carried in doc-event/v1, task-event/v1, or carried claims.
  const matchedPaths: string[] = [];
  let matchedTextDoc = Boolean(false);
  if (typeof docPath === "string" && docPath.length > 0) matchedPaths.push(docPath);
  const collectChanges = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const rawChange of list) {
      const change = asRecord(rawChange);
      if (!change || typeof change.path !== "string") continue;
      const candidate = asRecord(change.candidate);
      const blob = asRecord(change.blob);
      const sha =
        typeof candidate?.sha256 === "string"
          ? candidate.sha256
          : typeof blob?.sha256 === "string"
            ? blob.sha256
            : typeof change.sha256 === "string"
              ? change.sha256
              : typeof change.blobSha256 === "string"
                ? change.blobSha256
                : null;
      if (sha === targetSha256) {
        matchedPaths.push(change.path);
        const docKind = change["policyId"];
        if (typeof docKind === "string" && docKind !== RAW_ARTIFACT_KIND) {
          matchedTextDoc = true;
        }
      }
    }
  };
  if (payload) {
    collectChanges(payload.changes);
    collectChanges(payload.documentClaims);
    collectChanges(payload.carriedDocumentClaims);
  }
  if (requireTextDocumentsHot && matchedTextDoc) return null;
  if (payload && typeof payload.path === "string" && payload.path.length > 0 && matchedPaths.length === 0) {
    matchedPaths.push(payload.path);
  }
  if (matchedPaths.length > 0) {
    let resolvedTaskId: string | null = null;
    for (const logicalPath of matchedPaths) {
      const normalized = logicalPath.replace(/^harness\//u, "");
      const match = TASK_ARTIFACT_PATH_RE.exec(normalized);
      if (!match) {
        // Any reference to a non-artifact path (e.g. task_plan.md, closeout.md, decisions/*, facts/*) is hot.
        return null;
      }
      resolvedTaskId = extractTaskIdFromEvent(event) ?? extractTaskIdFromFolder(match[1]!, taskStatuses);
    }
    return resolvedTaskId;
  }

  // Runtime execution result / handoff / CI evidence payloads attached to a specific task.
  if (
    type === "runtime_session_outcome_observed" ||
    type === "runtime_handoff_exported" ||
    type === "ci_run_observed" ||
    type === "task_artifact_attached"
  ) {
    return extractTaskIdFromEvent(event);
  }

  return null;
}

export interface HotSetTracker {
  readonly observeEvent: (event: PersistedCanonicalEventV1) => void;
  readonly finalize: (resolveSize?: (sha256: string) => number) => {
    readonly entries: readonly BaseBackupObjectEntry[];
    readonly hotCount: number;
    readonly coldCount: number;
  };
  readonly claimedSha256s: () => readonly string[];
}

/**
 * Deterministic single-pass hot/cold classifier for `fleet-basebackup/v4`.
 *
 * Hot set (always eagerly transferred during Edge Join):
 * - Every blob smaller than `coldThresholdBytes` (default 64 KiB).
 * - Every blob referenced by non-task entities (decisions, facts, agents, squads, schedules, KB, etc.).
 * - Every blob referenced by any core task document (`task_plan.md`, `closeout.md`, etc.).
 * - Every blob belonging to an active/non-terminal task.
 * - Any blob shared between a cold artifact and any hot reference (hot wins).
 *
 * Cold set (deferred for on-demand `fleet.blob.get/v1` or explicit `prefetch --all`):
 * - Blobs `>= coldThresholdBytes` whose ONLY references are task artifact/runtime payloads
 *   belonging exclusively to terminal/archived tasks (`done`, `cancelled`, `archived`, etc.).
 */
export function createHotSetTracker(options: HotSetTrackerOptions = {}): HotSetTracker {
  const coldThresholdBytes = options.coldThresholdBytes ?? COLD_BLOB_SIZE_THRESHOLD_BYTES;
  const requireTextDocumentsHot = options.requireTextDocumentsHot ?? false;
  const taskStatuses = new Map<string, string>();
  const objects = new Map<string, TrackedObject>();

  return {
    observeEvent(event: PersistedCanonicalEventV1): void {
      updateTaskStatusFromEvent(event, taskStatuses);
      for (const ref of contentClaims(event)) {
        let tracked = objects.get(ref.sha256);
        if (!tracked) {
          tracked = {
            sha256: ref.sha256,
            size: ref.size,
            pinnedHot: false,
            coldTaskIds: new Set<string>(),
          };
          objects.set(ref.sha256, tracked);
        } else if (ref.size > tracked.size) {
          tracked.size = ref.size;
        }
        if (tracked.pinnedHot) continue;
        const docPath = "path" in ref && typeof ref.path === "string" ? ref.path : undefined;
        const coldTaskId = coldEligibleTaskIdForDigest(
          event,
          ref.sha256,
          docPath,
          taskStatuses,
          requireTextDocumentsHot,
        );
        if (coldTaskId === null) {
          tracked.pinnedHot = true;
        } else {
          tracked.coldTaskIds.add(coldTaskId);
        }
      }
    },

    claimedSha256s(): readonly string[] {
      return [...objects.keys()];
    },

    finalize(resolveSize?: (sha256: string) => number) {
      const hotEntries: BaseBackupObjectEntry[] = [];
      const coldEntries: BaseBackupObjectEntry[] = [];
      for (const tracked of objects.values()) {
        const size = resolveSize ? resolveSize(tracked.sha256) : tracked.size;
        const allTasksTerminal =
          tracked.coldTaskIds.size > 0 &&
          [...tracked.coldTaskIds].every((taskId) => {
            const status = taskStatuses.get(taskId);
            return status !== undefined && TERMINAL_TASK_STATUSES.has(status);
          });
        const deferred = !tracked.pinnedHot && size >= coldThresholdBytes && allTasksTerminal;
        const bucket: BaseBackupObjectTier = deferred ? COLD_OBJECT_BUCKET : HOT_OBJECT_BUCKET;
        const entry: BaseBackupObjectEntry = { sha256: tracked.sha256, size, tier: bucket };
        if (deferred) coldEntries.push(entry);
        else hotEntries.push(entry);
      }
      return {
        entries: [...hotEntries, ...coldEntries],
        hotCount: hotEntries.length,
        coldCount: coldEntries.length,
      };
    },
  };
}

/** Lists all distinct content object SHA-256 digests claimed by events in a SQLite replica ledger. */
export function listLedgerClaimedContentObjects(ledgerPath: string): readonly string[] {
  const ledger = new DatabaseSync(ledgerPath, { readOnly: true });
  const seen = new Set<string>();
  try {
    for (const row of ledger.prepare("SELECT event_json FROM event ORDER BY revision").iterate()) {
      const event = JSON.parse(String(row.event_json)) as PersistedCanonicalEventV1;
      for (const ref of contentClaims(event)) {
        seen.add(ref.sha256);
      }
    }
  } finally {
    ledger.close();
  }
  return [...seen];
}
