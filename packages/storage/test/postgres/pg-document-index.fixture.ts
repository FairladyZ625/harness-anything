import assert from "node:assert/strict";
import type { Pool } from "pg";
import { pgValueQueries } from "../../src/pg/pg-value-queries.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { putPgProjectionValue } from "../../src/pg/pg-projection-values.ts";

const scope = { tenantId: "document-index", projectId: "document-index", policyEpoch: 1 };

/** Exercise the production read, including its RLS identity, and explain the SQL it actually issues. */
export async function assertDocumentIndex(pool: Pool, seedPool: Pool, backend: string): Promise<void> {
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `INSERT INTO ha_projection_values
      (tenant_id,project_id,policy_epoch,model,entity_id,owner_id,workspace_revision,value)
      SELECT $1,$2,$3,'document','history/' || lpad(n::text,6,'0'),'',1,
        json_build_object('body','old','path','history/' || lpad(n::text,6,'0'),
          'blobSha256','digest','size',3,'mediaType','text/plain','workspaceRevision',1)::text
      FROM generate_series(1,100000) n`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      for (const path of ["target/%_/a", "target/%_/b", "target/%_/深😀", "target/other", "target/%_0", "最大/😀/a"])
        await putPgProjectionValue(client, scope, "document", path, "", 2, {
          path,
          body: "body\0😀",
          blobSha256: "digest",
          size: 9,
          mediaType: "text/plain",
          workspaceRevision: 2,
        });
      await client.query(
        `INSERT INTO ha_task_snapshots
      (tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot,package_path)
      VALUES ($1,$2,$3,'parent',1,'{}','tasks/parent'),
        ($1,$2,$3,'child',1,'{}','tasks/parent/nested')`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query("ANALYZE ha_projection_values");
    },
    scope,
  );
  const plans: unknown[] = [];
  const traced = new Proxy(pool, {
    get(target, property) {
      if (property !== "connect") {
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, key) {
            if (key === "query")
              return async (...args: unknown[]) => {
                if (typeof args[0] === "string" && args[0].includes("SELECT document_metadata")) {
                  const explained = await connection.query(
                    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${args[0]}`,
                    args[1] as unknown[],
                  );
                  plans.push(explained.rows[0]["QUERY PLAN"]);
                }
                return Reflect.apply(connection.query, connection, args);
              };
            const value: unknown = Reflect.get(connection, key);
            return typeof value === "function" ? value.bind(connection) : value;
          },
        });
      };
    },
  });
  const queries = pgValueQueries({ pool: traced, scope, repoId: "document-index" });
  assert.deepEqual(
    (await queries.readDocuments("target/%_/")).documents.map(({ path }) => path),
    ["target/%_/a", "target/%_/b", "target/%_/深😀"],
  );
  process.stdout.write(`DOCUMENT_INDEX ${backend} ${JSON.stringify(plans)}\n`);
  const nodes = (plan: unknown): Record<string, unknown>[] => {
    if (Array.isArray(plan)) return plan.flatMap(nodes);
    if (typeof plan !== "object" || plan === null) return [];
    const row = plan as Record<string, unknown>;
    return [row, ...Object.values(row).flatMap(nodes)];
  };
  const scans = nodes(plans).filter((row) => row["Relation Name"] === "ha_projection_values");
  assert.ok(scans.length > 0, "the real production query must be explained");
  for (const scan of scans) {
    assert.ok(
      Number(scan["Actual Rows"]) + Number(scan["Rows Removed by Filter"] ?? 0) <= 4,
      `document prefix scanned history: ${JSON.stringify(scan)}`,
    );
  }
  assert.deepEqual(
    (await queries.readDocuments("最大/😀/")).documents.map(({ path }) => path),
    ["最大/😀/a"],
  );
  const first = await queries.readDocuments("target/%_/", { limit: 2 });
  assert.deepEqual(
    first.documents.map((row) => row.path),
    ["target/%_/a", "target/%_/b"],
  );
  assert.equal(first.page!.nextPath, "target/%_/b");
  const last = await queries.readDocuments("target/%_/", { limit: 2, afterPath: first.page!.nextPath! });
  assert.deepEqual(
    last.documents.map((row) => row.path),
    ["target/%_/深😀"],
  );
  assert.equal(last.page!.nextPath, null);
  assert.deepEqual(
    (await queries.readDocuments("target/%_/", { limit: 2, afterPath: "target/%_/深😀" })).documents,
    [],
  );
  assert.deepEqual((await queries.readDocuments("absent/")).documents, []);
  assert.equal((await queries.readDocuments("")).documents.length, 100006);
  assert.equal(await queries.taskIdForDocumentPath("tasks/parent/nested/a.md"), "child");
  assert.equal(await queries.taskIdForDocumentPath("tasks/parent/nested"), "child");
  assert.equal(await queries.taskIdForDocumentPath("tasks/parent/nested-neighbor/a.md"), "parent");
  assert.equal(await queries.taskIdForDocumentPath("tasks/parentish/a.md"), null);
}
