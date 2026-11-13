import { factEventTypes } from "./fact-event.ts";
import { decisionEventTypes } from "./decision-event-types.ts";
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
    | "sqlite-database"
    | "postgres-table"
    | "postgres-database"
    | "filesystem-store"
    | "canonical-event"
    | "shared-cache"
    | "host-operational";
  readonly recordSchema?: string;
  readonly table?: string;
  readonly module?: string;
  readonly tables?: readonly string[];
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
  ownerWriter: string | readonly string[],
  vocabulary: readonly string[] = [],
  types: readonly string[] = ["*"],
): StateStoreDeclaration =>
  freeze({
    id,
    role: "authority",
    residency: "canonical",
    medium: freeze({
      kind: "canonical-event",
      schema,
      types: freeze([...types]),
      writers: freeze([...(Array.isArray(ownerWriter) ? ownerWriter : [ownerWriter])]),
    }),
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

// Source-bound physical storage declarations. A marker must match its entity owner, module, and medium.
const physicalSourceStoreRows = Object.freeze([
  // Existing local files are owned here; registration changes no on-disk layout.
  {
    owner: "execution",
    id: "execution.dispatch-stream",
    module: "packages/daemon/src/dispatch-stream.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "execution",
    id: "execution.dispatch-stream-archive",
    module: "packages/daemon/src/dispatch-stream-archive.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "execution",
    id: "execution.dispatch-stream-compaction",
    module: "packages/daemon/src/dispatch-stream-compaction.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "execution",
    id: "execution.worktree-binding",
    module: "packages/daemon/src/task-worktree.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "runtime-instance",
    id: "runtime-instance.access-admin",
    module: "packages/daemon/src/access-admin-state.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "runtime-instance",
    id: "runtime-instance.provider-home",
    module: "packages/daemon/src/agent-runtime-instance-storage.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "runtime-instance",
    id: "runtime-instance.store",
    module: "packages/daemon/src/agent-runtime-instance-store.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "runtime-instance",
    id: "runtime-instance.daemon-stopped-marker",
    module: "packages/daemon/src/client/daemon-autostart.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "host-local",
  },
  {
    owner: "runtime-instance",
    id: "runtime-instance.daemon-singleton",
    module: "packages/daemon/src/daemon-singleton.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "host-local",
  },
  {
    owner: "runtime-instance",
    id: "runtime-instance.oidc-center-selection",
    module: "packages/daemon/src/oidc-center-selection.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "runtime-instance",
    id: "runtime-instance.provider-health",
    module: "packages/daemon/src/runtime-provider-health.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "script-execution",
    id: "script-execution.skill-eval-catalog",
    module: "packages/daemon/src/skill-eval-production.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "document",
    id: "document.route-owned-worktree-repair",
    module: "packages/daemon/src/doc-sync-candidate-scanner.ts",
    kind: "filesystem-store",
    role: "projection",
    residency: "runtime-local",
    projectionRead: {
      kind: "document",
      store: "document.events",
      cursor: "revision",
      reader: "scanDocCandidates",
    },
  },
  {
    owner: "document",
    id: "document.claim-recycle",
    module: "packages/daemon/src/doc-sync-details.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "document",
    id: "document.fleet-edge-content",
    module: "packages/daemon/src/fleet-edge-content.ts",
    kind: "filesystem-store",
    role: "projection",
    residency: "runtime-local",
    projectionRead: {
      kind: "document",
      store: "document.events",
      cursor: "revision",
      reader: "readFleetDocContentMetadata",
    },
  },
  {
    owner: "task",
    id: "task.replica-view-relocation",
    module: "packages/daemon/src/fleet-edge-workspace-migration.ts",
    kind: "filesystem-store",
    role: "projection",
    residency: "runtime-local",
    projectionRead: {
      kind: "task",
      store: "task.task-events",
      cursor: "revision",
      reader: "readReplicaGeneration",
    },
  },
  {
    owner: "document",
    id: "document.fleet-claim-cleanup",
    module: "packages/daemon/src/fleet/center-lease-claims.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "document",
    id: "document.fleet-upload-staging",
    module: "packages/daemon/src/fleet/center-listener.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "task",
    id: "task.replica-generation",
    module: "packages/daemon/src/fleet/replica-generation.ts",
    kind: "filesystem-store",
    role: "projection",
    residency: "runtime-local",
    projectionRead: {
      kind: "task",
      store: "task.task-events",
      cursor: "revision",
      reader: "readReplicaGeneration",
    },
  },
  {
    owner: "task",
    id: "task.replica-wal-objects",
    module: "packages/daemon/src/fleet/walreceiver.ts",
    kind: "filesystem-store",
    role: "projection",
    residency: "runtime-local",
    projectionRead: {
      kind: "task",
      store: "task.task-events",
      cursor: "revision",
      reader: "openWalReceiverGeneration",
    },
  },
  {
    owner: "fact",
    id: "fact.distill-candidates",
    module: "packages/daemon/src/repo-cell-errors.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "execution",
    id: "execution.workspace-writer-lock",
    module: "packages/daemon/src/repo-cell-lock.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
  },
  {
    owner: "runtime-instance",
    id: "runtime-instance.daemon-pid",
    module: "packages/daemon/src/runtime.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "host-local",
  },
  {
    owner: "runtime-instance",
    id: "runtime-instance.builtin-identity",
    module: "packages/authorization-builtin/src/state.ts",
    kind: "filesystem-store",
    role: "authority",
  },
  {
    owner: "script-execution",
    id: "script-execution.runs",
    module: "packages/preset/src/preset-process-service.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "runtime-local",
    vocabulary: ["PresetRun.outcome", "PresetRun.phase"],
  },
  {
    owner: "document",
    id: "document.local-edits",
    module: "packages/gui/src/main/local-doc-ipc.ts",
    kind: "filesystem-store",
    role: "authority",
    residency: "host-local",
  },
  {
    owner: "document",
    id: "document.artifact-cache",
    module: "packages/gui/src/main/artifact-open-ipc.ts",
    kind: "filesystem-store",
    role: "projection",
    residency: "host-local",
    projectionRead: {
      kind: "document",
      store: "document.events",
      cursor: "generation",
      reader: "openMaterializedCopy",
    },
  },
  {
    owner: "document",
    id: "document.fleet-read",
    module: "packages/cli/src/index.ts",
    kind: "filesystem-store",
    role: "projection",
    residency: "runtime-local",
    projectionRead: { kind: "document", store: "document.events", cursor: "revision", reader: "streamDocumentFile" },
  },
  {
    owner: "task",
    id: "task.backup-sqlite",
    module: "packages/storage/src/fleet-basebackup-worker.ts",
    kind: "filesystem-store",
    role: "projection",
    residency: "runtime-local",
    projectionRead: { kind: "task", store: "task.task-events", cursor: "revision", reader: "startBaseBackup" },
  },
  {
    owner: "task",
    id: "task.backup-postgres",
    module: "packages/storage/src/postgres/pg-basebackup.ts",
    kind: "filesystem-store",
    role: "projection",
    residency: "runtime-local",
    projectionRead: { kind: "task", store: "task.task-events", cursor: "revision", reader: "prepareSqlBaseBackup" },
  },
  {
    owner: "task",
    id: "task.replica-seed",
    module: "packages/storage/src/fleet-replica-seed.ts",
    kind: "sqlite-database",
    role: "projection",
    residency: "runtime-local",
    tables: [],
    projectionRead: { kind: "task", store: "task.task-events", cursor: "revision", reader: "hydrateReplicaSeed" },
  },
  // The exclusive physical-writer claim is execution state, not host process liveness.
  // The rowless SQLite sidecar retains its inode and OS lock for the owner's lifetime.
  {
    owner: "execution",
    id: "execution.pglite-directory",
    module: "packages/storage/src/pglite/data-dir-mutex.ts",
    kind: "filesystem-store",
    role: "authority",
  },
  {
    owner: "execution",
    id: "execution.pglite-owner",
    module: "packages/storage/src/pglite/data-dir-mutex.ts",
    kind: "sqlite-database",
    role: "authority",
    tables: [],
  },
  {
    owner: "runtime-instance",
    module: "packages/kernel/src/daemon/registry.ts",
    kind: "filesystem-store",
    role: "authority",
  },
  {
    owner: "document",
    module: "packages/kernel/src/local/local-layout-file-system.ts",
    kind: "filesystem-store",
    role: "authority",
  },
  {
    owner: "document",
    module: "packages/storage/src/canonical-tree-materialization.ts",
    kind: "filesystem-store",
    role: "authority",
  },
  { owner: "document", module: "packages/storage/src/durable-file.ts", kind: "filesystem-store", role: "authority" },
  {
    owner: "execution",
    module: "packages/storage/src/fleet-replica-delivery-lease.ts",
    kind: "sqlite-database",
    role: "authority",
    tables: ["delivery_lease", "delivery_metrics"],
  },
  {
    owner: "execution",
    module: "packages/storage/src/fleet-replication-slot.ts",
    kind: "filesystem-store",
    role: "authority",
  },
  {
    owner: "execution",
    module: "packages/storage/src/fleet-replication-slot.ts",
    kind: "sqlite-database",
    role: "authority",
    tables: ["replication_slot"],
  },
  {
    owner: "migration",
    module: "packages/storage/src/migration/engine.ts",
    kind: "filesystem-store",
    role: "authority",
  },
  {
    owner: "migration",
    module: "packages/storage/src/migration/postgres-grant.ts",
    kind: "postgres-database",
    role: "authority",
    tables: ["ha_migration_grants"],
  },
  {
    owner: "migration",
    module: "packages/storage/src/migration/postgres-projection-audit.ts",
    kind: "postgres-database",
    role: "authority",
    tables: ["${schema}.ha_events", "${schema}.ha_event_entity_refs"],
  },
  {
    owner: "migration",
    module: "packages/storage/src/migration/postgres-schema.ts",
    kind: "postgres-database",
    role: "authority",
    tables: ["ha_repo_writer_epochs"],
  },
  {
    owner: "migration",
    module: "packages/storage/src/migration/projection.ts",
    kind: "filesystem-store",
    role: "authority",
  },
  {
    owner: "migration",
    module: "packages/storage/src/migration/sqlite-control.ts",
    kind: "sqlite-database",
    role: "authority",
    tables: ["storage_migration_control", "storage_migration_scope", "storage_activation_markers"],
  },
  {
    owner: "migration",
    module: "packages/storage/src/migration/sqlite-endpoint.ts",
    kind: "sqlite-database",
    role: "authority",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/pg/pg-text-search.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: ["search", "input", "tokens"],
  },
  {
    owner: "task",
    module: "packages/storage/src/postgres/event-ledger-schema.ts",
    kind: "postgres-database",
    role: "authority",
    tables: [
      "ha_event_entity_refs",
      "ha_repo_heads",
      "ha_events",
      "ha_command_outcomes",
      "ha_content_blobs",
      "ha_document_heads",
      "ha_replication_positions",
      "ha_replication_slots",
      "ha_repo_sync_watermarks",
    ],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/decision-projection-reads.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/decision-projection-reducer.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/decision-projection-schema.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/fact-event-projection.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/projection-tables.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/rebuildable-task-projection-database.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/rebuildable-task-projection-event-application.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/rebuildable-task-projection-reads.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/rebuildable-task-projection-runtime-api.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/rebuildable-task-projection-runtime.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/rebuildable-task-projection-sql.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/rebuildable-task-projection-task-queries.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/rebuildable-task-projection-write-model.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/relation-graph-projection.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/projection/task-query-projection.ts",
    kind: "sqlite-database",
    role: "projection",
    tables: [],
  },
  {
    owner: "task",
    module: "packages/storage/src/store/local-version-control-system.ts",
    kind: "filesystem-store",
    role: "authority",
  },
  {
    owner: "task",
    module: "packages/storage/src/store/replication-log.ts",
    kind: "sqlite-database",
    role: "authority",
    tables: ["replication_state", "replication_log"],
  },
  {
    owner: "task",
    module: "packages/storage/src/store/sqlite-entity-declarations.ts",
    kind: "sqlite-database",
    role: "authority",
    tables: ["entity_declaration_head", "entity_declaration_meta"],
  },
  {
    owner: "task",
    module: "packages/storage/src/store/sqlite-event-store.ts",
    kind: "sqlite-database",
    role: "authority",
    tables: [
      "ledger_meta",
      "event",
      "event_query_entity",
      "event_query_meta",
      "document_head",
      "document_head_meta",
      "attach_migration_scan_meta",
      "command_outcome",
      "writer_lease",
      "lease_cas",
      "lease_interval",
    ],
  },
  { owner: "execution", module: "packages/storage/src/writer-epoch.ts", kind: "filesystem-store", role: "authority" },
  {
    owner: "execution",
    module: "packages/storage/src/writer-epoch.ts",
    kind: "sqlite-database",
    role: "authority",
    tables: ["writer_epoch_history", "writer_epochs"],
  },
]);
const physicalSourceStores: readonly { readonly owner: string; readonly store: StateStoreDeclaration }[] =
  Object.freeze(
    physicalSourceStoreRows.map((row) => {
      const { owner, module, kind, role } = row;
      const id = ("id" in row ? row.id : undefined) ?? moduleStoreId(owner, module, kind);
      const projectionStore = role === "projection";
      const stateRole = role as StateStoreRole;
      const residency = (
        "residency" in row
          ? row.residency
          : owner === "execution" || owner === "runtime-instance"
            ? "runtime-local"
            : "canonical"
      ) as StateStoreResidency;
      const read = "projectionRead" in row ? row.projectionRead : undefined;
      const medium: StateStoreMedium = {
        kind: kind as StateStoreMedium["kind"],
        module,
        ...("tables" in row ? { tables: freeze(row.tables) } : {}),
      };
      const store: StateStoreDeclaration = {
        id,
        role: stateRole,
        residency,
        medium: freeze(medium),
        vocabulary: freeze(("vocabulary" in row ? row.vocabulary : undefined) ?? []),
        ...(projectionStore
          ? {
              source: freeze({ kind: read?.kind ?? "task", store: read?.store ?? "task.task-events" }),
              freshness: freeze({ cursor: (read?.cursor ?? "revision") as StateStoreFreshnessCursor }),
              invalidation: read ? "fence-on-read" : "rebuild-on-start",
              reader: read?.reader ?? "readTaskProjection",
            }
          : {}),
      };
      return freeze({ owner, store: freeze(store) });
    }),
  );
function moduleStoreId(owner: string, module: string, kind: string): string {
  const slug = module
    .replace(/^packages\//u, "")
    .replace(/\.[cm]?[jt]sx?$/u, "")
    .replaceAll("/", ".");
  return `${owner}.source.${slug}.${kind}`;
}
function physicalStoresForKind(kind: string): readonly StateStoreDeclaration[] {
  return physicalSourceStores.filter((entry) => entry.owner === kind).map((entry) => entry.store);
}

const storesByKind: Readonly<Record<string, readonly StateStoreDeclaration[]>> = {
  task: [
    ...physicalStoresForKind("task"),
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
  fact: [
    ...physicalStoresForKind("fact"),
    canonical(
      "fact.events",
      "fact-event/v1",
      "packages/kernel/src/domain/fact-event.ts",
      ["fact.state"],
      factEventTypes,
    ),
  ],
  decision: [
    canonical(
      "decision.events",
      "decision-event/v1",
      "packages/kernel/src/domain/decision-event.ts",
      ["decision.state"],
      decisionEventTypes,
    ),
  ],
  relation: [
    canonical("relation.events", "relation-event/v1", "packages/kernel/src/domain/relation-event.ts", [
      "relation.state",
    ]),
  ],
  todo: [canonical("todo.entity-events", "entity-event/v1", "packages/kernel/src/domain/entity-event-compile.ts")],
  agent: [
    canonical("agent.entity-events", "agent-entity-event/v1", "packages/kernel/src/domain/entity-event.ts"),
    canonical("agent.people-events", "people-event/v1", "packages/kernel/src/domain/people-event.ts"),
  ],
  execution: [
    ...physicalStoresForKind("execution"),
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
    canonical("runtime-session.events", "agent-runtime-event/v1", "packages/kernel/src/domain/agent-runtime-event.ts"),
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
    ...physicalStoresForKind("document"),
    canonical("document.events", "doc-event/v1", "packages/kernel/src/domain/doc-sync-writer.ts"),
    canonical(
      "document.entity-events",
      "entity-document-event/v1",
      "packages/kernel/src/domain/entity-document-event.ts",
    ),
  ],
  migration: [
    ...physicalStoresForKind("migration"),
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
  "script-execution": physicalStoresForKind("script-execution"),
  "vertical-declaration": [
    canonical(
      "vertical-declaration.events",
      "vertical-declaration-event/v1",
      "packages/kernel/src/domain/vertical-declaration.ts",
    ),
  ],
  "runtime-instance": [
    ...physicalStoresForKind("runtime-instance"),
    freeze({
      id: "runtime-instance.authorization-configuration",
      role: "authority",
      residency: "runtime-local",
      medium: freeze({ kind: "journal", recordSchema: "harness-managed-rbac/v1" }),
      vocabulary: freeze([]),
    }),
    freeze({
      id: "runtime-instance.authorization-session",
      role: "authority",
      residency: "runtime-local",
      medium: freeze({ kind: "journal", recordSchema: "harness-oidc-session/v3" }),
      vocabulary: freeze([]),
    }),
    canonical("runtime-instance.pin-events", "entity-pin-event/v1", "packages/kernel/src/domain/entity-pin-event.ts"),
  ],
  host: hostStateStores,
};

export function stateStoresForKind(kind: EntityKind | string): readonly StateStoreDeclaration[] {
  return freeze([...(storesByKind[kind] ?? [])]);
}
