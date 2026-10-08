// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  makeTaskEventStore,
  openSqliteEventStore,
  type CanonicalEventV1,
  ciRunObservationWritePlan,
  ciDetailMeasurement,
  type CiRunObservationEventV4,
  type CiRunDetail,
} from "@harness-anything/kernel";
import legacyV2 from "../../kernel/fixtures/canonical-events/ci-run-observation-v2/accepted.json" with { type: "json" };
import legacyV3 from "../../kernel/fixtures/canonical-events/ci-run-observation-v3/accepted.json" with { type: "json" };
import sample from "../../kernel/fixtures/canonical-events/ci-run-observation-v4/job.json" with { type: "json" };
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";

async function seed(rootDir: string) {
  const store = makeTaskEventStore({ repoId: "lease-repo", rootDir });
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const detail: CiRunDetail = {
        schema: "ci-run-detail/v1",
        fileOutcomes: [],
        diagnostics: ["large diagnostic".repeat(10000)],
        tests: [
          {
            testKey: "one",
            file: "example.ts",
            name: "recovered",
            suite: ["suite"],
            executionOrdinal: 1,
            declarationLocation: { line: 2, column: 1 },
            failureLocation: null,
            tier: "fast",
            shard: 1,
            durationMs: attempt * 10,
            status: attempt === 1 ? "failed" : "passed",
            ...(attempt === 1 ? { failureSummary: "fixture failure", truncated: false } : {}),
          },
        ],
      };
      const body = JSON.stringify(detail),
        digest = createHash("sha256").update(body).digest("hex");
      const job = structuredClone(sample) as CiRunObservationEventV4;
      const base = {
        ...job.payload,
        identity: {
          ...job.payload.identity,
          databaseRunId: "101",
          runAttempt: attempt,
          jobExecutionId: `${attempt}01`,
          jobKey: "test-job",
        },
        run: { ...job.payload.run, runId: `101.${attempt}`, branch: "main" },
        ...ciDetailMeasurement(detail),
        detailRef: {
          schema: "ci-run-detail/v1" as const,
          sha256: digest,
          mediaType: "application/json" as const,
          encoding: "identity" as const,
          encodedBytes: Buffer.byteLength(body),
          decodedBytes: Buffer.byteLength(body),
        },
      };
      const scopes: CiRunObservationEventV4["payload"][] = [
        base,
        {
          ...base,
          scope: "attempt",
          verification: null,
          identity: { ...base.identity, jobExecutionId: null, jobKey: null },
          testSummary: null,
          failedTests: [],
          fileOutcomes: [],
          shardDurations: [],
          detailRef: null,
          measurementCoverage: {
            status: "no-test-artifact",
            missingReason: null,
            startedFileCount: null,
            completedFileCount: null,
          },
          attemptInventory: {
            jobs: [{ jobExecutionId: `${attempt}01`, name: "test-job", conclusion: "success" }],
            missingArtifactJobIds: [],
          },
        },
      ];
      for (const payload of scopes) {
        const revision = (store.readHead()?.revision ?? 0) + 1;
        const event: CiRunObservationEventV4 = {
          ...job,
          payload,
          eventId: `event-ci-seed-${revision}`,
          opId: `op-ci-seed-${revision}`,
          workspaceRevision: revision,
        };
        store.append({
          event,
          plan: ciRunObservationWritePlan(event),
          blobs: payload.detailRef
            ? [{ sha256: digest, size: Buffer.byteLength(body), mediaType: "application/json", body }]
            : [],
        });
      }
    }
  } finally {
    await store.drain();
  }
}

async function protocolRead(
  e: Awaited<ReturnType<typeof fleetEdgeHostFixture>>,
  fetch = false,
): Promise<Record<string, unknown>> {
  const response = await e.rpc.handle({
    jsonrpc: "2.0",
    id: 77,
    method: "repo.ci.observatory.read",
    params: { repo: { repoId: "lease-repo" }, payload: { window: 100, fetchDetails: fetch } },
  });
  if (!response || Array.isArray(response) || !("result" in response)) throw new Error(JSON.stringify(response));
  return response.result as Record<string, unknown>;
}

test(
  "center and two real edge hosts calculate the same fixed-cut statistics; cached details remain readable offline",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true, {}, seed);
    const edges = [
      await fleetEdgeHostFixture(t, f, { name: "ci-one" }),
      await fleetEdgeHostFixture(t, f, { name: "ci-two", nodeId: "node-two" }),
    ];
    const replica = f.host.replica("lease-repo");
    replica.activate();
    await replica.waitForCut(f.eventCount());
    for (const e of edges)
      await runFleetReplicaPullClient({
        ...f.peer(e.config.nodeId),
        viewRoot: e.viewRoot,
        diskQuotaBytes: e.config.quotaBytes,
      });
    const truth = (await f.host.read(
      "lease-repo",
      "repo.ci.observatory.read",
      { fetchDetails: true },
      localAuthFixture(),
    )) as Record<string, unknown>;
    assert.equal(truth.statisticsAvailability, "ready");
    for (const e of edges) {
      const before = (await protocolRead(e)) as Record<string, unknown>;
      assert.equal(before.statisticsAvailability, "pending");
      assert.deepEqual(before.tests, []);
      const beforeJobs = (before.runs as { scope: string; detailAvailability: string; detail: unknown }[]).filter(
        (run) => run.scope === "job",
      );
      assert.ok(
        beforeJobs.length > 0 &&
          beforeJobs.every((run) => run.detailAvailability === "not_cached" && run.detail === null),
      );
      const after = (await protocolRead(e, true)) as Record<string, unknown>;
      assert.equal(after.statisticsAvailability, "ready");
      assert.deepEqual(after.tests, truth.tests);
      assert.deepEqual(after.recoveries, truth.recoveries);
      assert.equal(after.sourceRevision, truth.sourceRevision);
      assert.deepEqual(after.runs, truth.runs);
      assert.deepEqual(after.importer, truth.importer);
      assert.ok(
        (after.runs as { scope: string; detail: unknown }[])
          .filter((run) => run.scope === "job")
          .every((run) => run.detail !== null),
      );
    }
    assert.notEqual(edges[0]!.viewRoot, edges[1]!.viewRoot);
    const unchanged = (await f.host.read(
      "lease-repo",
      "repo.ci.observatory.read",
      { fetchDetails: true },
      localAuthFixture(),
    )) as Record<string, unknown>;
    assert.equal(
      unchanged.sourceRevision,
      truth.sourceRevision,
      "edge detail downloads must not write occurrence or canonical evidence",
    );
    assert.deepEqual(unchanged.importer, truth.importer);
    await f.center.close();
    for (const e of edges) {
      const offline = (await protocolRead(e, true)) as Record<string, unknown>;
      assert.deepEqual(offline.tests, truth.tests);
      assert.deepEqual(offline.recoveries, truth.recoveries);
      assert.deepEqual(offline.runs, truth.runs);
      assert.deepEqual(offline.importer, truth.importer);
    }
  },
);

async function seedHistory(rootDir: string, mixed: boolean) {
  // Materialize accepted history through the store's historical replay seam; current admission stays v4-only.
  const ledger = openSqliteEventStore({ rootInput: rootDir, repoId: "lease-repo" });
  const fence = {
    repoId: "lease-repo",
    holder: "historical-ci-fixture",
    epoch: (ledger.writerFence()?.epoch ?? 0) + 1,
  };
  ledger.claimWriter(fence);
  try {
    for (const [index, history] of [legacyV2, legacyV3].entries()) {
      const event = {
        ...history,
        eventId: `event-ci-history-${index}`,
        opId: `op-ci-history-${index}`,
        workspaceRevision: ledger.revision() + 1,
      } as CanonicalEventV1;
      ledger.appendCommand({
        fence,
        intent: { opId: event.opId, intentDigest: `sha256:${"a".repeat(64)}`, summary: event.type },
        events: [event],
      });
    }
  } finally {
    ledger.releaseWriter(fence);
    ledger.close();
  }
  if (mixed) await seed(rootDir);
  else {
    const store = makeTaskEventStore({ repoId: "lease-repo", rootDir });
    await store.drain();
  }
}

for (const mixed of [false, true]) {
  test(
    `fetch-details preserves pending history and caches authorized cold objects in a ${mixed ? "mixed" : "legacy-only"} window`,
    { timeout: 180_000 },
    async (t) => {
      const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true, {}, (root) =>
        seedHistory(root, mixed),
      );
      const e = await fleetEdgeHostFixture(t, f, { name: `ci-history-${mixed}` });
      const replica = f.host.replica("lease-repo");
      replica.activate();
      await replica.waitForCut(f.eventCount());
      await runFleetReplicaPullClient({
        ...f.peer(e.config.nodeId),
        viewRoot: e.viewRoot,
        diskQuotaBytes: e.config.quotaBytes,
      });
      const truth = (await f.host.read(
        "lease-repo",
        "repo.ci.observatory.read",
        { fetchDetails: true },
        localAuthFixture(),
      )) as Record<string, unknown>;
      const before = await protocolRead(e);
      assert.equal(before.statisticsAvailability, "pending");
      assert.equal((before.missingDetails as string[]).length, mixed ? 4 : 2);
      const after = await protocolRead(e, true);
      assert.equal(after.statisticsAvailability, "pending", JSON.stringify(after));
      assert.deepEqual(after.missingDetails, ["unavailable:event-ci-history-0", "unavailable:event-ci-history-1"]);
      assert.deepEqual(after.tests, []);
      assert.deepEqual(after.recoveries, truth.recoveries);
      assert.equal((after.recoveries as unknown[]).length, mixed ? 1 : 0);
      assert.equal(after.sourceRevision, truth.sourceRevision);
      await f.center.close();
      const offline = await protocolRead(e, true);
      assert.deepEqual(
        { ...offline, freshness: null },
        { ...after, freshness: null },
        "cached statistics and fixed cut remain unchanged; freshness age advances with the clock",
      );
    },
  );
}
