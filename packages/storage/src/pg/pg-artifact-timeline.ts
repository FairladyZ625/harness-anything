import type { PoolClient } from "pg";
import {
  RAW_ARTIFACT_POLICY_ID,
  taskArtifactSubtreePath,
} from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import type { ArtifactTimelineKind, ArtifactTimelineQuery, ArtifactTimelineRead } from "@harness-anything/kernel";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { checkedPageLimit } from "./pg-query-page.ts";

/**
 * PostgreSQL half of the artifact timeline index (G38 read side, dec_72FADB86/CH3).
 * SQLite owns the same table shape through `artifact-timeline-projection.ts`; keep the facet rule
 * (`mediaType`/`policyId` of the committed claim) identical on both backends.
 */
export const artifactTimelineDdl = (): readonly string[] => [
  `CREATE TABLE IF NOT EXISTS ha_artifact_documents (
    tenant_id text NOT NULL, project_id text NOT NULL, policy_epoch bigint NOT NULL,
    readers text[] NOT NULL DEFAULT '{}',
    path text NOT NULL, package_dir text NOT NULL, relative text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('html', 'md', 'raw')),
    sort_ms bigint NOT NULL, occurred_at text NOT NULL, size_bytes bigint NOT NULL,
    PRIMARY KEY (tenant_id, project_id, policy_epoch, path)
  )`,
  `CREATE INDEX IF NOT EXISTS ha_artifact_documents_page ON ha_artifact_documents
    (tenant_id, project_id, policy_epoch, kind, sort_ms, relative, package_dir)`,
  `CREATE TABLE IF NOT EXISTS ha_artifact_counts (
    tenant_id text NOT NULL, project_id text NOT NULL, policy_epoch bigint NOT NULL,
    readers text[] NOT NULL DEFAULT '{}',
    kind text NOT NULL, total bigint NOT NULL CHECK (total >= 0),
    PRIMARY KEY (tenant_id, project_id, policy_epoch, kind)
  )`,
  // Backfill for deployments whose documents predate this index. The caller passes the repository
  // because canonical revisions are repo-scoped while projection rows are not.
  `CREATE OR REPLACE FUNCTION ha_backfill_artifact_documents(tenant text, project text, epoch bigint, repo text)
    RETURNS integer LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
    DECLARE processed integer;
    BEGIN
      INSERT INTO ha_artifact_documents(
        tenant_id, project_id, policy_epoch, path, package_dir, relative, kind, sort_ms, occurred_at, size_bytes)
      SELECT v.tenant_id, v.project_id, v.policy_epoch, v.entity_id,
        split_part(v.entity_id, '/', 2),
        substr(v.entity_id, strpos(v.entity_id, '/artifacts/') + 1),
        CASE WHEN metadata->>'mediaType' = 'text/html' THEN 'html'
             WHEN metadata->>'mediaType' = 'text/markdown' THEN 'md'
             ELSE 'raw' END,
        -round(extract(epoch FROM e.occurred_at::timestamptz) * 1000)::bigint,
        e.occurred_at,
        (metadata->>'size')::bigint
      FROM ha_projection_values v
      JOIN ha_events e
        ON e.tenant_id = v.tenant_id AND e.project_id = v.project_id
       AND e.repo_id = repo AND e.revision = v.workspace_revision
      CROSS JOIN LATERAL (SELECT v.document_metadata::jsonb AS metadata) m
      WHERE v.tenant_id = tenant AND v.project_id = project AND v.policy_epoch = epoch
        AND v.model = 'document' AND v.owner_id = ''
        AND v.entity_id LIKE 'tasks/%/artifacts/%'
        AND v.document_metadata IS NOT NULL
        AND ((metadata->>'mediaType') IN ('text/html', 'text/markdown')
          OR (metadata->>'policyId') = 'raw-artifact-bytes/v1')
      ON CONFLICT (tenant_id, project_id, policy_epoch, path) DO UPDATE SET
        package_dir=excluded.package_dir, relative=excluded.relative, kind=excluded.kind,
        sort_ms=excluded.sort_ms, occurred_at=excluded.occurred_at, size_bytes=excluded.size_bytes;
      GET DIAGNOSTICS processed = ROW_COUNT;
      DELETE FROM ha_artifact_counts WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch;
      INSERT INTO ha_artifact_counts(tenant_id, project_id, policy_epoch, kind, total)
      SELECT tenant_id, project_id, policy_epoch, kind, count(*)
      FROM ha_artifact_documents WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch
      GROUP BY tenant_id, project_id, policy_epoch, kind;
      RETURN processed;
    END $function$`,
];

const artifactKindOf = (document: {
  readonly mediaType: string;
  readonly policyId?: string | null;
}): ArtifactTimelineKind | null =>
  document.mediaType === "text/html"
    ? "html"
    : document.mediaType === "text/markdown"
      ? "md"
      : document.policyId === RAW_ARTIFACT_POLICY_ID
        ? "raw"
        : null;

const scopeValues = (scope: PgProjectionScope) => [scope.tenantId, scope.projectId, scope.policyEpoch];

const adjustCount = (client: PoolClient, scope: PgProjectionScope, kind: ArtifactTimelineKind, delta: 1 | -1) =>
  client.query(
    `INSERT INTO ha_artifact_counts(tenant_id, project_id, policy_epoch, kind, total) VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (tenant_id, project_id, policy_epoch, kind) DO UPDATE
     SET total = GREATEST(ha_artifact_counts.total + $5, 0)`,
    [...scopeValues(scope), kind, delta],
  );

/** Maintain the index in the same transaction that writes the canonical document row. */
export async function projectPgArtifactDocument(
  client: PoolClient,
  scope: PgProjectionScope,
  path: string,
  document: { readonly mediaType: string; readonly policyId?: string | null; readonly size: number },
  occurredAt: string,
): Promise<void> {
  if (!taskArtifactSubtreePath(path)) return;
  const kind = artifactKindOf(document);
  if (kind === null) return retirePgArtifactDocument(client, scope, path);
  const match = /^tasks\/([^/]+)\/artifacts\/(.+)$/u.exec(path);
  if (match === null) return;
  const sortMs = -Date.parse(occurredAt);
  if (!Number.isFinite(sortMs)) throw new Error(`artifact document ${path} has an invalid occurrence time`);
  const previous = await client.query<{ kind: ArtifactTimelineKind }>(
    `SELECT kind FROM ha_artifact_documents WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND path=$4`,
    [...scopeValues(scope), path],
  );
  await client.query(
    `INSERT INTO ha_artifact_documents(
       tenant_id, project_id, policy_epoch, path, package_dir, relative, kind, sort_ms, occurred_at, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, project_id, policy_epoch, path) DO UPDATE SET
       package_dir=excluded.package_dir, relative=excluded.relative, kind=excluded.kind,
       sort_ms=excluded.sort_ms, occurred_at=excluded.occurred_at, size_bytes=excluded.size_bytes`,
    [...scopeValues(scope), path, match[1]!, match[2]!, kind, sortMs, occurredAt, document.size],
  );
  const before = previous.rows[0]?.kind;
  if (before === undefined) await adjustCount(client, scope, kind, 1);
  else if (before !== kind) {
    await adjustCount(client, scope, before, -1);
    await adjustCount(client, scope, kind, 1);
  }
}

export async function retirePgArtifactDocument(
  client: PoolClient,
  scope: PgProjectionScope,
  path: string,
): Promise<void> {
  if (!taskArtifactSubtreePath(path)) return;
  const removed = await client.query<{ kind: ArtifactTimelineKind }>(
    `DELETE FROM ha_artifact_documents WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND path=$4
     RETURNING kind`,
    [...scopeValues(scope), path],
  );
  const kind = removed.rows[0]?.kind;
  if (kind !== undefined) await adjustCount(client, scope, kind, -1);
}

/** One ordered page plus maintained totals; the caller supplies the projection cut. */
export async function readPgArtifactTimeline(
  client: PoolClient,
  scope: PgProjectionScope,
  query: ArtifactTimelineQuery,
): Promise<Pick<ArtifactTimelineRead, "rows" | "hasMore" | "counts">> {
  if (query.kind !== "html" && query.kind !== "md" && query.kind !== "raw")
    throw new Error("artifact timeline kind is invalid");
  const limit = checkedPageLimit(query.limit, 500);
  const values: unknown[] = [...scopeValues(scope), query.kind];
  let afterSql = "";
  if (query.after !== undefined) {
    const sortMs = -Date.parse(query.after.occurredAt);
    if (!Number.isFinite(sortMs)) throw new Error("artifact timeline cursor time is invalid");
    afterSql = "AND (a.sort_ms, a.relative, a.package_dir) > ($5, $6, $7)";
    values.push(sortMs, query.after.relative, query.after.packageDir);
  }
  const limitParameter = values.push(limit + 1),
    page = await client.query<{
      readonly package_dir: string;
      readonly relative: string;
      readonly kind: ArtifactTimelineKind;
      readonly occurred_at: string;
      readonly size_bytes: string | number;
      readonly task_id: string | null;
      readonly title: string | null;
    }>(
      `SELECT a.package_dir, a.relative, a.kind, a.occurred_at, a.size_bytes, s.task_id,
         s.snapshot->'task'->>'title' AS title
       FROM ha_artifact_documents a
       LEFT JOIN LATERAL (
         SELECT task_id, snapshot FROM ha_task_snapshots t
         WHERE t.tenant_id=a.tenant_id AND t.project_id=a.project_id AND t.policy_epoch=a.policy_epoch
           AND t.package_path = 'tasks/' || a.package_dir
         ORDER BY t.workspace_revision DESC LIMIT 1
       ) s ON true
       WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.policy_epoch=$3 AND a.kind=$4 ${afterSql}
       ORDER BY a.sort_ms, a.relative, a.package_dir LIMIT $${limitParameter}`,
      values,
    ),
    totals = await client.query<{ readonly kind: ArtifactTimelineKind; readonly total: string | number }>(
      `SELECT kind, total FROM ha_artifact_counts WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`,
      scopeValues(scope),
    ),
    counts: Record<ArtifactTimelineKind, number> = { html: 0, md: 0, raw: 0 };
  for (const row of totals.rows) counts[row.kind] = Number(row.total);
  return {
    rows: page.rows.slice(0, limit).map((row) => ({
      kind: row.kind,
      packageDir: row.package_dir,
      relative: row.relative,
      occurredAt: row.occurred_at,
      sizeBytes: Number(row.size_bytes),
      taskId: row.task_id,
      taskTitle: row.title,
      packagePath: row.task_id === null ? null : `tasks/${row.package_dir}`,
    })),
    hasMore: page.rows.length > limit,
    counts,
  };
}

/** One-time expansion for projections whose documents predate the index. Idempotent, and it
 * marks the projection complete so an embedded upgrade does not rescan on every open. */
export async function backfillPgArtifactDocuments(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
): Promise<number> {
  const result = await client.query<{ readonly processed: number }>(
    "SELECT ha_backfill_artifact_documents($1,$2,$3,$4) AS processed",
    [...scopeValues(scope), repoId],
  );
  await client.query(
    `UPDATE ha_projection_meta SET artifact_index_version=1
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    scopeValues(scope),
  );
  return Number(result.rows[0]?.processed ?? 0);
}
