import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  consumeKnownError,
  resolveHarnessLayout,
  type RelationGraphEdgeRow,
  type MigrationImportEventV1,
  type RuntimeResultClaim,
  type RuntimeSession,
  type ScheduleV1,
} from "../../kernel/src/index.ts";
import { isMigrationImportRecord, migrationImportError, nonEmpty } from "./migration-import-report.ts";
import { inspectMigrationSourceEvents, rebuildMigrationProjectionOracle } from "./migration-import-oracle-rebuild.ts";
import type { MigrationFormatObservation } from "./migration-import-types.ts";

export const migrationOracleKinds = [
  "task",
  "decision",
  "fact",
  "relation",
  "execution",
  "agent",
  "schedule",
  "runtime-session",
] as const;
export type MigrationOracleKind = (typeof migrationOracleKinds)[number];

export interface ProjectionOracleTask {
  readonly taskId: string;
  readonly workspaceRevision: number;
  readonly packagePath: string | null;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly firstEvent: {
    readonly eventId: string;
    readonly occurredAt: string;
    readonly workspaceRevision: number;
  } | null;
}

export interface ProjectionOracleDecision {
  readonly decisionId: string;
  readonly workspaceRevision: number;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly chosen: readonly Readonly<Record<string, unknown>>[];
  readonly rejected: readonly Readonly<Record<string, unknown>>[];
  readonly claims: readonly Readonly<Record<string, unknown>>[];
}

export interface ProjectionOracleFact {
  readonly factId: string;
  readonly workspaceRevision: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ProjectionOracleRelation {
  readonly relationId: string;
  readonly workspaceRevision: number;
  readonly row: RelationGraphEdgeRow;
  readonly originalFields: Readonly<Record<string, unknown>>;
}

export interface ProjectionOracleExecution {
  readonly executionId: string;
  readonly workspaceRevision: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface MigrationSourceAnchor {
  readonly source: string;
  readonly occurredAt: string;
}

export interface ProjectionOracleAgent {
  readonly agentId: string;
  readonly workspaceRevision: number;
  readonly value: Readonly<Record<string, unknown>>;
  readonly sourceAnchor: MigrationSourceAnchor;
}

export interface ProjectionOracleSchedule {
  readonly scheduleId: string;
  readonly workspaceRevision: number;
  readonly value: ScheduleV1;
  readonly sourceAnchor: MigrationSourceAnchor;
}

export interface ProjectionOracleRuntimeSession {
  readonly runtimeSessionId: string;
  readonly workspaceRevision: number;
  readonly value: RuntimeSession;
  readonly startedAt: string;
  readonly sourceAnchor: MigrationSourceAnchor;
  readonly outcome: {
    readonly result: RuntimeResultClaim;
    readonly reasonCode?: string;
  } | null;
}

export interface MigrationProjectionOracle {
  readonly basis: "same-cut-projection" | "rebuilt-source";
  readonly formatObservations: readonly MigrationFormatObservation[];
  readonly databasePath: string;
  readonly watermark: number;
  readonly eventHeadRevision: number | null;
  readonly tasks: ReadonlyMap<string, ProjectionOracleTask>;
  readonly decisions: ReadonlyMap<string, ProjectionOracleDecision>;
  readonly facts: ReadonlyMap<string, ProjectionOracleFact>;
  readonly relations: ReadonlyMap<string, ProjectionOracleRelation>;
  readonly normalizedRelationMigrationEntities: ReadonlyMap<string, MigrationImportEventV1["payload"]["entity"]>;
  readonly executions: ReadonlyMap<string, ProjectionOracleExecution>;
  readonly agents: ReadonlyMap<string, ProjectionOracleAgent>;
  readonly schedules: ReadonlyMap<string, ProjectionOracleSchedule>;
  readonly runtimeSessions: ReadonlyMap<string, ProjectionOracleRuntimeSession>;
  readonly entityKeys: ReadonlySet<string>;
  readonly coverageCount: number;
}

interface SqlRow {
  readonly [key: string]: string | number | bigint | null;
}

export function readMigrationProjectionOracle(sourceRoot: string): MigrationProjectionOracle {
  const layout = resolveHarnessLayout(sourceRoot),
    databasePath = path.join(layout.localRoot, "cache", "task.sqlite"),
    inspection = inspectMigrationSourceEvents(sourceRoot);
  const oracle = !existsSync(databasePath)
    ? rebuildMigrationProjectionOracle(sourceRoot, inspection)
    : {
        ...readMigrationProjectionOracleAtPath(
          sourceRoot,
          databasePath,
          "same-cut-projection",
          inspection.observations,
        ),
        normalizedRelationMigrationEntities: inspection.normalizedRelationMigrationEntities,
      };
  return overlayAgentDeclarations(sourceRoot, oracle);
}

export function readMigrationProjectionOracleAtPath(
  sourceRoot: string,
  databasePath: string,
  basis: MigrationProjectionOracle["basis"],
  formatObservations: readonly MigrationFormatObservation[],
): MigrationProjectionOracle {
  const layout = resolveHarnessLayout(sourceRoot);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const meta = rows(database, "SELECT watermark FROM projection_meta WHERE singleton=1")[0],
      watermark = number(meta?.watermark, "projection watermark"),
      eventHeadRevision = readEventHeadRevision(layout.authoredRoot);
    if (eventHeadRevision !== null && watermark !== eventHeadRevision)
      throw migrationImportError(
        "migration_projection_oracle_cut_mismatch",
        `Projection watermark ${watermark} does not match canonical event head ${eventHeadRevision}.`,
      );
    const tasks = new Map(
        rows(
          database,
          [
            "SELECT snapshot.task_id, snapshot.workspace_revision, snapshot.snapshot_json, package.package_path,",
            "first_event.event_json FROM task_snapshot AS snapshot",
            "LEFT JOIN task_package AS package USING(task_id)",
            "LEFT JOIN event_index AS first_event ON first_event.op_id=(SELECT candidate.op_id FROM event_index",
            "AS candidate WHERE candidate.task_id=snapshot.task_id ORDER BY candidate.workspace_revision LIMIT 1)",
            "ORDER BY snapshot.task_id",
          ].join(" "),
        ).map((row) => {
          const taskId = text(row.task_id, "task id"),
            snapshot = record(row.snapshot_json, `task ${taskId} snapshot`),
            event = row.event_json === null ? null : record(row.event_json, `task ${taskId} first event`),
            firstEvent =
              event === null
                ? null
                : {
                    eventId: text(event.eventId, `task ${taskId} first event id`),
                    occurredAt: text(event.occurredAt, `task ${taskId} first event occurredAt`),
                    workspaceRevision: number(event.workspaceRevision, `task ${taskId} first event workspace revision`),
                  };
          return [
            taskId,
            {
              taskId,
              workspaceRevision: number(row.workspace_revision, `task ${taskId} workspace revision`),
              packagePath: row.package_path === null ? null : text(row.package_path, `task ${taskId} package path`),
              snapshot,
              firstEvent,
            },
          ] as const;
        }),
      ),
      decisions = readDecisions(database),
      facts = new Map(
        rows(database, "SELECT fact_id, workspace_revision, row_json FROM fact ORDER BY fact_id").map((row) => {
          const factId = text(row.fact_id, "fact id");
          return [
            factId,
            {
              factId,
              workspaceRevision: number(row.workspace_revision, `fact ${factId} workspace revision`),
              fields: record(row.row_json, `fact ${factId}`),
            },
          ] as const;
        }),
      ),
      relations = new Map(
        rows(
          database,
          [
            "SELECT relation_id, source_ref, target_ref, relation_type, state, owner_ref,",
            "workspace_revision, row_json FROM relation_edge ORDER BY relation_id",
          ].join(" "),
        ).map((row) => {
          const relationId = text(row.relation_id, "relation id"),
            originalFields = record(row.row_json, `relation ${relationId}`),
            relation = relationRow(row, originalFields);
          return [
            relationId,
            {
              relationId,
              workspaceRevision: number(row.workspace_revision, `relation ${relationId} workspace revision`),
              row: relation,
              originalFields,
            },
          ] as const;
        }),
      ),
      executions = new Map(
        rows(
          database,
          [
            "SELECT entity_id, workspace_revision, value_json FROM entity_projection",
            "WHERE entity_kind='execution' ORDER BY entity_id",
          ].join(" "),
        ).map((row) => {
          const executionId = text(row.entity_id, "execution id");
          return [
            executionId,
            {
              executionId,
              workspaceRevision: number(row.workspace_revision, `execution ${executionId} workspace revision`),
              fields: record(row.value_json, `execution ${executionId}`),
            },
          ] as const;
        }),
      ),
      sourceEvents = readEntitySourceEvents(database),
      agents = readEntityRows(database, "agent", (entityId, workspaceRevision, value) => ({
        agentId: entityId,
        workspaceRevision,
        value,
        sourceAnchor: sourceEvents.agents.get(entityId) ?? {
          source: `agents/${entityId}.json`,
          occurredAt: "1970-01-01T00:00:00.000Z",
        },
      })),
      schedules = readEntityRows(database, "schedule", (entityId, workspaceRevision, value) => ({
        scheduleId: entityId,
        workspaceRevision,
        value: value as unknown as ScheduleV1,
        sourceAnchor: sourceEvents.schedules.get(entityId) ?? {
          source: `projection:entity_projection/schedule/${entityId}`,
          occurredAt: String(value.updatedAt ?? value.createdAt ?? "1970-01-01T00:00:00.000Z"),
        },
      })),
      runtimeSessions = new Map(
        rows(
          database,
          "SELECT runtime_session_id, workspace_revision, value_json FROM runtime_session ORDER BY runtime_session_id",
        ).map((row) => {
          const runtimeSessionId = text(row.runtime_session_id, "runtime session id"),
            value = record(row.value_json, `runtime session ${runtimeSessionId}`) as unknown as RuntimeSession,
            events = sourceEvents.runtimeSessions.get(runtimeSessionId);
          return [
            runtimeSessionId,
            {
              runtimeSessionId,
              workspaceRevision: number(
                row.workspace_revision,
                `runtime session ${runtimeSessionId} workspace revision`,
              ),
              value,
              startedAt: events?.startedAt ?? value.lastObservedAt,
              sourceAnchor: events?.latest ?? {
                source: `projection:runtime_session/${runtimeSessionId}`,
                occurredAt: value.lastObservedAt,
              },
              outcome: events?.outcome ?? null,
            },
          ] as const;
        }),
      ),
      entityKeys = new Set(
        rows(
          database,
          [
            "SELECT entity_kind, entity_id FROM entity_projection",
            "UNION ALL SELECT 'runtime-session' AS entity_kind, runtime_session_id AS entity_id FROM runtime_session",
          ].join(" "),
        ).map((row) => `${text(row.entity_kind, "entity kind")}\0${text(row.entity_id, "entity id")}`),
      ),
      coverage = rows(database, "SELECT COUNT(*) AS count FROM decision_claim WHERE load_bearing=1")[0];
    return {
      basis,
      formatObservations,
      databasePath,
      watermark,
      eventHeadRevision,
      tasks,
      decisions,
      facts,
      relations,
      normalizedRelationMigrationEntities: new Map(),
      executions,
      agents,
      schedules,
      runtimeSessions,
      entityKeys,
      coverageCount: number(coverage?.count, "coverage count"),
    };
  } finally {
    database.close();
  }
}

function readEntityRows<T>(
  database: DatabaseSync,
  kind: string,
  project: (entityId: string, workspaceRevision: number, value: Readonly<Record<string, unknown>>) => T,
): ReadonlyMap<string, T> {
  return new Map(
    rows(
      database,
      "SELECT entity_id, workspace_revision, value_json FROM entity_projection WHERE entity_kind=? ORDER BY entity_id",
      kind,
    ).map((row) => {
      const entityId = text(row.entity_id, `${kind} id`);
      return [
        entityId,
        project(
          entityId,
          number(row.workspace_revision, `${kind} ${entityId} workspace revision`),
          record(row.value_json, `${kind} ${entityId}`),
        ),
      ] as const;
    }),
  );
}

function overlayAgentDeclarations(sourceRoot: string, oracle: MigrationProjectionOracle): MigrationProjectionOracle {
  const layout = resolveHarnessLayout(sourceRoot),
    agentsRoot = path.join(layout.authoredRoot, "agents"),
    agents = new Map(oracle.agents),
    entityKeys = new Set(oracle.entityKeys);
  let names: readonly string[];
  try {
    names = readdirSync(agentsRoot)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    consumeKnownError(error);
    return oracle;
  }
  for (const name of names) {
    const target = path.join(agentsRoot, name),
      source = `agents/${name}`;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(target, "utf8")) as unknown;
    } catch (error) {
      consumeKnownError(error);
      continue;
    }
    if (!isMigrationImportRecord(value) || typeof value.id !== "string") continue;
    const held = agents.get(value.id);
    agents.set(value.id, {
      agentId: value.id,
      workspaceRevision: held?.workspaceRevision ?? 0,
      value,
      sourceAnchor: {
        source,
        occurredAt: held?.sourceAnchor.occurredAt ?? statSync(target).mtime.toISOString(),
      },
    });
    entityKeys.add(`agent\0${value.id}`);
  }
  return { ...oracle, agents, entityKeys };
}

function readEntitySourceEvents(database: DatabaseSync): {
  readonly agents: ReadonlyMap<string, MigrationSourceAnchor>;
  readonly schedules: ReadonlyMap<string, MigrationSourceAnchor>;
  readonly runtimeSessions: ReadonlyMap<
    string,
    {
      readonly startedAt: string;
      readonly latest: MigrationSourceAnchor;
      readonly outcome: ProjectionOracleRuntimeSession["outcome"];
    }
  >;
} {
  const agents = new Map<string, MigrationSourceAnchor>(),
    schedules = new Map<string, MigrationSourceAnchor>(),
    runtime = new Map<
      string,
      {
        startedAt: string;
        latest: MigrationSourceAnchor;
        outcome: ProjectionOracleRuntimeSession["outcome"];
      }
    >();
  for (const row of rows(
    database,
    "SELECT workspace_revision, event_json FROM event_index ORDER BY workspace_revision",
  )) {
    const event = record(row.event_json, "source event"),
      eventId = typeof event.eventId === "string" ? event.eventId : null,
      occurredAt = typeof event.occurredAt === "string" ? event.occurredAt : null,
      payload = isMigrationImportRecord(event.payload) ? event.payload : null;
    if (eventId === null || occurredAt === null || payload === null) continue;
    const anchor = { source: `event:${eventId}`, occurredAt };
    if (
      (event.schema === "entity-event/v1" || event.schema === "agent-entity-event/v1") &&
      payload.entityKind === "agent" &&
      typeof payload.entityId === "string"
    )
      agents.set(payload.entityId, anchor);
    if (
      event.schema === "schedule-event/v1" &&
      isMigrationImportRecord(event.entity) &&
      event.entity.kind === "schedule" &&
      typeof event.entity.id === "string"
    )
      schedules.set(event.entity.id, anchor);
    if (event.schema !== "agent-runtime-event/v1" || typeof payload.runtimeSessionId !== "string") continue;
    const sessionId = payload.runtimeSessionId,
      held = runtime.get(sessionId) ?? { startedAt: occurredAt, latest: anchor, outcome: null };
    held.latest = anchor;
    if (event.type === "runtime_session_started") held.startedAt = occurredAt;
    if (event.type === "runtime_session_outcome_observed" && isMigrationImportRecord(payload.result))
      held.outcome = {
        result: payload.result as unknown as RuntimeResultClaim,
        ...(typeof payload.reasonCode === "string" ? { reasonCode: payload.reasonCode } : {}),
      };
    runtime.set(sessionId, held);
  }
  return { agents, schedules, runtimeSessions: runtime };
}

function readDecisions(database: DatabaseSync): ReadonlyMap<string, ProjectionOracleDecision> {
  const options = group(
      rows(
        database,
        [
          "SELECT decision_id, kind, option_id, position, text, rationale FROM decision_option",
          "ORDER BY decision_id, kind, position",
        ].join(" "),
      ),
      "decision_id",
    ),
    claims = group(
      rows(
        database,
        [
          "SELECT decision_id, claim_id, position, text, load_bearing, fulfillment FROM decision_claim",
          "ORDER BY decision_id, position",
        ].join(" "),
      ),
      "decision_id",
    );
  return new Map(
    rows(database, "SELECT * FROM decision ORDER BY decision_id").map((row) => {
      const decisionId = text(row.decision_id, "decision id"),
        decisionOptions = options.get(decisionId) ?? [],
        mappedOptions = (side: string) =>
          decisionOptions
            .filter((option) => option.kind === side)
            .map((option) => ({
              id: text(option.option_id, `decision ${decisionId} option id`),
              text: text(option.text, `decision ${decisionId} option text`),
              ...(side === "chosen"
                ? option.rationale === null
                  ? {}
                  : { rationale: text(option.rationale, `decision ${decisionId} option rationale`) }
                : { whyNot: text(option.rationale, `decision ${decisionId} rejection rationale`) }),
            }));
      return [
        decisionId,
        {
          decisionId,
          workspaceRevision: number(row.workspace_revision, `decision ${decisionId} workspace revision`),
          fields: row,
          chosen: mappedOptions("chosen"),
          rejected: mappedOptions("rejected"),
          claims: (claims.get(decisionId) ?? []).map((claim) => ({
            id: text(claim.claim_id, `decision ${decisionId} claim id`),
            text: text(claim.text, `decision ${decisionId} claim text`),
            loadBearing: number(claim.load_bearing, `decision ${decisionId} claim load bearing`) === 1,
            fulfillment: claim.fulfillment === null ? null : text(claim.fulfillment, "claim fulfillment"),
          })),
        },
      ] as const;
    }),
  );
}

function relationRow(row: SqlRow, original: Readonly<Record<string, unknown>>): RelationGraphEdgeRow {
  return {
    relationId: text(original.relationId ?? row.relation_id, "relation id"),
    sourceRef: text(original.sourceRef ?? row.source_ref, "relation source"),
    targetRef: text(original.targetRef ?? row.target_ref, "relation target"),
    relationType: text(
      original.relationType ?? row.relation_type,
      "relation type",
    ) as RelationGraphEdgeRow["relationType"],
    direction: text(original.direction, "relation direction") as RelationGraphEdgeRow["direction"],
    strength: text(original.strength, "relation strength") as RelationGraphEdgeRow["strength"],
    origin: text(original.origin, "relation origin") as RelationGraphEdgeRow["origin"],
    state: text(original.state ?? row.state, "relation state") as RelationGraphEdgeRow["state"],
    rationale: text(original.rationale, "relation rationale"),
    ownerRef: text(original.ownerRef ?? row.owner_ref, "relation owner"),
    sourcePath: text(original.sourcePath, "relation source path"),
    recordIndex:
      typeof original.recordIndex === "number" && Number.isSafeInteger(original.recordIndex) ? original.recordIndex : 0,
  };
}

function rows(
  database: DatabaseSync,
  sql: string,
  ...params: readonly (string | number | bigint | null)[]
): readonly SqlRow[] {
  return database.prepare(sql).all(...params) as SqlRow[];
}

function group(values: readonly SqlRow[], field: string): ReadonlyMap<string, readonly SqlRow[]> {
  const grouped = new Map<string, SqlRow[]>();
  for (const value of values) {
    const key = text(value[field], field),
      held = grouped.get(key) ?? [];
    held.push(value);
    grouped.set(key, held);
  }
  return grouped;
}

function readEventHeadRevision(authoredRoot: string): number | null {
  const target = path.join(authoredRoot, "events", "head.json");
  if (!existsSync(target)) return null;
  return number(record(readFileSync(target, "utf8"), "canonical event head").revision, "event head revision");
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  let parsed = value;
  if (typeof parsed === "string")
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw migrationImportError("invalid_migration_projection_oracle", `${label} is not JSON.`);
    }
  if (!isMigrationImportRecord(parsed))
    throw migrationImportError("invalid_migration_projection_oracle", `${label} is not an object.`);
  return parsed;
}

function text(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw migrationImportError("invalid_migration_projection_oracle", `${label} is empty.`);
  return value;
}

function number(value: unknown, label: string): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
    throw migrationImportError("invalid_migration_projection_oracle", `${label} is invalid.`);
  return result;
}
