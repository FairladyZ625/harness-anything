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
  readonly kind:
    | "journal"
    | "sqlite-table"
    | "postgres-table"
    | "canonical-event"
    | "shared-cache"
    | "host-operational";
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

const projectionTable = (
  table: string,
  medium: "sqlite-table" | "postgres-table" = "sqlite-table",
): StateStoreDeclaration =>
  freeze({
    id: `task.projection.${table}`,
    role: "projection",
    residency: "canonical",
    medium: freeze({ kind: medium, table }),
    vocabulary: freeze([]),
    source: freeze({ kind: "task", store: "task.task-events" }),
    freshness: freeze({ cursor: "revision" }),
    invalidation: "rebuild-on-start",
    reader: "readTaskProjection",
  });

// Projection tables are disposable views of the task event authority. Keeping their
// ownership beside the event store prevents a second hand-written table registry.
const taskProjectionTables = Object.freeze(
  [
    "artifact_document",
    "artifact_count",
    "decision",
    "decision_option",
    "decision_claim",
    "decision_judgment_consent",
    "decision_amendment",
    "decision_content_pin",
    "decision_review_event",
    "decision_fts",
    "dispatch_lifecycle_group",
    "dispatch_lifecycle_attempt",
    "dispatch_lifecycle_task_lease",
    "dispatch_lifecycle_cursor",
    "fact",
    "fact_fts",
    "fact_domain_type",
    "fact_reclassification",
    "task_snapshot",
    "task_package",
    "artifact_entity_state",
    "event_summary",
    "event_summary_entity_ref",
    "runtime_installation",
    "runtime_session",
    "runtime_session_task_binding",
    "squad_run_projection",
    "pinned_entities",
    "lease_interval",
    "event_index",
    "archived_entity",
    "projection_meta",
    "event_source",
    "document",
    "preset_snapshot",
    "task_generation",
    "task_progress",
    "entity_projection",
    "edge",
    "lease_cas",
    "projection_maintenance",
    "relation_cycle_edge",
    "relation_cycle_count",
    "relation_cycle_dirty",
    "relation_cycle_component",
    "relation_cycle_member",
    "relation_cycle_result",
    "relation_freshness_dirty",
    "relation_edge",
    "task_relation",
    "workspace_task_census",
  ].map((table) => projectionTable(table)),
);

const postgresProjectionTables = Object.freeze(
  [
    "ha_task_snapshots",
    "ha_decisions",
    "ha_decision_read_status",
    "ha_search_terms",
    "ha_decision_positions",
    "ha_facts",
    "ha_relations",
    "ha_agents",
    "ha_squads",
    "ha_projection_meta",
    "ha_projection_values",
    "ha_runtime_session_tasks",
    "ha_runtime_unsettled",
    "ha_event_summary_state",
    "ha_entity_declaration_heads",
    "ha_artifact_documents",
    "ha_artifact_counts",
    "ha_relation_freshness_dirty",
  ].map((table) => projectionTable(table, "postgres-table")),
);

const storesByKind: Readonly<Record<string, readonly StateStoreDeclaration[]>> = {
  task: [
    ...taskProjectionTables,
    ...postgresProjectionTables,
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
