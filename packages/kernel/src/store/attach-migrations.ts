import type { ActorIdentity } from "../domain/actor-identity.ts";
import {
  eventShapeMigrationNames,
  eventShapeMigrationWritePlan,
  isEventShapeMigrationEvent,
  retiredPersistedSchemaFields,
  withReviewerQualifiedDispatchKey,
  withoutRetiredVerticalHostedCi,
  type EventShapeMigrationEventV1,
  type EventShapeMigrationName,
} from "../domain/event-shape-migration-event.ts";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { RETIRED_SETTINGS_PATHS } from "../domain/settings.ts";
import type { CanonicalEventStore } from "./task-event-store-types.ts";
import { isRecord } from "../domain/write-chain.contract.ts";

export type AttachMigrationRegistryEntry = Readonly<{
  readonly name: EventShapeMigrationName;
  readonly fields: readonly string[];
  readonly matches: (
    event: PersistedCanonicalEventV1,
    readContentBlob?: (sha256: string) => Uint8Array | null,
  ) => boolean;
}>;

function taskHasRetiredFact(event: PersistedCanonicalEventV1): boolean {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return false;
  const task =
    event.schema === "migration-import-event/v1" && isRecord(payload.entity) && payload.entity.kind === "task"
      ? payload.entity.task
      : payload.task;
  return isRecord(task) && isRecord(task.closeoutOverrides) && typeof task.closeoutOverrides.fact === "boolean";
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

function hasRetiredSettingsCi(event: PersistedCanonicalEventV1): boolean {
  if (event.schema !== "settings-event/v1") return false;
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload) || !isRecord(payload.settings)) return false;
  const settings = payload.settings;
  if (
    RETIRED_SETTINGS_PATHS.some(([parent, key]) => isRecord(settings[parent]) && Object.hasOwn(settings[parent], key))
  )
    return true;
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

function hasLegacyReviewerDispatchKey(event: PersistedCanonicalEventV1): boolean {
  return withReviewerQualifiedDispatchKey(event) !== event;
}

export const attachMigrationRegistry: readonly AttachMigrationRegistryEntry[] = Object.freeze([
  { name: "closeout-overrides.fact", fields: ["Task.closeoutOverrides.fact"], matches: taskHasRetiredFact },
  { name: "schedule.ciObserve", fields: ["Schedule.status.ciObserve"], matches: hasRetiredScheduleCiObserve },
  {
    name: "squad-run.subject",
    fields: ["SquadRun.taskId+executionId"],
    matches: hasFlatSquadRunIdentity,
  },
  {
    name: "settings.ci",
    fields: ["Settings.gates.ci", "Settings.ci.workflows"],
    matches: hasRetiredSettingsCi,
  },
  {
    name: "runtime.reviewDispatchKey",
    fields: ["RuntimeDispatchRequested.payload.dispatchKey"],
    matches: hasLegacyReviewerDispatchKey,
  },
  {
    name: "vertical.completion.sources",
    fields: ["Vertical.completion.sources.*.kind"],
    matches: hasRetiredVerticalHostedCi,
  },
]);

const registeredRetiredFields = new Set(attachMigrationRegistry.flatMap(({ fields }) => fields));
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

function readAttachEvents(store: CanonicalEventStore): readonly PersistedCanonicalEventV1[] {
  const queryEvents = store.queryEvents;
  if (queryEvents === undefined)
    throw new Error("canonical event store must expose bounded queryEvents for attach migrations");
  const revision = store.readHead()?.revision ?? 0;
  return queryEvents({ limit: Math.max(1, revision) }) as readonly PersistedCanonicalEventV1[];
}

/** Apply all pending historical shape upgrades before a projection is opened. */
export function applyAttachMigrations(input: {
  readonly store: CanonicalEventStore;
  readonly now?: () => string;
  readonly actor?: ActorIdentity;
}): AttachMigrationReport {
  const events = readAttachEvents(input.store),
    applied = new Set(events.filter(isEventShapeMigrationEvent).map((event) => event.payload.migration));
  const appliedNow: EventShapeMigrationName[] = [];
  for (const migration of attachMigrationRegistry) {
    if (applied.has(migration.name)) continue;
    const affectedEvents = events.filter((event) => migration.matches(event, input.store.readContentBlob)).length;
    if (affectedEvents === 0) continue;
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
          affectedEvents,
        },
      };
    input.store.append({ event, plan: eventShapeMigrationWritePlan(event), blobs: [] });
    appliedNow.push(migration.name);
    applied.add(migration.name);
  }
  return {
    applied: appliedNow,
    skipped: eventShapeMigrationNames.filter((name) => !appliedNow.includes(name)),
  };
}
