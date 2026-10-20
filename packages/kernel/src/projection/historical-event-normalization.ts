import { isMigrationImportEvent } from "../domain/migration-import-event.ts";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { isRecord } from "../domain/write-chain.contract.ts";
import {
  withoutRetiredFactCloseoutOverride,
  withoutRetiredScheduleCiObserve,
  withoutRetiredSettings,
  withoutRetiredVerticalHostedCi,
} from "../domain/event-shape-migration-event.ts";
export { withoutRetiredFactCloseoutOverride } from "../domain/event-shape-migration-event.ts";

export function hasRetiredFactCloseoutOverride(event: PersistedCanonicalEventV1): boolean {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return false;
  const task =
    isMigrationImportEvent(event) && isRecord(payload.entity) && payload.entity.kind === "task"
      ? payload.entity.task
      : payload.task;
  return isRecord(task) && isRecord(task.closeoutOverrides) && typeof task.closeoutOverrides.fact === "boolean";
}

function withoutFactOverride(task: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const overrides = task.closeoutOverrides;
  if (!isRecord(overrides) || typeof overrides.fact !== "boolean") return task;
  const next = Object.fromEntries(Object.entries(task).filter(([key]) => key !== "closeoutOverrides")) as Record<
    string,
    unknown
  >;
  const remaining = withoutRetiredFactCloseoutOverride(overrides);
  if (remaining !== undefined) next.closeoutOverrides = remaining;
  return next;
}

function normalizeTaskCarrier(event: PersistedCanonicalEventV1): PersistedCanonicalEventV1 {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return event;
  if (isMigrationImportEvent(event)) {
    const entity = payload.entity;
    if (isRecord(entity) && entity.kind === "task" && isRecord(entity.task)) {
      const task = withoutFactOverride(entity.task);
      if (task !== entity.task)
        return {
          ...event,
          payload: { ...payload, entity: { ...entity, task } },
        } as unknown as PersistedCanonicalEventV1;
    }
  }
  if (!isRecord(payload.task)) return event;
  const task = withoutFactOverride(payload.task);
  return task === payload.task
    ? event
    : ({ ...event, payload: { ...payload, task } } as unknown as PersistedCanonicalEventV1);
}

export function normalizeHistoricalEvent(event: PersistedCanonicalEventV1): PersistedCanonicalEventV1 {
  let normalized = normalizeTaskCarrier(event);
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
      const definition = withoutRetiredVerticalHostedCi(declaration.definition);
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
  const definition = withoutRetiredVerticalHostedCi(value.definition);
  return definition === value.definition ? value : { ...value, definition };
}
