import {
  STANDARD_POSTGRES_DIALECT_CAPABILITIES,
  dialectAddColumnIfNotExistsSql,
  dialectCreateTriggerStatements,
  type PgDialectCapabilities,
} from "../postgres/dialect.ts";

/**
 * dec_9979850C7CE87C17271D78E4D1 CH2: reverse code-path trace keys, the PostgreSQL twin of the
 * SQLite expression indexes (`TASK_SUBMISSION_COMMIT_SQL`, `fact_observed_commit`) and the
 * `decision_applies_module` prefix table.
 *
 * Every key is a STORED generated column: `ALTER TABLE ... ADD COLUMN` fills existing rows in the
 * same statement and every writer (current or previous binary) derives it, so no trigger version,
 * backfill function or readiness gate is needed.
 *
 * RLS note (measured on PostgreSQL 17 / PGlite: `pg_proc.proleakproof`): `texteq`, `text_ge` and
 * `text_lt` are leakproof, so scalar equality / range predicates on the task and fact keys stay index
 * conditions below the forced RLS barrier. `arrayoverlap` (`text[] && text[]`) is NOT leakproof:
 * under forced RLS the decision prefix GIN serves owner/bypass roles only, and runtime readers
 * evaluate the overlap as a filter over the `(scope, decision_state)` index range that the trace
 * query always pins to `in_effect`.
 */
export function traceIndexDdl(
  capabilities: PgDialectCapabilities = STANDARD_POSTGRES_DIALECT_CAPABILITIES,
): readonly string[] {
  const parallel = capabilities.supportsParallelSafe ? " PARALLEL SAFE" : "",
    submissionExpr = capabilities.supportsNegativeJsonbIndex
      ? "COALESCE(snapshot #>> '{executions,-1,submission,commitSha}', snapshot #>> '{executions,-2,submission,commitSha}')"
      : "ha_task_submission_commit_sha(snapshot)";
  const helpers: string[] = [
    // `\` → `/`, one leading `./`, no trailing `/`, empty and non-string entries dropped: the same
    // normalization as the SQLite trigger in decision-projection-schema.ts.
    `CREATE OR REPLACE FUNCTION ha_trace_module_prefixes(modules jsonb) RETURNS text[]
      LANGUAGE sql IMMUTABLE${parallel} AS $function$
        SELECT COALESCE(array_agg(DISTINCT module_prefix ORDER BY module_prefix), '{}'::text[]) FROM (
          SELECT rtrim(regexp_replace(replace(btrim(entry #>> '{}'), chr(92), '/'), '^\\./', ''), '/') AS module_prefix
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(modules) = 'array' THEN modules ELSE '[]'::jsonb END) AS entry
          WHERE jsonb_typeof(entry) = 'string'
        ) normalized WHERE module_prefix <> ''
      $function$`,
  ];
  if (!capabilities.supportsNegativeJsonbIndex) {
    helpers.push(
      `CREATE OR REPLACE FUNCTION ha_task_submission_commit_sha(snapshot jsonb) RETURNS text
        LANGUAGE sql IMMUTABLE AS $function$
          SELECT CASE
            WHEN jsonb_typeof(snapshot->'executions') <> 'array' THEN NULL
            ELSE COALESCE(
              CASE WHEN jsonb_array_length(snapshot->'executions') >= 1
                AND jsonb_typeof((snapshot->'executions'->(jsonb_array_length(snapshot->'executions') - 1))->'submission') = 'object'
                THEN (snapshot->'executions'->(jsonb_array_length(snapshot->'executions') - 1))->'submission'->>'commitSha' END,
              CASE WHEN jsonb_array_length(snapshot->'executions') >= 2
                AND jsonb_typeof((snapshot->'executions'->(jsonb_array_length(snapshot->'executions') - 2))->'submission') = 'object'
                THEN (snapshot->'executions'->(jsonb_array_length(snapshot->'executions') - 2))->'submission'->>'commitSha' END
            )
          END
        $function$`,
    );
  }
  const addCol = (table: string, col: string, def: string) =>
    dialectAddColumnIfNotExistsSql(capabilities, table, col, def);
  if (capabilities.supportsStoredComputedColumns) {
    return [
      ...helpers,
      addCol("ha_task_snapshots", "submission_commit_sha", `text GENERATED ALWAYS AS (${submissionExpr}) STORED`),
      addCol(
        "ha_task_snapshots",
        "external_commit_sha",
        "text GENERATED ALWAYS AS (snapshot #>> '{externalResolution,commitSha}') STORED",
      ),
      `CREATE INDEX IF NOT EXISTS ha_task_snapshots_submission_commit ON ha_task_snapshots
        (tenant_id,project_id,policy_epoch,submission_commit_sha) WHERE submission_commit_sha IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS ha_task_snapshots_external_commit ON ha_task_snapshots
        (tenant_id,project_id,policy_epoch,external_commit_sha) WHERE external_commit_sha IS NOT NULL`,
      addCol(
        "ha_decisions",
        "applies_modules",
        "text[] GENERATED ALWAYS AS (ha_trace_module_prefixes(value->'appliesTo'->'modules')) STORED",
      ),
      "CREATE INDEX IF NOT EXISTS ha_decisions_applies_modules ON ha_decisions USING gin (applies_modules)",
      addCol("ha_facts", "observed_commit", "text GENERATED ALWAYS AS (value->>'observedCommit') STORED"),
      addCol("ha_facts", "evidence_source", "text COLLATE \"C\" GENERATED ALWAYS AS (value->>'evidenceSource') STORED"),
      `CREATE INDEX IF NOT EXISTS ha_facts_observed_commit ON ha_facts
        (tenant_id,project_id,policy_epoch,observed_commit) WHERE observed_commit IS NOT NULL`,
      "CREATE INDEX IF NOT EXISTS ha_facts_evidence_source ON ha_facts (tenant_id,project_id,policy_epoch,evidence_source)",
    ];
  }
  return [
    ...helpers,
    addCol("ha_task_snapshots", "submission_commit_sha", "text"),
    addCol("ha_task_snapshots", "external_commit_sha", "text"),
    `CREATE OR REPLACE FUNCTION ha_task_trace_columns_sync() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        NEW.submission_commit_sha := ${submissionExpr.replaceAll("snapshot", "NEW.snapshot")};
        NEW.external_commit_sha := NEW.snapshot #>> '{externalResolution,commitSha}';
        RETURN NEW;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_task_trace_columns_sync",
      tableName: "ha_task_snapshots",
      timingAndEvent: "BEFORE INSERT OR UPDATE OF snapshot",
      functionCall: "ha_task_trace_columns_sync()",
    }),
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_submission_commit ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,submission_commit_sha) WHERE submission_commit_sha IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_external_commit ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,external_commit_sha) WHERE external_commit_sha IS NOT NULL`,
    addCol("ha_decisions", "applies_modules", "text[]"),
    `CREATE OR REPLACE FUNCTION ha_decision_trace_columns_sync() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        NEW.applies_modules := ha_trace_module_prefixes(NEW.value->'appliesTo'->'modules');
        RETURN NEW;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_decision_trace_columns_sync",
      tableName: "ha_decisions",
      timingAndEvent: "BEFORE INSERT OR UPDATE OF value",
      functionCall: "ha_decision_trace_columns_sync()",
    }),
    "CREATE INDEX IF NOT EXISTS ha_decisions_applies_modules ON ha_decisions USING gin (applies_modules)",
    addCol("ha_facts", "observed_commit", "text"),
    addCol("ha_facts", "evidence_source", 'text COLLATE "C"'),
    `CREATE OR REPLACE FUNCTION ha_fact_trace_columns_sync() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
      BEGIN
        NEW.observed_commit := NEW.value->>'observedCommit';
        NEW.evidence_source := NEW.value->>'evidenceSource';
        RETURN NEW;
      END $function$`,
    ...dialectCreateTriggerStatements(capabilities, {
      triggerName: "ha_fact_trace_columns_sync",
      tableName: "ha_facts",
      timingAndEvent: "BEFORE INSERT OR UPDATE OF value",
      functionCall: "ha_fact_trace_columns_sync()",
    }),
    `CREATE INDEX IF NOT EXISTS ha_facts_observed_commit ON ha_facts
      (tenant_id,project_id,policy_epoch,observed_commit) WHERE observed_commit IS NOT NULL`,
    "CREATE INDEX IF NOT EXISTS ha_facts_evidence_source ON ha_facts (tenant_id,project_id,policy_epoch,evidence_source)",
  ];
}

/** `<path>`, `<path>:<line…>` and `<path>#<anchor>` evidence sources as leakproof equality and C-collation ranges. */
export function pgEvidenceSourcePathClause(paths: readonly string[], bind: (value: unknown) => string): string {
  const terms = paths.flatMap((path) => [
    `evidence_source=${bind(path)}`,
    `(evidence_source>=${bind(`${path}:`)} AND evidence_source<${bind(`${path};`)})`,
    `(evidence_source>=${bind(`${path}#`)} AND evidence_source<${bind(`${path}$`)})`,
  ]);
  return terms.length === 0 ? "false" : `(${terms.join(" OR ")})`;
}
