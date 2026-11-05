// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { artifactTimelineDdl } from "../../src/pg/pg-artifact-timeline.ts";
import { PG_PROJECTION_TABLES, projectionDdl } from "../../src/pg/pg-projection-schema.ts";

test("the artifact timeline tables join the projection registry that owns grants, RLS and rebuild cleanup", () => {
  for (const table of ["ha_artifact_documents", "ha_artifact_counts"])
    assert.ok(
      (PG_PROJECTION_TABLES as readonly string[]).includes(table),
      `${table} must be in PG_PROJECTION_TABLES so grantPgProjectionRuntimeAccess, the scope RLS policy and rebuild cleanup all include it`,
    );
  const ddl = projectionDdl().join("\n");
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS ha_artifact_documents/u);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS ha_artifact_counts/u);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS ha_artifact_documents_page/u);
  assert.match(ddl, /artifact_index_version/u);
});

test("the artifact timeline tables carry tenant scope, readers and the ordered page index", () => {
  const ddl = artifactTimelineDdl().join("\n");
  assert.match(ddl, /ha_artifact_documents[\s\S]*readers text\[\] NOT NULL/u);
  assert.match(ddl, /PRIMARY KEY \(tenant_id, project_id, policy_epoch, reader, path\)/u);
  assert.match(ddl, /ha_artifact_counts[\s\S]*PRIMARY KEY \(tenant_id, project_id, policy_epoch, reader, kind\)/u);
  assert.match(ddl, /\(tenant_id, project_id, policy_epoch, reader, kind, sort_ms, relative, package_dir\)/u);
  assert.match(ddl, /relative text NOT NULL COLLATE "C"/u);
  assert.match(ddl, /package_dir text NOT NULL COLLATE "C"/u);
  assert.match(ddl, /substr\(v\.entity_id, strpos\(v\.entity_id, '\/artifacts\/'\) \+ 1\)/u);
});
