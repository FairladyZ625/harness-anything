import { validateCurrentEntityEvent, validateEntityEvent } from "./entity-event.ts";
import { validateCiRunObservationEvent, validateCurrentCiRunObservationEvent } from "./ci-run-observation-event.ts";
import { validateAgentRuntimeEvent, validateCurrentAgentRuntimeEvent } from "./agent-runtime.ts";
import { validateCurrentDecisionEvent, validateDecisionEvent } from "./decision-event.ts";
import type { CanonicalEventV1, DocEventV1 } from "./doc-sync-types.ts";
import { validateCurrentDocEvent } from "./doc-sync-validation.ts";
import { validateCurrentFactEvent, validateFactEvent } from "./fact-event.ts";
import {
  validateCurrentLedgerLayoutMigrationEvent,
  validateLedgerLayoutMigrationEvent,
} from "./ledger-layout-migration-event.ts";
import { validateCurrentMigrationImportEvent, validateMigrationImportEvent } from "./migration-import-event.ts";
import {
  validateCurrentPresetSnapshotUpgradeEvent,
  validatePresetSnapshotUpgradeEvent,
} from "./preset-snapshot-upgrade-event.ts";
import { validateCurrentTaskBootstrapEvent, validateTaskBootstrapEvent } from "./task-bootstrap-event.ts";
import { validateCurrentTaskEvent, validateTaskEvent, type TaskEventV1 } from "./task-lifecycle-event.ts";
import { validateCurrentTaskProgressEvent, validateTaskProgressEvent } from "./task-progress-event.ts";
import { validateCurrentScheduleEvent, validateScheduleEvent } from "./schedule-event.ts";
import { validateCurrentSettingsEvent, validateSettingsEvent } from "./settings-event.ts";
import { validateCurrentPeopleEvent, validatePeopleEvent } from "./people-event.ts";
import { canonicalizeWriteValue, isRecord } from "./write-chain.contract.ts";
import { normalizePersistedTimestamp } from "./timestamp.ts";

interface CanonicalEventSchemaRegistration {
  readonly schema: string;
  readonly validate: (value: unknown) => readonly string[];
  readonly validateCurrent?: (value: unknown) => readonly string[];
}

export const canonicalEventSchemas: readonly CanonicalEventSchemaRegistration[] = Object.freeze([
  {
    schema: "ci-run-observation/v1",
    validate: validateCiRunObservationEvent,
    validateCurrent: validateCurrentCiRunObservationEvent,
  },
  {
    schema: "task-event/v1",
    validate: (value: unknown) => validateTaskEvent(value).map((issue) => issue.message),
    validateCurrent: (value: unknown) => validateCurrentTaskEvent(value).map((issue) => issue.message),
  },
  {
    schema: "doc-event/v1",
    validate: validateDocEvent,
    validateCurrent: validateCurrentDocEvent,
  },
  {
    schema: "agent-runtime-event/v1",
    validate: validateAgentRuntimeEvent,
    validateCurrent: validateCurrentAgentRuntimeEvent,
  },
  {
    schema: "schedule-event/v1",
    validate: validateScheduleEvent,
    validateCurrent: validateCurrentScheduleEvent,
  },
  {
    schema: "settings-event/v1",
    validate: validateSettingsEvent,
    validateCurrent: validateCurrentSettingsEvent,
  },
  {
    schema: "people-event/v1",
    validate: validatePeopleEvent,
    validateCurrent: validateCurrentPeopleEvent,
  },
  {
    schema: "task-bootstrap-event/v1",
    validate: validateTaskBootstrapEvent,
    validateCurrent: validateCurrentTaskBootstrapEvent,
  },
  {
    schema: "task-progress-event/v1",
    validate: validateTaskProgressEvent,
    validateCurrent: validateCurrentTaskProgressEvent,
  },
  {
    schema: "preset-snapshot-upgrade-event/v1",
    validate: validatePresetSnapshotUpgradeEvent,
    validateCurrent: validateCurrentPresetSnapshotUpgradeEvent,
  },
  {
    schema: "entity-event/v1",
    validate: validateEntityEvent,
    validateCurrent: validateCurrentEntityEvent,
  },
  {
    schema: "agent-entity-event/v1",
    validate: validateEntityEvent,
  },
  {
    schema: "fact-event/v1",
    validate: validateFactEvent,
    validateCurrent: validateCurrentFactEvent,
  },
  {
    schema: "decision-event/v1",
    validate: validateDecisionEvent,
    validateCurrent: validateCurrentDecisionEvent,
  },
  {
    schema: "migration-import-event/v1",
    validate: validateMigrationImportEvent,
    validateCurrent: validateCurrentMigrationImportEvent,
  },
  {
    schema: "ledger-layout-event/v1",
    validate: validateLedgerLayoutMigrationEvent,
    validateCurrent: validateCurrentLedgerLayoutMigrationEvent,
  },
] as const);

import { validateDocEvent } from "./doc-sync-validation.ts";

export function validateCurrentCanonicalEvent(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["canonical event is not an object"];
  const entry = canonicalEventSchemas.find((candidate) => candidate.schema === value.schema);
  return entry?.validateCurrent?.(value) ?? ["canonical event schema is unknown or not current"];
}

export function serializeCanonicalEvent(event: CanonicalEventV1): string {
  const entry = canonicalEventSchemas.find((candidate) => candidate.schema === event.schema);
  const errors = entry?.validate(event) ?? ["canonical event schema is unknown"];
  if (errors.length) throw new Error(errors.join("; "));
  return canonicalEventBytes(event);
}

export function serializePersistedCanonicalEvent(event: CanonicalEventV1): string {
  const normalized = normalizePersistedCanonicalEvent(event),
    entry = canonicalEventSchemas.find((candidate) => candidate.schema === normalized.schema),
    candidate =
      entry?.schema === "fact-event/v1" ? (normalizeHistoricalFactEvent(normalized) ?? normalized) : normalized,
    errors = entry?.validate(candidate) ?? ["canonical event schema is unknown"];
  if (errors.length) throw new Error(errors.join("; "));
  return canonicalEventBytes(event);
}

export function parseCanonicalEvent(body: string): CanonicalEventV1 {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("canonical event is not JSON");
  }
  if (!isRecord(value)) throw new Error("canonical event is not an object");
  const normalized = normalizePersistedCanonicalEvent(value as unknown as CanonicalEventV1),
    entry = canonicalEventSchemas.find((candidate) => candidate.schema === normalized.schema),
    historical = entry?.schema === "fact-event/v1" ? normalizeHistoricalFactEvent(normalized) : null,
    candidate = historical ?? normalized,
    errors = entry?.validate(candidate) ?? ["canonical event schema is unknown"];
  if (errors.length) throw new Error(errors.join("; "));
  if (canonicalEventBytes(value as unknown as CanonicalEventV1) !== body)
    throw new Error("canonical event bytes are not canonical");
  return value as unknown as CanonicalEventV1;
}

/**
 * Pre-fact-first-class events used task-scoped supersedes refs. Keep this
 * normalization in the immutable historical reader so current validation and
 * writers remain canonical-only; migration can then replay and rewrite those
 * events without widening the fact contract.
 */
function normalizeHistoricalFactEvent(value: CanonicalEventV1): CanonicalEventV1 | null {
  if (value.schema !== "fact-event/v1" || !isRecord(value.payload) || !isRecord(value.payload.supersedes)) return null;
  const superseded = /^fact\/[^/]+\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(value.payload.supersedes.factRef);
  return superseded
    ? ({
        ...value,
        payload: {
          ...value.payload,
          supersedes: { ...value.payload.supersedes, factRef: `fact/${superseded[1]}` },
        },
      } as CanonicalEventV1)
    : null;
}

export function normalizePersistedCanonicalEvent(event: CanonicalEventV1): CanonicalEventV1 {
  return normalizeTimestampFields(event) as CanonicalEventV1;
}

function normalizeTimestampFields(value: unknown, field = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeTimestampFields(entry));
  if (!isRecord(value)) {
    const normalized = /At$/u.test(field) ? normalizePersistedTimestamp(value) : null;
    return normalized ?? value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizeTimestampFields(nested, key)]));
}

function canonicalEventBytes(event: CanonicalEventV1): string {
  return `${JSON.stringify(canonicalizeWriteValue(event))}\n`;
}

export function isTaskEvent(event: CanonicalEventV1): event is TaskEventV1 {
  return event.schema === "task-event/v1";
}

export function isDocEvent(event: CanonicalEventV1): event is DocEventV1 {
  return event.schema === "doc-event/v1";
}
