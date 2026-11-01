// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { serializePersistedCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
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
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";
import { bundle, docBundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";
import { assertDocumentAdmission, admissionSettingsBase } from "../store/document-admission.contract.ts";
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
    // This host owns the test pool. The intentional backend termination can also report an idle-client
    // error after its query rejects; record it and verify its exact backend instead of leaking an event.
    runtime.on("error", (error, client) => poolErrors.push({ message: error.message, client }));
    const identity = (
      await runtime.query(
        "SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.deepEqual(identity, { role: runtimeRole, rolsuper: false, rolbypassrls: false });

    const make = (repoId: string, otherScope = scope, hooks: PostgresAppendHooks = {}) =>
        makePostgresTaskEventStore({ pool: runtime!, repoId, scope: otherScope, ...hooks }),
      fence = (repoId: string, epoch = 1, holderId = "center-writer") => ({ repoId, holderId, epoch }),
      pg = make("parity-repo");
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

    await t.test("sequential append preserves persisted bytes, digest and cut at each revision", async () => {
      const latency: number[] = [];
      for (let revision = 1; revision <= 12; revision++) {
        const input =
            revision === 2
              ? docBundle(sqlite!, "PG ledger content\n", revision, "op-doc-parity", "harness/ledger.md")
              : bundle(eventAt(revision)),
          sqliteReceipt = sqlite!.append(input),
          start = performance.now(),
          pgReceipt = await pg.append(input, revision - 1, fence("parity-repo"));
        latency.push(performance.now() - start);
        assert.deepEqual(pgReceipt.cut, sqliteReceipt.cut);
        assert.equal((await pg.currentCut()).headDigest, sqlite!.currentCut().headDigest);
        const row = (
          await admin!.query(
            "SELECT event_json,event_digest FROM ha_events WHERE repo_id='parity-repo' AND revision=$1",
            [revision],
          )
        ).rows[0];
        assert.equal(row.event_json, serializePersistedCanonicalEvent(input.event));
        assert.equal(row.event_digest, `sha256:${sha256Text(row.event_json)}`);
        if (revision === 2)
          assert.deepEqual(
            Buffer.from((await pg.execute({ operation: "content", sha256: input.blobs[0]!.sha256 })) as Uint8Array),
            Buffer.from("PG ledger content\n"),
          );
        process.stdout.write(`PG_EVENT_LEDGER_PARITY revision=${revision} headDigest=${pgReceipt.cut.headDigest}\n`);
      }
      const positions = (
        await admin!.query(
          "SELECT history,sequence,revision,head_digest FROM ha_replication_positions WHERE repo_id='parity-repo' ORDER BY sequence",
        )
      ).rows;
      assert.equal(positions.length, 12, "every commit has a durable position even if NOTIFY is lost");
      assert.equal(new Set(positions.map((position) => position.history)).size, 1);
      assert.match(positions[0]!.history, /^[0-9a-f-]{36}$/u);
      assert.deepEqual(
        positions.map((position) => Number(position.sequence)),
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
      assert.equal(positions.at(-1)!.head_digest, (await pg.currentCut()).headDigest);
      assert.deepEqual(await pg.execute({ operation: "events" }), sqlite!.read().events);
      assert.deepEqual(
        await pg.execute({
          operation: "events",
          query: { limit: 2, type: "task_created", actor: "person-1", revisionBound: 8 },
        }),
        sqlite!.queryEvents!({ limit: 2, type: "task_created", actor: "person-1", revisionBound: 8 }),
      );
      assert.deepEqual(
        await pg.execute({ operation: "event", key: "event_id", value: eventAt(1).eventId }),
        eventAt(1),
      );
      latency.sort((a, b) => a - b);
      process.stdout.write(
        `PG_EVENT_LEDGER_LATENCY events_per_bundle=1 samples=${latency.length} blob_bytes=18 p50_ms=${latency[Math.floor(latency.length / 2)]!.toFixed(2)} p95_ms=${latency.at(-1)!.toFixed(2)}\n`,
      );
    });

    await t.test("idempotency returns original cut and conflicts reject another intent", async () => {
      const first = bundle(eventAt(1));
      const replay = await pg.append(first, 0, fence("parity-repo"));
      assert.equal(replay.cut.revision, 1);
      assert.equal((await pg.readHead())!.revision, 12);
      const altered = { ...first.event, payload: { task: { ...eventAt(1).payload.task, title: "another intent" } } };
      await assert.rejects(pg.append(bundle(altered as ReturnType<typeof eventAt>), 12, fence("parity-repo")), {
        code: "op_conflict",
      });
      assert.equal(
        ((await pg.execute({ operation: "outcome", opId: first.event.opId })) as { lastRevision: number }).lastRevision,
        1,
      );
    });

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
        await store.append(bundle(eventAt(2)), 1, fence(repoId, 2, "new-owner"));
        await assert.rejects(store.append(bundle(eventAt(3)), 2, fence(repoId)), { code: "revision_conflict" });
        await assert.rejects(store.append(bundle(eventAt(3)), 2, fence(repoId, 2, "other-owner")), {
          code: "revision_conflict",
        });
        await assert.rejects(store.append(bundle(eventAt(3)), 1, fence(repoId, 2, "new-owner")), {
          code: "revision_conflict",
        });
        await assert.rejects(store.append(bundle(eventAt(3)), 2, fence("wrong-repo")), { code: "revision_conflict" });
        assert.equal((await store.readHead())!.revision, 2);
        process.stdout.write(
          "PG_EVENT_LEDGER_CONCURRENCY one accepted, one revision_conflict; stale epoch and competing holder rejected\n",
        );
      },
    );

    await t.test("one bundle commits preceding events, outcome and projection callback atomically", async () => {
      const repoId = "bundle-repo",
        store = make(repoId, scope, {
          project: async (client, value) => {
            assert.equal(value.events.length, 2);
            assert.equal(value.revision, 2);
            assert.equal(
              (await client.query("SELECT count(*) AS n FROM ha_events WHERE repo_id=$1", [repoId])).rows[0]!.n,
              "2",
            );
          },
        });
      const input = { ...bundle(eventAt(2)), preceding: [bundle(eventAt(1))] };
      await store.append(input, 0, fence(repoId));
      const outcome = (await store.execute({ operation: "outcome", opId: eventAt(1).opId })) as {
        memberOpIds: string[];
      };
      assert.deepEqual(outcome.memberOpIds, [eventAt(1).opId, eventAt(2).opId]);
      const broken = make("rollback-repo", scope, {
        project: async () => {
          throw new Error("projection failed");
        },
      });
      await assert.rejects(broken.append(input, 0, fence("rollback-repo")), /projection failed/u);
      assert.equal(await broken.readHead(), null);
      for (const table of ["ha_events", "ha_command_outcomes", "ha_replication_positions"])
        assert.equal(
          (await admin!.query(`SELECT count(*) AS n FROM ${table} WHERE repo_id='rollback-repo'`)).rows[0]!.n,
          "0",
        );
    });

    await t.test("blob mismatches, missing content and cancellation roll back the whole operation", async () => {
      const repoId = "blob-repo",
        store = make(repoId),
        input = docBundle(sqlite!, "unique blob content\n", 1, "op-blob", "harness/blob.md");
      for (const change of [{ body: "bad" }, { size: 1 }, { sha256: "0".repeat(64) }])
        await assert.rejects(store.append({ ...input, blobs: [{ ...input.blobs[0]!, ...change }] }, 0, fence(repoId)), {
          code: "invalid_write_plan",
        });
      await assert.rejects(store.append({ ...input, blobs: [] }, 0, fence(repoId)), { code: "invalid_write_plan" });
      assert.equal(await store.readHead(), null);
      await store.append(input, 0, fence(repoId));
      const second = docBundle(sqlite!, "unique blob content\n", 2, "op-blob-reuse", "harness/blob-again.md");
      await store.append({ ...second, blobs: [] }, 1, fence(repoId));
      assert.equal(
        (await admin!.query("SELECT count(*) AS n FROM ha_content_blobs WHERE sha256=$1", [input.blobs[0]!.sha256]))
          .rows[0]!.n,
        "1",
      );
      await admin!.query("UPDATE ha_content_blobs SET body=$2 WHERE sha256=$1", [
        input.blobs[0]!.sha256,
        Buffer.from("X".repeat(input.blobs[0]!.size)),
      ]);
      const third = docBundle(sqlite!, "unique blob content\n", 3, "op-blob-corrupt", "harness/blob-third.md");
      await assert.rejects(store.append({ ...third, blobs: [] }, 2, fence(repoId)), { code: "invalid_write_plan" });
      assert.equal((await store.readHead())!.revision, 2);
      const abort = new AbortController(),
        cancelled = make("cancel-repo", scope, { project: async () => abort.abort(new Error("cancelled operation")) });
      await assert.rejects(
        cancelled.append(bundle(eventAt(1)), 0, fence("cancel-repo"), abort.signal),
        /cancelled operation/u,
      );
      assert.equal(await cancelled.readHead(), null);
      process.stdout.write(
        "PG_EVENT_LEDGER_CONTENT malformed/missing/corrupt blobs rejected; dedup and cancellation rollback verified\n",
      );
    });

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
      process.stdout.write(
        "PG_EVENT_LEDGER_FAILURES pool exhaustion surfaced; SQLSTATE 57P01 preserved after disconnect; next connection clean\n",
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
    process.stdout.write(`PG_EVENT_LEDGER_POOL_ERRORS expected_disconnect_events=${poolErrors.length}\n`);
  } finally {
    await sqlite?.drain();
    await runtime?.end();
    await admin?.end();
    await fixture.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
