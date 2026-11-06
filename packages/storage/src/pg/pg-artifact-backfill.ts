import type { PoolClient } from "pg";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { artifactTimelineEntry } from "./pg-artifact-timeline.ts";

interface Progress {
  phase: number;
  cursor: Record<string, unknown> | null;
  upper_bound: string | null;
}
interface DocumentRow {
  entity_id: string;
  readers: string[];
  metadata: { mediaType: string; policyId?: string; size: number };
  occurred_at: string | null;
}

/** One writer transaction: clean at most 64 old rows, or visit at most 64 document/reader units.
 * Phase/cursor and exact counts commit together. Only a zero document page certifies readiness.
 * Retire this pre-timeline upgrade after 2026-12-05 (dec_659E15CF).
 */
export async function backfillPgArtifactDocumentsPage(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
): Promise<number> {
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch];
  await client.query(
    `INSERT INTO ha_artifact_backfill(tenant_id,project_id,policy_epoch) VALUES($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    keys,
  );
  const state = (
    await client.query<Progress>(
      "SELECT phase,cursor,upper_bound FROM ha_artifact_backfill WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 FOR UPDATE",
      keys,
    )
  ).rows[0]!;
  const save = (phase: number, cursor: unknown, upper = state.upper_bound) =>
    client.query(
      `UPDATE ha_artifact_backfill SET phase=$4,cursor=$5::jsonb,upper_bound=$6
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`,
      [...keys, phase, JSON.stringify(cursor), upper],
    );
  if (state.phase < 2) {
    const table = state.phase === 0 ? "ha_artifact_documents" : "ha_artifact_counts",
      columns = state.phase === 0 ? ["all_readers", "reader", "path"] : ["all_readers", "reader", "kind"],
      after = state.cursor ? `AND (${columns.join(",")}) > ($4,$5,$6)` : "",
      page = await client.query<Record<string, unknown>>(
        `WITH batch AS MATERIALIZED (
           SELECT ctid,${columns.join(",")} FROM ${table}
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 ${after}
           ORDER BY ${columns.join(",")} LIMIT 64
         ), removed AS (
           DELETE FROM ${table} d WHERE d.ctid=ANY(ARRAY(SELECT ctid FROM batch))
           RETURNING ${columns.map((column) => `d.${column}`).join(",")}
         ) SELECT * FROM removed ORDER BY ${columns.join(",")}`,
        [...keys, ...(state.cursor ? columns.map((column) => state.cursor![column]) : [])],
      );
    if (page.rows.length) await save(state.phase, page.rows.at(-1));
    else {
      // Capture a finite key boundary only after cleanup. New writes during cleanup are in
      // canonical documents; writes during copying maintain their index, even behind the cursor.
      const upper =
        state.phase === 1
          ? ((
              await client.query<{ entity_id: string }>(
                `SELECT entity_id FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
         AND model='document' AND owner_id='' ORDER BY entity_id DESC LIMIT 1`,
                keys,
              )
            ).rows[0]?.entity_id ?? "")
          : null;
      await save(state.phase + 1, null, upper);
    }
    return page.rows.length;
  }
  const afterEntity = String(state.cursor?.entity ?? ""),
    afterOffset = Number(state.cursor?.offset ?? 0),
    documents = (
      await client.query<DocumentRow>(
        `WITH batch AS MATERIALIZED (
         SELECT entity_id,readers,workspace_revision,document_metadata,value FROM ha_projection_values
         WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='document' AND owner_id=''
           AND entity_id ${afterOffset ? ">=" : ">"} $4 AND entity_id <= $5 ORDER BY entity_id LIMIT 64
       ) SELECT v.entity_id,v.readers,
           COALESCE(v.document_metadata,ha_document_metadata_from_value(v.value))::jsonb AS metadata,e.occurred_at
         FROM batch v LEFT JOIN LATERAL (
           SELECT occurred_at FROM ha_events e WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.repo_id=$6
             AND e.revision=v.workspace_revision LIMIT 1
         ) e ON true ORDER BY v.entity_id`,
        [...keys, afterEntity, state.upper_bound, repoId],
      )
    ).rows;
  if (!documents.length) {
    await save(3, state.cursor);
    await client.query(
      `UPDATE ha_projection_meta SET artifact_index_version=1
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
      keys,
    );
    await client.query(
      "DELETE FROM ha_artifact_backfill WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
      keys,
    );
    return 0;
  }
  let processed = 0,
    cursor = state.cursor;
  const rows: Record<string, unknown>[] = [];
  for (const document of documents) {
    const entry =
      document.occurred_at === null
        ? null
        : artifactTimelineEntry(
            { ...scope, readers: document.readers },
            document.entity_id,
            document.metadata,
            document.occurred_at,
          );
    if (entry?.kind) {
      const offset = Math.min(document.entity_id === afterEntity ? afterOffset : 0, entry.readers.length + 1),
        end = Math.min(entry.readers.length + 1, offset + 64 - processed);
      for (let index = offset; index < end; index++)
        rows.push({
          path: entry.path,
          readers: entry.readers,
          all_readers: index === 0,
          reader: index === 0 ? "" : entry.readers[index - 1],
          kind: entry.kind,
          sort_ms: entry.sortMs,
          occurred_at: entry.occurredAt,
          size_bytes: entry.sizeBytes,
        });
      processed += Math.max(end - offset, 1);
      cursor = { entity: document.entity_id, offset: end === entry.readers.length + 1 ? 0 : end };
    } else {
      processed++;
      cursor = { entity: document.entity_id, offset: 0 };
    }
    if (processed === 64) break;
  }
  // Foreground writes may already have installed a complete path. Only newly inserted rows
  // contribute to counts; a partial old revision is removed by the ordinary replacement write.
  await client.query(
    `WITH inserted AS (
       INSERT INTO ha_artifact_documents(tenant_id,project_id,policy_epoch,all_readers,reader,readers,path,
         package_dir,relative,kind,sort_ms,occurred_at,size_bytes)
       SELECT $1,$2,$3,x.all_readers,x.reader,x.readers,x.path,split_part(x.path,'/',2),
         substr(x.path,strpos(x.path,'/artifacts/')+1),x.kind,x.sort_ms,x.occurred_at,x.size_bytes
       FROM jsonb_to_recordset($4::jsonb) AS x(all_readers boolean,reader text,readers text[],path text,
         kind text,sort_ms bigint,occurred_at text,size_bytes bigint)
       ON CONFLICT DO NOTHING RETURNING all_readers,reader,kind
     ) INSERT INTO ha_artifact_counts(tenant_id,project_id,policy_epoch,all_readers,reader,kind,total)
       SELECT $1,$2,$3,all_readers,reader,kind,count(*) FROM inserted GROUP BY all_readers,reader,kind
       ON CONFLICT (tenant_id,project_id,policy_epoch,all_readers,reader,kind)
       DO UPDATE SET total=ha_artifact_counts.total+excluded.total`,
    [...keys, JSON.stringify(rows)],
  );
  await save(2, cursor);
  return processed;
}
