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
import { actor, initRepo } from "../../packages/daemon/test/task-surface.fixtures.ts";
import { serializePersistedCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import { makeTaskEventReader } from "../../packages/kernel/src/index.ts";
import { sha256Text } from "../../packages/kernel/src/integrity/stable-hash.ts";
import { makeTaskProjection } from "../../packages/kernel/src/projection/rebuildable-task-projection.ts";
import { migrateEventsToSqlite, openSqliteEventStore } from "../../packages/kernel/src/store/sqlite-event-store.ts";
import { reconcileSqliteEvents } from "../../packages/kernel/src/store/sqlite-ledger-reconcile.ts";
import { openWalEventLog } from "../../packages/kernel/src/store/wal-event-log.ts";
import { eventAt } from "../../packages/kernel/test/store/task-event-store.fixtures.ts";
import { createProcessTree, createSeededScenario, runScenario } from "./core/controller.mjs";
import { generateCoverageDenominators } from "./core/denominators.mjs";
import { runOracleNegativeControls, runOracles } from "./core/oracles.mjs";
import { buildStressReport, emitStressReport, parseStressReportFrame } from "./core/report.mjs";
import { openReceiptLog, readReceiptLog } from "./core/receipt-log.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const seed = "stress-s1-seed-20260905";

test(
  "S1 drives real store and RepoCell paths, rejects every oracle corruption, and emits a report",
  { concurrency: false, timeout: 120_000 },
  async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-stress-s1-"));
    const targetRoot = path.join(scratch, "target");
    const controllerRoot = path.join(scratch, "controller");
    mkdirSync(targetRoot, { recursive: true });
    mkdirSync(controllerRoot, { recursive: true });
    try {
      assert.throws(
        () =>
          openReceiptLog({
            file: path.join(targetRoot, "bad-receipts.jsonl"),
            targetRoots: [targetRoot],
            campaignId: "negative-location",
            seed,
          }),
        /outside target root/u,
      );

      const core = await runCoreFixture(targetRoot, controllerRoot);
      const crash = await runCrashFixture(path.join(scratch, "crash"), controllerRoot);
      const daemon = await runRepoCellShadowFixture(path.join(scratch, "daemon"), controllerRoot);
      const denominators = await generateCoverageDenominators({ repoRoot });
      const mappedIds = mappedCoverage(denominators.required);
      const coverage = await generateCoverageDenominators({ repoRoot, mappedIds });
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
          sqlite: core.sqliteVersion,
          os: `${process.platform}-${process.arch}`,
          filesystem: "isolated target temporary filesystem",
          capabilities: ["node:sqlite", "POSIX process SIGKILL", "fsync receipt log"],
        },
        seed,
        topology: "serial S1 fixture: external controller + SQLite store + RepoCell shadow",
        generation: 1,
        counts: {
          acceptedEvents: core.cut.events.length,
          uniqueBlobs: core.content.claims.length,
          maxConcurrentClients: 1,
        },
        coverage: {
          denominatorSchema: coverage.schema,
          denominatorDigest: coverage.digest,
          sources: coverage.sources,
          categories: coverage.categories,
          facets: coverage.facets,
          required: coverage.required.map(({ id }) => id),
          hit: coverage.hit,
          missing: coverage.missing,
          unmapped: coverage.unmapped,
          negativeControls: core.negativeControls,
        },
        calibration: {
          tCmdMs: core.calibration.tCmdMs,
          tBlobMs: core.calibration.tBlobMs,
          tRebuildMs: core.calibration.tRebuildMs,
          killRestartMs: crash.killRestartMs,
          sample: {
            commands: core.commandCount,
            blobs: 1,
            rebuildEvents: core.cut.events.length,
            killRestartArms: crash.cases.length,
          },
        },
        cases: [
          {
            id: "S1/sqlite-core",
            pid: process.pid,
            loadedBuild: sourceBuildId(),
            nodeId: "isolated-s1-node",
            holder: core.cut.writer.holder,
            epoch: core.cut.writer.epoch,
            claim: null,
            cut: { generation: 1, revision: core.cut.revision },
            schedule: core.schedule,
            boundaryHits: ["request-fsync", "sqlite-commit", "receipt-fsync", "strict-rebuild"],
            receiptLog: core.receiptLog,
            receiptLogLocation: core.receiptLogPath,
            oracles: core.oracles,
            verdict: "PASS",
          },
          {
            id: "S1/sqlite-process-crash",
            pid: process.pid,
            loadedBuild: sourceBuildId(),
            nodeId: "isolated-s1-node",
            holder: "successor",
            epoch: 2,
            claim: null,
            cut: { generation: 1, revision: 3 },
            schedule: crash.cases.map(({ boundary }) => boundary),
            boundaryHits: crash.cases.map(({ boundary }) => `SIGKILL:${boundary}`),
            receiptLog: crash.receiptLogs,
            faults: crash.cases,
            oracles: {},
            verdict: "PASS",
          },
          {
            id: "S1/repo-cell-shadow",
            pid: process.pid,
            loadedBuild: sourceBuildId(),
            nodeId: "isolated-s1-node",
            holder: daemon.holder,
            epoch: daemon.epoch,
            claim: daemon.taskId,
            cut: { generation: 1, revision: daemon.sqliteRevision },
            schedule: daemon.schedule,
            boundaryHits: ["repo-cell-wal-append", "sqlite-shadow-append"],
            receiptLog: daemon.receiptLog,
            receiptLogLocation: daemon.receiptLogPath,
            oracles: {},
            verdict: "PASS",
          },
        ],
        replayCommand:
          "node tools/dispatch-isolated-test.mjs --target ubuntu " +
          "--file tools/stress/campaign.integration.test.mjs",
        residualRisks: [
          "S1 is intentionally below S4 scale and leaves all unmapped denominator items explicit.",
          "Diagnostic lifecycle/request/stdout durability remains unresolved by contract.",
          "Native VFS I/O faults, power loss, fleet topology, and full daemon recovery belong to S2-S4.",
        ],
      });
      assert.equal(report.schema, "sqlite-stress-report/v1");
      assert.equal(report.verdict, "INCOMPLETE");
      assert.ok(report.coverage.required.length > report.coverage.hit.length);
      assert.ok(report.coverage.negativeControls.every(({ passed }) => passed));
      const frames = [];
      emitStressReport(report, { write: (line) => frames.push(line) });
      assert.deepEqual(parseStressReportFrame(frames[0].trim()), report);
      emitStressReport(report);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

async function runCoreFixture(targetRoot, controllerRoot) {
  const repoId = "stress-s1-core";
  const databasePath = path.join(targetRoot, "sqlite", "ledger.sqlite");
  const receiptLogPath = path.join(controllerRoot, "core-receipts.jsonl");
  const store = openSqliteEventStore({ repoId, databasePath });
  const fence = { repoId, holder: "controller-primary", epoch: 1 };
  store.claimWriter(fence);
  const eventOne = eventAt(1);
  const eventTwo = eventAt(2);
  const eventThree = eventAt(3);
  const eventFour = eventAt(4);
  const eventFive = eventAt(5);
  const eventSix = eventAt(6);
  const requests = [
    commandRequest("create-one", eventOne, fence),
    commandRequest("create-two", eventTwo, fence),
    commandRequest("create-three", eventThree, fence),
    {
      requestId: "zero-event-noop",
      kind: "command",
      opId: "stress-noop",
      intentDigest: digest("zero-event-noop"),
      summary: "zero event no-op",
      expectedEvents: [],
      fence,
    },
    {
      requestId: "rejected-command",
      kind: "command",
      opId: "stress-rejected",
      intentDigest: digest("rejected-command"),
      summary: "rejected command",
      expectedEvents: [],
      rejectionCode: "fixture_rejected",
      fence,
    },
    commandRequest("replay-one", eventOne, fence),
    {
      ...commandRequest("conflicting-intent", eventFive, fence),
      kind: "conflict",
      opId: eventOne.opId,
      intentDigest: digest("different-intent"),
    },
    commandRequest("after-conflict", eventFour, fence),
    { ...commandRequest("unacknowledged", eventSix, fence), kind: "transport-loss" },
  ];
  const scenario = createSeededScenario({ seed, requests });
  const receiptLog = openReceiptLog({
    file: receiptLogPath,
    targetRoots: [targetRoot],
    campaignId: "stress-s1-core",
    seed,
  });
  const schedule = [];
  const started = performance.now();
  await runScenario({
    scenario,
    receiptLog,
    barrier: async ({ phase, boundary, request }) => {
      schedule.push(`${request.callSequence}:${phase}:${boundary}`);
    },
    adapter: {
      submit: async (request) => {
        if (request.kind === "transport-loss")
          throw Object.assign(new Error("injected transport loss"), {
            code: "transport_lost",
          });
        try {
          const outcome = store.appendCommand({
            fence: request.fence,
            intent: {
              opId: request.opId,
              intentDigest: request.intentDigest,
              summary: request.summary,
            },
            events: request.expectedEvents,
            ...(request.rejectionCode ? { rejectionCode: request.rejectionCode } : {}),
          });
          return { ...outcome, sequence: request.callSequence };
        } catch (error) {
          if (request.kind !== "conflict") throw error;
          return {
            status: "rejected",
            code: error.code,
            opId: request.opId,
            intentDigest: request.intentDigest,
            sequence: request.callSequence,
          };
        }
      },
    },
  });
  const commandElapsedMs = performance.now() - started;
  store.claimWriter({ repoId, holder: "controller-successor", epoch: 2 });
  const sqliteVersion = store.sqliteVersion;
  store.close();
  const cut = readSqliteCut(databasePath);
  const receiptLogValue = readReceiptLog(receiptLogPath);

  const blobBody = "stress-s1-blob-π\n";
  const blobHash = sha256Text(blobBody);
  const wal = openWalEventLog(targetRoot);
  const blobStarted = performance.now();
  wal.append({
    event: eventOne,
    blobs: [{ sha256: blobHash, size: Buffer.byteLength(blobBody), mediaType: "text/plain", body: blobBody }],
  });
  const tBlobMs = performance.now() - blobStarted;
  const blobBytes = wal.readContentBlob(blobHash);
  wal.close();
  assert.ok(blobBytes);
  const segmentPath = path.join(targetRoot, ".harness", "wal", "seg-000000.log");
  const segmentBytes = readFileSync(segmentPath);

  const eventStream = sqliteEventStream(cut.events);
  const hotRoot = path.join(targetRoot, "hot-projection");
  const coldRoot = path.join(targetRoot, "cold-projection");
  const hot = makeTaskProjection({ rootDir: hotRoot, eventStore: eventStream });
  const rebuildStarted = performance.now();
  hot.catchUp();
  const hotRows = hot.list().rows;
  const hotGuards = hot.readLeaseIntervals(eventOne.taskId);
  hot.close();
  const cold = makeTaskProjection({ rootDir: coldRoot, eventStore: eventStream });
  const firstRebuild = cold.rebuild();
  const rebuildRows = cold.list().rows;
  const rebuildGuards = cold.readLeaseIntervals(eventOne.taskId);
  cold.close();
  const second = makeTaskProjection({ rootDir: coldRoot, eventStore: eventStream });
  const secondRebuild = second.rebuild();
  const apiRows = second.list().rows;
  second.close();
  const tRebuildMs = performance.now() - rebuildStarted;

  const reconciliation = reconcileSqliteEvents({ repoId, databasePath, events: cut.events });
  const otherRepo = openSqliteEventStore({
    repoId: "stress-s1-other",
    databasePath: path.join(targetRoot, "other", "ledger.sqlite"),
  });
  const otherEvent = eventAt(1);
  const otherOutcome = otherRepo.appendCommand({
    fence: { repoId: "stress-s1-other", holder: "other-holder", epoch: 1 },
    intent: {
      opId: otherEvent.opId,
      intentDigest: digest(serializePersistedCanonicalEvent(otherEvent)),
      summary: otherEvent.type,
    },
    events: [otherEvent],
  });
  otherRepo.close();
  const input = {
    receiptLog: receiptLogValue,
    cut,
    content: {
      claims: [{ acceptedOpId: eventOne.opId, sha256: blobHash, size: Buffer.byteLength(blobBody) }],
      objects: { [blobHash]: { bytesBase64: Buffer.from(blobBytes).toString("base64") } },
    },
    logs: {
      diagnosticScope: "unresolved",
      claims: [
        {
          streamId: "wal/seg-000000.log",
          offset: 0,
          length: segmentBytes.length,
          contentBase64: segmentBytes.toString("base64"),
        },
      ],
      streams: { "wal/seg-000000.log": { bytesBase64: segmentBytes.toString("base64") } },
    },
    projection: {
      hotRows,
      rebuildRows,
      apiRows,
      hotLeaseGuards: hotGuards,
      rebuildLeaseGuards: rebuildGuards,
    },
    identity: {
      writerClaims: [
        { repoId, holder: fence.holder, epoch: fence.epoch, sequence: 0 },
        { repoId, holder: "controller-successor", epoch: 2, sequence: 100 },
      ],
      writes: scenario.requests
        .filter((request) => !["transport-loss", "conflict"].includes(request.kind))
        .map((request) => ({
          repoId,
          opId: request.opId,
          holder: fence.holder,
          epoch: fence.epoch,
          sequence: request.callSequence,
          status: request.rejectionCode ? "rejected" : "accepted_durable",
        })),
      scheduleClaims: [
        {
          occurrenceId: "occurrence-s1",
          nodeId: "isolated-s1-node",
          claimFence: "claim-s1",
          status: "accepted",
        },
      ],
      replicas: [{ repoId, generation: 1, ackRevision: cut.revision, availableRevision: cut.revision }],
    },
    recovery: {
      reconciliation,
      sql: { integrity: cut.integrity, head: cut.revision, outcomes: cut.outcomes },
      objectsComplete: true,
      firstRebuild: { ...firstRebuild, rows: rebuildRows },
      secondRebuild: { ...secondRebuild, rows: apiRows },
    },
    availability: {
      watchdog: { status: "ok", boundary: null },
      operations: [
        { id: "after-conflict", repoId, status: "accepted_durable" },
        { id: "other-repo-progress", repoId: "stress-s1-other", status: otherOutcome.status },
      ],
      expectedProgress: ["after-conflict", "other-repo-progress"],
    },
  };
  const oracles = runOracles(input);
  assert.deepEqual(Object.fromEntries(Object.entries(oracles).map(([id, oracle]) => [id, oracle.verdict])), {
    O1: "PASS",
    O2: "PASS",
    O3: "PASS",
    O4: "PASS",
    O5: "PASS",
    O6: "PASS",
    O7: "PASS",
    O8: "PASS",
  });
  const negativeControls = runOracleNegativeControls(input);
  assert.ok(
    negativeControls.every(({ passed }) => passed),
    JSON.stringify(negativeControls),
  );
  return {
    cut,
    receiptLog: receiptLogValue,
    receiptLogPath,
    content: input.content,
    oracles,
    negativeControls,
    sqliteVersion,
    schedule,
    commandCount: requests.length,
    calibration: {
      tCmdMs: commandElapsedMs / requests.length,
      tBlobMs,
      tRebuildMs,
    },
  };
}

async function runCrashFixture(root, controllerRoot) {
  mkdirSync(root, { recursive: true });
  const tree = createProcessTree();
  const cases = [];
  const receiptLogs = [];
  try {
    for (const boundary of ["before-outcome", "after-commit", "after-receipt"]) {
      const databasePath = path.join(root, `${boundary}.sqlite`);
      const repoId = "stress-s1-crash-fixture";
      const initial = openSqliteEventStore({ repoId, databasePath });
      initial.claimWriter({ repoId, holder: "original", epoch: 1 });
      initial.close();
      const receiptLogPath = path.join(controllerRoot, `crash-${boundary}.jsonl`);
      const receiptLog = openReceiptLog({
        file: receiptLogPath,
        targetRoots: [root],
        campaignId: `stress-s1-crash-${boundary}`,
        seed,
      });
      const command = crashCommand(repoId);
      const request = {
        requestId: `crash-${boundary}`,
        opId: command.intent.opId,
        intentDigest: command.intent.intentDigest,
        expectedEvents: command.events,
        boundary,
      };
      receiptLog.recordRequest(request);
      const started = performance.now();
      const killed = await spawnCapture(tree, process.execPath, [
        path.join(import.meta.dirname, "core/sqlite-crash-fixture.mjs"),
        databasePath,
        boundary,
      ]);
      assert.equal(killed.signal, "SIGKILL", killed.stderr);
      const childFrame = JSON.parse(killed.stdout.trim());
      if (childFrame.outcome)
        receiptLog.recordReceipt(request.requestId, {
          ...childFrame.outcome,
          status: "accepted_durable",
        });
      receiptLog.close();
      receiptLogs.push(readReceiptLog(receiptLogPath));
      const recovered = readSqliteCut(databasePath);
      assert.equal(recovered.integrity, "ok");
      if (boundary === "before-outcome") {
        assert.equal(recovered.revision, 0);
        assert.deepEqual(recovered.events, []);
        assert.deepEqual(recovered.outcomes, []);
      } else {
        assert.equal(recovered.revision, 3);
        assert.equal(recovered.events.length, 3);
        assert.equal(recovered.outcomes.length, 1);
      }
      const reopened = openSqliteEventStore({ repoId, databasePath });
      const input = command;
      const outcome = reopened.appendCommand(input);
      assert.deepEqual(reopened.appendCommand(input), outcome);
      assert.equal(reopened.revision(), 3);
      reopened.close();
      cases.push({
        boundary,
        elapsedMs: performance.now() - started,
        exitCode: killed.code,
        signal: killed.signal,
        recoveredRevision: recovered.revision,
        recoveredOutcomes: recovered.outcomes.length,
      });
    }
  } finally {
    tree.terminate();
  }
  return {
    cases,
    receiptLogs,
    killRestartMs: cases.reduce((sum, arm) => sum + arm.elapsedMs, 0) / cases.length,
  };
}

async function runRepoCellShadowFixture(targetRoot, controllerRoot) {
  mkdirSync(targetRoot, { recursive: true });
  initRepo(targetRoot);
  const repoId = "stress-s1-repo-cell";
  let cell = await openBootstrappedRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(targetRoot),
    ownerId: "stress-s1-bootstrap",
    now: () => "2026-09-05T00:00:00.000Z",
  });
  await cell.close();
  const authority = openPersistentWriterEpoch({
    stateRoot: path.join(targetRoot, ".harness", "fleet"),
    holderId: "stress-s1-center",
    now: () => "2026-09-05T00:00:01.000Z",
  });
  const lease = authority.acquire(repoId);
  const eventReader = makeTaskEventReader({ repoId, rootDir: targetRoot });
  const canonicalEvents = eventReader.read().events;
  const sqlite = openSqliteEventStore({ repoId, rootInput: targetRoot });
  migrateEventsToSqlite({
    store: sqlite,
    repoId,
    events: canonicalEvents,
    holder: lease.holderId,
    epoch: lease.epoch,
  });
  const before = sqlite.revision();
  sqlite.close();
  const descriptor = {
    schema: "harness-writer-epoch-fence/v1",
    stateRoot: path.join(targetRoot, ".harness", "fleet"),
    repoId,
    epoch: lease.epoch,
    holderId: lease.holderId,
  };
  cell = await openBootstrappedRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(targetRoot),
    ownerId: "stress-s1-shadow",
    defaultWriterEpochFence: descriptor,
    now: () => "2026-09-05T00:00:02.000Z",
  });
  const taskId = "task_stress_s1_shadow";
  const receiptLogPath = path.join(controllerRoot, "repo-cell-receipts.jsonl");
  const receiptLog = openReceiptLog({
    file: receiptLogPath,
    targetRoots: [targetRoot],
    campaignId: "stress-s1-repo-cell",
    seed,
  });
  const scenario = createSeededScenario({
    seed,
    requests: [
      {
        requestId: "repo-cell-task-create",
        kind: "repo-cell",
        opId: "repo-cell-task-create",
        intentDigest: digest("repo-cell-task-create"),
        summary: "task-create through RepoCell",
        expectedEvents: [],
        action: { kind: "task-create", taskId, title: "Stress S1 shadow", profileId: "baseline" },
      },
    ],
  });
  const schedule = [];
  try {
    await runScenario({
      scenario,
      receiptLog,
      barrier: async ({ phase, boundary }) => schedule.push(`${phase}:${boundary}`),
      adapter: {
        submit: async (request) => {
          const receipt = await cell.run(request.action, { actor, source: "local" });
          assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
          return {
            status: "accepted_durable",
            opId: request.opId,
            intentDigest: request.intentDigest,
            receiptOutcome: receipt.outcome,
          };
        },
      },
    });
    await cell.settlePendingMaterialization("stress S1 fixture");
  } finally {
    await cell.close();
    authority.close();
  }
  const after = readSqliteCut(path.join(targetRoot, ".harness", "store", "generations", "1", "ledger.sqlite"));
  assert.ok(after.revision > before, `SQLite shadow did not advance beyond ${before}`);
  assert.ok(after.events.some((event) => event.taskId === taskId));
  return {
    taskId,
    holder: lease.holderId,
    epoch: lease.epoch,
    sqliteRevision: after.revision,
    receiptLog: readReceiptLog(receiptLogPath),
    receiptLogPath,
    schedule,
  };
}

function commandRequest(requestId, event, fence) {
  return {
    requestId,
    kind: "command",
    opId: event.opId,
    intentDigest: digest(serializePersistedCanonicalEvent(event)),
    summary: event.type,
    expectedEvents: [event],
    fence,
  };
}

function crashCommand(repoId) {
  const events = [1, 2, 3].map(eventAt);
  return {
    fence: { repoId, holder: "successor", epoch: 2 },
    intent: {
      opId: "stress-s1-crash-command",
      intentDigest: digest(JSON.stringify(events.map(serializePersistedCanonicalEvent))),
      summary: "three-event crash fixture",
    },
    events,
  };
}

function readSqliteCut(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
    const revision = Number(database.prepare("SELECT revision FROM ledger_meta WHERE singleton=1").get().revision);
    const events = database
      .prepare("SELECT event_json FROM event ORDER BY revision")
      .all()
      .map((row) => JSON.parse(row.event_json));
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
    const writerRow = database.prepare("SELECT holder, epoch FROM writer_lease").get();
    return {
      integrity,
      revision,
      events,
      outcomes,
      writer: { holder: String(writerRow.holder), epoch: Number(writerRow.epoch) },
    };
  } finally {
    database.close();
  }
}

function sqliteEventStream(events) {
  return {
    readHead: () => ({
      revision: events.at(-1).workspaceRevision,
      eventDigest: digest(serializePersistedCanonicalEvent(events.at(-1))),
    }),
    readBatch: (cursor, maxItems) => {
      const start = cursor === null ? 0 : Number(cursor);
      const slice = events.slice(start, start + maxItems);
      return {
        sourceRevision: events.length,
        events: slice,
        cursor: start + slice.length >= events.length ? null : String(start + slice.length),
        done: start + slice.length >= events.length,
        accessedItems: slice.length,
        prefetchContent: () => new Map(),
      };
    },
    readContentBlob: () => null,
  };
}

function digest(value) {
  return `sha256:${sha256Text(value)}`;
}

function mappedCoverage(required) {
  const exact = new Set(["event-schema:task-event/v1"]);
  for (const item of required) {
    if (item.source.includes("sqlite-event-store.ts") && item.boundary === "commit") exact.add(item.id);
    if (item.source.includes("sqlite-event-store.ts") && item.boundary === "claimWriter") exact.add(item.id);
    if (item.source.includes("local-layout-file-system.ts") && item.boundary === "fsync") exact.add(item.id);
  }
  return [...exact];
}

function sourceBuildId() {
  const hash = createHash("sha256");
  for (const file of [
    "tools/stress/core/controller.mjs",
    "tools/stress/core/receipt-log.mjs",
    "tools/stress/core/oracles.mjs",
    "tools/stress/core/denominators.mjs",
    "tools/stress/core/report.mjs",
  ])
    hash.update(readFileSync(path.join(repoRoot, file)));
  return `source:${hash.digest("hex")}`;
}

function spawnCapture(tree, command, args) {
  return new Promise((resolve, reject) => {
    const child = tree.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
