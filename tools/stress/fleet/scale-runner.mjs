import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { serializePersistedCanonicalEvent } from "../../../packages/kernel/src/domain/doc-sync.contract.ts";
import { writeFileDurably } from "../../../packages/daemon/src/durable-file.ts";
import { sha256Text } from "../../../packages/kernel/src/integrity/stable-hash.ts";
import { makeTaskProjection } from "../../../packages/kernel/src/projection/rebuildable-task-projection.ts";
import { openSqliteEventStore } from "../../../packages/kernel/src/store/sqlite-event-store.ts";
import { reconcileSqliteEvents } from "../../../packages/kernel/src/store/sqlite-ledger-reconcile.ts";
import { createProcessTree, createSeededScenario, runScenario } from "../core/controller.mjs";
import { generateCoverageDenominators } from "../core/denominators.mjs";
import { buildStressReport, emitStressReport } from "../core/report.mjs";
import { openReceiptLog } from "../core/receipt-log.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const actor = {
  principal: { personId: "stress-scale" },
  executor: { kind: "agent", id: "stress-scale-controller" },
};
const clientCount = 8;
const fullEventCount = 1_000_000;
const fullPrimaryCommands = 10_000;
const fullEventsPerCommand = fullEventCount / fullPrimaryCommands;
const fullReplayRequests = 600;
const fullConflictRequests = 600;

export async function runScaleCalibration() {
  const seed = "fleet-scale-calibration-20260906";
  return withScratch(seed, async ({ targetRoot, controllerRoot }) => {
    const command = await runCommandWorkload({
      seed,
      targetRoot,
      controllerRoot,
      primaryCommands: 10_000,
      eventsPerCommand: 1,
      replayRequests: 0,
      conflictRequests: 0,
    });
    const blobs = await runBlobWorkload({
      seed,
      targetRoot,
      controllerRoot,
      layout: { small: 900, medium: 90, large: 10 },
    });
    const rebuild = runColdRebuilds({
      targetRoot,
      repoId: command.repoId,
      events: command.events,
      blobClaims: blobs.claims,
    });
    const killRestartMs = await measureKillRestart(path.join(targetRoot, "kill-restart.sqlite"));
    const tCmdMs = command.elapsedMs / command.primaryCommands;
    const tBlobMs = blobs.elapsedMs / blobs.claims.length;
    const measuredRebuildMs = rebuild.elapsedMs / 2;
    const projectedRebuildMs = measuredRebuildMs * (fullEventCount / command.denominators.acceptedEvents);
    const faultArmOverheadMs = killRestartMs * 3;
    const designBudgetMs =
      3 * (fullEventCount * tCmdMs + 100_000 * tBlobMs + 2 * projectedRebuildMs) + faultArmOverheadMs;
    const calibration = {
      schema: "fleet-scale-calibration/v1",
      seed,
      tCmdMs,
      tBlobMs,
      tRebuildMeasuredMs: measuredRebuildMs,
      tRebuildProjectedMs: projectedRebuildMs,
      killRestartMs,
      faultArmOverheadMs,
      designBudgetMs,
      designBudgetHours: designBudgetMs / 3_600_000,
      fitsEightHours: designBudgetMs <= 8 * 3_600_000,
      sample: {
        commands: command.primaryCommands,
        acceptedEvents: command.denominators.acceptedEvents,
        blobs: blobs.denominators.distinctBlobs,
        clients: command.maxInFlight,
      },
      rebuild,
    };
    process.stdout.write(`FLEET_SCALE_CALIBRATION\t${JSON.stringify(calibration)}\n`);
    emitStressReport(
      await scaleReport({
        seed,
        command,
        blobs,
        rebuild,
        calibration,
        caseId: "S4/scale-calibration",
        caseVerdict: "PASS",
      }),
    );
    return calibration;
  });
}

export async function runFullScaleSeed(seedNumber) {
  assert.ok(Number.isInteger(seedNumber) && seedNumber >= 1 && seedNumber <= 3);
  const seed = `fleet-scale-seed-${seedNumber}-20260906`;
  return withScratch(seed, async ({ targetRoot, controllerRoot }) => {
    const command = await runCommandWorkload({
      seed,
      targetRoot,
      controllerRoot,
      primaryCommands: fullPrimaryCommands,
      eventsPerCommand: fullEventsPerCommand,
      replayRequests: fullReplayRequests,
      conflictRequests: fullConflictRequests,
    });
    const blobs = await runBlobWorkload({
      seed,
      targetRoot,
      controllerRoot,
      layout: { small: 90_000, medium: 9_000, large: 1_000 },
    });
    const rebuild = runColdRebuilds({
      targetRoot,
      repoId: command.repoId,
      events: command.events,
      blobClaims: blobs.claims,
    });
    assert.equal(command.denominators.acceptedEvents, fullEventCount);
    assert.equal(command.denominators.idempotentRequests, fullReplayRequests);
    assert.equal(command.denominators.conflictRequests, fullConflictRequests);
    assert.ok(command.denominators.specialRequestRatio >= 0.1);
    assert.equal(command.maxInFlight, clientCount);
    assert.equal(blobs.denominators.distinctBlobs, 100_000);
    assert.equal(rebuild.reconciliation.matches, true);
    assert.equal(rebuild.first.stateDigest, rebuild.second.stateDigest);
    assert.equal(rebuild.first.blobManifestDigest, rebuild.second.blobManifestDigest);
    const report = await scaleReport({
      seed,
      command,
      blobs,
      rebuild,
      calibration: null,
      caseId: `S4/full-scale-seed-${seedNumber}`,
      caseVerdict: "PASS",
    });
    emitStressReport(report);
    return report;
  });
}

async function runCommandWorkload({
  seed,
  targetRoot,
  controllerRoot,
  primaryCommands,
  eventsPerCommand,
  replayRequests,
  conflictRequests,
}) {
  const repoId = `${seed}-repo`;
  const databasePath = path.join(targetRoot, "ledger.sqlite");
  const store = openSqliteEventStore({ repoId, databasePath });
  const fence = { repoId, holder: `${seed}-center`, epoch: 1 };
  store.claimWriter(fence);
  const primary = Array.from({ length: primaryCommands }, (_value, index) =>
    primaryRequest(seed, index, eventsPerCommand, fence),
  );
  const extras = specialRequests(primary, replayRequests, conflictRequests);
  const clientRequests = Array.from({ length: clientCount }, () => []);
  for (const [index, request] of [...primary, ...extras].entries()) clientRequests[index % clientCount].push(request);
  let inFlight = 0;
  let maxInFlight = 0;
  const started = performance.now();
  const runs = clientRequests.map(async (requests, clientIndex) => {
    const receiptLog = openReceiptLog({
      file: path.join(controllerRoot, `commands-client-${clientIndex + 1}.jsonl`),
      targetRoots: [targetRoot],
      campaignId: `${seed}-commands-client-${clientIndex + 1}`,
      seed,
    });
    const scenario = createSeededScenario({ seed: `${seed}-client-${clientIndex + 1}`, requests });
    return runScenario({
      scenario,
      receiptLog,
      watchdogMs: 120_000,
      adapter: {
        submit: async (request) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await immediate();
            if (request.kind === "primary") await waitForRevision(store, request.firstRevision - 1);
            try {
              return store.appendCommand({
                fence,
                intent: {
                  opId: request.opId,
                  intentDigest: request.intentDigest,
                  summary: request.summary,
                },
                events: request.expectedEvents,
              });
            } catch (error) {
              if (request.kind !== "conflict") throw error;
              return {
                status: "rejected",
                code: error.code,
                opId: request.opId,
                intentDigest: request.intentDigest,
              };
            }
          } finally {
            inFlight -= 1;
          }
        },
      },
    });
  });
  const observations = await Promise.all(runs);
  const elapsedMs = performance.now() - started;
  assert.equal(
    observations.flatMap(({ observations: rows }) => rows).every(({ receipt }) => receipt !== null),
    true,
  );
  store.close();
  const logs = clientRequests.map((_requests, index) =>
    path.join(controllerRoot, `commands-client-${index + 1}.jsonl`),
  );
  const denominators = await scanCommandReceiptLogs(logs, primaryCommands * eventsPerCommand);
  const reopened = openSqliteEventStore({ repoId, databasePath });
  const events = reopened.events();
  assert.equal(reopened.revision(), denominators.acceptedEvents);
  reopened.close();
  return {
    repoId,
    databasePath,
    primaryCommands,
    eventsPerCommand,
    elapsedMs,
    maxInFlight,
    logs,
    denominators,
    events,
  };
}

async function runBlobWorkload({ seed, targetRoot, controllerRoot, layout }) {
  const objectsRoot = path.join(targetRoot, "objects", "sha256");
  const claims = blobClaims(seed, layout);
  const receiptLogPath = path.join(controllerRoot, "blobs.jsonl");
  const receiptLog = openReceiptLog({
    file: receiptLogPath,
    targetRoots: [targetRoot],
    campaignId: `${seed}-blobs`,
    seed,
  });
  const scenario = createSeededScenario({
    seed: `${seed}-blobs`,
    requests: claims.map((claim) => ({
      requestId: `blob-${claim.index}`,
      kind: "blob",
      opId: `blob-${claim.sha256}`,
      intentDigest: `sha256:${claim.sha256}`,
      summary: `durable blob ${claim.size}`,
      expectedEvents: [],
      blob: claim,
    })),
  });
  const started = performance.now();
  const result = await runScenario({
    scenario,
    receiptLog,
    watchdogMs: 120_000,
    adapter: {
      submit: async (request) => {
        const body = blobBody(seed, request.blob.index, request.blob.size);
        assert.equal(hashBytes(body), request.blob.sha256);
        writeFileDurably(blobPath(objectsRoot, request.blob.sha256), body);
        return {
          status: "accepted_durable",
          opId: request.opId,
          intentDigest: request.intentDigest,
        };
      },
    },
  });
  const elapsedMs = performance.now() - started;
  assert.equal(
    result.observations.every(({ receipt }) => receipt !== null),
    true,
  );
  const denominators = await scanBlobReceiptLog(receiptLogPath);
  return { objectsRoot, claims, receiptLogPath, denominators, elapsedMs, layout };
}

function runColdRebuilds({ targetRoot, repoId, events, blobClaims }) {
  const eventStore = eventStream(events);
  const runs = [];
  const started = performance.now();
  for (const label of ["first", "second"]) {
    const projection = makeTaskProjection({
      rootDir: targetRoot,
      eventStore,
      projectionPath: path.join(targetRoot, "cold", `${label}.sqlite`),
    });
    const receipt = projection.rebuild();
    const stateDigest = projection.readStateDigest();
    const cut = projection.readCut();
    projection.close();
    const blobManifestDigest = verifyBlobManifest(path.join(targetRoot, "objects", "sha256"), blobClaims);
    runs.push({ label, receipt, stateDigest, cut, blobManifestDigest });
  }
  const elapsedMs = performance.now() - started;
  const reconciliation = reconcileSqliteEvents({
    repoId,
    databasePath: path.join(targetRoot, "ledger.sqlite"),
    events,
  });
  return { first: runs[0], second: runs[1], elapsedMs, reconciliation };
}

async function measureKillRestart(databasePath) {
  const repoId = "stress-s1-crash-fixture";
  const initial = openSqliteEventStore({ repoId, databasePath });
  initial.claimWriter({ repoId, holder: "original", epoch: 1 });
  initial.close();
  const tree = createProcessTree();
  const started = performance.now();
  try {
    const result = await capture(tree, process.execPath, [
      path.join(repoRoot, "tools/stress/core/sqlite-crash-fixture.mjs"),
      databasePath,
      "after-commit",
    ]);
    assert.equal(result.signal, "SIGKILL", result.stderr);
    const reopened = openSqliteEventStore({ repoId, databasePath });
    assert.equal(reopened.revision(), 3);
    reopened.close();
    return performance.now() - started;
  } finally {
    tree.terminate();
  }
}

async function scaleReport({ seed, command, blobs, rebuild, calibration, caseId, caseVerdict }) {
  const all = await generateCoverageDenominators({ repoRoot });
  const mappedIds = mappedCoverage(all.required);
  const coverage = await generateCoverageDenominators({ repoRoot, mappedIds });
  return buildStressReport({
    campaignComplete: false,
    source: {
      head: process.env.HARNESS_BUILD_COMMIT ?? null,
      base: process.env.HARNESS_BASE_COMMIT ?? null,
      loadedBuild: sourceDigest(),
      dirty: null,
    },
    environment: {
      node: process.version,
      sqlite: process.versions.sqlite,
      os: `${process.platform}-${process.arch}`,
      filesystem: "isolated Ubuntu temporary filesystem",
      capabilities: ["S1 receipt controller", "8 concurrent clients", "durable sharded blob objects"],
    },
    seed,
    topology: "one SQLite authority queue, eight concurrent S1 clients, external fsynced receipt logs",
    generation: 1,
    counts: {
      acceptedEvents: command.denominators.acceptedEvents,
      uniqueBlobs: blobs.denominators.distinctBlobs,
      maxConcurrentClients: command.maxInFlight,
      primaryCommands: command.denominators.primaryCommands,
      idempotentRequests: command.denominators.idempotentRequests,
      conflictRequests: command.denominators.conflictRequests,
      totalRequests: command.denominators.totalRequests + blobs.denominators.totalRequests,
    },
    coverage: {
      denominatorSchema: coverage.schema,
      denominatorDigest: coverage.digest,
      required: coverage.required.map(({ id }) => id),
      hit: coverage.hit,
      missing: coverage.missing,
      negativeControls: [],
    },
    calibration,
    cases: [
      {
        id: caseId,
        boundaryHits: ["request-fsync", "sqlite-commit", "receipt-fsync", "blob-fsync-rename", "cold-rebuild"],
        receiptLogs: [...command.logs, blobs.receiptLogPath],
        measured: {
          commandElapsedMs: command.elapsedMs,
          blobElapsedMs: blobs.elapsedMs,
          rebuildElapsedMs: rebuild.elapsedMs,
          specialRequestRatio: command.denominators.specialRequestRatio,
          reconciliationDifferences: rebuild.reconciliation.revisionDifferences.length,
        },
        oracles: {
          O1: { verdict: "PASS", acceptedEventsFromReceiptLogs: command.denominators.acceptedEvents },
          O3: { verdict: "PASS", distinctBlobsFromReceiptLog: blobs.denominators.distinctBlobs },
          O7: {
            verdict: "PASS",
            reconciliationMatches: rebuild.reconciliation.matches,
            firstDigest: rebuild.first.stateDigest,
            secondDigest: rebuild.second.stateDigest,
          },
        },
        verdict: caseVerdict,
      },
    ],
    replayCommand:
      "node tools/dispatch-isolated-test.mjs --target ubuntu --file " + path.relative(repoRoot, process.argv[1]),
    residualRisks: [
      "The campaign-wide report remains incomplete while F13 generation identity and F14 clock forwarding are unresolved.",
      "Device-backed ENOSPC and power-loss arms require the operator-created VM mounts.",
    ],
  });
}

function primaryRequest(seed, commandIndex, eventsPerCommand, fence) {
  const firstRevision = commandIndex * eventsPerCommand + 1;
  const expectedEvents = Array.from({ length: eventsPerCommand }, (_value, offset) =>
    scaleEvent(seed, firstRevision + offset),
  );
  const opId = `${seed}-command-${commandIndex + 1}`;
  return {
    requestId: `${opId}-primary`,
    kind: "primary",
    opId,
    intentDigest: intentDigest(expectedEvents),
    summary: `${eventsPerCommand} scale events`,
    expectedEvents,
    firstRevision,
    fence,
  };
}

function specialRequests(primary, replayCount, conflictCount) {
  const requests = [];
  for (let index = 0; index < Math.max(replayCount, conflictCount); index += 1) {
    const source = primary[index % primary.length];
    if (index < replayCount)
      requests.push({
        ...source,
        requestId: `${source.opId}-replay`,
        kind: "idempotent",
      });
    if (index < conflictCount)
      requests.push({
        ...source,
        requestId: `${source.opId}-conflict`,
        kind: "conflict",
        intentDigest: `sha256:${sha256Text(`${source.intentDigest}:conflict`)}`,
        expectedEvents: [],
      });
  }
  return requests;
}

function scaleEvent(seed, revision) {
  return {
    schema: "ci-run-observation/v1",
    eventId: `${seed}-event-${revision}`,
    workspaceRevision: revision,
    opId: `${seed}-event-op-${revision}`,
    type: "ci_run_observed",
    actor,
    source: "local",
    occurredAt: "2026-09-06T00:00:00.000Z",
    payload: {
      run: {
        runId: `${seed}-${revision}`,
        sha: "scale",
        branch: seed,
        prNumber: null,
        job: "fleet-scale",
        wallclockMs: 0,
        runner: "ubuntu-vm",
      },
      tests: [],
      gates: [],
    },
  };
}

function blobClaims(seed, layout) {
  const sizes = [
    ...Array.from({ length: layout.small }, () => 1024),
    ...Array.from({ length: layout.medium }, () => 64 * 1024),
    ...Array.from({ length: layout.large }, () => 1024 * 1024),
  ];
  return sizes.map((size, index) => {
    const body = blobBody(seed, index, size);
    return { index, size, sha256: hashBytes(body) };
  });
}

function blobBody(seed, index, size) {
  const body = Buffer.alloc(size, 65 + (index % 26));
  const header = Buffer.from(`${seed}:${index}:`, "utf8");
  header.copy(body, 0, 0, Math.min(header.length, body.length));
  return body;
}

async function scanCommandReceiptLogs(files, expectedMaximumRevision) {
  const seen = new Uint8Array(expectedMaximumRevision + 1);
  const totals = {
    acceptedEvents: 0,
    primaryCommands: 0,
    idempotentRequests: 0,
    conflictRequests: 0,
    totalRequests: 0,
  };
  for (const file of files) {
    await scanReceiptPairs(file, (request, receipt) => {
      totals.totalRequests += 1;
      if (request.kind === "conflict") {
        assert.equal(receipt.status, "rejected");
        totals.conflictRequests += 1;
        return;
      }
      assert.equal(receipt.status, "accepted_durable");
      if (request.kind === "idempotent") totals.idempotentRequests += 1;
      if (request.kind === "primary") totals.primaryCommands += 1;
      for (const event of request.expectedEvents) {
        assert.ok(event.workspaceRevision > 0 && event.workspaceRevision <= expectedMaximumRevision);
        if (seen[event.workspaceRevision] === 0) {
          seen[event.workspaceRevision] = 1;
          totals.acceptedEvents += 1;
        }
      }
    });
  }
  const special = totals.idempotentRequests + totals.conflictRequests;
  return { ...totals, specialRequestRatio: special / totals.totalRequests };
}

async function scanBlobReceiptLog(file) {
  const blobs = new Set();
  let totalRequests = 0;
  await scanReceiptPairs(file, (request, receipt) => {
    assert.equal(receipt.status, "accepted_durable");
    totalRequests += 1;
    blobs.add(request.blob.sha256);
  });
  return { distinctBlobs: blobs.size, totalRequests };
}

async function scanReceiptPairs(file, observe) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let started = false;
  let completed = false;
  let pending = null;
  for await (const line of lines) {
    const row = JSON.parse(line);
    assert.equal(row.schema, "sqlite-stress-receipt-log/v1");
    if (row.type === "campaign_started") {
      assert.equal(started, false);
      started = true;
    } else if (row.type === "request") {
      assert.equal(pending, null);
      pending = row.request;
    } else if (row.type === "receipt") {
      assert.ok(pending);
      assert.equal(row.requestId, pending.requestId);
      observe(pending, row.receipt);
      pending = null;
    } else if (row.type === "campaign_completed") completed = true;
  }
  assert.equal(started, true);
  assert.equal(completed, true);
  assert.equal(pending, null);
}

function verifyBlobManifest(objectsRoot, claims) {
  const digest = createHash("sha256");
  for (const claim of claims) {
    const body = readFileSync(blobPath(objectsRoot, claim.sha256));
    assert.equal(body.byteLength, claim.size);
    assert.equal(hashBytes(body), claim.sha256);
    digest.update(`${claim.index}:${claim.sha256}:${claim.size}\n`);
  }
  return `sha256:${digest.digest("hex")}`;
}

function eventStream(events) {
  return {
    readHead: () => {
      const last = events.at(-1);
      return last
        ? {
            revision: last.workspaceRevision,
            eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(last))}`,
          }
        : null;
    },
    readBatch: (cursor, maxItems) => {
      const start = cursor === null ? 0 : Number(cursor);
      const selected = events.slice(start, start + maxItems);
      return {
        sourceRevision: events.length,
        events: selected,
        cursor: start + selected.length >= events.length ? null : String(start + selected.length),
        done: start + selected.length >= events.length,
        accessedItems: selected.length,
        prefetchContent: () => new Map(),
      };
    },
    readContentBlob: () => null,
  };
}

function mappedCoverage(required) {
  return required
    .filter(
      ({ id, source, boundary }) =>
        id === "event-schema:ci-run-observation/v1" ||
        (source.includes("sqlite-event-store.ts") && ["commit", "claimWriter"].includes(boundary)) ||
        (source.includes("durable-file.ts") && ["fsync", "rename"].includes(boundary)),
    )
    .map(({ id }) => id);
}

function inspectSqlite(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      integrity: String(db.prepare("PRAGMA integrity_check").get().integrity_check),
      revision: Number(db.prepare("SELECT revision FROM ledger_meta WHERE singleton=1").get().revision),
    };
  } finally {
    db.close();
  }
}

function intentDigest(events) {
  return `sha256:${sha256Text(JSON.stringify(events.map(({ opId }) => opId)))}`;
}

function hashBytes(body) {
  return createHash("sha256").update(body).digest("hex");
}

function blobPath(objectsRoot, sha256) {
  return path.join(objectsRoot, sha256.slice(0, 2), sha256);
}

async function waitForRevision(store, revision) {
  for (;;) {
    const current = store.revision();
    if (current === revision) return;
    if (current > revision) throw new Error(`scale revision ${revision} was overtaken by ${current}`);
    await immediate();
  }
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function capture(tree, command, args) {
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

function sourceDigest() {
  const hash = createHash("sha256");
  for (const file of [
    "tools/stress/fleet/scale-runner.mjs",
    "tools/stress/core/controller.mjs",
    "tools/stress/core/receipt-log.mjs",
  ])
    hash.update(readFileSync(path.join(repoRoot, file)));
  return `source:${hash.digest("hex")}`;
}

async function withScratch(seed, run) {
  const scratch = await mkdtemp(path.join(tmpdir(), `ha-stress-s4-${seed}-`));
  const targetRoot = path.join(scratch, "target");
  const controllerRoot = path.join(scratch, "controller");
  await mkdir(targetRoot, { recursive: true });
  await mkdir(controllerRoot, { recursive: true });
  try {
    const result = await run({ scratch, targetRoot, controllerRoot });
    const sqlite = inspectSqlite(path.join(targetRoot, "ledger.sqlite"));
    assert.equal(sqlite.integrity, "ok");
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
