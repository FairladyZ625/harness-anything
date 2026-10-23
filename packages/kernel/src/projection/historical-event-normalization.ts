import {
  normalizeHistoricalSquadRunIdentity,
  normalizePersistedCanonicalEvent,
} from "../domain/doc-sync-canonical-events.ts";
import { isMigrationImportEvent } from "../domain/migration-import-event.ts";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { isRecord } from "../domain/write-chain.contract.ts";
import {
  retiredCloseoutOverrideKeys,
  withoutRetiredCloseoutCodeDoc,
  withoutRetiredCloseoutOverrides,
  withoutRetiredScheduleCiObserve,
  withoutRetiredSettings,
  withoutRetiredVerticalHostedCi,
  withReviewerQualifiedDispatchKey,
} from "../domain/event-shape-migration-event.ts";
export { withoutRetiredCloseoutOverrides } from "../domain/event-shape-migration-event.ts";

export function hasRetiredCloseoutOverride(event: PersistedCanonicalEventV1): boolean {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return false;
  const task =
    isMigrationImportEvent(event) && isRecord(payload.entity) && payload.entity.kind === "task"
      ? payload.entity.task
      : payload.task;
  return (
    isRecord(task) &&
    isRecord(task.closeoutOverrides) &&
    retiredCloseoutOverrideKeys.some((key) => Object.hasOwn(task.closeoutOverrides as object, key))
  );
}

function withoutRetiredTaskOverrides(task: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const overrides = task.closeoutOverrides;
  if (!isRecord(overrides) || !retiredCloseoutOverrideKeys.some((key) => Object.hasOwn(overrides, key))) return task;
  const next = Object.fromEntries(Object.entries(task).filter(([key]) => key !== "closeoutOverrides")) as Record<
    string,
    unknown
  >;
  const remaining = withoutRetiredCloseoutOverrides(overrides);
  if (remaining !== undefined) next.closeoutOverrides = remaining;
  return next;
}

function normalizeTaskCarrier(event: PersistedCanonicalEventV1): PersistedCanonicalEventV1 {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return event;
  if (isMigrationImportEvent(event)) {
    const entity = payload.entity;
    if (isRecord(entity) && entity.kind === "task" && isRecord(entity.task)) {
      const task = withoutRetiredTaskOverrides(entity.task);
      if (task !== entity.task)
        return {
          ...event,
          payload: { ...payload, entity: { ...entity, task } },
        } as unknown as PersistedCanonicalEventV1;
    }
  }
  if (!isRecord(payload.task)) return event;
  const task = withoutRetiredTaskOverrides(payload.task);
  return task === payload.task
    ? event
    : ({ ...event, payload: { ...payload, task } } as unknown as PersistedCanonicalEventV1);
}

/** The registered transform also applies to already-stored projection rows. */
export const normalizeHistoricalSquadRunState = normalizeHistoricalSquadRunIdentity;

export function normalizeHistoricalEvent(event: PersistedCanonicalEventV1): PersistedCanonicalEventV1 {
  let normalized = normalizeTaskCarrier(
    withReviewerQualifiedDispatchKey(normalizePersistedCanonicalEvent(event)) as PersistedCanonicalEventV1,
  );
  const payload = (normalized as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return normalized;
  if (normalized.schema === "schedule-event/v1" && isRecord(payload.schedule) && isRecord(payload.schedule.status)) {
    const status = withoutRetiredScheduleCiObserve(payload.schedule.status);
    if (status !== payload.schedule.status) {
      normalized = {
        ...normalized,
        payload: { ...payload, schedule: { ...payload.schedule, status } },
      } as unknown as PersistedCanonicalEventV1;
    }
  }
  if (normalized.schema === "settings-event/v1" && isRecord(payload.settings)) {
    const settings = withoutRetiredSettings(payload.settings);
    if (settings !== payload.settings)
      normalized = { ...normalized, payload: { ...payload, settings } } as unknown as PersistedCanonicalEventV1;
  }
  if (normalized.schema === "vertical-declaration-event/v1" && isRecord(payload.declaration)) {
    const declaration = payload.declaration;
    if (isRecord(declaration) && isRecord(declaration.definition)) {
      const declared = withoutRetiredCloseoutCodeDoc(declaration.definition),
        definition = withoutRetiredVerticalHostedCi(declared);
      if (definition !== declaration.definition)
        normalized = {
          ...normalized,
          payload: { ...payload, declaration: { ...declaration, definition } },
        } as unknown as PersistedCanonicalEventV1;
    }
  }
  return normalized;
}

export function normalizeHistoricalScheduleValue(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.status)) return value;
  const status = withoutRetiredScheduleCiObserve(value.status);
  return status === value.status ? value : { ...value, status };
}

export function normalizeHistoricalVerticalDocument(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.definition)) return value;
  const declared = withoutRetiredCloseoutCodeDoc(value.definition),
    definition = withoutRetiredVerticalHostedCi(declared);
  return definition === value.definition ? value : { ...value, definition };
}

/**
 * Preset snapshots carry the same vertical completion declaration at their root, and a profile may
 * still name a retired closeout override the preset manifest used to accept.
 */
export function normalizeHistoricalPresetSnapshot(value: unknown): unknown {
  const completion = withoutRetiredVerticalHostedCi(withoutRetiredCloseoutCodeDoc(value));
  if (!isRecord(completion) || !isRecord(completion.profile)) return completion;
  const overrides = withoutRetiredCloseoutOverrides(completion.profile.closeoutOverrides);
  if (overrides === completion.profile.closeoutOverrides) return completion;
  const { closeoutOverrides: _retired, ...profile } = completion.profile;
  return { ...completion, profile: overrides === undefined ? profile : { ...profile, closeoutOverrides: overrides } };
}
