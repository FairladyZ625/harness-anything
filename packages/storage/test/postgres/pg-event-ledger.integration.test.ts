// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS,
  POSTGRES_EVENT_LEDGER_TABLES,
  POSTGRES_SCOPE_SCHEMA_CONTRACT,
  makeTaskEventStore,
  makePostgresTaskEventStore,
  withPostgresTransaction,
  type PostgresEventStoreScope,
  type PostgresAppendHooks,
} from "../../src/index.ts";
import { assertSingleSessionLedger, assertWriterFencing } from "./pg-ledger.assertions.ts";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";
import { bundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";
import { assertDocumentAdmission, admissionSettingsBase } from "../store/document-admission.assertions.ts";
import { localGitWorktreeSettlement } from "../../src/store/local-version-control-system.ts";

const scope: PostgresEventStoreScope = {
  tenantId: "tenant-a",
  projectId: "project-a",
  readers: ["reader-a"],
  policyEpoch: 7,
};

test("real PG ledger: SQLite byte parity, scoped locks, outcomes, rollback and pooled claims", async (t) => {
  const fixture = await startManagedPostgresFixture(),
    database = `ha_ledger_${randomUUID().replaceAll("-", "")}`,
    rootDir = mkdtempSync(path.join(tmpdir(), "ha-pg-ledger-sqlite-"));
  let admin: Pool | undefined, runtime: Pool | undefined, sqlite: ReturnType<typeof makeTaskEventStore> | undefined;
  let terminatedClient: unknown;
  const poolErrors: { readonly message: string; readonly client: unknown }[] = [];
  try {
    const version = (await fixture.adminPool.query("SELECT version() AS version")).rows[0]!.version;
    assert.match(version, /^PostgreSQL 18\.3(?:\s|$)/u);
    process.stdout.write(`PG_EVENT_LEDGER_SERVER ${version}\n`);
    await fixture.adminPool.query(`CREATE DATABASE "${database}"`);
    admin = new Pool({ connectionString: `postgres://postgres@127.0.0.1:${fixture.port}/${database}`, max: 1 });
    const { schemaOwner, runtime: runtimeRole } = POSTGRES_SCOPE_SCHEMA_CONTRACT.roles;
    await admin.query(`CREATE ROLE ${schemaOwner} ${POSTGRES_SCOPE_SCHEMA_CONTRACT.roleAttributes.schemaOwner}`);
    await admin.query(`CREATE ROLE ${runtimeRole} ${POSTGRES_SCOPE_SCHEMA_CONTRACT.roleAttributes.runtime}`);
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${schemaOwner}`);
    await admin.query(`SET ROLE ${schemaOwner}`);
    for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await admin.query(statement);
    await admin.query("RESET ROLE");
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    for (const table of POSTGRES_EVENT_LEDGER_TABLES)
      await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${table} TO ${runtimeRole}`);
    runtime = new Pool({ connectionString: `postgres://${runtimeRole}@127.0.0.1:${fixture.port}/${database}`, max: 2 });
    runtime.on("error", (error, client) => poolErrors.push({ message: error.message, client }));
    const identity = (
      await runtime.query(
        "SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.deepEqual(identity, { role: runtimeRole, rolsuper: false, rolbypassrls: false });

    const make = (repoId: string, otherScope = scope, hooks: PostgresAppendHooks = {}) =>
        makePostgresTaskEventStore({ pool: runtime!, repoId, scope: otherScope, ...hooks }),
      fence = (repoId: string, epoch = 1, holderId = "center-writer") => ({ repoId, holderId, epoch });
    initRepo(rootDir);
    sqlite = makeTaskEventStore({ repoId: "parity-repo", rootDir });

    await t.test(
      "document admission matches SQLite for stateful replacement, preceding heads, rollback and replay",
      async () => {
        const documentRoot = mkdtempSync(path.join(tmpdir(), "ha-pg-document-admission-"));
        initRepo(documentRoot);
        writeFileSync(path.join(documentRoot, "harness/harness.yaml"), admissionSettingsBase);
        const repoId = "document-admission",
          store = make(repoId, scope, {
            readAuthoredDocument: (target) => {
              const node = localGitWorktreeSettlement.readNode(path.join(documentRoot, "harness", target));
              return node && { ...node, nodeKind: node.mode === "120000" ? "symbolic-link" : "file" };
            },
          });
        try {
          await assertDocumentAdmission({
            rootDir: documentRoot,
            docStore: sqlite!,
            append: async (candidate) =>
              store.append(candidate, (await store.readHead())?.revision ?? 0, fence(repoId)),
            snapshot: async () => {
              const tables = POSTGRES_EVENT_LEDGER_TABLES;
              const rows = [];
              for (const table of tables)
                rows.push(
                  (
                    await admin!.query(
                      `SELECT * FROM ${table} WHERE tenant_id=$1 AND project_id=$2${table === "ha_content_blobs" ? "" : " AND repo_id=$3"} ORDER BY 1,2,3`,
                      table === "ha_content_blobs"
                        ? [scope.tenantId, scope.projectId]
                        : [scope.tenantId, scope.projectId, repoId],
                    )
                  ).rows,
                );
              return rows;
            },
          });
        } finally {
          rmSync(documentRoot, { recursive: true, force: true });
        }
      },
    );

    await assertSingleSessionLedger(t, { make, sqlite, inspect: admin });

    await t.test(
      "two connections serialize on the same head and stale epoch/holder/revision are rejected",
      async () => {
        const repoId = "race-repo",
          store = make(repoId);
        const competing = await Promise.allSettled(
          ["left", "right"].map((side) => {
            const event = { ...eventAt(1), opId: `op-race-${side}`, eventId: `event-race-${side}` };
            return store.append(bundle(event), 0, fence(repoId));
          }),
        );
        assert.equal(competing.filter(({ status }) => status === "fulfilled").length, 1);
        const failure = competing.find((item) => item.status === "rejected") as PromiseRejectedResult;
        assert.equal(failure.reason.code, "revision_conflict");
        await assertWriterFencing(store, repoId);
        process.stdout.write(
          "PG_EVENT_LEDGER_CONCURRENCY one accepted, one revision_conflict; stale epoch and competing holder rejected\n",
        );
      },
    );

    await t.test("pool exhaustion and a lost connection fail visibly without leaking a partial head", async () => {
      const exhausted = new Pool({
        connectionString: `postgres://${POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime}@127.0.0.1:${fixture.port}/${database}`,
        max: 1,
        connectionTimeoutMillis: 50,
      });
      const held = await exhausted.connect();
      try {
        const store = makePostgresTaskEventStore({ pool: exhausted, repoId: "exhausted-repo", scope });
        await assert.rejects(store.append(bundle(eventAt(1)), 0, fence("exhausted-repo")), /timeout.*connect/u);
      } finally {
        held.release();
        await exhausted.end();
      }
      const disconnected = make("disconnect-repo", scope, {
        project: async (client) => {
          terminatedClient = client;
          await client.query("SELECT pg_terminate_backend(pg_backend_pid())");
        },
      });
      await assert.rejects(disconnected.append(bundle(eventAt(1)), 0, fence("disconnect-repo")), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal((error.errors[0] as { code: string }).code, "57P01");
        return true;
      });
      assert.equal(await disconnected.readHead(), null);
      const disconnectedBetweenQueries = make("idle-disconnect-repo", scope, {
        project: async (client) => {
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          const ended = new Promise<void>((resolve) => client.once("end", resolve));
          await admin!.query("SELECT pg_terminate_backend($1)", [pid]);
          await ended;
        },
      });
      await assert.rejects(
        disconnectedBetweenQueries.append(bundle(eventAt(1)), 0, fence("idle-disconnect-repo")),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          const original = error.errors.find(
            (item: Error & { readonly code?: string }) =>
              item.code === "57P01" || item.message === "Connection terminated unexpectedly",
          ) as (Error & { readonly code?: string }) | undefined;
          // PostgreSQL may deliver its fatal response before closing the idle socket, or the driver
          // may observe the transport close first. Preserve either native error without inventing a code.
          assert.ok(original, "the originating connection error must survive a later not-queryable error");
          if (original.code === undefined) assert.equal(original.message, "Connection terminated unexpectedly");
          else assert.equal(original.code, "57P01");
          return true;
        },
      );
      assert.equal(await disconnectedBetweenQueries.readHead(), null);
      process.stdout.write(
        "PG_EVENT_LEDGER_FAILURES pool exhaustion surfaced; SQLSTATE 57P01 preserved during query; between-query transport close surfaced unchanged; next connection clean\n",
      );
    });

    await t.test("a lost commit response is indeterminate and retry reads the durable outcome", async () => {
      let restore = () => {};
      const repoId = "indeterminate-repo",
        store = make(repoId, scope, {
          project: async (client) => {
            const original = client.query;
            const spy = t.mock.method(client, "query", async (...args: unknown[]) => {
              const result = await Reflect.apply(original, client, args);
              if (args[0] === "COMMIT") throw Object.assign(new Error("commit response lost"), { code: "ECONNRESET" });
              return result;
            });
            restore = () => spy.mock.restore();
          },
        });
      const input = bundle(eventAt(1));
      try {
        await assert.rejects(store.append(input, 0, fence(repoId)), { code: "publication_indeterminate" });
      } finally {
        restore();
      }
      assert.equal((await store.readHead())!.revision, 1);
      const retry = await store.append(input, 0, fence(repoId));
      assert.equal(retry.cut.revision, 1);
      assert.equal(
        (await admin!.query("SELECT count(*) AS n FROM ha_command_outcomes WHERE repo_id=$1", [repoId])).rows[0]!.n,
        "1",
      );
      process.stdout.write(
        "PG_EVENT_LEDGER_COMMIT lost response mapped to publication_indeterminate; replay found one durable outcome\n",
      );
    });

    await t.test("genesis rejection, RLS scope and transaction claims remain durable and isolated", async () => {
      const repoId = "reject-repo",
        store = make(repoId),
        rejection = {
          opId: "op-rejected",
          intentDigest: `sha256:${"0".repeat(64)}` as const,
          summary: "rejected operation",
          rejectionCode: "invalid_write_plan",
        };
      const result = (await store.execute({
        operation: "reject",
        rejection,
        expectedRevision: 0,
        writerFence: fence(repoId),
      })) as { status: string };
      assert.equal(result.status, "rejected");
      assert.equal(await store.readHead(), null);
      const position = (
        await admin!.query("SELECT sequence, revision, head_digest FROM ha_replication_positions WHERE repo_id=$1", [
          repoId,
        ])
      ).rows[0];
      assert.equal(position.sequence, "1");
      assert.equal(position.revision, "0");
      assert.equal(position.head_digest, (await store.currentCut()).headDigest);
      for (const otherScope of [
        { ...scope, tenantId: "tenant-b" },
        { ...scope, projectId: "project-b" },
        { ...scope, policyEpoch: 8 },
      ]) {
        const other = make("parity-repo", otherScope);
        assert.equal(await other.readHead(), null);
        assert.deepEqual(await other.execute({ operation: "events" }), []);
        if (otherScope.policyEpoch === 8)
          await assert.rejects(other.append(bundle(eventAt(1)), 0, fence("parity-repo")), {
            code: "revision_conflict",
          });
        else {
          await other.append(bundle(eventAt(1)), 0, fence("parity-repo"));
          assert.equal((await other.readHead())!.revision, 1);
        }
      }
      // No claims on a runtime connection, even after rejected/rolled-back operations.
      assert.equal((await runtime!.query("SELECT count(*) AS n FROM ha_events")).rows[0]!.n, "0");
      await assert.rejects(
        withPostgresTransaction(runtime!, (client) => client.query("UPDATE ha_events SET tenant_id='tenant-b'"), scope),
        { code: "42501" },
      );
      process.stdout.write(
        "PG_EVENT_LEDGER_RLS non-owner runtime; tenant/project/epoch isolation; claims clear after rollback\n",
      );
    });
    await runtime.end();
    runtime = undefined;
    assert.ok(poolErrors.length <= 1, "only the deliberately terminated backend may emit one pool error");
    for (const error of poolErrors) {
      assert.equal(error.client, terminatedClient);
      assert.equal(error.message, "Connection terminated unexpectedly");
    }
    assert.equal(poolErrors.length, 0, "transaction-owned disconnects must not leak to the idle pool");
    process.stdout.write(`PG_EVENT_LEDGER_POOL_ERRORS expected_disconnect_events=${poolErrors.length}\n`);
  } finally {
    await sqlite?.drain();
    await runtime?.end();
    await admin?.end();
    await fixture.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
