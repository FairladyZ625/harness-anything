import { scaleReport } from "./scale-report.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { serializePersistedCanonicalEvent } from "../../../packages/kernel/src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../../packages/kernel/src/integrity/stable-hash.ts";
import { makeTaskProjection } from "../../../packages/kernel/src/projection/rebuildable-task-projection.ts";
import { openSqliteEventStore } from "../../../packages/kernel/src/store/sqlite-event-store.ts";
import { createProcessTree, createSeededScenario, runScenario } from "../core/controller.mjs";
import { emitStressReport } from "../core/report.mjs";
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
    const blobClaims = makeBlobClaims(seed, { small: 900, medium: 90, large: 10 });
    const command = await runCommandWorkload({
      seed,
      targetRoot,
      controllerRoot,
      primaryCommands: 10_000,
      eventsPerCommand: 1,
      replayRequests: 0,
      conflictRequests: 0,
      blobClaims,
    });
    const blobs = command.blobs;
    const rebuild = runColdRebuilds({
      targetRoot,
      repoId: command.repoId,
      blobClaims: blobs.claims,
      expectedEvents: command.expectedEvents,
      expectedCommands: command.primaryCommands,
      expectedCommandIntents: command.expectedCommandIntents,
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
    const blobClaims = makeBlobClaims(seed, { small: 90_000, medium: 9_000, large: 1_000 });
    const command = await runCommandWorkload({
      seed,
      targetRoot,
      controllerRoot,
      primaryCommands: fullPrimaryCommands,
      eventsPerCommand: fullEventsPerCommand,
      replayRequests: fullReplayRequests,
      conflictRequests: fullConflictRequests,
      blobClaims,
    });
    const blobs = command.blobs;
    const rebuild = runColdRebuilds({
      targetRoot,
      repoId: command.repoId,
      blobClaims: blobs.claims,
      expectedEvents: command.expectedEvents,
      expectedCommands: command.primaryCommands,
      expectedCommandIntents: command.expectedCommandIntents,
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
  blobClaims,
}) {
  const repoId = `${seed}-repo`;
  const databasePath = path.join(targetRoot, "ledger.sqlite");
  const store = openSqliteEventStore({ repoId, databasePath });
  const fence = { repoId, holder: `${seed}-center`, epoch: 1 };
  store.claimWriter(fence);
  const claimsByCommand = distributeClaims(blobClaims, primaryCommands),
    primary = Array.from({ length: primaryCommands }, (_value, index) =>
      primaryRequest(seed, index, eventsPerCommand, fence, claimsByCommand[index]),
    ),
    expectedEvents = primary.flatMap(({ expectedEvents: events }) => events);
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
                blobs: request.blobClaims.map((claim) => ({
                  sha256: claim.sha256,
                  size: claim.size,
                  mediaType: "text/plain",
                  body: blobBody(seed, claim.index, claim.size).toString("utf8"),
                })),
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
  const reopened = openSqliteEventStore({ repoId, databasePath, readOnly: true });
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
    expectedEvents,
    expectedCommandIntents: primary.map(({ opId, intentDigest, firstRevision, expectedEvents }) => ({
      opId,
      intentDigest,
      firstRevision,
      lastRevision: firstRevision + expectedEvents.length - 1,
      memberOpIds: expectedEvents.map((event) => event.opId),
    })),
    blobs: {
      claims: blobClaims,
      denominators: { distinctBlobs: new Set(blobClaims.map(({ sha256 }) => sha256)).size, totalRequests: 0 },
      elapsedMs,
    },
  };
}

function runColdRebuilds({ targetRoot, repoId, expectedEvents, expectedCommands, expectedCommandIntents, blobClaims }) {
  const runs = [];
  const started = performance.now();
  for (const label of ["first", "second"]) {
    const ledger = openSqliteEventStore({
        repoId,
        databasePath: path.join(targetRoot, "ledger.sqlite"),
        readOnly: true,
      }),
      eventStore = sqliteEventStream(ledger);
    const projection = makeTaskProjection({
      rootDir: targetRoot,
      eventStore,
      projectionPath: path.join(targetRoot, "cold", `${label}.sqlite`),
    });
    const receipt = projection.rebuild();
    const stateDigest = projection.readStateDigest();
    const cut = projection.readCut();
    projection.close();
    const blobManifestDigest = verifyBlobManifest(ledger, blobClaims);
    ledger.close();
    runs.push({ label, receipt, stateDigest, cut, blobManifestDigest });
  }
  const elapsedMs = performance.now() - started;
  const ledger = openSqliteEventStore({ repoId, databasePath: path.join(targetRoot, "ledger.sqlite") }),
    rows = ledger.eventRows(),
    outcomes = ledger.outcomes(),
    expectedDigests = expectedEvents.map((event) => `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`),
    reconciliation = {
      matches:
        rows.length === expectedEvents.length &&
        rows.every(
          (row, index) =>
            row.digest === expectedDigests[index] &&
            row.eventJson === serializePersistedCanonicalEvent(expectedEvents[index]),
        ) &&
        outcomes.length === expectedCommands &&
        outcomes.every((outcome, index) => {
          const expected = expectedCommandIntents[index];
          return (
            outcome.status === "accepted_durable" &&
            outcome.opId === expected.opId &&
            outcome.intentDigest === expected.intentDigest &&
            outcome.firstRevision === expected.firstRevision &&
            outcome.lastRevision === expected.lastRevision &&
            JSON.stringify(outcome.memberOpIds) === JSON.stringify(expected.memberOpIds)
          );
        }) &&
        ledger.contentObjectDigests().length === blobClaims.length,
      fixedExpectedEvents: expectedEvents.length,
      acceptedRows: rows.length,
      acceptedOutcomes: outcomes.length,
      contentObjects: ledger.contentObjectDigests().length,
    };
  ledger.close();
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

function primaryRequest(seed, commandIndex, eventsPerCommand, fence, blobClaims) {
  const firstRevision = commandIndex * eventsPerCommand + 1;
  const expectedEvents = Array.from({ length: eventsPerCommand }, (_value, offset) => {
    const revision = firstRevision + offset;
    return offset === 0 && blobClaims.length > 0
      ? scaleDocumentEvent(seed, revision, blobClaims)
      : scaleEvent(seed, revision);
  });
  const opId = `${seed}-command-${commandIndex + 1}`;
  return {
    requestId: `${opId}-primary`,
    kind: "primary",
    opId,
    intentDigest: intentDigest(expectedEvents),
    summary: `${eventsPerCommand} scale events`,
    expectedEvents,
    blobClaims,
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

function makeBlobClaims(seed, layout) {
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

function distributeClaims(claims, commandCount) {
  const grouped = Array.from({ length: commandCount }, () => []);
  for (const [index, claim] of claims.entries()) grouped[index % commandCount].push(claim);
  return grouped;
}

function scaleDocumentEvent(seed, revision, claims) {
  return {
    schema: "doc-event/v1",
    eventId: `${seed}-event-${revision}`,
    workspaceRevision: revision,
    opId: `${seed}-event-op-${revision}`,
    type: "documents_written",
    actor,
    source: "local",
    occurredAt: "2026-09-06T00:00:00.000Z",
    payload: {
      executionId: `${seed}-execution`,
      baseLedgerSha: { repoId: `${seed}-repo`, revision: revision - 1, headDigest: `sha256:${"0".repeat(64)}` },
      changes: claims.map((claim) => ({
        path: `scale/${claim.index}.bin`,
        baseBlobSha256: null,
        policyId: "opaque-textual-whole-file/v1",
        candidate: { sha256: claim.sha256, size: claim.size, mediaType: "text/plain" },
        regionProofs: [],
      })),
    },
  };
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
        assert.equal(receipt.code, "op_conflict");
        totals.conflictRequests += 1;
        return;
      }
      assert.equal(receipt.status, "accepted_durable");
      assert.equal(receipt.opId, request.opId);
      assert.equal(receipt.intentDigest, request.intentDigest);
      assert.equal(receipt.firstRevision, request.expectedEvents[0].workspaceRevision);
      assert.equal(receipt.lastRevision, request.expectedEvents.at(-1).workspaceRevision);
      assert.deepEqual(
        receipt.memberOpIds,
        request.expectedEvents.map((event) => event.opId),
      );
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

function verifyBlobManifest(ledger, claims) {
  const digest = createHash("sha256");
  for (const claim of claims) {
    const body = ledger.readContentObject(claim.sha256);
    assert.ok(body);
    assert.equal(body.byteLength, claim.size);
    assert.equal(hashBytes(body), claim.sha256);
    digest.update(`${claim.index}:${claim.sha256}:${claim.size}\n`);
  }
  return `sha256:${digest.digest("hex")}`;
}

function sqliteEventStream(ledger) {
  return {
    readHead: () => {
      const last = ledger.eventAtRevision(ledger.revision());
      return last
        ? {
            revision: last.workspaceRevision,
            eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(last))}`,
          }
        : null;
    },
    readBatch: (cursor, maxItems) => {
      const start = cursor === null ? 0 : Number(cursor),
        sourceRevision = ledger.revision(),
        selected = ledger.eventsAfter(start, maxItems);
      return {
        sourceRevision,
        events: selected,
        cursor: start + selected.length >= sourceRevision ? null : String(start + selected.length),
        done: start + selected.length >= sourceRevision,
        accessedItems: selected.length,
        prefetchContent: () =>
          new Map(
            selected.flatMap((event) =>
              (event.payload?.changes ?? []).flatMap((change) => {
                const sha = change.candidate?.sha256;
                return sha ? [[sha, ledger.readContentObject(sha)]] : [];
              }),
            ),
          ),
      };
    },
    readContentBlob: (sha256) => ledger.readContentObject(sha256),
  };
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

async function withScratch(seed, run) {
  const scratch = await mkdtemp(path.join(tmpdir(), `ha-stress-s4-${seed}-`));
  const targetRoot = path.join(scratch, "target");
  const controllerRoot = process.env.HARNESS_STRESS_EVIDENCE_ROOT
    ? path.join(path.resolve(process.env.HARNESS_STRESS_EVIDENCE_ROOT), seed, "controller")
    : path.join(scratch, "controller");
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
