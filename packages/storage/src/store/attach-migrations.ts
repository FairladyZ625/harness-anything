import type { ActorIdentity } from "@harness-anything/kernel/internal/domain/actor-identity.ts";
import {
  migrateUnclosedDispatchGroup,
  type DispatchLifecycleAttempt,
  type DispatchLifecycleGroup,
} from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import {
  eventShapeMigrationNames,
  eventShapeMigrationWritePlan,
  isEventShapeMigrationEvent,
  retiredPersistedSchemaFields,
  withReviewerQualifiedDispatchKey,
  withoutRetiredCloseoutCodeDoc,
  withoutRetiredVerticalHostedCi,
  type EventShapeMigrationEventV1,
  type EventShapeMigrationName,
} from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import type {
  CanonicalEventV1,
  PersistedCanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync-types.ts";
import {
  isAgentRuntimeEvent,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { isRecord } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import { RETIRED_SETTINGS_PATHS } from "@harness-anything/kernel/internal/domain/settings.ts";
import { historicalReadConclusions } from "@harness-anything/kernel/internal/domain/index.ts";
import type { CanonicalEventStore } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { canonicalEventWritePlan } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import type { CanonicalWriteBundle } from "@harness-anything/kernel/internal/ports/task-event-store.ts";

export type AttachMigrationRegistryEntry =
  | Readonly<{
      readonly kind: "event-migration";
      readonly name: EventShapeMigrationName;
      readonly fields: readonly string[];
      readonly matches: (
        event: PersistedCanonicalEventV1,
        readContentBlob?: (sha256: string) => Uint8Array | null,
      ) => boolean;
    }>
  | Readonly<{
      readonly kind: "read-conclusion";
      readonly name: string;
      readonly fields: readonly string[];
      readonly attachRequired: false;
      readonly conclusion: string;
    }>
  | Readonly<{
      readonly kind: "dispatch-lifecycle-import";
      readonly name: "dispatch-lifecycle.import";
      readonly fields: readonly string[];
    }>;

function taskOverrideAt(event: PersistedCanonicalEventV1, key: "fact" | "codeDoc"): boolean {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return false;
  const task =
    event.schema === "migration-import-event/v1" && isRecord(payload.entity) && payload.entity.kind === "task"
      ? payload.entity.task
      : payload.task;
  return isRecord(task) && isRecord(task.closeoutOverrides) && typeof task.closeoutOverrides[key] === "boolean";
}

function taskHasRetiredFact(event: PersistedCanonicalEventV1): boolean {
  return taskOverrideAt(event, "fact");
}

/**
 * The same retired key rides two carriers: the task-bound override set and the
 * `preset-snapshot/v1` profile it was frozen from. The snapshot is content, so the matcher reads
 * the claimed blob. `vertical.completion.closeoutCodeDoc` owns the declaration default and cannot
 * absorb this field: a step name already applied on a ledger is skipped wholesale.
 */
function hasRetiredCodeDocCloseoutOverride(
  event: PersistedCanonicalEventV1,
  readContentBlob?: (sha256: string) => Uint8Array | null,
): boolean {
  if (taskOverrideAt(event, "codeDoc")) return true;
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload) || !isRecord(payload.presetSnapshotClaim)) return false;
  if (typeof payload.presetSnapshotClaim.sha256 !== "string") return false;
  const bytes = readContentBlob?.(payload.presetSnapshotClaim.sha256);
  if (!bytes) return false;
  const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return (
    isRecord(snapshot) &&
    isRecord(snapshot.profile) &&
    isRecord(snapshot.profile.closeoutOverrides) &&
    typeof snapshot.profile.closeoutOverrides.codeDoc === "boolean"
  );
}

function hasRetiredScheduleCiObserve(event: PersistedCanonicalEventV1): boolean {
  const payload = (event as { readonly payload?: unknown }).payload;
  return (
    event.schema === "schedule-event/v1" &&
    isRecord(payload) &&
    isRecord(payload.schedule) &&
    isRecord(payload.schedule.status) &&
    Object.hasOwn(payload.schedule.status, "ciObserve")
  );
}

function hasFlatSquadRunIdentity(event: PersistedCanonicalEventV1): boolean {
  if (event.schema !== "agent-runtime-event/v1") return false;
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return false;
  const identity =
    event.type === "runtime_dispatch_requested"
      ? payload.squadRun
      : event.type === "runtime_squad_run_observed"
        ? payload
        : null;
  return isRecord(identity) && identity.subject === undefined && typeof identity.taskId === "string";
}

function settingsAt(
  settings: Readonly<Record<string, unknown>>,
  path: readonly string[],
): Readonly<Record<string, unknown>> {
  let current: unknown = settings;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(current)) return {};
    current = current[segment];
  }
  return isRecord(current) ? current : {};
}

const retiredSettingsCodeDocPath = ["closeout", "overrides", "codeDoc"] as const;

/** The review thresholds own a step of their own; `settings.ci` must not absorb them. */
const retiredSettingsReviewThresholdPaths = RETIRED_SETTINGS_PATHS.filter(
    (path) => path[0] === "review" && path[1] === "thresholds",
  ),
  retiredSettingsReviewThresholdKeys = new Set(retiredSettingsReviewThresholdPaths.map((path) => path.join(".")));

/** Settings paths retired by `settings.ci`; paths owned by another step are excluded. */
const retiredSettingsCiPaths = RETIRED_SETTINGS_PATHS.filter(
  (path) =>
    path.join(".") !== retiredSettingsCodeDocPath.join(".") && !retiredSettingsReviewThresholdKeys.has(path.join(".")),
);

function hasRetiredSettingsReviewThresholds(event: PersistedCanonicalEventV1): boolean {
  if (event.schema !== "settings-event/v1") return false;
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return false;
  const settings = payload.settings;
  if (!isRecord(settings)) return false;
  return retiredSettingsReviewThresholdPaths.some((path) => Object.hasOwn(settingsAt(settings, path), path.at(-1)!));
}

function hasRetiredSettingsCloseoutCodeDoc(event: PersistedCanonicalEventV1): boolean {
  if (event.schema !== "settings-event/v1") return false;
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload) || !isRecord(payload.settings)) return false;
  return Object.hasOwn(settingsAt(payload.settings, retiredSettingsCodeDocPath), "codeDoc");
}

function hasRetiredSettingsCi(event: PersistedCanonicalEventV1): boolean {
  if (event.schema !== "settings-event/v1") return false;
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload) || !isRecord(payload.settings)) return false;
  const settings = payload.settings;
  if (retiredSettingsCiPaths.some((path) => Object.hasOwn(settingsAt(settings, path), path.at(-1)!))) return true;
  return (
    Array.isArray(settings.gates) &&
    settings.gates.some(
      (gate) => isRecord(gate) && ["github-actions", "gitlab-pipeline"].includes(String(gate.adapter)),
    )
  );
}

function hasRetiredVerticalHostedCi(
  event: PersistedCanonicalEventV1,
  readContentBlob?: (sha256: string) => Uint8Array | null,
): boolean {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return false;
  if (event.schema === "vertical-declaration-event/v1" && isRecord(payload.declaration)) {
    const declaration = payload.declaration;
    return (
      isRecord(declaration) &&
      isRecord(declaration.definition) &&
      withoutRetiredVerticalHostedCi(declaration.definition) !== declaration.definition
    );
  }
  if (!isRecord(payload.presetSnapshotClaim) || typeof payload.presetSnapshotClaim.sha256 !== "string") return false;
  const bytes = readContentBlob?.(payload.presetSnapshotClaim.sha256);
  if (!bytes) return false;
  const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return withoutRetiredVerticalHostedCi(snapshot) !== snapshot;
}

/**
 * The retired code/doc closeout default is a field of its own step, never folded into
 * `vertical.completion.sources`: a step name that was already applied on a ledger is skipped
 * wholesale, so a field added to that entry afterwards would never run there. The same rule bans
 * reusing `settings.ci` for the settings-side `closeout.overrides.codeDoc` path.
 */
function hasRetiredVerticalCloseoutCodeDoc(
  event: PersistedCanonicalEventV1,
  readContentBlob?: (sha256: string) => Uint8Array | null,
): boolean {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return false;
  if (event.schema === "vertical-declaration-event/v1" && isRecord(payload.declaration)) {
    const declaration = payload.declaration;
    return (
      isRecord(declaration) &&
      isRecord(declaration.definition) &&
      withoutRetiredCloseoutCodeDoc(declaration.definition) !== declaration.definition
    );
  }
  if (!isRecord(payload.presetSnapshotClaim) || typeof payload.presetSnapshotClaim.sha256 !== "string") return false;
  const bytes = readContentBlob?.(payload.presetSnapshotClaim.sha256);
  if (!bytes) return false;
  const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return withoutRetiredCloseoutCodeDoc(snapshot) !== snapshot;
}

function hasLegacyReviewerDispatchKey(event: PersistedCanonicalEventV1): boolean {
  return withReviewerQualifiedDispatchKey(event) !== event;
}

/**
 * Why no step covers doc claims: this registry converts *retired persisted fields* — a field the
 * current validator no longer admits, which a cold replay would otherwise reject. Two properties
 * keep historical doc claims out of it. The opaque textual policy is not retired: every read path
 * answers it for a persisted row of that policy (`effectiveDocCandidateClassification`), so
 * `validDocEventMutation` still admits an `opaque-textual-whole-file/v1` change and a full replay of
 * the live ledger succeeds. The bytes may still be re-judged raw today — the old write boundary
 * classified by path, so a persisted opaque row can carry a NUL byte and the current byte judgment
 * calls that non-textual — and that is exactly why the policy must come from the row, not from the
 * bytes. No field needs rewriting either way: the policy id itself is still valid, and both readers
 * that decide a persisted row's fate — the local scanner and the edge mirror — take its policy from
 * the stored `policyId` (`effectiveDocCandidateClassification`) and treat any persisted row as a
 * channel member; a path with no persisted document row is judged by the shared candidate classifier
 * (`classifyDocCandidate`). A path neither the classifier nor the persisted row names, and that no
 * route owns, is `inapplicable` on both sides: not this channel's business, so it is reported and
 * left alone instead of refused — one stray binary in a task package must not block that package's
 * commands. The byte
 * classifier changed which policy *new* writes choose; the rows already written keep the policy they
 * were written under. `historical-doc-claims.integration.test.ts` pins that on a frozen cut of the
 * real ledger; `attach-migrations.test.ts` pins that this reasoning stays true
 * (`retiredPersistedSchemaFields` never names an artifact policy, and a NUL-bearing persisted row
 * still reads and edits under its written policy).
 */
export const attachMigrationRegistry: readonly AttachMigrationRegistryEntry[] = Object.freeze([
  {
    kind: "event-migration",
    name: "closeout-overrides.fact",
    fields: ["Task.closeoutOverrides.fact"],
    matches: taskHasRetiredFact,
  },
  {
    kind: "event-migration",
    name: "closeout-overrides.codeDoc",
    fields: ["Task.closeoutOverrides.codeDoc", "PresetSnapshot.profile.closeoutOverrides.codeDoc"],
    matches: hasRetiredCodeDocCloseoutOverride,
  },
  {
    kind: "event-migration",
    name: "schedule.ciObserve",
    fields: ["Schedule.status.ciObserve"],
    matches: hasRetiredScheduleCiObserve,
  },
  {
    kind: "event-migration",
    name: "squad-run.subject",
    fields: ["SquadRun.taskId+executionId"],
    matches: hasFlatSquadRunIdentity,
  },
  {
    kind: "event-migration",
    name: "settings.ci",
    fields: ["Settings.gates.ci", "Settings.ci.workflows"],
    matches: hasRetiredSettingsCi,
  },
  {
    kind: "event-migration",
    name: "settings.closeout.codeDoc",
    fields: ["Settings.closeout.overrides.codeDoc"],
    matches: hasRetiredSettingsCloseoutCodeDoc,
  },
  {
    kind: "event-migration",
    name: "settings.review.thresholds",
    fields: retiredSettingsReviewThresholdPaths.map((path) => `Settings.${path.join(".")}`),
    matches: hasRetiredSettingsReviewThresholds,
  },
  {
    kind: "event-migration",
    name: "runtime.reviewDispatchKey",
    fields: ["RuntimeDispatchRequested.payload.dispatchKey"],
    matches: hasLegacyReviewerDispatchKey,
  },
  {
    kind: "event-migration",
    name: "vertical.completion.sources",
    fields: ["Vertical.completion.sources.*.kind"],
    matches: hasRetiredVerticalHostedCi,
  },
  {
    kind: "event-migration",
    name: "vertical.completion.closeoutCodeDoc",
    fields: ["Vertical.completion.closeoutDefaults.codeDoc"],
    matches: hasRetiredVerticalCloseoutCodeDoc,
  },
  {
    kind: "dispatch-lifecycle-import",
    name: "dispatch-lifecycle.import",
    fields: ["RuntimeDispatchRequested", "RuntimeSessionFacts", "DispatchLifecycleProjection"],
  },
  ...historicalReadConclusions,
]);

const registeredRetiredFields = new Set(
  attachMigrationRegistry.flatMap((entry) => (entry.kind === "event-migration" ? entry.fields : [])),
);
if (
  registeredRetiredFields.size !== retiredPersistedSchemaFields.length ||
  retiredPersistedSchemaFields.some((field) => !registeredRetiredFields.has(field))
)
  throw new Error("retired persisted schema fields must have exactly one attach migration registration");

const defaultMigrationActor: ActorIdentity = { principal: { personId: "daemon-upgrade" }, executor: null };

const dispatchLifecycleMigrationVersion = "dispatch-lifecycle/v1";

type HistoricalDispatchGroup = {
  readonly dispatch: Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;
  readonly started: boolean;
  readonly exited: boolean;
  readonly outcome: Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }> | null;
};

function runtimeEventsByType(
  store: CanonicalEventStore,
  type: AgentRuntimeEventV1["type"],
): readonly AgentRuntimeEventV1[] {
  // Both SQLite and PG answer this through the runtime type index. Page by the canonical revision
  // bound rather than using readBatch, so attach never walks unrelated event types and remains
  // within the shared 500-row query contract.
  if (!store.queryEvents) return [];
  const events: AgentRuntimeEventV1[] = [];
  let revisionBound: number | undefined;
  for (;;) {
    const page = store.queryEvents({ type, limit: 500, ...(revisionBound === undefined ? {} : { revisionBound }) });
    const runtime = page.filter(isAgentRuntimeEvent);
    events.push(...runtime);
    if (page.length < 500) break;
    const oldest = page.reduce(
      (minimum, event) => Math.min(minimum, event.workspaceRevision),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(oldest) || oldest >= (revisionBound ?? Number.POSITIVE_INFINITY)) break;
    revisionBound = oldest;
  }
  return events.sort((left, right) => left.workspaceRevision - right.workspaceRevision);
}

function historicalDispatchGroups(store: CanonicalEventStore, repoId: string): readonly DispatchLifecycleGroup[] {
  // A real canonical store always exposes ledger metadata. Keeping malformed unit fakes out of
  // the indexed import path preserves the existing shape-migration scan contract while still
  // making the production path fail closed on any missing metadata.
  if (store.ledgerMetadata === undefined) return [];
  const indexedEvents = store.readDispatchLifecycleMigrationEvents?.(),
    eventsByType = (type: AgentRuntimeEventV1["type"]): readonly AgentRuntimeEventV1[] =>
      indexedEvents === undefined
        ? runtimeEventsByType(store, type)
        : indexedEvents.filter(
            (event): event is AgentRuntimeEventV1 => isAgentRuntimeEvent(event) && event.type === type,
          ),
    requests = eventsByType("runtime_dispatch_requested").filter(
      (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
        event.type === "runtime_dispatch_requested" &&
        (event.payload.attemptGroupId === undefined || typeof event.payload.attemptGroupId === "string"),
    ),
    starts = new Set(
      eventsByType("runtime_session_started")
        .filter((event) => event.type === "runtime_session_started")
        .map((event) => event.payload.runtimeSessionId),
    ),
    exits = new Set(
      eventsByType("runtime_session_exited")
        .filter((event) => event.type === "runtime_session_exited")
        .map((event) => event.payload.runtimeSessionId),
    ),
    outcomes = new Map<string, Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>>();
  for (const event of eventsByType("runtime_session_outcome_observed")) {
    if (event.type === "runtime_session_outcome_observed") outcomes.set(event.payload.runtimeSessionId, event);
  }
  const grouped = new Map<string, HistoricalDispatchGroup[]>();
  for (const dispatch of requests) {
    const groupId = dispatch.payload.attemptGroupId ?? dispatch.payload.dispatchId,
      values = grouped.get(groupId) ?? [];
    values.push({
      dispatch,
      started: starts.has(dispatch.payload.runtimeSessionId),
      exited: exits.has(dispatch.payload.runtimeSessionId),
      outcome: outcomes.get(dispatch.payload.runtimeSessionId) ?? null,
    });
    grouped.set(groupId, values);
  }
  const result: DispatchLifecycleGroup[] = [];
  for (const [attemptGroupId, values] of grouped) {
    values.sort(
      (left, right) =>
        (left.dispatch.payload.attemptIndex ?? 0) - (right.dispatch.payload.attemptIndex ?? 0) ||
        left.dispatch.workspaceRevision - right.dispatch.workspaceRevision,
    );
    const attempts: DispatchLifecycleAttempt[] = values.map((value, index) => {
      const payload = value.dispatch.payload,
        current = index === values.length - 1,
        outcome = value.outcome?.payload.outcome ?? null,
        terminal = value.outcome !== null,
        process = value.exited ? "exited" : value.started ? "alive" : "unobserved";
      // Historical outcome/stream summaries do not prove that the process group was stopped.
      // An exit observation changes the process fact, but only a center-accepted stop proof can
      // release the reservation and lease. Apply the exited fact before the current-attempt
      // fallback so an exited current attempt cannot be imported as starting/running.
      return {
        dispatchId: payload.dispatchId,
        runtimeSessionId: payload.runtimeSessionId,
        instanceId: payload.instanceId,
        // An outcome or runtime-session exit is not a process-tree stop proof. The canonical
        // center lifecycle must later accept process_stop_proven before this attempt can close.
        phase: value.exited ? "settling" : current && !terminal ? (value.started ? "running" : "starting") : "settling",
        process,
        stopProof: "unproven",
        capacity: "held",
        reservationId: payload.dispatchId,
        outcome,
        taskLease:
          payload.taskId && payload.executionId
            ? {
                taskId: payload.taskId,
                executionId: payload.executionId,
                version: Number.isSafeInteger((payload as unknown as Readonly<Record<string, unknown>>).leaseVersion)
                  ? Number((payload as unknown as Readonly<Record<string, unknown>>).leaseVersion)
                  : 0,
              }
            : null,
        workspaceRef: payload.cwd ?? null,
      };
    });
    const current = values.at(-1)!,
      currentOutcome = current.outcome?.payload,
      fallbackScheduled = currentOutcome?.attempt?.fallbackState === "scheduled",
      awaitingRuling = currentOutcome?.attempt?.classification === "awaiting_ruling",
      currentTerminal = current.outcome !== null,
      // An outcome alone is not a stop proof. Import terminal groups whose historical attempts
      // still lack an exit observation so their reservations and leases cannot be reused.
      unfinished =
        !currentTerminal ||
        fallbackScheduled ||
        awaitingRuling ||
        attempts.some((attempt) => attempt.stopProof === "unproven");
    if (!unfinished) continue;
    const currentAttempt = attempts.at(-1)!;
    result.push({
      repoId,
      attemptGroupId,
      phase: "settling",
      ownerFence: null,
      ownerFenceVerified: false,
      version: 1,
      currentDispatchId: currentAttempt.dispatchId,
      successorDispatchId: fallbackScheduled
        ? `${attemptGroupId}:fallback:${(current.dispatch.payload.attemptIndex ?? values.length - 1) + 1}`
        : null,
      notBeforeAt: null,
      rulingId: awaitingRuling ? `ruling-${currentAttempt.dispatchId}` : null,
      attempts,
    });
  }
  return result;
}

function makeDispatchLifecycleImportEvents(input: {
  readonly store: CanonicalEventStore;
  readonly now: () => string;
  readonly repoId: string;
  readonly sourceRevision: number;
}): { readonly preceding: readonly CanonicalWriteBundle[]; readonly groups: number } {
  const groups = historicalDispatchGroups(input.store, input.repoId),
    baseRevision = input.store.readHead()?.revision ?? 0,
    preceding: CanonicalWriteBundle[] = [];
  for (const [index, group] of groups.entries()) {
    const migrated = migrateUnclosedDispatchGroup({
        group: {
          ...group,
          phase: "settling",
          fenceVerifiable: false,
        },
        lifecycleMigrationVersion: dispatchLifecycleMigrationVersion,
      }),
      lifecycle = migrated.events[0]!,
      opId = `dispatch-lifecycle-import-${group.attemptGroupId}`,
      event = {
        schema: "agent-runtime-event/v1" as const,
        eventId: `event-${opId}`,
        workspaceRevision: baseRevision + index + 1,
        opId,
        type: "runtime_dispatch_lifecycle_observed" as const,
        actor: defaultMigrationActor,
        source: "local" as const,
        occurredAt: input.now(),
        payload: {
          runtimeSessionId: group.attempts.at(-1)!.runtimeSessionId,
          lifecycle,
        },
      } as unknown as CanonicalEventV1;
    preceding.push({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
  }
  return { preceding, groups: groups.length };
}

function applyDispatchLifecycleImport(input: {
  readonly store: CanonicalEventStore;
  readonly now?: () => string;
  readonly actor?: ActorIdentity;
  readonly sourceRevision: number;
}): boolean {
  const now = input.now ?? (() => new Date().toISOString()),
    repoId = input.store.ledgerMetadata?.().repoId ?? "legacy-repository",
    { preceding, groups } = makeDispatchLifecycleImportEvents({
      store: input.store,
      now,
      repoId,
      sourceRevision: input.sourceRevision,
    }),
    markerRevision = (input.store.readHead()?.revision ?? 0) + preceding.length + 1,
    opId = "upgrade-dispatch-lifecycle-import",
    marker: EventShapeMigrationEventV1 = {
      schema: "event-shape-migration/v1",
      eventId: `event-${opId}`,
      workspaceRevision: markerRevision,
      opId,
      type: "event_shape_migration_applied",
      actor: input.actor ?? defaultMigrationActor,
      source: "local",
      occurredAt: now(),
      payload: {
        migration: "dispatch-lifecycle.import",
        version: 1,
        sourceRevision: input.sourceRevision,
        affectedEvents: groups,
      },
    };
  input.store.append({
    event: marker,
    plan: eventShapeMigrationWritePlan(marker),
    blobs: [],
    ...(preceding.length > 0 ? { preceding } : {}),
  });
  return true;
}

export interface AttachMigrationReport {
  readonly applied: readonly EventShapeMigrationName[];
  readonly skipped: readonly EventShapeMigrationName[];
}

const attachMigrationBatchSize = 256;

function readAppliedMigrationNames(store: CanonicalEventStore): Set<EventShapeMigrationName> {
  return new Set(
    attachMigrationRegistry.flatMap((entry) => {
      // `dispatch-lifecycle-import` has its own registry kind because it is derived from
      // runtime history, but it records the same event-shape marker as every other attach
      // migration. Keep it in this single marker lookup so a second attach is a no-op.
      if (entry.kind === "read-conclusion") return [];
      const event = store.readEvent(`upgrade-${entry.name.replaceAll(".", "-")}`);
      return event !== null && isEventShapeMigrationEvent(event) && event.payload.migration === entry.name
        ? [entry.name]
        : [];
    }),
  );
}

/** Apply all pending historical shape upgrades before a projection is opened. */
export function applyAttachMigrations(input: {
  readonly store: CanonicalEventStore;
  readonly now?: () => string;
  readonly actor?: ActorIdentity;
  readonly onProgress?: (progress: { readonly applied: number; readonly total: number }) => void;
}): AttachMigrationReport {
  const applied = readAppliedMigrationNames(input.store),
    pending = attachMigrationRegistry.filter(
      (entry): entry is Extract<AttachMigrationRegistryEntry, { readonly kind: "event-migration" }> =>
        entry.kind === "event-migration" && !applied.has(entry.name),
    ),
    affectedEvents = new Map(pending.map(({ name }) => [name, 0])),
    total = input.store.readHead()?.revision ?? 0,
    canPersistWatermarks =
      input.store.readAttachMigrationScanWatermarks !== undefined &&
      input.store.recordAttachMigrationScanWatermarks !== undefined,
    watermarks = new Map<string, number>(canPersistWatermarks ? input.store.readAttachMigrationScanWatermarks!() : []);

  for (const { name } of pending) if ((watermarks.get(name) ?? 0) > total) watermarks.delete(name);
  const scanFrom = pending.length === 0 ? total : Math.min(...pending.map(({ name }) => watermarks.get(name) ?? 0));

  if (pending.length > 0 && scanFrom < total) {
    let cursor: string | null = String(scanFrom),
      scanned = 0;
    const scanTotal = total - scanFrom;
    for (;;) {
      const batch = input.store.readBatch(cursor, attachMigrationBatchSize);
      for (const event of batch.events) {
        if (isEventShapeMigrationEvent(event)) applied.add(event.payload.migration);
        for (const migration of pending) {
          if (
            event.workspaceRevision > (watermarks.get(migration.name) ?? 0) &&
            migration.matches(event, input.store.readContentBlob)
          )
            affectedEvents.set(migration.name, affectedEvents.get(migration.name)! + 1);
        }
      }
      scanned += batch.events.length;
      if (batch.events.length > 0) input.onProgress?.({ applied: scanned, total: scanTotal });
      if (batch.done) break;
      if (batch.cursor === cursor) throw new Error("attach migration scan did not advance its event cursor");
      cursor = batch.cursor;
    }
  }

  const appliedNow: EventShapeMigrationName[] = [];
  for (const migration of attachMigrationRegistry) {
    // Read conclusions belong to this registry so attach and the public reader share one
    // historical contract, but they intentionally append no event and leave old bytes intact.
    if (migration.kind !== "event-migration") continue;
    if (migration.name === "dispatch-lifecycle.import" || applied.has(migration.name)) continue;
    const affectedCount = affectedEvents.get(migration.name) ?? 0;
    if (affectedCount === 0) continue;
    const revision = (input.store.readHead()?.revision ?? 0) + 1,
      opId = `upgrade-${migration.name.replaceAll(".", "-")}`,
      event: EventShapeMigrationEventV1 = {
        schema: "event-shape-migration/v1",
        eventId: `event-${opId}`,
        workspaceRevision: revision,
        opId,
        type: "event_shape_migration_applied",
        actor: input.actor ?? defaultMigrationActor,
        source: "local",
        occurredAt: input.now?.() ?? new Date().toISOString(),
        payload: {
          migration: migration.name,
          version: 1,
          sourceRevision: revision - 1,
          affectedEvents: affectedCount,
        },
      };
    input.store.append({ event, plan: eventShapeMigrationWritePlan(event), blobs: [] });
    appliedNow.push(migration.name);
    applied.add(migration.name);
  }
  if (!applied.has("dispatch-lifecycle.import") && input.store.ledgerMetadata !== undefined) {
    applyDispatchLifecycleImport({
      store: input.store,
      now: input.now,
      actor: input.actor,
      sourceRevision: total,
    });
    appliedNow.push("dispatch-lifecycle.import");
    applied.add("dispatch-lifecycle.import");
  }
  if (canPersistWatermarks) {
    const completed = pending
      .filter(({ name }) => !watermarks.has(name) || watermarks.get(name)! < total)
      .map(({ name }) => ({ migration: name, revision: total }));
    if (completed.length > 0) input.store.recordAttachMigrationScanWatermarks!(completed);
  }
  return {
    applied: appliedNow,
    skipped: eventShapeMigrationNames.filter((name) => !appliedNow.includes(name)),
  };
}
