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
 * (`mediaType`/`policyId` of the committed claim) and the stored `artifacts/...` relative path
 * identical on both backends.
 *
 * Rows carry the document's `readers` allowlist and are filtered by the caller's readers on every
 * page and count, matching `readDocument`'s overlap rule. Counts are maintained per reader set and
 * summed over the sets visible to the caller, so an exact total never requires scanning artifacts.
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
    PRIMARY KEY (tenant_id, project_id, policy_epoch, kind, readers)
  )`,
  // One round trip per written document: the previous row, the upsert and both count deltas
  // happen inside the projection transaction. Doing this as three client queries made a bulk
  // 34k-output projection take 146s in PGlite (G38 fixture setup); the function keeps writes
  // and counts in the same statement without paying three parse/plan cycles per document.
  `CREATE OR REPLACE FUNCTION ha_project_artifact_document(
    p_tenant text, p_project text, p_epoch bigint, p_path text, p_readers text[],
    p_kind text, p_sort_ms bigint, p_occurred_at text, p_size bigint)
    RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
    DECLARE previous_kind text; previous_readers text[];
    BEGIN
      SELECT kind, readers INTO previous_kind, previous_readers
        FROM ha_artifact_documents
       WHERE tenant_id = p_tenant AND project_id = p_project AND policy_epoch = p_epoch
         AND path = p_path;
      IF previous_kind IS NOT NULL THEN
        DELETE FROM ha_artifact_documents
         WHERE tenant_id = p_tenant AND project_id = p_project AND policy_epoch = p_epoch
           AND path = p_path;
        UPDATE ha_artifact_counts SET total = GREATEST(total - 1, 0)
         WHERE tenant_id = p_tenant AND project_id = p_project AND policy_epoch = p_epoch
           AND kind = previous_kind AND readers = previous_readers;
      END IF;
      INSERT INTO ha_artifact_documents(
        tenant_id, project_id, policy_epoch, readers, path, package_dir, relative, kind, sort_ms,
        occurred_at, size_bytes)
      VALUES (p_tenant, p_project, p_epoch, p_readers, p_path,
        split_part(p_path, '/', 2), substr(p_path, strpos(p_path, '/artifacts/') + 1), p_kind,
        p_sort_ms, p_occurred_at, p_size)
      ON CONFLICT (tenant_id, project_id, policy_epoch, path) DO UPDATE SET
        readers = excluded.readers, package_dir = excluded.package_dir,
        relative = excluded.relative, kind = excluded.kind, sort_ms = excluded.sort_ms,
        occurred_at = excluded.occurred_at, size_bytes = excluded.size_bytes;
      INSERT INTO ha_artifact_counts(
        tenant_id, project_id, policy_epoch, readers, kind, total)
      VALUES (p_tenant, p_project, p_epoch, p_readers, p_kind, 1)
      ON CONFLICT (tenant_id, project_id, policy_epoch, kind, readers) DO UPDATE
      SET total = ha_artifact_counts.total + 1;
    END $function$`,
  // Backfill for deployments whose documents predate this index. The caller passes the repository
  // because canonical revisions are repo-scoped while projection rows are not. The reader arrays
  // come from the projected document rows, and counts are rebuilt per reader set.
  `CREATE OR REPLACE FUNCTION ha_backfill_artifact_documents(tenant text, project text, epoch bigint, repo text)
    RETURNS integer LANGUAGE plpgsql SET search_path FROM CURRENT AS $function$
    DECLARE processed integer;
    BEGIN
      -- Reconstruct the scope's index rather than only adding rows: a partial or dirty index is
      -- repaired by the same one-time expansion, so readiness cannot hide stale outputs.
      DELETE FROM ha_artifact_documents WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch;
      DELETE FROM ha_artifact_counts WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch;
      INSERT INTO ha_artifact_documents(
        tenant_id, project_id, policy_epoch, readers, path, package_dir, relative, kind, sort_ms, occurred_at, size_bytes)
      SELECT v.tenant_id, v.project_id, v.policy_epoch, v.readers, v.entity_id,
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
        readers=excluded.readers, package_dir=excluded.package_dir, relative=excluded.relative,
        kind=excluded.kind, sort_ms=excluded.sort_ms, occurred_at=excluded.occurred_at,
        size_bytes=excluded.size_bytes;
      GET DIAGNOSTICS processed = ROW_COUNT;
      DELETE FROM ha_artifact_counts WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch;
      INSERT INTO ha_artifact_counts(tenant_id, project_id, policy_epoch, readers, kind, total)
      SELECT tenant_id, project_id, policy_epoch, readers, kind, count(*)
      FROM ha_artifact_documents WHERE tenant_id = tenant AND project_id = project AND policy_epoch = epoch
      GROUP BY tenant_id, project_id, policy_epoch, readers, kind;
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

/** The scope's reader allowlist in one canonical order, so equal sets share a count row. */
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

type CountDelta = { readonly readers: string[]; readonly kind: ArtifactTimelineKind; delta: number };

/** Flush a batch of document writes and retirements in three set-based statements. The per-document
 * form (a 34k-output projection) spent over 100s in PGlite on parse/plan and transaction overhead;
 * batching by canonical transaction keeps the same rows and exact counts at batch cost. */
export async function flushPgArtifactDocuments(
  client: PoolClient,
  scope: PgProjectionScope,
  entries: readonly PgArtifactTimelineEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const paths = entries.map(({ path }) => path),
    removed = await client.query<{ kind: ArtifactTimelineKind; readers: string[] }>(
      `DELETE FROM ha_artifact_documents
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND path = ANY($4::text[])
       RETURNING kind, readers`,
      [...scopeValues(scope), paths],
    ),
    present = entries.filter(
      (entry): entry is PgArtifactTimelineEntry & { readonly kind: ArtifactTimelineKind } => entry.kind !== null,
    );
  if (present.length > 0)
    await client.query(
      `INSERT INTO ha_artifact_documents(
         tenant_id, project_id, policy_epoch, readers, path, package_dir, relative, kind, sort_ms,
         occurred_at, size_bytes)
       SELECT $1, $2, $3, x.readers, x.path,
         split_part(x.path, '/', 2), substr(x.path, strpos(x.path, '/artifacts/') + 1),
         x.kind, x.sort_ms, x.occurred_at, x.size_bytes
       FROM jsonb_to_recordset($4::jsonb) AS x(
         path text, readers text[], kind text, sort_ms bigint, occurred_at text, size_bytes bigint)`,
      [
        ...scopeValues(scope),
        JSON.stringify(
          present.map(({ path, readers, kind, sortMs, occurredAt, sizeBytes }) => ({
            path,
            readers,
            kind,
            sort_ms: sortMs,
            occurred_at: occurredAt,
            size_bytes: sizeBytes,
          })),
        ),
      ],
    );
  const deltas = new Map<string, CountDelta>();
  const add = (readers: readonly string[], kind: ArtifactTimelineKind, delta: number) => {
    const key = `${kind}\u0000${readers.join("\u0000")}`,
      current = deltas.get(key);
    deltas.set(key, { readers: [...readers], kind, delta: (current?.delta ?? 0) + delta });
  };
  for (const row of removed.rows) add(canonicalReaders(row.readers), row.kind, -1);
  for (const entry of present) add(entry.readers, entry.kind, 1);
  const changes = [...deltas.values()].filter(({ delta }) => delta !== 0);
  if (changes.length === 0) return;
  await client.query(
    `INSERT INTO ha_artifact_counts(tenant_id, project_id, policy_epoch, readers, kind, total)
     SELECT $1, $2, $3, x.readers, x.kind, x.delta
     FROM jsonb_to_recordset($4::jsonb) AS x(readers text[], kind text, delta bigint)
     ON CONFLICT (tenant_id, project_id, policy_epoch, kind, readers) DO UPDATE
     SET total = GREATEST(ha_artifact_counts.total + excluded.total, 0)`,
    [...scopeValues(scope), JSON.stringify(changes)],
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

/** One ordered page plus maintained totals for exactly the reader sets this caller can see. */
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
  const readers = canonicalReaders(scope.readers),
    values: unknown[] = [...scopeValues(scope), readers, query.kind];
  let afterSql = "";
  if (query.after !== undefined) {
    const sortMs = -Date.parse(query.after.occurredAt);
    if (!Number.isFinite(sortMs)) throw new Error("artifact timeline cursor time is invalid");
    afterSql = "AND (a.sort_ms, a.relative, a.package_dir) > ($6, $7, $8)";
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
           AND (cardinality($4::text[]) = 0 OR t.readers && $4::text[])
         ORDER BY t.workspace_revision DESC LIMIT 1
       ) s ON true
       WHERE a.tenant_id=$1 AND a.project_id=$2 AND a.policy_epoch=$3 AND a.kind=$5
         AND (cardinality($4::text[]) = 0 OR a.readers && $4::text[])
         ${afterSql}
       ORDER BY a.sort_ms, a.relative, a.package_dir LIMIT $${limitParameter}`,
      values,
    ),
    totals = await client.query<{ readonly kind: ArtifactTimelineKind; readonly total: string | number }>(
      `SELECT kind, SUM(total) AS total FROM ha_artifact_counts
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
         AND (cardinality($4::text[]) = 0 OR readers && $4::text[])
       GROUP BY kind`,
      [...scopeValues(scope), readers],
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
