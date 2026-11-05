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
 * (`mediaType`/`policyId` of the committed claim), the stored `artifacts/...` relative path, and
 * the binary path order identical on both backends.
 *
 * The index stores one row per (path, reader), plus a `*` row that answers the unscoped timeline.
 * That makes both authorization and ordering structural rather than a post-filter: a scoped page
 * reads one ordered reader range per held reader, and counts are per reader. The `*` row keeps a
 * single ordered range for callers that hold no reader scope (the G38 case).
 *
 * `relative` and `package_dir` are explicitly `COLLATE "C"`. The previous in-memory timeline
 * compared strings with JavaScript `<` (no locale collation); relying on a deployment's default
 * collation could reorder case/accent variants or make distinct paths compare equal at a page
 * boundary.
 */
export const artifactTimelineDdl = (): readonly string[] => [
  `CREATE TABLE IF NOT EXISTS ha_artifact_documents (
    tenant_id text NOT NULL, project_id text NOT NULL, policy_epoch bigint NOT NULL,
    reader text NOT NULL,
    readers text[] NOT NULL DEFAULT '{}',
    path text NOT NULL COLLATE "C",
    package_dir text NOT NULL COLLATE "C",
    relative text NOT NULL COLLATE "C",
    kind text NOT NULL CHECK (kind IN ('html', 'md', 'raw')),
    sort_ms bigint NOT NULL, occurred_at text NOT NULL, size_bytes bigint NOT NULL,
    PRIMARY KEY (tenant_id, project_id, policy_epoch, reader, path)
  )`,
  // One reader range is (reader, kind, sort_ms, relative, package_dir); the same columns in the
  // cursor predicate keep a page at the index boundary instead of scanning invisible rows.
  `CREATE INDEX IF NOT EXISTS ha_artifact_documents_page ON ha_artifact_documents
    (tenant_id, project_id, policy_epoch, reader, kind, sort_ms, relative, package_dir)`,
  `CREATE TABLE IF NOT EXISTS ha_artifact_counts (
    tenant_id text NOT NULL, project_id text NOT NULL, policy_epoch bigint NOT NULL,
    reader text NOT NULL,
    kind text NOT NULL, total bigint NOT NULL CHECK (total >= 0),
    PRIMARY KEY (tenant_id, project_id, policy_epoch, reader, kind)
  )`,
  // Backfill for deployments whose documents predate this index. The caller passes the repository
  // because canonical revisions are repo-scoped while projection rows are not. Each document
  // contributes its `*` row and one row per reader; counts are rebuilt from those rows.
  `CREATE OR REPLACE FUNCTION ha_backfill_artifact_documents(tenant text, project text, epoch bigint, repo text)
    RETURNS integer LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
    DECLARE processed integer;
    BEGIN
      -- Reconstruct the scope's index rather than only adding rows: a partial or dirty index is
      -- repaired by the same one-time expansion, so readiness cannot hide stale outputs.
      DELETE FROM ha_artifact_documents WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch;
      DELETE FROM ha_artifact_counts WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch;
      INSERT INTO ha_artifact_documents(
        tenant_id, project_id, policy_epoch, reader, readers, path, package_dir, relative, kind,
        sort_ms, occurred_at, size_bytes)
      SELECT v.tenant_id, v.project_id, v.policy_epoch, r.reader, v.readers, v.entity_id,
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
      CROSS JOIN LATERAL (
        SELECT '*'::text AS reader
        UNION ALL
        SELECT unnest(v.readers)
      ) r
      WHERE v.tenant_id = tenant AND v.project_id = project AND v.policy_epoch = epoch
        AND v.model = 'document' AND v.owner_id = ''
        AND v.entity_id LIKE 'tasks/%/artifacts/%'
        AND v.document_metadata IS NOT NULL
        AND ((metadata->>'mediaType') IN ('text/html', 'text/markdown')
          OR (metadata->>'policyId') = 'raw-artifact-bytes/v1')
      ON CONFLICT (tenant_id, project_id, policy_epoch, reader, path) DO UPDATE SET
        readers=excluded.readers, package_dir=excluded.package_dir, relative=excluded.relative,
        kind=excluded.kind, sort_ms=excluded.sort_ms, occurred_at=excluded.occurred_at,
        size_bytes=excluded.size_bytes;
      SELECT count(DISTINCT path) INTO processed
        FROM ha_artifact_documents
       WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch;
      INSERT INTO ha_artifact_counts(tenant_id, project_id, policy_epoch, reader, kind, total)
      SELECT tenant_id, project_id, policy_epoch, reader, kind, count(*)
      FROM ha_artifact_documents WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch
      GROUP BY tenant_id, project_id, policy_epoch, reader, kind;
      RETURN processed;
    END $function$`,
];

const ARTIFACT_READER_ALL = "*";

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

/** The scope's reader allowlist in one canonical order, so equal sets share rows. */
const canonicalReaders = (readers: readonly string[] | undefined): string[] => [...new Set(readers ?? [])].sort();

/** One artifact write collected for a batch flush; `kind: null` retires the path. */
export interface PgArtifactTimelineEntry {
  readonly path: string;
  readonly readers: readonly string[];
  readonly kind: ArtifactTimelineKind | null;
  readonly sortMs: number;
  readonly occurredAt: string;
  readonly sizeBytes: number;
}

/** Classify one committed document claim, or null when the path is outside the artifact subtree. */
export function artifactTimelineEntry(
  scope: PgProjectionScope,
  path: string,
  document: { readonly mediaType: string; readonly policyId?: string | null; readonly size: number },
  occurredAt: string,
): PgArtifactTimelineEntry | null {
  if (!taskArtifactSubtreePath(path)) return null;
  const kind = artifactKindOf(document),
    sortMs = -Date.parse(occurredAt);
  if (kind !== null && !Number.isFinite(sortMs))
    throw new Error(`artifact document ${path} has an invalid occurrence time`);
  return {
    path,
    readers: canonicalReaders(scope.readers),
    kind,
    sortMs: Number.isFinite(sortMs) ? sortMs : 0,
    occurredAt,
    sizeBytes: document.size,
  };
}

export function artifactRetirementEntry(path: string): PgArtifactTimelineEntry | null {
  return taskArtifactSubtreePath(path)
    ? { path, readers: [], kind: null, sortMs: 0, occurredAt: "", sizeBytes: 0 }
    : null;
}

type CountDelta = { readonly reader: string; readonly kind: ArtifactTimelineKind; delta: number };

type PageRow = {
  readonly package_dir: string;
  readonly relative: string;
  readonly kind: ArtifactTimelineKind;
  readonly occurred_at: string;
  readonly sort_ms: string | number;
  readonly size_bytes: string | number;
  readonly task_id: string | null;
  readonly title: string | null;
};

/** Flush a batch of document writes and retirements in set-based statements. The per-document
 * form (a 34k-output projection) spent over 100s in PGlite on parse/plan and transaction overhead;
 * batching by canonical transaction keeps the same rows and exact counts at batch cost. */
export async function flushPgArtifactDocuments(
  client: PoolClient,
  scope: PgProjectionScope,
  entries: readonly PgArtifactTimelineEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const paths = entries.map(({ path }) => path),
    removed = await client.query<{ reader: string; kind: ArtifactTimelineKind }>(
      `DELETE FROM ha_artifact_documents
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND path = ANY($4::text[])
       RETURNING reader, kind`,
      [...scopeValues(scope), paths],
    ),
    present = entries.filter(
      (entry): entry is PgArtifactTimelineEntry & { readonly kind: ArtifactTimelineKind } => entry.kind !== null,
    );
  const rows = present.flatMap(({ path, readers, kind, sortMs, occurredAt, sizeBytes }) =>
    [ARTIFACT_READER_ALL, ...readers].map((reader) => ({
      reader,
      readers,
      path,
      kind,
      sort_ms: sortMs,
      occurred_at: occurredAt,
      size_bytes: sizeBytes,
    })),
  );
  if (rows.length > 0)
    await client.query(
      `INSERT INTO ha_artifact_documents(
         tenant_id, project_id, policy_epoch, reader, readers, path, package_dir, relative, kind,
         sort_ms, occurred_at, size_bytes)
       SELECT $1, $2, $3, x.reader, x.readers, x.path,
         split_part(x.path, '/', 2), substr(x.path, strpos(x.path, '/artifacts/') + 1),
         x.kind, x.sort_ms, x.occurred_at, x.size_bytes
       FROM jsonb_to_recordset($4::jsonb) AS x(
         reader text, readers text[], path text, kind text, sort_ms bigint,
         occurred_at text, size_bytes bigint)`,
      [...scopeValues(scope), JSON.stringify(rows)],
    );
  const deltas = new Map<string, CountDelta>();
  const add = (reader: string, kind: ArtifactTimelineKind, delta: number) => {
    const key = `${reader}\u0000${kind}`,
      current = deltas.get(key);
    deltas.set(key, { reader, kind, delta: (current?.delta ?? 0) + delta });
  };
  for (const row of removed.rows) add(row.reader, row.kind, -1);
  for (const row of rows) add(row.reader, row.kind as ArtifactTimelineKind, 1);
  const changes = [...deltas.values()].filter(({ delta }) => delta !== 0);
  if (changes.length === 0) return;
  const payload = JSON.stringify(changes);
  // Keep the negative side out of the INSERT row: `total` has CHECK (total >= 0), and PostgreSQL
  // validates the proposed row before ON CONFLICT resolves it. Positive deltas insert/raise the
  // count; negative deltas only update an existing row.
  await client.query(
    `INSERT INTO ha_artifact_counts(tenant_id, project_id, policy_epoch, reader, kind, total)
     SELECT $1, $2, $3, x.reader, x.kind, GREATEST(x.delta, 0)
     FROM jsonb_to_recordset($4::jsonb) AS x(reader text, kind text, delta bigint)
     ON CONFLICT (tenant_id, project_id, policy_epoch, reader, kind) DO UPDATE
     SET total = ha_artifact_counts.total + GREATEST(excluded.total, 0)`,
    [...scopeValues(scope), payload],
  );
  await client.query(
    `UPDATE ha_artifact_counts c SET total = GREATEST(c.total + x.delta, 0)
     FROM jsonb_to_recordset($4::jsonb) AS x(reader text, kind text, delta bigint)
     WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.policy_epoch=$3
       AND c.reader=x.reader AND c.kind=x.kind AND x.delta < 0`,
    [...scopeValues(scope), payload],
  );
}

/** Maintain the index in the same transaction that writes the canonical document row. */
export async function projectPgArtifactDocument(
  client: PoolClient,
  scope: PgProjectionScope,
  path: string,
  document: { readonly mediaType: string; readonly policyId?: string | null; readonly size: number },
  occurredAt: string,
): Promise<void> {
  const entry = artifactTimelineEntry(scope, path, document, occurredAt);
  if (entry !== null) await flushPgArtifactDocuments(client, scope, [entry]);
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const comparePageRows = (left: PageRow, right: PageRow): number =>
  Number(left.sort_ms) - Number(right.sort_ms) ||
  compareText(left.relative, right.relative) ||
  compareText(left.package_dir, right.package_dir);

/** One ordered page plus maintained totals. A caller holding readers reads one bounded range per
 * reader and merges them; the unscoped caller reads the single `*` range. */
export async function readPgArtifactTimeline(
  client: PoolClient,
  scope: PgProjectionScope,
  query: ArtifactTimelineQuery,
): Promise<Pick<ArtifactTimelineRead, "rows" | "hasMore" | "counts">> {
  if (query.kind !== "html" && query.kind !== "md" && query.kind !== "raw")
    throw new Error("artifact timeline kind is invalid");
  const limit = checkedPageLimit(query.limit, 500),
    meta = await client.query<{ artifact_index_version: number }>(
      `SELECT artifact_index_version FROM ha_projection_meta
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
      scopeValues(scope),
    );
  // A cache that predates the index must not answer "ready" with a partial timeline.
  if ((meta.rows[0]?.artifact_index_version ?? 1) === 0)
    throw Object.assign(new Error("Artifact timeline index backfill is pending; retry after migration."), {
      code: "projection_pending",
    });
  const scopedReaders = canonicalReaders(scope.readers),
    pageReaders = scopedReaders.length === 0 ? [ARTIFACT_READER_ALL] : scopedReaders,
    rowsByPath = new Map<string, PageRow>();
  for (const reader of pageReaders) {
    const values: unknown[] = [...scopeValues(scope), reader, query.kind, scopedReaders];
    let afterSql = "";
    if (query.after !== undefined) {
      const sortMs = -Date.parse(query.after.occurredAt);
      if (!Number.isFinite(sortMs)) throw new Error("artifact timeline cursor time is invalid");
      afterSql = 'AND (a.sort_ms, a.relative, a.package_dir) > ($7, $8::text COLLATE "C", $9::text COLLATE "C")';
      values.push(sortMs, query.after.relative, query.after.packageDir);
    }
    const limitParameter = values.push(limit + 1),
      page = await client.query<PageRow>(
        `SELECT a.package_dir, a.relative, a.kind, a.occurred_at, a.sort_ms, a.size_bytes,
           s.task_id, s.snapshot->'task'->>'title' AS title
         FROM ha_artifact_documents a
         LEFT JOIN LATERAL (
           SELECT task_id, snapshot FROM ha_task_snapshots t
           WHERE t.tenant_id=a.tenant_id AND t.project_id=a.project_id AND t.policy_epoch=a.policy_epoch
             AND t.package_path = 'tasks/' || a.package_dir
             AND (cardinality($6::text[]) = 0 OR t.readers && $6::text[])
           ORDER BY t.workspace_revision DESC LIMIT 1
         ) s ON true
         WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.policy_epoch=$3
           AND a.reader=$4 AND a.kind=$5
           ${afterSql}
         ORDER BY a.sort_ms, a.relative COLLATE "C", a.package_dir COLLATE "C"
         LIMIT $${limitParameter}`,
        values,
      );
    for (const row of page.rows) {
      const key = `${row.relative}\u0000${row.package_dir}`;
      if (!rowsByPath.has(key)) rowsByPath.set(key, row);
    }
  }
  const ordered = [...rowsByPath.values()].sort(comparePageRows),
    counts: Record<ArtifactTimelineKind, number> = { html: 0, md: 0, raw: 0 };
  if (scopedReaders.length <= 1) {
    const totals = await client.query<{ readonly kind: ArtifactTimelineKind; readonly total: string | number }>(
      `SELECT kind, total FROM ha_artifact_counts
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader=$4`,
      [...scopeValues(scope), scopedReaders[0] ?? ARTIFACT_READER_ALL],
    );
    for (const row of totals.rows) counts[row.kind] = Number(row.total);
  } else {
    // Exact union across several held readers. This is the multi-reader authorization path; the
    // single-reader and unscoped reads above stay index/count bounded. Intersections make an exact
    // union count require visiting matching paths, so this path is measured separately from G38.
    const totals = await client.query<{ readonly kind: ArtifactTimelineKind; readonly total: string | number }>(
      `SELECT kind, COUNT(DISTINCT path) AS total FROM ha_artifact_documents
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND reader = ANY($4::text[])
       GROUP BY kind`,
      [...scopeValues(scope), scopedReaders],
    );
    for (const row of totals.rows) counts[row.kind] = Number(row.total);
  }
  return {
    rows: ordered.slice(0, limit).map((row) => ({
      kind: row.kind,
      packageDir: row.package_dir,
      relative: row.relative,
      occurredAt: row.occurred_at,
      sizeBytes: Number(row.size_bytes),
      taskId: row.task_id,
      taskTitle: row.title,
      packagePath: row.task_id === null ? null : `tasks/${row.package_dir}`,
    })),
    hasMore: ordered.length > limit,
    counts,
  };
}

/** One-time expansion for projections whose documents predate the index. Idempotent, and it
 * marks the projection complete so a later catch-up does not rescan. */
export async function backfillPgArtifactDocuments(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
): Promise<number> {
  const version = await client.query<{ artifact_index_version: number }>(
    `SELECT artifact_index_version FROM ha_projection_meta
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    scopeValues(scope),
  );
  if ((version.rows[0]?.artifact_index_version ?? 1) !== 0) return 0;
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
