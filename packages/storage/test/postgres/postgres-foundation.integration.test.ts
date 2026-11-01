// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { Pool } from "pg";
import {
  POSTGRES_SCOPE_COLUMNS_SQL,
  POSTGRES_SCOPE_SCHEMA_CONTRACT,
  createPostgresPool,
  postgresScopeRlsStatements,
  withPostgresTransaction,
  type PostgresScopeClaims,
} from "../../src/postgres/index.ts";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";

const tableName = "pg_scope_probe",
  scope: PostgresScopeClaims = { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 7 };

test("managed PostgreSQL transaction bridge enforces the shared scope and RLS contract", async () => {
  const fixture = await startManagedPostgresFixture();
  const pools: Pool[] = [];
  try {
    const version = await fixture.adminPool.query<{ version: string }>("SELECT version() AS version");
    assert.match(version.rows[0]!.version, /^PostgreSQL 18\.3(?:\s|$)/u);
    process.stdout.write(`PG_SERVER_VERSION ${version.rows[0]!.version}\n`);

    const database = `ha_test_${randomUUID().replaceAll("-", "")}`;
    await fixture.adminPool.query(`CREATE DATABASE "${database}"`);
    const adminPool = new Pool({
      host: "127.0.0.1",
      port: fixture.port,
      user: "postgres",
      database,
      max: 1,
    });
    pools.push(adminPool);
    const runtimePassword = randomUUID().replaceAll("-", ""),
      migratorPassword = randomUUID().replaceAll("-", ""),
      runtimePool = createPostgresPool(
        `postgres://${POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime}:${runtimePassword}@127.0.0.1:${fixture.port}/${database}`,
        { max: 1 },
      ),
      migratorPool = createPostgresPool(
        `postgres://${POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.migration}:${migratorPassword}@127.0.0.1:${fixture.port}/${database}`,
        { max: 1 },
      );
    pools.push(runtimePool, migratorPool);
    await createRolesAndProbeTable(adminPool, runtimePassword, migratorPassword);

    const roleResult = await adminPool.query<{
      readonly role: string;
      readonly canLogin: boolean;
      readonly superuser: boolean;
      readonly bypassRls: boolean;
    }>(
      `SELECT rolname AS role, rolcanlogin AS "canLogin", rolsuper AS superuser, rolbypassrls AS "bypassRls"
       FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [
        [
          POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.schemaOwner,
          POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime,
          POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.migration,
        ],
      ],
    );
    assert.deepEqual(
      roleResult.rows.map((role) => ({
        role: role.role,
        canLogin: role.canLogin,
        superuser: role.superuser,
        bypassRls: role.bypassRls,
      })),
      [
        { role: POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.migration, canLogin: true, superuser: false, bypassRls: false },
        { role: POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime, canLogin: true, superuser: false, bypassRls: false },
        { role: POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.schemaOwner, canLogin: false, superuser: false, bypassRls: false },
      ],
    );

    const identity = await withPostgresTransaction(runtimePool, (client) =>
      client.query<{
        readonly currentUser: string;
        readonly sessionUser: string;
        readonly tableOwner: string;
      }>(
        `SELECT current_user AS "currentUser", session_user AS "sessionUser",
                (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = $1) AS "tableOwner"`,
        [tableName],
      ),
    );
    assert.deepEqual(identity.rows[0], {
      currentUser: POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime,
      sessionUser: POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime,
      tableOwner: POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.schemaOwner,
    });

    const visible = await readPayloads(runtimePool, scope);
    assert.deepEqual(visible, ["tenant-a/project-a/epoch-7"]);
    process.stdout.write(
      "PG_RLS_NEGATIVE tenant-a/project-a/epoch-7 cannot read other tenant, project, or epoch rows\n",
    );
    const missingClaims = await readPayloads(runtimePool, undefined);
    assert.deepEqual(missingClaims, []);
    process.stdout.write("PG_RLS_NEGATIVE missing claims returned 0 rows\n");
    assert.deepEqual(await readPayloads(runtimePool, { ...scope, projectId: "project-b" }), [
      "tenant-a/project-b/epoch-7",
    ]);
    assert.deepEqual(await readPayloads(runtimePool, { ...scope, policyEpoch: 8 }), ["tenant-a/project-a/epoch-8"]);
    process.stdout.write("PG_RLS_SCOPE sequential project and policy-epoch claims remained isolated on a max=1 pool\n");
    assert.deepEqual(await readPayloads(migratorPool, scope), ["tenant-a/project-a/epoch-7"]);
    assert.deepEqual(await readPayloads(migratorPool, undefined), []);

    await assert.rejects(
      withPostgresTransaction(
        runtimePool,
        (client) =>
          client.query(
            `INSERT INTO "${tableName}" (id, tenant_id, project_id, policy_epoch, payload)
           VALUES ($1, 'tenant-b', 'project-a', 7, 'cross-scope-write')`,
            [randomUUID()],
          ),
        scope,
      ),
      { code: "42501" },
    );
    process.stdout.write("PG_RLS_NEGATIVE cross-tenant/project write rejected SQLSTATE 42501\n");
    await assert.rejects(
      withPostgresTransaction(
        runtimePool,
        (client) =>
          client.query(
            `INSERT INTO "${tableName}" (id, tenant_id, project_id, policy_epoch, payload)
           VALUES ($1, 'tenant-a', 'project-b', 7, 'cross-project-write')`,
            [randomUUID()],
          ),
        scope,
      ),
      { code: "42501" },
    );
    process.stdout.write("PG_RLS_NEGATIVE cross-project write rejected SQLSTATE 42501\n");
    await assert.rejects(
      withPostgresTransaction(
        runtimePool,
        (client) => client.query(`SET ROLE "${POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.schemaOwner}"`),
        scope,
      ),
      { code: "42501" },
    );
    process.stdout.write("PG_RLS_NEGATIVE runtime cannot assume schema-owner role SQLSTATE 42501\n");

    await assert.rejects(
      withPostgresTransaction(
        migratorPool,
        async (client) => {
          await client.query("SET LOCAL row_security = off");
          return client.query(`SELECT * FROM "${tableName}"`);
        },
        scope,
      ),
      { code: "42501" },
    );
    process.stdout.write("PG_RLS_NEGATIVE migration role cannot disable row security SQLSTATE 42501\n");

    const beforeRollback = await withPostgresTransaction(
      runtimePool,
      (client) => client.query<{ readonly pid: number }>("SELECT pg_backend_pid() AS pid"),
      scope,
    );
    await assert.rejects(
      withPostgresTransaction(
        runtimePool,
        async (client) => {
          await client.query(
            `INSERT INTO "${tableName}" (id, tenant_id, project_id, policy_epoch, payload)
             VALUES ($1, $2, $3, $4, 'rollback-only')`,
            [randomUUID(), scope.tenantId, scope.projectId, scope.policyEpoch],
          );
          throw new Error("rollback witness");
        },
        scope,
      ),
      /rollback witness/u,
    );
    const afterRollback = await withPostgresTransaction(runtimePool, async (client) => {
      const pid = await client.query<{ readonly pid: number }>("SELECT pg_backend_pid() AS pid"),
        claim = await client.query<{
          readonly tenantId: string;
          readonly projectId: string;
          readonly policyEpoch: string;
        }>(
          `SELECT current_setting($1, true) AS "tenantId",
                  current_setting($2, true) AS "projectId",
                  current_setting($3, true) AS "policyEpoch"`,
          [
            POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.tenantId,
            POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.projectId,
            POSTGRES_SCOPE_SCHEMA_CONTRACT.claims.policyEpoch,
          ],
        ),
        rows = await client.query<{ readonly count: string }>(`SELECT count(*) AS count FROM "${tableName}"`);
      return { pid: pid.rows[0]!.pid, claims: Object.values(claim.rows[0]!), rowCount: rows.rows[0]!.count };
    });
    assert.equal(afterRollback.pid, beforeRollback.rows[0]!.pid);
    assert.deepEqual(afterRollback.claims, ["", "", ""]);
    assert.equal(afterRollback.rowCount, "0");
    process.stdout.write(
      "PG_POOL_NEGATIVE rollback reused same connection; all transaction-local claims reset to empty\n",
    );

    const latency = await measureSynchronousCapability(runtimePool, 40);
    assert.equal(latency.samples, 40);
    process.stdout.write(`PG_BRIDGE_LATENCY ${JSON.stringify(latency)}\n`);
  } finally {
    try {
      await Promise.all(pools.map((pool) => pool.end()));
    } finally {
      await fixture.close();
    }
  }
});

async function createRolesAndProbeTable(
  adminPool: Pool,
  runtimePassword: string,
  migratorPassword: string,
): Promise<void> {
  const { roles, roleAttributes } = POSTGRES_SCOPE_SCHEMA_CONTRACT;
  await adminPool.query(`CREATE ROLE "${roles.schemaOwner}" ${roleAttributes.schemaOwner}`);
  await adminPool.query(`CREATE ROLE "${roles.runtime}" ${roleAttributes.runtime} PASSWORD '${runtimePassword}'`);
  await adminPool.query(`CREATE ROLE "${roles.migration}" ${roleAttributes.migration} PASSWORD '${migratorPassword}'`);
  await adminPool.query(`GRANT CREATE ON SCHEMA public TO "${roles.schemaOwner}"`);
  await adminPool.query(`SET ROLE "${roles.schemaOwner}"`);
  try {
    await adminPool.query(
      `CREATE TABLE "${tableName}" (
        id text NOT NULL,
        ${POSTGRES_SCOPE_COLUMNS_SQL},
        payload text NOT NULL,
        PRIMARY KEY (tenant_id, project_id, id)
      )`,
    );
    for (const statement of postgresScopeRlsStatements(tableName)) await adminPool.query(statement);
  } finally {
    await adminPool.query("RESET ROLE");
  }
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO "${roles.runtime}", "${roles.migration}"`);
  await adminPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${tableName}" TO "${roles.runtime}", "${roles.migration}"`,
  );
  await adminPool.query(
    `INSERT INTO "${tableName}" (id, tenant_id, project_id, policy_epoch, payload) VALUES
      ('visible', 'tenant-a', 'project-a', 7, 'tenant-a/project-a/epoch-7'),
      ('other-project', 'tenant-a', 'project-b', 7, 'tenant-a/project-b/epoch-7'),
      ('other-tenant', 'tenant-b', 'project-a', 7, 'tenant-b/project-a/epoch-7'),
      ('newer-policy', 'tenant-a', 'project-a', 8, 'tenant-a/project-a/epoch-8')`,
  );
}

async function readPayloads(pool: Pool, claims: PostgresScopeClaims | undefined): Promise<string[]> {
  return withPostgresTransaction(
    pool,
    async (client) => {
      const result = await client.query<{ readonly payload: string }>(
        `SELECT payload FROM "${tableName}" ORDER BY payload`,
      );
      return result.rows.map((row) => row.payload);
    },
    claims,
  );
}

async function measureSynchronousCapability(
  pool: Pool,
  iterations: number,
): Promise<{
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}> {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    const stateBuffer = new SharedArrayBuffer(8);
    const resultBuffer = new SharedArrayBuffer(1024 * 1024);
    const state = new Int32Array(stateBuffer);
    const samples = [];
    for (let sequence = 0; sequence < workerData.iterations; sequence += 1) {
      Atomics.store(state, 0, 0);
      Atomics.store(state, 1, 0);
      const started = performance.now();
      parentPort.postMessage({ type: "call", sequence, stateBuffer, resultBuffer });
      Atomics.wait(state, 0, 0);
      const length = Atomics.load(state, 1);
      const result = JSON.parse(new TextDecoder().decode(new Uint8Array(resultBuffer, 0, length)));
      if (!result.ok) throw new Error(result.error);
      samples.push(performance.now() - started);
    }
    parentPort.postMessage({ type: "complete", samples });
    parentPort.close();
  `;
  const worker = new Worker(source, { eval: true, workerData: { iterations } });
  try {
    const samples = await new Promise<number[]>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (message: SyncBridgeWorkerMessage) => {
        if (message.type === "complete") {
          resolve(message.samples);
          return;
        }
        void withPostgresTransaction(
          pool,
          async (client) => {
            const result = await client.query<{ readonly id: string }>(
              `INSERT INTO "${tableName}" (id, tenant_id, project_id, policy_epoch, payload)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [
                `bridge-${message.sequence}`,
                scope.tenantId,
                scope.projectId,
                scope.policyEpoch,
                `bridge-payload-${message.sequence}`,
              ],
            );
            return result.rows[0]!.id;
          },
          scope,
        )
          .then(
            (value) => ({ ok: true, value }),
            (error: unknown) => ({ ok: false, error: errorMessage(error) }),
          )
          .then((result) => {
            const bytes = new TextEncoder().encode(JSON.stringify(result)),
              destination = new Uint8Array(message.resultBuffer);
            destination.set(bytes);
            const state = new Int32Array(message.stateBuffer);
            Atomics.store(state, 1, bytes.length);
            Atomics.store(state, 0, 1);
            Atomics.notify(state, 0);
          });
      });
    });
    const sorted = [...samples].sort((left, right) => left - right),
      percentile = (rank: number) => Number(sorted[Math.ceil(rank * sorted.length) - 1]!.toFixed(3));
    return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
  } finally {
    await worker.terminate();
  }
}

type SyncBridgeWorkerMessage =
  | {
      readonly type: "call";
      readonly sequence: number;
      readonly stateBuffer: SharedArrayBuffer;
      readonly resultBuffer: SharedArrayBuffer;
    }
  | { readonly type: "complete"; readonly samples: number[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
