import type { EntityKind } from "./base-entity.ts";
import { scheduleEventTypes } from "./schedule.ts";
import { taskEventTypes as canonicalTaskEventTypes } from "./task-lifecycle-event.ts";

export type StateStoreRole = "authority" | "replica" | "projection" | "spool" | "operational";
export type StateStoreResidency = "canonical" | "runtime-local" | "host-local";
export type StateStoreFreshnessCursor = "revision" | "watermark" | "generation" | "none";

export interface StateStoreSource {
  readonly kind: string;
  readonly store: string;
}

export interface StateStoreMedium {
  readonly kind: "journal" | "sqlite-table" | "canonical-event" | "shared-cache" | "host-operational";
  readonly recordSchema?: string;
  readonly table?: string;
  readonly schema?: string;
  readonly types?: readonly string[];
  readonly payloadField?: string;
  readonly writers?: readonly string[];
  readonly adapter?: string;
  readonly purpose?: "process-lock" | "diagnostic-log";
}

export interface StateStoreDeclaration {
  readonly id: string;
  readonly role: StateStoreRole;
  readonly residency: StateStoreResidency;
  readonly medium: StateStoreMedium;
  readonly vocabulary: readonly string[];
  readonly source?: StateStoreSource;
  readonly freshness?: { readonly cursor: StateStoreFreshnessCursor };
  readonly invalidation?: "event-push" | "fence-on-read" | "rebuild-on-start" | `ttl:${number}`;
  readonly reader?: string;
  readonly purpose?: "process-lock" | "diagnostic-log";
  readonly writerApi?: "withHostProcessLock" | "appendHostDiagnostic";
  readonly projection?: {
    readonly payloadField: string;
    readonly types: readonly string[];
  };
}

const freeze = <T>(value: T): T => Object.freeze(value);

const canonical = (
  id: string,
  schema: string,
  ownerWriter: string,
  vocabulary: readonly string[] = [],
  types: readonly string[] = ["*"],
): StateStoreDeclaration =>
  freeze({
    id,
    role: "authority",
    residency: "canonical",
    medium: freeze({ kind: "canonical-event", schema, types: freeze([...types]), writers: [ownerWriter] }),
    vocabulary: freeze([...vocabulary]),
  });

const projection = (
  id: string,
  ownerKind: string,
  sourceStore: string,
  schema: string,
  payloadField: string,
  types: readonly string[],
): StateStoreDeclaration =>
  freeze({
    id,
    role: "projection",
    residency: "canonical",
    medium: freeze({ kind: "canonical-event", schema, types: freeze([...types]), payloadField }),
    vocabulary: freeze([]),
    source: freeze({ kind: ownerKind, store: sourceStore }),
    freshness: freeze({ cursor: "revision" }),
    invalidation: "event-push",
    reader: `read${ownerKind[0]!.toUpperCase()}${ownerKind.slice(1).replaceAll("-", "")}Projection`,
    projection: freeze({ payloadField, types: freeze([...types]) }),
  });

const taskProjectionEventTypes = [
  "execution_started",
  "lease_renewed",
  "execution_submitted",
  "submission_forwarded",
  "submission_returned",
  "execution_executor_declared",
  "execution_annotated",
  "review_recorded",
  "task_review_responded",
  "review_consent_recorded",
  "completion_gate_verified",
  "gate_run_changed",
  "task_completion_generation_retired",
  "task_completed",
  "lease_released",
] as const;

export const hostStateStores: readonly StateStoreDeclaration[] = freeze([
  freeze({
    id: "host.process-lock",
    role: "operational",
    purpose: "process-lock",
    residency: "host-local",
    medium: freeze({ kind: "host-operational", recordSchema: "host-process-lock/v1", purpose: "process-lock" }),
    vocabulary: freeze([]),
    writerApi: "withHostProcessLock",
  }),
  freeze({
    id: "host.diagnostic-log",
    role: "operational",
    purpose: "diagnostic-log",
    residency: "host-local",
    medium: freeze({ kind: "host-operational", recordSchema: "host-diagnostic-line/v1", purpose: "diagnostic-log" }),
    vocabulary: freeze([]),
    writerApi: "appendHostDiagnostic",
  }),
]);

const storesByKind: Readonly<Record<string, readonly StateStoreDeclaration[]>> = {
  task: [
    canonical(
      "task.task-events",
      "task-event/v1",
      "packages/kernel/src/domain/task-lifecycle-event.ts",
      [],
      canonicalTaskEventTypes,
    ),
    canonical("task.bootstrap-events", "task-bootstrap-event/v1", "packages/kernel/src/domain/task-bootstrap-event.ts"),
    canonical("task.progress-events", "task-progress-event/v1", "packages/kernel/src/domain/task-progress-event.ts"),
    canonical("task.preset-snapshot-events", "preset-snapshot-upgrade-event/v1", "packages/preset/src"),
  ],
  fact: [canonical("fact.events", "fact-event/v1", "packages/kernel/src/domain/fact-event.ts", ["fact.state"])],
  decision: [
    canonical("decision.events", "decision-event/v1", "packages/kernel/src/domain/decision-event.ts", [
      "decision.state",
    ]),
  ],
  relation: [
    canonical("relation.events", "relation-event/v1", "packages/kernel/src/domain/relation-event.ts", [
      "relation.state",
    ]),
  ],
  todo: [canonical("todo.entity-events", "entity-event/v1", "packages/kernel/src/domain/entity-event.ts")],
  agent: [
    canonical("agent.entity-events", "agent-entity-event/v1", "packages/kernel/src/domain/entity-event.ts"),
    canonical("agent.people-events", "people-event/v1", "packages/kernel/src/domain/people-event.ts"),
  ],
  execution: [
    canonical(
      "execution.delegation-events",
      "execution-delegation-event/v1",
      "packages/kernel/src/domain/execution-delegation-event.ts",
    ),
    canonical(
      "execution.ci-observation-v2",
      "ci-run-observation/v2",
      "packages/kernel/src/domain/ci-run-observation-event.ts",
    ),
    canonical(
      "execution.ci-observation-v1",
      "ci-run-observation/v1",
      "packages/kernel/src/domain/ci-run-observation-event.ts",
    ),
    canonical(
      "execution.ci-observation-v3",
      "ci-run-observation/v3",
      "packages/kernel/src/domain/ci-run-observation-event.ts",
    ),
    canonical(
      "execution.ci-observation-v4",
      "ci-run-observation/v4",
      "packages/kernel/src/domain/ci-run-observation-v4.ts",
    ),
    projection(
      "execution.task-events",
      "task",
      "task.task-events",
      "task-event/v1",
      "execution",
      taskProjectionEventTypes,
    ),
  ],
  review: [
    projection("review.task-events", "task", "task.task-events", "task-event/v1", "review", [
      "review_recorded",
      "review_consent_recorded",
    ]),
  ],
  "runtime-session": [
    canonical("runtime-session.events", "agent-runtime-event/v1", "packages/kernel/src/domain/agent-runtime.ts"),
  ],
  schedule: [
    canonical("schedule.events", "schedule-event/v1", "packages/kernel/src/domain/schedule-event.ts", [
      "schedule.state",
    ]),
    projection(
      "schedule.schedule-events",
      "schedule",
      "schedule.events",
      "schedule-event/v1",
      "schedule",
      scheduleEventTypes,
    ),
  ],
  settings: [
    canonical("settings.events", "settings-event/v1", "packages/kernel/src/domain/settings-event.ts", [
      "settings.state",
    ]),
    projection("settings.settings-events", "settings", "settings.events", "settings-event/v1", "settings", [
      "settings_changed",
    ]),
  ],
  document: [
    canonical("document.events", "doc-event/v1", "packages/kernel/src/domain/doc-sync-types.ts"),
    canonical(
      "document.entity-events",
      "entity-document-event/v1",
      "packages/kernel/src/domain/entity-document-event.ts",
    ),
  ],
  migration: [
    canonical(
      "migration.import-events",
      "migration-import-event/v1",
      "packages/kernel/src/domain/migration-import-event.ts",
    ),
    canonical(
      "migration.layout-events",
      "ledger-layout-event/v1",
      "packages/kernel/src/domain/ledger-layout-migration-event.ts",
    ),
    canonical(
      "migration.shape-events",
      "event-shape-migration/v1",
      "packages/kernel/src/domain/event-shape-migration-event.ts",
    ),
  ],
  "vertical-declaration": [
    canonical(
      "vertical-declaration.events",
      "vertical-declaration-event/v1",
      "packages/kernel/src/domain/vertical-declaration.ts",
    ),
  ],
  "runtime-instance": [
    canonical("runtime-instance.pin-events", "entity-pin-event/v1", "packages/kernel/src/domain/entity-pin-event.ts"),
  ],
  host: hostStateStores,
};

export function stateStoresForKind(kind: EntityKind | string): readonly StateStoreDeclaration[] {
  return freeze([...(storesByKind[kind] ?? [])]);
}
