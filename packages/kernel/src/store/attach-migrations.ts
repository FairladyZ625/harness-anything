import type { ActorIdentity } from "../domain/actor-identity.ts";
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
} from "../domain/event-shape-migration-event.ts";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { RETIRED_SETTINGS_PATHS } from "../domain/settings.ts";
import { historicalReadConclusions } from "../domain/index.ts";
import type { CanonicalEventStore } from "./task-event-store-types.ts";
import { isRecord } from "../domain/write-chain.contract.ts";

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

/** The settings paths retired by the `settings.ci` step; `closeout.overrides.codeDoc` has its own step. */
const retiredSettingsCiPaths = RETIRED_SETTINGS_PATHS.filter(
  (path) => path.join(".") !== retiredSettingsCodeDocPath.join("."),
);

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

function hasRetiredReviewThresholds(event: PersistedCanonicalEventV1): boolean {
  if (event.schema !== "settings-event/v1") return false;
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload) || !isRecord(payload.settings)) return false;
  const review = payload.settings.review;
  return (
    isRecord(review) &&
    isRecord(review.thresholds) &&
    ["correctness", "migration", "securityAuth"].some((key) => Object.hasOwn(review.thresholds!, key))
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
    fields: [
      "Settings.review.thresholds.correctness",
      "Settings.review.thresholds.migration",
      "Settings.review.thresholds.securityAuth",
    ],
    matches: hasRetiredReviewThresholds,
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

export interface AttachMigrationReport {
  readonly applied: readonly EventShapeMigrationName[];
  readonly skipped: readonly EventShapeMigrationName[];
}

const attachMigrationBatchSize = 256;

/** Apply all pending historical shape upgrades before a projection is opened. */
export function applyAttachMigrations(input: {
  readonly store: CanonicalEventStore;
  readonly now?: () => string;
  readonly actor?: ActorIdentity;
  readonly onProgress?: (progress: { readonly applied: number; readonly total: number }) => void;
}): AttachMigrationReport {
  const applied = new Set(
      attachMigrationRegistry.flatMap((entry) => {
        if (entry.kind === "read-conclusion") return [];
        const { name } = entry;
        const event = input.store.readEvent(`upgrade-${name.replaceAll(".", "-")}`);
        return event !== null && isEventShapeMigrationEvent(event) && event.payload.migration === name ? [name] : [];
      }),
    ),
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
    if (migration.kind === "read-conclusion") continue;
    if (applied.has(migration.name)) continue;
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
