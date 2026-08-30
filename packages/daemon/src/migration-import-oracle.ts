import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { resolveHarnessLayout, type RelationGraphEdgeRow } from "../../kernel/src/index.ts";
import { isMigrationImportRecord, migrationImportError, nonEmpty } from "./migration-import-report.ts";

export const migrationOracleKinds = ["task", "decision", "fact", "relation", "execution"] as const;
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

export interface MigrationProjectionOracle {
  readonly databasePath: string;
  readonly watermark: number;
  readonly eventHeadRevision: number | null;
  readonly tasks: ReadonlyMap<string, ProjectionOracleTask>;
  readonly decisions: ReadonlyMap<string, ProjectionOracleDecision>;
  readonly facts: ReadonlyMap<string, ProjectionOracleFact>;
  readonly relations: ReadonlyMap<string, ProjectionOracleRelation>;
  readonly executions: ReadonlyMap<string, ProjectionOracleExecution>;
  readonly entityKeys: ReadonlySet<string>;
  readonly coverageCount: number;
}

interface SqlRow {
  readonly [key: string]: string | number | bigint | null;
}

export function readMigrationProjectionOracle(sourceRoot: string): MigrationProjectionOracle {
  const layout = resolveHarnessLayout(sourceRoot),
    databasePath = path.join(layout.localRoot, "cache", "task.sqlite");
  if (!existsSync(databasePath))
    throw migrationImportError(
      "migration_projection_oracle_missing",
      `Same-cut migration oracle is missing: ${path.relative(sourceRoot, databasePath)}.`,
    );
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
      databasePath,
      watermark,
      eventHeadRevision,
      tasks,
      decisions,
      facts,
      relations,
      executions,
      entityKeys,
      coverageCount: number(coverage?.count, "coverage count"),
    };
  } finally {
    database.close();
  }
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

function rows(database: DatabaseSync, sql: string): readonly SqlRow[] {
  return database.prepare(sql).all() as SqlRow[];
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
