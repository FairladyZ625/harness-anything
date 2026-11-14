// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { createPgTaskQueryReader } from "../../src/pg/pg-task-query-reader.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { backfillPgRelationReaderIndexPage, relationReaderIndexDdl } from "../../src/pg/pg-relation-queries.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import {
  readTaskDependencyClosureRows,
  readTaskRelationNeighborhoodWindow,
} from "../../src/projection/task-query-projection.ts";
import { pgRuntimeFixture } from "../postgres/pg-runtime.fixture.ts";

const scope = { tenantId: "bounded", projectId: "relation", policyEpoch: 1, readers: ["one", "two"] };
const ids = (rows) => rows.map(({ relationId }) => relationId);
async function fixture(backend) {
  if (backend === "postgres") {
    const native = await pgRuntimeFixture();
    return {
      ...native,
      close: async () => {
        await native.pool.end();
        await native.close();
      },
    };
  }
  const embedded = await createPGliteStorageBackend({ repoId: "bounded", storage: { backend: "pglite", scope } });
  return { ...embedded, adminPool: embedded.pool };
}
async function edge(pool, id, source, target, extra = {}) {
  const { readers = scope.readers, type = "depends-on", state = "active", tenant = scope.tenantId } = extra;
  const value = {
    id,
    revision: 1,
    source,
    target,
    type,
    state,
    direction: "directed",
    origin: "declared",
    strength: "strong",
    rationale: "fixture",
    targetObservedVersion: null,
    sourcePath: "fixture",
    recordIndex: 0,
  };
  // Only columns the previous binary knew, including for migration and ACL updates.
  await pool.query(
    `INSERT INTO ha_relations(tenant_id,project_id,policy_epoch,readers,relation_id,source_ref,target_ref,
    relation_type,relation_state,workspace_revision,value,freshness) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,'current')`,
    [tenant, scope.projectId, scope.policyEpoch, readers, id, source, target, type, state, value],
  );
  return value;
}
async function scoped(pool, operation) {
  return withPostgresTransaction(pool, operation, scope);
}
function capture(operation) {
  try {
    return { ids: ids(operation().rows) };
  } catch (error) {
    if (!/depth limit|node budget/u.test(error.message)) throw error;
    return { error: error.message };
  }
}
test("postgres production open completes reader-key expansion independently for each scope", async () => {
  const f = await fixture("postgres");
  try {
    await f.adminPool.query("DROP TRIGGER ha_relation_reader_index_mark ON ha_relations");
    await f.adminPool.query("DROP TRIGGER ha_relation_reader_index_sync ON ha_relations");
    for (const tenant of [scope.tenantId, "second-scope"])
      for (let i = 0; i < 130; i++)
        await edge(f.adminPool, `legacy-${String(i).padStart(3, "0")}`, "task/old", `task/${i}`, { tenant });
    const client = await f.adminPool.connect();
    try {
      await ensurePgProjectionSchema(client, { indexBuild: "isolated" });
    } finally {
      client.release();
    }
    for (const tenantId of [scope.tenantId, "second-scope"]) {
      const reader = createPgTaskQueryReader({
        connectionString: f.connectionString,
        requireRuntimeRole: true,
        scope: { ...scope, tenantId },
        repoId: "bounded",
      });
      try {
        assert.equal(
          (
            await f.adminPool.query(
              "SELECT count(*)::integer AS n FROM ha_relations WHERE tenant_id=$1 AND reader_index_version=0",
              [tenantId],
            )
          ).rows[0].n,
          0,
          "production startup must commit the expansion before handing off this scope",
        );
        assert.deepEqual(ids(reader.withSession((queries) => queries.readRelationQuery({ limit: 1 })).rows), [
          "legacy-000",
        ]);
        if (tenantId === scope.tenantId)
          assert.equal(
            (
              await f.adminPool.query(
                "SELECT count(*)::integer AS n FROM ha_relations WHERE tenant_id='second-scope' AND reader_index_version=0",
              )
            ).rows[0].n,
            130,
            "opening one scope must leave the other scope for its own startup",
          );
      } finally {
        reader.close();
      }
    }
  } finally {
    await f.close();
  }
});
async function captureAsync(operation) {
  try {
    return { ids: ids((await operation()).rows) };
  } catch (error) {
    if (!/depth limit|node budget/u.test(error.message)) throw error;
    return { error: error.message };
  }
}
for (const backend of ["postgres", "pglite"]) {
  const runtime = {
    skip:
      backend === "pglite" && Number(process.versions.node.split(".")[0]) < 26
        ? "PGlite database assertions require Node 26"
        : false,
  };
  test(
    `${backend} relation owner, endpoint and overlapping authorization pages preserve identity`,
    runtime,
    async () => {
      const f = await fixture(backend),
        source = createPgTaskProjectionSource({ pool: f.pool, repoId: "bounded", scope });
      try {
        const owners = [
          "decision/dec_A",
          "decision/dec_A/CH1",
          "decision/dec_A/C2",
          "decision/dec_AA/CH1",
          "task/a",
          "fact/F-a",
        ];
        for (const [index, owner] of owners.entries())
          await edge(f.adminPool, `r${index}`, owner, "task/target", {
            readers: index === 2 ? ["two"] : index === 3 ? ["hidden"] : ["one", "two", "one"],
            type: index % 2 ? "derives" : "depends-on",
            state: index === 4 ? "retired" : "active",
          });
        await edge(f.adminPool, "r-foreign", "decision/dec_A/CH2", "task/target", { tenant: "foreign" });
        assert.deepEqual(ids((await source.readRelationQuery({ ownerRef: "decision/dec_A" })).rows), [
          "r0",
          "r1",
          "r2",
        ]);
        assert.deepEqual(ids((await source.readRelationQuery({ ownerRef: "decision/dec_A/CH1" })).rows), []);
        assert.deepEqual(ids((await source.readRelationQuery({ ownerRef: "task/a" })).rows), ["r4"]);
        assert.deepEqual(
          ids((await source.readTaskRelationsByTargets(["missing", "task/target", "task/target"])).rows),
          ["r0", "r1", "r2", "r4", "r5"],
        );
        assert.deepEqual(ids((await source.readTaskRelationsBySources([owners[2], owners[0], owners[0]])).rows), [
          "r0",
          "r2",
        ]);
        assert.deepEqual((await source.readTaskRelationsBySources([])).rows, []);
        assert.deepEqual((await source.readTaskRelationsByTargets([])).rows, []);
        for (const filter of [
          {},
          { relationType: "depends-on" },
          { state: "active" },
          { relationType: "derives", state: "active" },
        ]) {
          const expected = ids((await source.readRelationQuery(filter)).rows),
            actual = [];
          let cursor;
          do {
            const result = await source.readRelationQuery({ ...filter, limit: 1, ...(cursor ? { cursor } : {}) });
            actual.push(...ids(result.rows));
            cursor = result.page.nextCursor;
          } while (cursor !== null);
          assert.deepEqual(actual, expected, JSON.stringify(filter));
        }
        // The old writer changes only readers; a revocation must disappear on the next cut.
        const first = await source.readRelationQuery({ limit: 1 });
        await f.adminPool.query(
          "UPDATE ha_relations SET readers=ARRAY['hidden'] WHERE relation_id='r1' AND tenant_id=$1",
          [scope.tenantId],
        );
        assert.deepEqual(ids((await source.readRelationQuery({ limit: 1, cursor: first.page.nextCursor })).rows), [
          "r2",
        ]);
        await f.adminPool.query(
          "UPDATE ha_relations SET readers=ARRAY['one'],relation_state='retired',relation_type='awaits' WHERE relation_id='r2' AND tenant_id=$1",
          [scope.tenantId],
        );
        assert.deepEqual(
          ids((await source.readRelationQuery({ relationType: "awaits", state: "retired", limit: 2 })).rows),
          ["r2"],
        );
        await f.adminPool.query("DELETE FROM ha_relations WHERE relation_id='r2' AND tenant_id=$1", [scope.tenantId]);
        assert.deepEqual(
          ids((await source.readRelationQuery({ relationType: "awaits", state: "retired", limit: 2 })).rows),
          [],
        );
        const hidden = createPgTaskProjectionSource({
          pool: f.pool,
          repoId: "bounded",
          scope: { ...scope, readers: ["nobody"] },
        });
        assert.deepEqual((await hidden.readRelationQuery({ limit: 1 })).rows, []);
        const admin = createPgTaskProjectionSource({
          pool: f.pool,
          repoId: "bounded",
          scope: { ...scope, readers: [] },
        });
        assert.equal((await admin.readRelationQuery({ limit: 100 })).rows.length, 5);
        if (backend === "postgres")
          assert.equal(
            (await f.pool.query("SELECT * FROM ha_relation_reader_keys")).rows.length,
            0,
            "forced RLS denies missing scope",
          );
      } finally {
        await f.close();
      }
    },
  );
  test(`${backend} expansion keeps previous pages readable until committed backfill completes`, runtime, async () => {
    const f = await fixture(backend),
      source = createPgTaskProjectionSource({ pool: f.pool, repoId: "bounded", scope });
    try {
      await f.adminPool.query("DROP TRIGGER ha_relation_reader_index_mark ON ha_relations");
      await f.adminPool.query("DROP TRIGGER ha_relation_reader_index_sync ON ha_relations");
      for (let i = 0; i < 130; i++)
        await edge(f.adminPool, `old-${String(i).padStart(3, "0")}`, "task/old", `task/${i}`);
      const client = await f.adminPool.connect();
      try {
        await ensurePgProjectionSchema(client, { indexBuild: "isolated" });
      } finally {
        client.release();
      }
      const first = await source.readRelationQuery({ limit: 1 });
      assert.deepEqual(ids(first.rows), ["old-000"]);
      assert.equal(
        (
          await scoped(f.pool, (client) =>
            client.query("SELECT count(*)::integer AS n FROM ha_relations WHERE reader_index_version=0"),
          )
        ).rows[0].n,
        130,
        "reads must not lazily backfill",
      );
      assert.equal(await scoped(f.pool, (client) => backfillPgRelationReaderIndexPage(client, scope)), 64);
      assert.deepEqual(ids((await source.readRelationQuery({ limit: 1, cursor: first.page.nextCursor })).rows), [
        "old-001",
      ]);
      assert.equal(await scoped(f.pool, (client) => backfillPgRelationReaderIndexPage(client, scope)), 64);
      assert.equal(await scoped(f.pool, (client) => backfillPgRelationReaderIndexPage(client, scope)), 2);
      assert.equal(await scoped(f.pool, (client) => backfillPgRelationReaderIndexPage(client, scope)), 0);
      assert.deepEqual(ids((await source.readRelationQuery({ limit: 1 })).rows), ["old-000"]);
      const rows = await scoped(f.pool, (client) =>
        client.query("SELECT count(*)::integer AS n FROM ha_relation_reader_keys"),
      );
      assert.equal(rows.rows[0].n, 260);
      const metadata = await scoped(f.pool, (client) =>
        client.query("SELECT bool_and(readers=ARRAY[reader_key]) AS narrow FROM ha_relation_reader_keys"),
      );
      assert.equal(
        metadata.rows[0].narrow,
        true,
        "one index row carries only its own key, avoiding quadratic ACL replication",
      );
    } finally {
      await f.close();
    }
  });
  test(
    `${backend} previous writes at every expansion cut cannot become ready before their keys exist`,
    runtime,
    async () => {
      const f = await fixture(backend);
      try {
        await f.adminPool.query("DROP TRIGGER ha_relation_reader_index_mark ON ha_relations");
        await f.adminPool.query("DROP TRIGGER ha_relation_reader_index_sync ON ha_relations");
        let step = 0;
        for (const statement of relationReaderIndexDdl()) {
          await f.adminPool.query(statement);
          await edge(f.adminPool, `cut-${step++}`, "task/old", "task/target");
          const invalid = await f.adminPool.query(`SELECT r.relation_id FROM ha_relations r
          CROSS JOIN LATERAL unnest(r.readers) AS allowed(key)
          WHERE r.reader_index_version=1 AND NOT EXISTS(SELECT 1 FROM ha_relation_reader_keys k
            WHERE k.tenant_id=r.tenant_id AND k.project_id=r.project_id AND k.policy_epoch=r.policy_epoch
              AND k.relation_id=r.relation_id AND k.reader_key=allowed.key)`);
          assert.deepEqual(invalid.rows, [], `previous writer reached an uncertified ready cut after: ${statement}`);
        }
        while (await scoped(f.pool, (client) => backfillPgRelationReaderIndexPage(client, scope))) {
          /* drain committed pages */
        }
        const count = await scoped(f.pool, (client) =>
          client.query("SELECT count(*)::integer AS n FROM ha_relation_reader_keys"),
        );
        assert.equal(count.rows[0].n, step * 2);
      } finally {
        await f.close();
      }
    },
  );
  test(
    `${backend} cyclic and unequal diamond paths match SQLite depth, backedge and seed ordering`,
    runtime,
    async () => {
      const f = await fixture(backend),
        db = new DatabaseSync(":memory:"),
        source = createPgTaskProjectionSource({ pool: f.pool, repoId: "bounded", scope });
      createRelationGraphProjectionTables(db);
      try {
        const edges = [
          ["a", "a"],
          ["a", "b"],
          ["a", "c"],
          ["b", "c"],
          ["c", "d"],
          ["d", "b"],
          ["c", "e"],
        ];
        for (const [index, [from, to]] of edges.entries()) {
          const id = `edge-${index}`,
            sourceRef = `task/${from}`,
            target = `task/${to}`,
            row = await edge(f.adminPool, id, sourceRef, target);
          db.prepare(
            "INSERT INTO relation_edge VALUES(?,?,?,'depends-on','active',NULL,?,1,'2026-11-01',?,'current',NULL)",
          ).run(id, sourceRef, target, sourceRef, JSON.stringify(row));
        }
        await edge(f.adminPool, "hidden", "task/e", "task/secret", { readers: ["hidden"] });
        for (const depth of [1, 2, 3, 4, 5]) {
          for (const seeds of [["task/a"], ["task/c", "task/a", "task/c"], ["missing"]]) {
            const expected = capture(() => ({ rows: readTaskDependencyClosureRows(db, seeds, depth) }));
            for (const narrow of [false, true])
              assert.deepEqual(
                await captureAsync(() => source.readTaskDependencyClosure(seeds, depth, narrow)),
                expected,
              );
          }
          for (const direction of ["outgoing", "incoming", "both"])
            for (const maxNodes of [2, 20]) {
              const query = {
                seed: "task/a",
                relationTypes: ["depends-on"],
                maxDepth: depth,
                maxNodes,
                direction,
                allowTruncation: true,
              };
              const expected = capture(() => readTaskRelationNeighborhoodWindow(db, query));
              assert.deepEqual(await captureAsync(() => source.readTaskRelationNeighborhood(query)), expected);
              if (!expected.error)
                assert.equal(
                  (await source.readTaskRelationNeighborhood(query)).truncated,
                  readTaskRelationNeighborhoodWindow(db, query).truncated,
                );
            }
        }
      } finally {
        db.close();
        await f.close();
      }
    },
  );
  test(`${backend} connected diamond adjacency is read once per node instead of once per path`, runtime, async () => {
    const f = await fixture(backend);
    let reads = 0;
    const counted = new Proxy(f.pool, {
      get(target, key) {
        if (key !== "connect") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, property) {
              if (property === "query")
                return (...args) => {
                  if (typeof args[0] === "string" && /FROM ha_relations WHERE/u.test(args[0])) reads++;
                  return connection.query(...args);
                };
              const value = Reflect.get(connection, property);
              return typeof value === "function" ? value.bind(connection) : value;
            },
          });
        };
      },
    });
    try {
      let previous = ["task/root"],
        edgeCount = 0;
      for (let layer = 0; layer < 24; layer++) {
        const next = [`task/${layer}a`, `task/${layer}b`];
        for (const from of previous)
          for (const to of next) await edge(f.adminPool, `dag-${String(edgeCount++).padStart(3, "0")}`, from, to);
        previous = next;
      }
      const source = createPgTaskProjectionSource({ pool: counted, repoId: "bounded", scope }),
        result = await source.readTaskDependencyClosure(["task/root"], 24);
      assert.equal(result.rows.length, edgeCount);
      assert.equal(reads, 49, "24 layers expose 2^24 paths but only 49 distinct node adjacency reads");
      await assert.rejects(source.readTaskDependencyClosure(["task/root"], 23), /depth limit/);
    } finally {
      await f.close();
    }
  });
}
