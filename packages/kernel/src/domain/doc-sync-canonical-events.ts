import { validateCurrentEntityEvent, validateEntityEvent } from "./entity-event.ts";
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
import { validateCurrentTaskEvent, validateTaskEvent, type TaskEventV1 } from "./task-lifecycle.contract.ts";
import { validateCurrentTaskProgressEvent, validateTaskProgressEvent } from "./task-progress-event.ts";
import { canonicalizeWriteValue, isRecord } from "./write-chain.contract.ts";

export const canonicalEventSchemas = Object.freeze([
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
  return entry?.validateCurrent(value) ?? ["canonical event schema is unknown"];
}

export function serializeCanonicalEvent(event: CanonicalEventV1): string {
  const entry = canonicalEventSchemas.find((candidate) => candidate.schema === event.schema);
  const errors = entry?.validate(event) ?? ["canonical event schema is unknown"];
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(canonicalizeWriteValue(event))}\n`;
}

export function parseCanonicalEvent(body: string): CanonicalEventV1 {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("canonical event is not JSON");
  }
  if (!isRecord(value)) throw new Error("canonical event is not an object");
  const entry = canonicalEventSchemas.find((candidate) => candidate.schema === value.schema);
  const errors = entry?.validate(value) ?? ["canonical event schema is unknown"];
  if (errors.length) throw new Error(errors.join("; "));
  const event = value as unknown as CanonicalEventV1;
  if (serializeCanonicalEvent(event) !== body) throw new Error("canonical event bytes are not canonical");
  return event;
}

export function isTaskEvent(event: CanonicalEventV1): event is TaskEventV1 {
  return event.schema === "task-event/v1";
}

export function isDocEvent(event: CanonicalEventV1): event is DocEventV1 {
  return event.schema === "doc-event/v1";
}
