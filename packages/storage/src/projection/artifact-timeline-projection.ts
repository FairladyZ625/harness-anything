import type { DatabaseSync } from "node:sqlite";
import type { ArtifactTimelineKind, ArtifactTimelineQuery, ArtifactTimelineRead } from "@harness-anything/kernel";
import { queryRows, runSql } from "./rebuildable-task-projection-sql.ts";

/**
 * Ordered artifact timeline index (G38 read side, dec_72FADB86/CH3).
 *
 * The GUI timeline asks for one page of one facet ordered by ledger time desc. Walking every task
 * package's `artifacts/` subtree answers that question but costs the whole repository's output
 * history, and a filesystem directory carries no time order to page on. This projection table is
 * maintained in the same transaction as the document row, so a page is an index range read and the
 * per-kind counts are totals instead of a scan.
 *
 * A row exists exactly when the document is a task-package artifact the timeline can display:
 * `tasks/<package>/artifacts/...` whose claim is HTML, Markdown, or a claimed raw artifact. The
 * facet comes from the claim's media type/policy (the same fields the write boundary validated),
 * never from disk inspection, so the timeline is the ledger's view of committed outputs.
 */
export const ARTIFACT_TIMELINE_KINDS: readonly ArtifactTimelineKind[] = ["html", "md", "raw"];

/** Artifact facet of one projected document; null means "not a timeline artifact". */
const artifactKindOf = (expression: string): string =>
  [
    `CASE WHEN json_extract(${expression}, '$.mediaType') = 'text/html' THEN 'html'`,
    "WHEN json_extract(" + expression + ", '$.mediaType') = 'text/markdown' THEN 'md'",
    "ELSE 'raw' END",
  ].join(" ");
const isTimelineArtifact = (expression: string): string =>
  [
    `json_extract(${expression}, '$.mediaType') IN ('text/html', 'text/markdown')`,
    `OR json_extract(${expression}, '$.policyId') = 'raw-artifact-bytes/v1'`,
  ].join(" ");

/** Bounded MILISCECOND sort key: timeline order is time desc, so the index stores the negated
 * occurrence time and the query orders ascending. VARCHAR time comparison cannot use a page
 * cursor with an ascending relative path in the same row-value comparison. */
const sortMillisecondsOf = (timestampExpression: string): string =>
  `-CAST(ROUND((julianday(${timestampExpression}) - 2440587.5) * 86400000) AS INTEGER)`;

const documentArtifactRowSql = (): string => {
  const source = "NEW",
    value = "NEW.value_json",
    path = "NEW.path";
  return [
    "SELECT",
    `${path},`,
    `substr(${path}, 7, instr(substr(${path}, 7), '/') - 1),`,
    `substr(${path}, instr(${path}, '/artifacts/') + 1),`,
    `${artifactKindOf(value)},`,
    `${sortMillisecondsOf("(SELECT json_extract(event_json, '$.occurredAt') FROM event_index WHERE workspace_revision = " + source + ".workspace_revision)")},`,
    "(SELECT json_extract(event_json, '$.occurredAt') FROM event_index WHERE workspace_revision = " +
      source +
      ".workspace_revision),",
    `json_extract(${value}, '$.size')`,
  ].join(" ");
};

/** Column order every INSERT below uses. */
const artifactDocumentColumns = "(path, package_dir, relative, kind, sort_ms, occurred_at, size_bytes)";

const artifactDocumentUpsert =
  "ON CONFLICT(path) DO UPDATE SET package_dir=excluded.package_dir, " +
  "relative=excluded.relative, kind=excluded.kind, sort_ms=excluded.sort_ms, " +
  "occurred_at=excluded.occurred_at, size_bytes=excluded.size_bytes";

export const ARTIFACT_TIMELINE_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS artifact_document (
      path TEXT PRIMARY KEY,
      package_dir TEXT NOT NULL,
      relative TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('html', 'md', 'raw')),
      sort_ms INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      size_bytes INTEGER NOT NULL
    );
    -- One facet page is (kind, sort_ms, relative, package_dir): the row-value cursor consumes the
    -- last three columns in the same order the timeline compares them.
    CREATE INDEX IF NOT EXISTS artifact_document_page
      ON artifact_document(kind, sort_ms, relative, package_dir);
    CREATE TABLE IF NOT EXISTS artifact_count (
      kind TEXT PRIMARY KEY,
      total INTEGER NOT NULL
    );
    -- Reconcile a document write in both directions: an overwritten path may enter or leave the
    -- timeline, and a retirement removes it. Counts are only touched by real transitions.
    CREATE TRIGGER IF NOT EXISTS document_artifact_insert AFTER INSERT ON document
    WHEN NEW.path LIKE 'tasks/%/artifacts/%'
    BEGIN
      INSERT INTO artifact_document ${artifactDocumentColumns}
      ${documentArtifactRowSql()}
      WHERE (${isTimelineArtifact("NEW.value_json")})
        AND (SELECT json_extract(event_json, '$.occurredAt') FROM event_index WHERE workspace_revision = NEW.workspace_revision) IS NOT NULL
      ${artifactDocumentUpsert};
      INSERT INTO artifact_count(kind, total)
      SELECT kind, 1 FROM artifact_document WHERE path = NEW.path
      ON CONFLICT(kind) DO UPDATE SET total = total + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS document_artifact_update AFTER UPDATE OF workspace_revision, value_json ON document
    WHEN NEW.path LIKE 'tasks/%/artifacts/%'
    BEGIN
      UPDATE artifact_count SET total = total - 1
      WHERE kind = (SELECT kind FROM artifact_document WHERE path = OLD.path);
      INSERT INTO artifact_document ${artifactDocumentColumns}
      ${documentArtifactRowSql()}
      WHERE (${isTimelineArtifact("NEW.value_json")})
        AND (SELECT json_extract(event_json, '$.occurredAt') FROM event_index WHERE workspace_revision = NEW.workspace_revision) IS NOT NULL
      ${artifactDocumentUpsert};
      DELETE FROM artifact_document
      WHERE path = NEW.path AND NOT (${isTimelineArtifact("NEW.value_json")});
      INSERT INTO artifact_count(kind, total)
      SELECT kind, 1 FROM artifact_document WHERE path = NEW.path
      ON CONFLICT(kind) DO UPDATE SET total = total + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS document_artifact_delete AFTER DELETE ON document
    WHEN OLD.path LIKE 'tasks/%/artifacts/%'
    BEGIN
      UPDATE artifact_count SET total = total - 1
      WHERE kind = (SELECT kind FROM artifact_document WHERE path = OLD.path);
      DELETE FROM artifact_document WHERE path = OLD.path;
    END;`;

const artifactBackfillKey = "artifact-timeline-v1",
  artifactBackfillPage = 500;

/**
 * Additive expansion for caches written before the index existed. Full replay is not survivable at
 * canonical scale (projection-schema.ts:38 records the measured attach watchdog), so this rewrites
 * only the index: bounded path pages read the already-projected document rows, then counts are
 * recomputed from the index. The marker makes it a one-time migration.
 */
export function ensureArtifactTimelineBackfill(db: DatabaseSync): void {
  if (queryRows(db, "SELECT 1 FROM projection_maintenance WHERE key = ?", artifactBackfillKey).length > 0) return;
  let cursor = "";
  for (;;) {
    const paths = queryRows<{ readonly path: string } & Record<string, string>>(
      db,
      "SELECT path FROM document WHERE path LIKE 'tasks/%/artifacts/%' AND path > ? ORDER BY path LIMIT ?",
      cursor,
      artifactBackfillPage,
    );
    if (paths.length === 0) break;
    cursor = paths.at(-1)!.path;
    runSql(
      db,
      [
        `INSERT INTO artifact_document ${artifactDocumentColumns}`,
        "SELECT document.path,",
        "substr(document.path, 7, instr(substr(document.path, 7), '/') - 1),",
        "substr(document.path, instr(document.path, '/artifacts/') + 1),",
        `${artifactKindOf("document.value_json")},`,
        `${sortMillisecondsOf("(SELECT json_extract(event_json, '$.occurredAt') FROM event_index WHERE workspace_revision = document.workspace_revision)")},`,
        "(SELECT json_extract(event_json, '$.occurredAt') FROM event_index WHERE workspace_revision = document.workspace_revision),",
        "json_extract(document.value_json, '$.size')",
        "FROM document WHERE document.path IN (SELECT value FROM json_each(?))",
        `AND (${isTimelineArtifact("document.value_json")})`,
        "AND (SELECT json_extract(event_json, '$.occurredAt') FROM event_index WHERE workspace_revision = document.workspace_revision) IS NOT NULL",
        artifactDocumentUpsert,
      ].join(" "),
      JSON.stringify(paths.map(({ path }) => path)),
    );
  }
  runSql(db, "DELETE FROM artifact_count");
  runSql(db, "INSERT INTO artifact_count(kind, total) SELECT kind, COUNT(*) FROM artifact_document GROUP BY kind");
  runSql(
    db,
    "INSERT INTO projection_maintenance(key, completed_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    artifactBackfillKey,
  );
}

const checkedTimelineLimit = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500)
    throw new Error("artifact timeline page limit must be an integer between 1 and 500");
  return value;
};

/** One ordered page plus the maintained per-kind totals; the caller supplies the projection cut. */
export function readArtifactTimelineRows(
  db: DatabaseSync,
  query: ArtifactTimelineQuery,
): Pick<ArtifactTimelineRead, "rows" | "hasMore" | "counts" | "countsCapped"> {
  if (!ARTIFACT_TIMELINE_KINDS.includes(query.kind)) throw new Error("artifact timeline kind is invalid");
  const limit = checkedTimelineLimit(query.limit),
    values: (string | number)[] = [query.kind];
  let afterSql = "";
  if (query.after !== undefined) {
    const sortMs = -Date.parse(query.after.occurredAt);
    if (!Number.isFinite(sortMs)) throw new Error("artifact timeline cursor time is invalid");
    afterSql = "AND (a.sort_ms, a.relative, a.package_dir) > (?, ?, ?)";
    values.push(sortMs, query.after.relative, query.after.packageDir);
  }
  values.push(limit + 1);
  const rows = queryRows<{
    readonly package_dir: string;
    readonly relative: string;
    readonly kind: ArtifactTimelineKind;
    readonly occurred_at: string;
    readonly size_bytes: number;
    readonly task_id: string | null;
    readonly title: string | null;
  }>(
    db,
    [
      "SELECT a.package_dir, a.relative, a.kind, a.occurred_at, a.size_bytes,",
      "p.task_id, json_extract(s.snapshot_json, '$.task.title') AS title",
      "FROM artifact_document a",
      "LEFT JOIN task_package p ON p.package_path = 'tasks/' || a.package_dir",
      "LEFT JOIN task_snapshot s ON s.task_id = p.task_id",
      `WHERE a.kind = ? ${afterSql}`,
      "ORDER BY a.sort_ms, a.relative, a.package_dir",
      "LIMIT ?",
    ].join(" "),
    ...values,
  );
  const counts: Record<ArtifactTimelineKind, number> = { html: 0, md: 0, raw: 0 };
  for (const row of queryRows<{ readonly kind: ArtifactTimelineKind; readonly total: number }>(
    db,
    "SELECT kind, total FROM artifact_count",
  ))
    counts[row.kind] = row.total;
  return {
    rows: rows.slice(0, limit).map((row) => ({
      packageDir: row.package_dir,
      relative: row.relative,
      kind: row.kind,
      occurredAt: row.occurred_at,
      sizeBytes: row.size_bytes,
      taskId: row.task_id,
      taskTitle: row.title,
      packagePath: row.task_id === null ? null : `tasks/${row.package_dir}`,
    })),
    hasMore: rows.length > limit,
    counts,
    // SQLite holds no reader union: every value above is a maintained exact total.
    countsCapped: { html: false, md: false, raw: false },
  };
}
