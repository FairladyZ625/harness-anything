// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  makePostgresTaskEventStore,
  POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS,
  type PostgresTaskEventStoreRequest,
  type CanonicalEventAppendReceipt,
} from "@harness-anything/storage";
import { startManagedPostgresFixture } from "../../storage/test/postgres/managed-postgres.fixture.ts";
import { bundle, eventAt, initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import type { RepoWriterCapabilityCallV1 } from "../src/repo-writer-protocol.ts";
import { seedSettingsEvent } from "./repo-settings.fixture.ts";

test("RepoWriter sends complete PG operations asynchronously and drains before returning the borrowed pool", async () => {
  const fixture = await startManagedPostgresFixture(),
    root = mkdtempSync(path.join(tmpdir(), "ha-writer-pg-")),
    repoId = workspaceId("writer-canonical-pg"),
    rootDir = canonicalRoot(root),
    scope = { tenantId: "writer-tenant", projectId: "writer-project", readers: [], policyEpoch: 1 },
    writerFence = { repoId, holderId: "writer-host", epoch: 1 },
    calls: RepoWriterCapabilityCallV1[] = [];
  let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>> | undefined;
  try {
    for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await fixture.adminPool.query(statement);
    const store = makePostgresTaskEventStore({ pool: fixture.adminPool, repoId, scope });
    let execute = store.execute;
    initRepo(root);
    seedSettingsEvent({ repoId, rootDir });
    supervisor = await openWriterSupervisor(
      { repoId, rootDir, ownerId: "pg-writer-test" },
      {
        canonicalStore: (request, signal) => execute(request, signal),
        createWorker: (url, options) => {
          const worker = new Worker(url, options);
          worker.on("message", (message: RepoWriterCapabilityCallV1) => {
            if (message.schema === "harness-repo-writer-capability-call/v1" && message.capability === "canonicalStore")
              calls.push(message);
          });
          return worker;
        },
      },
    );
    const request: PostgresTaskEventStoreRequest = {
      operation: "append",
      bundle: bundle(eventAt(1)),
      expectedRevision: 0,
      writerFence,
    };
    const receipt = await supervisor.request<CanonicalEventAppendReceipt>("canonicalStore", request);
    assert.equal(receipt.revision, 1);
    assert.equal(calls.length, 1, "one complete bundle crosses the worker boundary once");
    assert.equal(calls[0]!.sync, undefined, "PG never enters the blocking capability bridge");
    assert.equal((await store.readHead())!.revision, 1);
    await assert.rejects(
      supervisor.request("canonicalStore", {
        ...request,
        expectedRevision: 1,
        bundle: { ...bundle(eventAt(2)), plan: { commandType: eventAt(2).type, targets: [] } },
      }),
      { code: "invalid_write_plan" },
    );
    assert.equal((await store.readHead())!.revision, 1, "freezing transport data never replaces bundle validation");
    const next: PostgresTaskEventStoreRequest = { ...request, bundle: bundle(eventAt(2)), expectedRevision: 1 };
    await assert.rejects(supervisor.request("canonicalStore", { ...next, expectedRevision: 0 }), {
      code: "revision_conflict",
    });

    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    execute = makePostgresTaskEventStore({
      pool: fixture.adminPool,
      repoId,
      scope,
      project: async () => {
        entered.resolve();
        await release.promise;
      },
    }).execute;
    const abort = new AbortController();
    const cancelled = assert.rejects(
      supervisor.request("canonicalStore", next, undefined, abort.signal),
      /cancel canonical operation/u,
    );
    await entered.promise;
    abort.abort(new Error("cancel canonical operation"));
    release.resolve();
    await cancelled;
    assert.equal((await store.readHead())!.revision, 1, "aborted transaction never advances head");

    const draining = Promise.withResolvers<void>(),
      drained = Promise.withResolvers<void>();
    execute = makePostgresTaskEventStore({
      pool: fixture.adminPool,
      repoId,
      scope,
      project: async () => {
        draining.resolve();
        await drained.promise;
      },
    }).execute;
    const inFlight = assert.rejects(supervisor.request("canonicalStore", next), /RepoWriterCell closed/u);
    await draining.promise;
    const closing = supervisor.close();
    drained.resolve();
    await Promise.all([closing, inFlight]);
    assert.equal((await store.readHead())!.revision, 1);
    assert.equal(
      (await fixture.adminPool.query("SELECT 1 AS alive")).rows[0]!.alive,
      1,
      "pool lifecycle stays with the host",
    );
    assert.ok(calls.every((call) => call.sync === undefined));
    process.stdout.write(
      `PG_REPO_WRITER_CAPABILITY calls=${calls.length} blocking_calls=0; cancellation and drain rolled back in-flight transactions\n`,
    );
  } finally {
    await supervisor?.close();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
