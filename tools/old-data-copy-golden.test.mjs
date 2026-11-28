// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalEventSchemas } from "../packages/kernel/src/domain/doc-sync-canonical-events.ts";
import { seedSettingsEvent } from "../packages/daemon/test/repo-settings.fixture.ts";
import { processAlive } from "./old-data-copy-evidence.mjs";
import { generateGoldenOldDataSnapshot, GOLDEN_REQUIRED_EVENT_SCHEMAS } from "./fixtures/old-data-copy-golden.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "tools/old-data-copy-evidence.mjs");

function runEvidence(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 300_000);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test(
  "Tier 1 (--tier golden): full-morphology Gen-3 snapshot runs end-to-end with warm/cold Fact parity and all canonical event schemas",
  { concurrency: true },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-golden-e2e-"));
    try {
      const out = path.join(parent, "out");
      const result = await runEvidence(["--tier", "golden", "--out", out, "--attach-timeout-ms", "120000"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.ok, true, JSON.stringify(receipt.failures));
      assert.equal(receipt.tier, "golden");
      assert.deepEqual(receipt.failures, []);
      assert.equal(receipt.attach.outcome, "terminal-record");
      assert.equal(receipt.attach.record.event, "repo_attach_completed");
      assert.equal(receipt.warmProjection.preserved, true, "warm projection preserved across attach");
      assert.equal(receipt.archivedFactHistory.equal, true);
      assert.equal(receipt.archivedFactHistory.allContentReadable, true);
      assert.ok(receipt.archivedFactHistory.warmCount >= 3, JSON.stringify(receipt.archivedFactHistory));
      assert.equal(receipt.coldRebuild.watermark, receipt.coldRebuild.sourceRevision);
      assert.ok(
        receipt.coldRebuild.sourceRevision >= 2000,
        `expected >= 2000 events, got ${receipt.coldRebuild.sourceRevision}`,
      );
      assert.equal(receipt.reads.taskIndex.hasAnyTask, true);
      assert.ok((receipt.reads.taskDispatches?.count ?? 0) > 0, "dispatches read on golden primary task");

      const observedSchemas = new Set((receipt.census?.ledger?.eventSchemas ?? []).map((entry) => entry.schema));
      for (const schema of canonicalEventSchemas.map((entry) => entry.schema)) {
        assert.ok(observedSchemas.has(schema), `golden snapshot must cover canonical event schema ${schema}`);
      }
      assert.ok(observedSchemas.has("ci-run-observation/v2"));
      assert.ok(observedSchemas.has("ci-run-observation/v3"));
      assert.equal(observedSchemas.size, GOLDEN_REQUIRED_EVENT_SCHEMAS.length);
      assert.equal(existsSync(path.join(out, "old-data-copy-evidence-receipt.json")), true);
      assert.equal(receipt.cleanup.kept, false);
      assert.equal(existsSync(receipt.cleanup.tempRoot), false);
      assert.equal(receipt.cleanup.daemonStopped, true);
      assert.equal(processAlive(receipt.build.pid), false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test(
  "L6 positive control: Tier 1 (--tier golden) fails red when archived-Fact warm/cold parity is broken",
  { concurrency: true },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-golden-pc-fact-"));
    try {
      const source = path.join(parent, "golden-source");
      generateGoldenOldDataSnapshot(source, { workloadEvents: 80 });
      // Tamper the warm projection's archived Fact descriptor in document_history so warm != cold.
      const cachePath = path.join(source, ".harness", "cache", "task.sqlite");
      const db = new DatabaseSync(cachePath);
      try {
        const row = db
          .prepare("SELECT path, value_json FROM document_history WHERE path LIKE 'facts/%.md' LIMIT 1")
          .get();
        assert.ok(row, "golden snapshot must have archived Fact rows in document_history");
        const parsed = JSON.parse(String(row.value_json));
        parsed.workspaceRevision = 999_999;
        db.prepare("UPDATE document_history SET value_json = ? WHERE path = ?").run(
          JSON.stringify(parsed),
          String(row.path),
        );
      } finally {
        db.close();
      }

      const result = await runEvidence(["--tier", "golden", "--source", source, "--attach-timeout-ms", "120000"]);
      assert.notEqual(result.status, 0, "broken archived-Fact parity must fail red");
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.tier, "golden");
      assert.ok(receipt.failures.length >= 1, JSON.stringify(receipt));
      assert.match(
        JSON.stringify(receipt.failures),
        /warm upgrade and cold rebuild disagree on archived Fact descriptors/u,
      );
      assert.equal(existsSync(receipt.cleanup.tempRoot), false);
      if (receipt.build?.pid) assert.equal(processAlive(receipt.build.pid), false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test(
  "L6 positive control: Tier 1 (--tier golden) fails red when historical event normalization/replay is broken",
  { concurrency: true },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-golden-pc-norm-"));
    try {
      const source = path.join(parent, "golden-source");
      generateGoldenOldDataSnapshot(source, { workloadEvents: 80 });
      // Corrupt the retired people-event/v1 event's roster so historical event replay fails closed
      // when cold rebuild validates the persisted historical roster against its CAS YAML blob.
      const ledgerPath = path.join(source, ".harness", "store", "generations", "3", "ledger.sqlite");
      const db = new DatabaseSync(ledgerPath);
      try {
        const row = db
          .prepare(
            "SELECT revision, event_json FROM event WHERE json_extract(event_json, '$.schema') = 'people-event/v1' LIMIT 1",
          )
          .get();
        assert.ok(row, "golden snapshot must contain a people-event/v1 row");
        const parsed = JSON.parse(String(row.event_json));
        parsed.payload.roster.people[0].displayName = "Tampered Historical Roster";
        db.prepare("UPDATE event SET event_json = ? WHERE revision = ?").run(
          `${JSON.stringify(parsed)}\n`,
          Number(row.revision),
        );
      } finally {
        db.close();
      }

      const result = await runEvidence(["--tier", "golden", "--source", source, "--attach-timeout-ms", "120000"]);
      assert.notEqual(result.status, 0, "broken historical event normalization/replay must fail red");
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.tier, "golden");
      assert.ok(receipt.failures.length >= 1, JSON.stringify(receipt));
      assert.match(JSON.stringify(receipt.failures), /retired People blob .* does not match|direct-evidence/u);
      assert.equal(existsSync(receipt.cleanup.tempRoot), false);
      if (receipt.build?.pid) assert.equal(processAlive(receipt.build.pid), false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

test(
  "L6 positive control: Tier 1 (--tier golden) fails red on an incomplete single-event ledger",
  { concurrency: true },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-oldcopy-golden-pc-cov-"));
    try {
      const source = path.join(parent, "minimal");
      const harness = path.join(source, "harness");
      mkdirSync(harness, { recursive: true });
      writeFileSync(
        path.join(harness, "harness.yaml"),
        "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
        "utf8",
      );
      const store = seedSettingsEvent({ repoId: "minimal-golden-neg", rootDir: source, keepOpen: true });
      assert.ok(store);
      await store.drain();

      const result = await runEvidence(["--tier", "golden", "--source", source, "--attach-timeout-ms", "120000"]);
      assert.notEqual(result.status, 0, "minimal single-event ledger must not satisfy golden tier");
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.tier, "golden");
      assert.ok(
        receipt.failures.some((failure) => failure.phase === "golden-coverage"),
        JSON.stringify(receipt.failures),
      );
      assert.equal(existsSync(receipt.cleanup.tempRoot), false);
    } finally {
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);
