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
import { buildHistoricalTimestampFixtures, HISTORICAL_TIMESTAMP_CASES } from "../canonical-factory.assertions.ts";
import { explainNodes, tracedPgReads } from "./pg-explain.fixture.ts";
import { readPgEventWindow } from "../../src/postgres/pg-event-window.ts";
import { POSTGRES_EVENT_OCCURRED_MS_SCHEMA_STATEMENTS } from "../../src/postgres/event-ledger-schema.ts";
import { ensurePgProjectionSchema, grantPgProjectionRuntimeAccess } from "../../src/pg/pg-projection-schema.ts";

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
    await t.test(
      "DM-01 & DM-03: real PG readEventWindow sub-ms truncation, ±23:59 offsets, equal endpoints, and O(page) sparse index scan under RLS",
      async () => {
        const tsRepo = "dm01-dm03-ts";
        const tsStore = make(tsRepo, scope);
        const baseEvents = Array.from({ length: HISTORICAL_TIMESTAMP_CASES.length }, (_, idx) => {
          const ev = eventAt(idx + 1);
          return { ...ev, eventId: `hist-ts-event-${idx + 1}`, opId: `hist-ts-op-${idx + 1}` };
        });
        for (let idx = 0; idx < baseEvents.length; idx += 1) {
          await tsStore.append(bundle(baseEvents[idx]!), idx, fence(tsRepo));
        }
        await withPostgresTransaction(
          admin!,
          async (client) => {
            for (const row of buildHistoricalTimestampFixtures(baseEvents)) {
              await client.query(
                "UPDATE ha_events SET occurred_at=$1, event_json=$2, event_digest=$3 WHERE tenant_id=$4 AND project_id=$5 AND repo_id=$6 AND revision=$7",
                [row.occurredAt, row.eventJson, row.digest, scope.tenantId, scope.projectId, tsRepo, row.revision],
              );
            }
          },
          scope,
        );
        const expectedNov5 = HISTORICAL_TIMESTAMP_CASES.filter((c) => c.expectedInNov5).map((c) => [
          c.revision,
          c.occurredAt,
        ]);
        const nov5 = (await tsStore.execute({
          operation: "window",
          query: {
            afterRevision: 0,
            after: "2026-11-05T00:00:00.000Z",
            before: "2026-11-05T23:59:59.999Z",
            limit: 20,
          },
        })) as {
          readonly events: readonly { readonly workspaceRevision: number; readonly occurredAt: string }[];
          readonly done: boolean;
        };
        assert.equal(nov5.done, true);
        assert.deepEqual(
          nov5.events.map((e) => [e.workspaceRevision, e.occurredAt]),
          expectedNov5,
        );
        const eqEnd = (await tsStore.execute({
          operation: "window",
          query: {
            afterRevision: 0,
            after: "2026-11-05T23:59:59.999Z",
            before: "2026-11-05T23:59:59.999Z",
            limit: 10,
          },
        })) as { readonly events: readonly { readonly workspaceRevision: number; readonly occurredAt: string }[] };
        assert.deepEqual(
          eqEnd.events.map((e) => [e.workspaceRevision, e.occurredAt]),
          [
            [7, "2026-11-05T23:59:59.999999Z"],
            [8, "2026-11-06T23:58:59.999999+23:59"],
            [9, "2026-11-06T07:59:59.999+08:00"],
          ],
        );

        const sparseScenarios = [
          {
            name: "full-day",
            after: "2026-11-05T00:00:00.000Z",
            before: "2026-11-05T23:59:59.999Z",
            matchAt: () => "2026-11-05T12:00:00.000Z",
            gapAt: () => "2026-11-06T12:00:00.000Z",
          },
          {
            name: "narrow-intraday",
            after: "2026-11-05T10:00:00.000Z",
            before: "2026-11-05T10:59:59.999Z",
            matchAt: (idx: number) => new Date(Date.parse("2026-11-05T10:00:00.000Z") + idx * 1_000).toISOString(),
            gapAt: () => "2026-11-05T18:00:00.000Z",
          },
          {
            name: "wide-40-days",
            after: "2026-09-01T00:00:00.000Z",
            before: "2026-10-10T23:59:59.999Z",
            matchAt: (idx: number) =>
              new Date(
                Date.parse("2026-09-01T06:00:00.000Z") + Math.floor(idx / 2) * 86_400_000 + (idx % 2) * 1_000,
              ).toISOString(),
            gapAt: () => "2026-11-15T12:00:00.000Z",
          },
        ] as const;

        for (const scenario of sparseScenarios) {
          const sparseRepo = `dm03-sparse-pg-${scenario.name}`;
          const sparseStore = make(sparseRepo, scope);
          const matchingBefore = 40;
          const gapSize = 1_500;
          const matchingAfter = 40;
          const total = matchingBefore + gapSize + matchingAfter;
          let matchIdx = 0;
          for (let offset = 0; offset < total; offset += 100) {
            const end = Math.min(total, offset + 100);
            const batch = [];
            for (let rev = offset + 1; rev <= end; rev += 1) {
              const inWindow = rev <= matchingBefore || rev > matchingBefore + gapSize;
              batch.push(
                bundle({
                  ...eventAt(rev),
                  occurredAt: inWindow ? scenario.matchAt(matchIdx++) : scenario.gapAt(),
                }),
              );
            }
            const terminal = batch.pop()!;
            await sparseStore.append({ ...terminal, preceding: batch }, offset, fence(sparseRepo));
          }
          await admin!.query("ANALYZE ha_events");
          const plans: unknown[] = [];
          const tracedRuntime = tracedPgReads(runtime!, plans, (sql) => /FROM ha_events/u.test(sql));
          const collected: number[] = [];
          let afterRevision = 0;
          let maxRevision: number | undefined;
          let afterOccurredAtMs: number | undefined;
          let pages = 0;
          for (;;) {
            const page = await withPostgresTransaction(
              tracedRuntime,
              (client) =>
                readPgEventWindow(
                  client,
                  scope,
                  {
                    repoId: sparseRepo,
                    query: {
                      afterRevision,
                      ...(maxRevision === undefined ? {} : { maxRevision }),
                      ...(afterOccurredAtMs === undefined ? {} : { afterOccurredAtMs }),
                      after: scenario.after,
                      before: scenario.before,
                      limit: 20,
                    },
                  },
                  total,
                ),
              scope,
            );
            pages += 1;
            for (const ev of page.events) collected.push(ev.workspaceRevision);
            maxRevision = page.windowMaxRevision;
            afterOccurredAtMs = page.nextAfterOccurredAtMs;
            if (page.done) break;
            afterRevision = page.lastScannedRevision;
          }
          assert.equal(pages, 4, scenario.name);
          assert.equal(collected.length, matchingBefore + matchingAfter, scenario.name);
          assert.equal(collected[0], 1, scenario.name);
          assert.equal(collected[matchingBefore], matchingBefore + gapSize + 1, scenario.name);
          const scans = explainNodes(plans).filter((node) => String(node["Relation Name"] ?? "") === "ha_events");
          const occurredScans = scans.filter(
            (node) => String(node["Index Name"] ?? "") === "ha_events_occurred_ms_revision",
          );
          assert.ok(
            occurredScans.length >= 4,
            `${scenario.name}: expected occurred_ms index scans, got ${JSON.stringify(scans)}`,
          );
          let totalRowsVisited = 0;
          for (const scan of scans) {
            const indexName = String(scan["Index Name"] ?? "");
            assert.ok(
              indexName === "ha_events_occurred_ms_revision" ||
                indexName === "ha_events_occurred_ms_pending" ||
                indexName === "ha_events_pkey",
              `${scenario.name}: unexpected scan plan ${JSON.stringify(scan)}`,
            );
            totalRowsVisited +=
              (Number(scan["Actual Rows"] ?? 0) + Number(scan["Rows Removed by Filter"] ?? 0)) *
              Number(scan["Actual Loops"] ?? 1);
          }
          assert.ok(
            totalRowsVisited <= 320,
            `${scenario.name}: expected <=320 total rows visited across 1,500-row gap, got ${totalRowsVisited}`,
          );
        }
      },
    );
    await t.test(
      "DM-09: pre-G4 external PG database upgrades via ensurePgProjectionSchema with zero table rewrite, backfills in 64-row batches, and serves RLS-restricted reader",
      async () => {
        const upgradeDb = `ha_dm09_${randomUUID().replaceAll("-", "")}`;
        await fixture.adminPool.query(`CREATE DATABASE "${upgradeDb}"`);
        const upgradeAdmin = new Pool({
          connectionString: `postgres://postgres@127.0.0.1:${fixture.port}/${upgradeDb}`,
          max: 1,
        });
        const { schemaOwner, runtime: runtimeRole, migration: migrationRole } = POSTGRES_SCOPE_SCHEMA_CONTRACT.roles;
        let upgradeRuntime: Pool | undefined;
        try {
          await upgradeAdmin.query(
            `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${migrationRole}') THEN ` +
              `CREATE ROLE "${migrationRole}" ${POSTGRES_SCOPE_SCHEMA_CONTRACT.roleAttributes.migration}; END IF; END $$`,
          );
          await upgradeAdmin.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${schemaOwner}"`);
          await upgradeAdmin.query(`SET ROLE "${schemaOwner}"`);
          const g4Set = new Set<string>(POSTGRES_EVENT_OCCURRED_MS_SCHEMA_STATEMENTS);
          for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) {
            if (!g4Set.has(statement)) await upgradeAdmin.query(statement);
          }
          await upgradeAdmin.query("RESET ROLE");
          const colBefore = await upgradeAdmin.query(
            "SELECT 1 FROM information_schema.columns WHERE table_name='ha_events' AND column_name='occurred_at_ms'",
          );
          assert.equal(colBefore.rows.length, 0, "pre-G4 schema must not contain occurred_at_ms");
          await upgradeAdmin.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}", "${migrationRole}"`);
          for (const table of POSTGRES_EVENT_LEDGER_TABLES) {
            await upgradeAdmin.query(
              `GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "${runtimeRole}", "${migrationRole}"`,
            );
          }
          upgradeRuntime = new Pool({
            connectionString: `postgres://${runtimeRole}@127.0.0.1:${fixture.port}/${upgradeDb}`,
            max: 2,
          });
          const upRepo = "dm09-legacy-repo";
          const upStore = makePostgresTaskEventStore({ pool: upgradeRuntime, repoId: upRepo, scope });
          const baseEvents = Array.from({ length: HISTORICAL_TIMESTAMP_CASES.length }, (_, idx) => {
            const ev = eventAt(idx + 1);
            return { ...ev, eventId: `dm09-ev-${idx + 1}`, opId: `dm09-op-${idx + 1}` };
          });
          for (let idx = 0; idx < baseEvents.length; idx += 1) {
            await upStore.append(bundle(baseEvents[idx]!), idx, fence(upRepo));
          }
          await withPostgresTransaction(
            upgradeAdmin,
            async (client) => {
              for (const row of buildHistoricalTimestampFixtures(baseEvents)) {
                await client.query(
                  "UPDATE ha_events SET occurred_at=$1, event_json=$2, event_digest=$3 WHERE tenant_id=$4 AND project_id=$5 AND repo_id=$6 AND revision=$7",
                  [row.occurredAt, row.eventJson, row.digest, scope.tenantId, scope.projectId, upRepo, row.revision],
                );
              }
            },
            scope,
          );
          const beforeBytes = (
            await upgradeAdmin.query<{
              readonly revision: string;
              readonly occurred_at: string;
              readonly event_json: string;
              readonly event_digest: string;
            }>(
              "SELECT revision, occurred_at, event_json, event_digest FROM ha_events WHERE repo_id=$1 ORDER BY revision ASC",
              [upRepo],
            )
          ).rows;

          // Upgrade via the published schema-owner entrypoint (CONCURRENTLY outside any transaction) + idempotent retry.
          const ownerClient = await upgradeAdmin.connect();
          try {
            await ownerClient.query(`SET ROLE "${schemaOwner}"`);
            await ensurePgProjectionSchema(ownerClient);
            await grantPgProjectionRuntimeAccess(ownerClient);
            await ensurePgProjectionSchema(ownerClient);
            await ownerClient.query("RESET ROLE");
          } finally {
            ownerClient.release();
          }

          // Pre-existing rows remain NULL until bounded backfill (proving zero table rewrite), and bytes stay identical.
          const pendingBefore = await upgradeAdmin.query<{ readonly n: string }>(
            "SELECT count(*) AS n FROM ha_events WHERE repo_id=$1 AND occurred_at_ms IS NULL",
            [upRepo],
          );
          assert.equal(Number(pendingBefore.rows[0]!.n), HISTORICAL_TIMESTAMP_CASES.length);
          await assert.rejects(
            upStore.execute({
              operation: "window",
              query: {
                afterRevision: 0,
                after: "2026-11-05T00:00:00.000Z",
                before: "2026-11-05T23:59:59.999Z",
                limit: 20,
              },
            }),
            { code: "projection_pending" },
          );
          // Pure revision window remains available even before occurred_at_ms backfill finishes.
          const revOnly = (await upStore.execute({
            operation: "window",
            query: { afterRevision: 0, maxRevision: 3, limit: 10 },
          })) as { readonly events: readonly { readonly workspaceRevision: number }[]; readonly done: boolean };
          assert.equal(revOnly.done, true);
          assert.deepEqual(
            revOnly.events.map((e) => e.workspaceRevision),
            [1, 2, 3],
          );

          // Previous-version writer INSERT (omitting occurred_at_ms) during upgrade window is stamped by trigger.
          const prevWriterRev = HISTORICAL_TIMESTAMP_CASES.length + 1;
          const prevWriterEv = {
            ...eventAt(prevWriterRev),
            eventId: "dm09-prev-writer",
            opId: "dm09-prev-writer",
            occurredAt: "2026-11-05T15:30:00.123999Z",
          };
          await upStore.append(bundle(prevWriterEv), prevWriterRev - 1, fence(upRepo));
          const stamped = await upgradeAdmin.query<{ readonly occurred_at_ms: string | null }>(
            "SELECT occurred_at_ms FROM ha_events WHERE repo_id=$1 AND revision=$2",
            [upRepo, prevWriterRev],
          );
          assert.equal(Number(stamped.rows[0]!.occurred_at_ms), Date.parse("2026-11-05T15:30:00.123Z"));

          // Phase 4 bounded backfill via existing ha_backfill_event_read_indexes until processed=0.
          let processed = 0;
          do {
            processed = await withPostgresTransaction(
              upgradeAdmin,
              async (client) => {
                await client.query(`SET LOCAL ROLE "${schemaOwner}"`);
                return (
                  await client.query<{ readonly processed: number }>(
                    "SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed",
                    [scope.tenantId, scope.projectId, scope.policyEpoch, upRepo],
                  )
                ).rows[0]!.processed;
              },
              scope,
            );
          } while (processed > 0);

          const pendingAfter = await upgradeAdmin.query<{ readonly n: string }>(
            "SELECT count(*) AS n FROM ha_events WHERE repo_id=$1 AND occurred_at_ms IS NULL",
            [upRepo],
          );
          assert.equal(Number(pendingAfter.rows[0]!.n), 0);
          const afterBytes = (
            await upgradeAdmin.query<{
              readonly revision: string;
              readonly occurred_at: string;
              readonly event_json: string;
              readonly event_digest: string;
            }>(
              "SELECT revision, occurred_at, event_json, event_digest FROM ha_events WHERE repo_id=$1 AND revision<=$2 ORDER BY revision ASC",
              [upRepo, HISTORICAL_TIMESTAMP_CASES.length],
            )
          ).rows;
          assert.deepEqual(afterBytes, beforeBytes);

          // RLS-restricted ha_runtime reader reads all pre-existing + previous-writer rows accurately.
          await upgradeAdmin.query("ANALYZE ha_events");
          const plans: unknown[] = [];
          const tracedUpgradeRuntime = tracedPgReads(upgradeRuntime, plans, (sql) => /FROM ha_events/u.test(sql));
          const nov5After = await withPostgresTransaction(
            tracedUpgradeRuntime,
            (client) =>
              readPgEventWindow(
                client,
                scope,
                {
                  repoId: upRepo,
                  query: {
                    afterRevision: 0,
                    after: "2026-11-05T00:00:00.000Z",
                    before: "2026-11-05T23:59:59.999Z",
                    limit: 20,
                  },
                },
                prevWriterRev,
              ),
            scope,
          );
          assert.equal(nov5After.done, true);
          assert.deepEqual(
            nov5After.events.map((e) => [e.workspaceRevision, e.occurredAt]),
            [
              ...HISTORICAL_TIMESTAMP_CASES.filter((c) => c.expectedInNov5).map((c) => [c.revision, c.occurredAt]),
              [prevWriterRev, "2026-11-05T15:30:00.123999Z"],
            ],
          );
        } finally {
          await upgradeRuntime?.end();
          await upgradeAdmin.end();
        }
      },
    );
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
