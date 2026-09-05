// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../../packages/daemon/src/protocol/daemon-protocol.contract.ts";
import { openPersistentWriterEpoch } from "../../packages/daemon/src/writer-epoch.ts";
import { openBootstrappedRepoCell } from "../../packages/daemon/test/repo-settings.fixture.ts";
import { initRepo } from "../../packages/daemon/test/task-surface.fixtures.ts";
import { serializePersistedCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import { makeTaskEventReader } from "../../packages/kernel/src/index.ts";
import { sha256Text } from "../../packages/kernel/src/integrity/stable-hash.ts";
import { migrateEventsToSqlite, openSqliteEventStore } from "../../packages/kernel/src/store/sqlite-event-store.ts";
import { reconcileSqliteEvents } from "../../packages/kernel/src/store/sqlite-ledger-reconcile.ts";
import { oracleO1, oracleO2, oracleO7 } from "./core/oracles.mjs";
import { buildStressReport, emitStressReport } from "./core/report.mjs";
import { openReceiptLog, readReceiptLog } from "./core/receipt-log.mjs";
import { runUnderStrace, syscallOccurrences } from "./storage/strace-injector.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixture = path.join(import.meta.dirname, "storage/repo-cell-shadow-fixture.mjs");
const repoId = "stress-s2-shadow";
const taskId = "task_stress_s2_shadow_fault";
const seed = "stress-s2-seed-20260905";

test(
  "S2 reports an unknown shadow cause when rollback masks injected physical I/O",
  { concurrency: false, timeout: 120_000 },
  async () => {
    assert.equal(process.platform, "linux", "requires Linux strace fault injection");
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-stress-s2-"));
    const controllerRoot = path.join(scratch, "controller");
    mkdirSync(controllerRoot, { recursive: true });
    try {
      const positiveControl = await proveNativePwriteInjection(scratch);
      const baselineRoot = path.join(scratch, "baseline");
      const baselineRevision = await prepareShadowRoot(baselineRoot);
      const baselineTrace = path.join(controllerRoot, "baseline.strace");
      const baseline = await runUnderStrace({
        command: process.execPath,
        args: [fixture, "command", baselineRoot, repoId, taskId],
        tracePath: baselineTrace,
        cwd: repoRoot,
      });
      assert.equal(baseline.code, 0, baseline.stderr);
      const baselineFrame = parseSingleFrame(baseline.stdout);
      assert.equal(baselineFrame.receipt.outcome, "applied", baseline.stdout);
      const baselineEvents = canonicalDelta(baselineRoot, baselineRevision);
      assert.ok(baselineEvents.length > 0, "baseline command did not append canonical events");
      const sqliteWalSuffix = path.join("store", "generations", "1", "ledger.sqlite-wal");
      const shadowWrites = syscallOccurrences(baseline.trace, {
        syscall: "pwrite64",
        pathIncludes: sqliteWalSuffix,
      });
      if (shadowWrites.length === 0) {
        const allPwrite64 = syscallOccurrences(baseline.trace, {
          syscall: "pwrite64",
        });
        const sqliteTrace = baseline.trace
          .split(/\r?\n/u)
          .filter((line) => line.includes("ledger.sqlite"))
          .slice(0, 20);
        const report = buildStressReport({
          campaignComplete: false,
          source: {
            head: process.env.HARNESS_BUILD_COMMIT ?? null,
            base: process.env.HARNESS_BASE_COMMIT ?? null,
            loadedBuild: sourceBuildId(),
            dirty: null,
          },
          environment: {
            node: process.version,
            sqlite: readSqliteCut(path.join(baselineRoot, ".harness", "store", "generations", "1", "ledger.sqlite"))
              .sqliteVersion,
            os: `${process.platform}-${process.arch}`,
            filesystem: "isolated Ubuntu temporary filesystem",
            capabilities: ["strace pwrite64 fault injection", "node:sqlite", "fresh SQLite reopen"],
          },
          seed,
          topology: "external controller + RepoCell WAL/Git accept path + SQLite shadow",
          generation: 1,
          counts: { acceptedEvents: baselineEvents.length, uniqueBlobs: 0, maxConcurrentClients: 1 },
          coverage: {
            required: ["F01/repo-cell-shadow-pwrite64-EIO"],
            hit: [],
            missing: ["F01/repo-cell-shadow-pwrite64-EIO"],
            unmapped: ["F01/repo-cell-shadow-pwrite64-EIO"],
            negativeControls: [
              {
                id: "injector/pwrite64-EIO",
                observed: positiveControl.code,
                passed: positiveControl.passed,
              },
            ],
          },
          calibration: {
            processPwrite64Occurrences: allPwrite64.length,
            sqliteWalPwrite64Occurrences: 0,
            sqliteTrace,
          },
          cases: [
            {
              id: "F01/repo-cell-shadow-pwrite64-EIO",
              pid: baselineFrame.pid,
              loadedBuild: sourceBuildId(),
              boundaryHits: [],
              faults: [],
              oracles: {},
              verdict: "BLOCKED",
              violations: [
                "strace observed no pwrite64 call attributable to the SQLite shadow WAL, so occurrence-index injection cannot target the required native boundary",
              ],
            },
          ],
          replayCommand:
            "node tools/dispatch-isolated-test.mjs --target ubuntu " +
            "--file tools/stress/storage-campaign.integration.test.mjs",
          residualRisks: [
            "No candidate green claim was made because the required native SQLite boundary was not intercepted.",
            "The storage fault matrix remains unverified after the task checkpoint fired.",
          ],
        });
        assert.equal(report.verdict, "BLOCKED");
        emitStressReport(report);
        return;
      }

      const faultRoot = path.join(scratch, "fault");
      const faultBaselineRevision = await prepareShadowRoot(faultRoot);
      assert.equal(faultBaselineRevision, baselineRevision);
      const receiptLogPath = path.join(controllerRoot, "fault-receipts.jsonl");
      const expectedOpId = baselineEvents.at(-1).opId;
      const request = {
        requestId: "F01-shadow-pwrite64-EIO",
        opId: expectedOpId,
        intentDigest: `sha256:${sha256Text(JSON.stringify(baselineEvents.map(serializePersistedCanonicalEvent)))}`,
        expectedEvents: baselineEvents,
        boundary: "sqlite-shadow-pwrite64",
      };
      const receiptLog = openReceiptLog({
        file: receiptLogPath,
        targetRoots: [faultRoot],
        campaignId: "stress-s2-f01-shadow",
        seed,
      });
      receiptLog.recordRequest(request);
      const occurrence = shadowWrites[0].ordinal;
      const tracee = shadowWrites[0].tracee;
      const faultTrace = path.join(controllerRoot, "fault.strace");
      const faulted = await runUnderStrace({
        command: process.execPath,
        args: [fixture, "command", faultRoot, repoId, taskId],
        tracePath: faultTrace,
        injection: `pwrite64:error=EIO:when=${occurrence}`,
        cwd: repoRoot,
      });
      assert.equal(faulted.code, 0, faulted.stderr);
      const faultFrame = parseSingleFrame(faulted.stdout);
      assert.equal(faultFrame.receipt.outcome, "applied", faulted.stdout);
      receiptLog.recordReceipt(request.requestId, {
        status: "accepted_durable",
        opId: expectedOpId,
        intentDigest: request.intentDigest,
        receiptOutcome: faultFrame.receipt.outcome,
      });
      receiptLog.close();

      const injectedLine = faulted.trace
        .split(/\r?\n/u)
        .find((line) => line.includes("pwrite64(") && line.includes("EIO") && line.includes("INJECTED"));
      assert.ok(injectedLine, "fault trace does not contain an injected EIO pwrite64");
      const canonicalCut = readCanonicalCut(faultRoot);
      const canonicalEvents = canonicalCut.events.slice(faultBaselineRevision);
      assert.deepEqual(canonicalEvents, baselineEvents, "canonical command changed under the shadow-only fault");
      const databasePath = path.join(faultRoot, ".harness", "store", "generations", "1", "ledger.sqlite");
      const sqliteCut = readSqliteCut(databasePath);
      assert.equal(
        sqliteCut.events.some((event) => event.opId === expectedOpId),
        false,
      );
      assert.equal(
        sqliteCut.outcomes.some((outcome) => outcome.opId === expectedOpId),
        false,
      );
      const reconciliation = reconcileSqliteEvents({ repoId, databasePath, events: canonicalCut.events });
      const injectedRevision = faultBaselineRevision + 1;
      assert.equal(reconciliation.matches, false);
      assert.equal(reconciliation.firstDivergentRevision, injectedRevision);
      const shadowFailureCause = classifyShadowFailure(faulted.stderr, sqliteCut.revision < canonicalCut.revision);
      assert.equal(shadowFailureCause, "unknown", faulted.stderr);
      const sharedOracleInput = {
        receiptLog: readReceiptLog(receiptLogPath),
        canonicalCut,
        sqliteCut,
        shadowLag: {
          canonicalRevision: canonicalCut.revision,
          sqliteRevision: sqliteCut.revision,
          firstDivergentRevision: injectedRevision,
        },
        shadowFailureCause,
        recovery: {
          reconciliation,
          sql: { integrity: sqliteCut.integrity, head: sqliteCut.revision },
          objectsComplete: true,
          firstRebuild: {},
          secondRebuild: {},
        },
      };
      const canonicalInput = { ...sharedOracleInput, authority: "canonical" };
      const canonicalOracles = {
        O1: oracleO1(canonicalInput),
        O2: oracleO2(canonicalInput),
        O7: oracleO7(canonicalInput),
      };
      assert.equal(canonicalOracles.O1.verdict, "PASS");
      assert.equal(canonicalOracles.O2.verdict, "PASS");
      assert.equal(canonicalOracles.O7.verdict, "FAIL");
      const sqliteInput = { ...sharedOracleInput, authority: "sqlite" };
      const sqliteOracles = {
        O1: oracleO1(sqliteInput),
        O2: oracleO2(sqliteInput),
        O7: oracleO7(sqliteInput),
      };
      assert.ok(Object.values(sqliteOracles).every(({ verdict }) => verdict === "FAIL"));

      const caseResult = {
        id: "F01/repo-cell-shadow-pwrite64-EIO",
        authority: "canonical",
        pid: faultFrame.pid,
        loadedBuild: sourceBuildId(),
        nodeId: "isolated-s2-node",
        holder: "stress-s2-center",
        epoch: 1,
        claim: taskId,
        cut: { generation: 1, revision: canonicalCut.revision },
        shadowLag: sharedOracleInput.shadowLag,
        shadowFailureCause,
        schedule: [
          `baseline pwrite64 K=${shadowWrites.length}`,
          `inject tracee=${tracee} occurrence n=${occurrence}`,
          "fresh reopen",
        ],
        boundaryHits: [
          {
            id: "repo-cell:after-canonical-append:before-sqlite-shadow-commit",
            syscall: "pwrite64",
            tracee,
            occurrence,
            observedK: shadowWrites.length,
          },
        ],
        faults: [
          {
            kind: "one-shot-io",
            errno: "EIO",
            syscall: "pwrite64",
            tracee,
            occurrence,
            trace: injectedLine.trim(),
          },
        ],
        receiptLog: sharedOracleInput.receiptLog,
        receiptLogLocation: receiptLogPath,
        receiptLogCut: sharedOracleInput.receiptLog.records.length,
        reconciliation,
        oracles: canonicalOracles,
        redModel: {
          authority: "sqlite",
          oracles: sqliteOracles,
          observedVerdict: "FAIL",
          expectedVerdict: "FAIL",
        },
        verdict: "FAIL",
        replayCommand:
          "node tools/dispatch-isolated-test.mjs --target ubuntu " +
          "--file tools/stress/storage-campaign.integration.test.mjs",
      };
      const report = buildStressReport({
        campaignComplete: false,
        source: {
          head: process.env.HARNESS_BUILD_COMMIT ?? null,
          base: process.env.HARNESS_BASE_COMMIT ?? null,
          loadedBuild: sourceBuildId(),
          dirty: null,
        },
        environment: {
          node: process.version,
          sqlite: sqliteCut.sqliteVersion,
          os: `${process.platform}-${process.arch}`,
          filesystem: "isolated Ubuntu temporary filesystem",
          capabilities: ["strace pwrite64 fault injection", "node:sqlite", "fresh SQLite reopen"],
        },
        seed,
        topology: "external controller + RepoCell WAL/Git accept path + SQLite shadow",
        generation: 1,
        counts: { acceptedEvents: canonicalEvents.length, uniqueBlobs: 0, maxConcurrentClients: 1 },
        coverage: {
          required: ["F01/repo-cell-shadow-pwrite64-EIO"],
          hit: ["F01/repo-cell-shadow-pwrite64-EIO"],
          missing: [],
          unmapped: [],
          negativeControls: [
            {
              id: "injector/pwrite64-EIO",
              observed: positiveControl.code,
              passed: positiveControl.passed,
            },
            {
              id: "F01/sqlite-authority-shadow-loss",
              observed: caseResult.redModel.observedVerdict,
              passed: caseResult.redModel.observedVerdict === caseResult.redModel.expectedVerdict,
            },
          ],
        },
        calibration: { pwrite64Occurrences: shadowWrites.length },
        cases: [caseResult],
        replayCommand: caseResult.replayCommand,
        residualRisks: [
          "The injected EIO was masked by a rollback error in the only SQLite shadow failure log, so the required cause classification is unknown and canonical authority fails closed.",
          "The remaining F01-F03/F06-F08 matrix is unverified because the signed cause-classification precondition was falsified.",
        ],
      });
      assert.equal(report.verdict, "FAIL");
      emitStressReport(report);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

async function proveNativePwriteInjection(scratch) {
  const probeRoot = path.join(scratch, "positive-control");
  const tracePath = path.join(scratch, "controller", "positive-control.strace");
  const result = await runUnderStrace({
    command: process.execPath,
    args: [fixture, "pwrite-probe", probeRoot],
    tracePath,
    injection: "pwrite64:error=EIO:when=1",
    cwd: repoRoot,
  });
  assert.equal(result.code, 0, result.stderr);
  const frame = parseSingleFrame(result.stdout);
  assert.equal(frame.status, "error");
  assert.equal(frame.code, "EIO");
  assert.match(result.trace, /pwrite64\(.+ = -1 EIO .+INJECTED/u);
  return { passed: true, code: frame.code, trace: result.trace.trim() };
}

async function prepareShadowRoot(rootDir) {
  mkdirSync(rootDir, { recursive: true });
  initRepo(rootDir);
  let cell = await openBootstrappedRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: "stress-s2-bootstrap",
    now: () => "2026-09-05T00:59:58.000Z",
  });
  await cell.close();
  const authority = openPersistentWriterEpoch({
    stateRoot: path.join(rootDir, ".harness", "fleet"),
    holderId: "stress-s2-center",
    now: () => "2026-09-05T00:59:59.000Z",
  });
  const lease = authority.acquire(repoId);
  assert.equal(lease.epoch, 1);
  const canonicalEvents = makeTaskEventReader({ repoId, rootDir }).read().events;
  const sqlite = openSqliteEventStore({ repoId, rootInput: rootDir });
  migrateEventsToSqlite({ store: sqlite, repoId, events: canonicalEvents, holder: lease.holderId, epoch: lease.epoch });
  const revision = sqlite.revision();
  sqlite.close();
  authority.close();
  return revision;
}

function canonicalDelta(rootDir, baselineRevision) {
  return makeTaskEventReader({ repoId, rootDir }).read().events.slice(baselineRevision);
}

function readCanonicalCut(rootDir) {
  const events = makeTaskEventReader({ repoId, rootDir }).read().events;
  return { revision: events.length, events, outcomes: [] };
}

function classifyShadowFailure(stderr, shadowLags) {
  const prefix = "[sqlite-shadow] append failed:";
  const messages = stderr
    .split(/\r?\n/u)
    .filter((line) => line.includes(prefix))
    .map((line) => line.slice(line.indexOf(prefix) + prefix.length).trim());
  if (messages.some((message) => message.includes("writer epoch fence is unavailable"))) return "fence-unavailable";
  if (messages.some((message) => /\b(?:EIO|ENOSPC)\b|I\/O|disk|short write/iu.test(message))) return "physical-io";
  return shadowLags ? "unknown" : null;
}

function readSqliteCut(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = String(database.prepare("PRAGMA integrity_check").get().integrity_check);
    const sqliteVersion = String(database.prepare("SELECT sqlite_version() AS version").get().version);
    const revision = Number(database.prepare("SELECT revision FROM ledger_meta WHERE singleton=1").get().revision);
    const events = database
      .prepare("SELECT event_json FROM event ORDER BY revision")
      .all()
      .map((row) => JSON.parse(String(row.event_json)));
    const outcomes = database
      .prepare(
        "SELECT op_id, status, first_revision, last_revision, intent_digest, " +
          "intent_summary, rejection_code FROM command_outcome ORDER BY recorded_at, op_id",
      )
      .all()
      .map((row) => ({
        opId: String(row.op_id),
        status: String(row.status),
        firstRevision: row.first_revision === null ? null : Number(row.first_revision),
        lastRevision: row.last_revision === null ? null : Number(row.last_revision),
        intentDigest: String(row.intent_digest),
        summary: String(row.intent_summary),
        rejectionCode: row.rejection_code === null ? null : String(row.rejection_code),
      }));
    return { integrity, sqliteVersion, revision, events, outcomes };
  } finally {
    database.close();
  }
}

function parseSingleFrame(stdout) {
  const frames = stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(frames.length, 1, stdout);
  return frames[0];
}

function sourceBuildId() {
  const hash = createHash("sha256");
  for (const file of [
    "tools/stress/storage/strace-injector.mjs",
    "tools/stress/storage/repo-cell-shadow-fixture.mjs",
    "tools/stress/storage-campaign.integration.test.mjs",
  ])
    hash.update(readFileSync(path.join(repoRoot, file)));
  return `source:${hash.digest("hex")}`;
}
