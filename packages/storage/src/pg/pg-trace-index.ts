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
export function traceIndexDdl(): readonly string[] {
  return [
    // `\` → `/`, one leading `./`, no trailing `/`, empty and non-string entries dropped: the same
    // normalization as the SQLite trigger in decision-projection-schema.ts.
    `CREATE OR REPLACE FUNCTION ha_trace_module_prefixes(modules jsonb) RETURNS text[]
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $function$
        SELECT COALESCE(array_agg(DISTINCT module_prefix ORDER BY module_prefix), '{}'::text[]) FROM (
          SELECT rtrim(regexp_replace(replace(btrim(entry #>> '{}'), chr(92), '/'), '^\\./', ''), '/') AS module_prefix
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(modules) = 'array' THEN modules ELSE '[]'::jsonb END) AS entry
          WHERE jsonb_typeof(entry) = 'string'
        ) normalized WHERE module_prefix <> ''
      $function$`,
    `ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS submission_commit_sha text GENERATED ALWAYS AS (
      COALESCE(snapshot #>> '{executions,-1,submission,commitSha}', snapshot #>> '{executions,-2,submission,commitSha}')
    ) STORED`,
    "ALTER TABLE ha_task_snapshots ADD COLUMN IF NOT EXISTS external_commit_sha text GENERATED ALWAYS AS (snapshot #>> '{externalResolution,commitSha}') STORED",
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_submission_commit ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,submission_commit_sha) WHERE submission_commit_sha IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ha_task_snapshots_external_commit ON ha_task_snapshots
      (tenant_id,project_id,policy_epoch,external_commit_sha) WHERE external_commit_sha IS NOT NULL`,
    `ALTER TABLE ha_decisions ADD COLUMN IF NOT EXISTS applies_modules text[] GENERATED ALWAYS AS (
      ha_trace_module_prefixes(value->'appliesTo'->'modules')
    ) STORED`,
    "CREATE INDEX IF NOT EXISTS ha_decisions_applies_modules ON ha_decisions USING gin (applies_modules)",
    "ALTER TABLE ha_facts ADD COLUMN IF NOT EXISTS observed_commit text GENERATED ALWAYS AS (value->>'observedCommit') STORED",
    `ALTER TABLE ha_facts ADD COLUMN IF NOT EXISTS evidence_source text COLLATE "C" GENERATED ALWAYS AS (value->>'evidenceSource') STORED`,
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
