// harness-test-tier: integration
// harness-test-file-timeout: 1800000
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initRepo } from "../../packages/storage/test/store/task-event-store.fixtures.ts";
import { seedSettingsEvent } from "../../packages/daemon/test/repo-settings.fixture.ts";
import { openSqliteEventStore } from "../../packages/storage/src/store/sqlite-event-store.ts";
import { serializePersistedCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import { generateCenterLedger, ledgerProfile } from "./center-ledger.mjs";
import { runCenterBenchmark, defaultTrafficModel } from "./center-bench.mjs";

test(
  "same seed generates identical canonical events and objects with the declared counts",
  { timeout: 60_000 },
  async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-center-generator-"));
    const signatures = [];
    try {
      for (const arm of ["first", "second"]) {
        const rootDir = path.join(scratch, arm),
          userRoot = path.join(scratch, "user");
        mkdirSync(rootDir);
        initRepo(rootDir);
        writeFileSync(
          path.join(rootDir, "harness", "harness.yaml"),
          "schema: harness-anything/v1\nname: center-bench\n",
        );
        const seeded = seedSettingsEvent({ rootDir, repoId: "center-bench", keepOpen: true });
        await seeded.drain();
        const profile = {
          events: 90,
          documents: 60,
          tasks: 2,
          jsonBytes: 1_000_000,
          largeJsonBytes: [1000, 3000, 5000],
        };
        const result = await generateCenterLedger({
          rootDir,
          repoId: "center-bench",
          userRoot,
          seed: "fixed",
          profile,
        });
        assert.equal(result.generatedEvents, 90);
        assert.equal(result.documents, 60);
        assert.equal(result.tasks, 2);
        assert.equal(result.follower.cut, result.revision);
        assert.equal(result.follower.git, "verified");
        const store = openSqliteEventStore({ rootInput: rootDir, repoId: "center-bench", readOnly: true });
        try {
          const hash = createHash("sha256");
          for (const event of store.events()) hash.update(serializePersistedCanonicalEvent(event));
          for (const digest of store.contentObjectDigests().toSorted())
            hash.update(digest).update(store.readContentObject(digest));
          signatures.push(hash.digest("hex"));
          assert.equal(store.events().length, result.baselineRevision + 90);
          assert.ok(store.documentHead(result.sampleDocuments[0].path));
        } finally {
          store.close();
        }
      }
      assert.equal(signatures[0], signatures[1]);
      assert.equal(ledgerProfile(1).events, 225_000);
      assert.equal(ledgerProfile(10).documents, 1_350_000);
      assert.ok(ledgerProfile(10).largeJsonBytes.every((bytes) => bytes <= 300_000_000));
      console.log(`CENTER_LEDGER_DETERMINISM\t${JSON.stringify({ signatures, events: 90, documents: 60 })}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);

test(
  "center campaign measures real transports, replica reconnect, backup and controlled faults",
  {
    timeout: 1_700_000,
    skip:
      process.platform === "win32"
        ? "requires POSIX OpenSSL certificate generation for an isolated fleet listener"
        : false,
  },
  async (t) => {
    const full = process.env.FLEET_STRESS_CENTER_ISOLATED === "1";
    const nodes = full ? (process.env.FLEET_STRESS_CENTER_NODES ?? "1,10,100,500,1000").split(",").map(Number) : [1, 2];
    const scale = full ? Number(process.env.FLEET_STRESS_CENTER_SCALE ?? "1") : 0.001;
    const durationMs = full ? Number(process.env.FLEET_STRESS_CENTER_DURATION_MS ?? "10000") : 3000;
    const model = process.env.FLEET_STRESS_CENTER_MODEL
      ? JSON.parse(Buffer.from(process.env.FLEET_STRESS_CENTER_MODEL, "base64").toString())
      : defaultTrafficModel();
    const report = await runCenterBenchmark({
      nodes,
      scale,
      durationMs,
      model,
      track: (close) => t.after(close),
      onProgress: (row) => console.log(`CENTER_PROGRESS\t${JSON.stringify(row)}`),
    });
    console.log(`CENTER_BENCH_REPORT\t${JSON.stringify(report)}`);
    assert.ok(
      report.recordedTraffic.lifecycle.length > 0,
      "retain the product lifecycle log before deleting the owned fixture",
    );
    assert.equal(report.capacity.length, nodes.length);
    for (const row of report.capacity) {
      assert.deepEqual(row.methods, row.plannedMethods);
      if (!full || row.nodes === 1) {
        assert.deepEqual(
          row.wireObservedMethods,
          row.plannedMethods,
          "daemon connection log confirms actual method composition",
        );
        assert.equal(row.replication.recovered, row.nodes, JSON.stringify(row.replication));
      }
      if (!full) {
        assert.ok(
          row.productDiagnostics.some(
            (sample) =>
              !sample.error &&
              Number.isFinite(sample.eventLoopDelayMs?.p99) &&
              Number.isFinite(sample.eventLoopDelayMs?.max),
          ),
          "product watchdog provides event-loop metrics through its independent diagnostic socket",
        );
        assert.equal(row.errorRate, 0, JSON.stringify(row.errors));
        assert.ok(
          row.read.count > 0 && row.write.count > 0,
          "calibration exercises both RPC read and durable write paths",
        );
        assert.equal(row.replication.connectedAfter, row.nodes);
        assert.ok(row.replication.commitsReceived > 0, "replica sinks decode incremental commits during replay");
        assert.ok(
          row.observePolls.history >= row.nodes && row.observePolls.follow >= row.nodes,
          "GUI calibration bootstraps history then follows the returned live cursor",
        );
      }
    }
    const fault = (name) => report.faults.find((row) => row.scenario === name).observations;
    assert.equal(fault("drain-hang").heldCloseEntered, true);
    if (!full) {
      assert.equal(fault("reconnect").reconnect.recovered, Math.max(...nodes));
      assert.ok(fault("base-backup").bytes > 0);
      assert.ok(fault("large-document").reads.every((row) => row.ok));
      assert.equal(fault("large-document").write.outcome, "applied", JSON.stringify(fault("large-document").write));
      assert.ok(fault("slow-read").reads.every((row) => row.ok));
    }
    assert.equal(fault("legacy-frame").accepted, false);
    assert.equal(fault("legacy-frame").faultSent, true);
    assert.equal(fault("legacy-frame").processSurvived, true);
    assert.equal(fault("legacy-frame").code, "center_upgrade_required");
  },
);
