import { isMigrationImportEvent, type PersistedCanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { isRecord } from "../domain/write-chain.contract.ts";

interface TaskCarrier {
  readonly task: Readonly<Record<string, unknown>>;
  readonly replace: (task: Readonly<Record<string, unknown>>) => PersistedCanonicalEventV1;
}

function taskCarrier(event: PersistedCanonicalEventV1): TaskCarrier | null {
  const payload = (event as { readonly payload?: unknown }).payload;
  if (!isRecord(payload)) return null;
  if (isMigrationImportEvent(event)) {
    const entity = payload.entity;
    if (isRecord(entity) && entity.kind === "task" && isRecord(entity.task))
      return {
        task: entity.task,
        replace: (task) =>
          ({ ...event, payload: { ...payload, entity: { ...entity, task } } }) as unknown as PersistedCanonicalEventV1,
      };
  }
  if (!isRecord(payload.task)) return null;
  return {
    task: payload.task,
    replace: (task) => ({ ...event, payload: { ...payload, task } }) as unknown as PersistedCanonicalEventV1,
  };
}

export function hasRetiredFactCloseoutOverride(event: PersistedCanonicalEventV1): boolean {
  const overrides = taskCarrier(event)?.task.closeoutOverrides;
  return isRecord(overrides) && typeof overrides.fact === "boolean";
}

export function withoutRetiredFactCloseoutOverride(value: unknown): unknown {
  if (!isRecord(value) || typeof value.fact !== "boolean") return value;
  const remaining = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fact"));
  return Object.keys(remaining).length > 0 ? remaining : undefined;
}

export function normalizeRetiredFactCloseoutOverride(event: PersistedCanonicalEventV1): PersistedCanonicalEventV1 {
  const carrier = taskCarrier(event);
  if (carrier === null) return event;
  const currentOverrides = withoutRetiredFactCloseoutOverride(carrier.task.closeoutOverrides);
  if (currentOverrides === carrier.task.closeoutOverrides) return event;
  const task = Object.fromEntries(Object.entries(carrier.task).filter(([key]) => key !== "closeoutOverrides"));
  return carrier.replace({
    ...task,
    ...(currentOverrides === undefined ? {} : { closeoutOverrides: currentOverrides }),
  });
}
