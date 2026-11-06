import type { PoolClient } from "pg";
import { projectPgArtifactDocument } from "../../src/pg/pg-artifact-timeline.ts";

export const artifactScope = { tenantId: "artifact-online", projectId: "artifact-online", policyEpoch: 1 },
  artifactRepo = "artifact-online",
  artifactPath = (n: number) => `tasks/pkg/artifacts/${String(n).padStart(6, "0")}.html`;
export const artifactMetadata = { mediaType: "text/html", policyId: "opaque-textual-whole-file/v1", size: 7 };
const keys = [artifactScope.tenantId, artifactScope.projectId, artifactScope.policyEpoch];

export async function seedArtifactUpgrade(client: PoolClient, size: number, readerCount: number): Promise<void> {
  await client.query(
    `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest) VALUES($1,$2,$3,$4,$5,'fixture','fixture','fixture')`,
    [...keys, artifactRepo, size],
  );
  await client.query(
    `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision,artifact_index_version)
    VALUES($1,$2,$3,5,$4,$4,0)`,
    [...keys, size],
  );
  await client.query(
    `INSERT INTO ha_events(tenant_id,project_id,policy_epoch,repo_id,revision,op_id,event_id,event_type,event_json,event_digest,occurred_at)
    SELECT $1,$2,$3,$4,n,'op-'||n,'event-'||n,'doc_written',
      json_build_object('schema','document-event/v1','type','doc_written','workspaceRevision',n)::text,'fixture','2026-11-06T00:00:00.000Z'
    FROM generate_series(1,$5::integer)n`,
    [...keys, artifactRepo, size],
  );
  await client.query(
    `INSERT INTO ha_projection_values(tenant_id,project_id,policy_epoch,model,owner_id,entity_id,workspace_revision,value,readers)
    SELECT $1,$2,$3,'document','','tasks/pkg/artifacts/'||lpad(n::text,6,'0')||'.html',n,
      json_build_object('body','fixture','mediaType','text/html','policyId','opaque-textual-whole-file/v1','size',7)::text,
      ARRAY(SELECT 'reader-'||r FROM generate_series(1,$5::integer)r) FROM generate_series(1,$4::integer)n`,
    [...keys, size, readerCount],
  );
  // A previous cache can contain both stale rows and incorrect counts; bounded cleanup repairs it.
  await client.query(
    `INSERT INTO ha_artifact_documents(tenant_id,project_id,policy_epoch,all_readers,reader,readers,path,package_dir,relative,kind,sort_ms,occurred_at,size_bytes)
    SELECT $1,$2,$3,true,'','{}',entity_id,'pkg',substr(entity_id,strpos(entity_id,'/artifacts/')+1),'html',-1,'2026-11-06T00:00:00.000Z',7
    FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='document'`,
    keys,
  );
  await client.query(
    `INSERT INTO ha_artifact_counts(tenant_id,project_id,policy_epoch,all_readers,reader,kind,total)
    VALUES($1,$2,$3,true,'','html',99)`,
    keys,
  );
}

/** Exercise the canonical projection write + the same transaction's derived artifact maintenance. */
export async function replaceArtifact(client: PoolClient, n: number, readers: string[], kind: "html" | "md" = "html") {
  const document = { ...artifactMetadata, mediaType: kind === "html" ? "text/html" : "text/markdown" };
  await client.query(
    `UPDATE ha_projection_values SET value=$4,readers=$5 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
    AND model='document' AND owner_id='' AND entity_id=$6`,
    [...keys, JSON.stringify({ body: "new", ...document }), readers, artifactPath(n)],
  );
  await projectPgArtifactDocument(
    client,
    { ...artifactScope, readers },
    artifactPath(n),
    document,
    "2026-11-06T00:00:00.000Z",
  );
}
