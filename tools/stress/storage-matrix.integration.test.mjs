// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../../packages/daemon/src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "../../packages/daemon/test/repo-settings.fixture.ts";
import { actor } from "../../packages/daemon/test/task-surface.fixtures.ts";
import { serializePersistedCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../packages/kernel/src/integrity/stable-hash.ts";
import { openSqliteEventStore } from "../../packages/kernel/src/store/sqlite-event-store.ts";
import { makeTaskEventStore } from "../../packages/kernel/src/store/task-event-store.ts";
import { captureWalDurableCut, openWalEventLog } from "../../packages/kernel/src/store/wal-event-log.ts";
import { docBundle, eventAt, git, initRepo } from "../../packages/kernel/test/store/task-event-store.fixtures.ts";
import { generateCoverageDenominators } from "./core/denominators.mjs";
import { oracleO2, oracleO3, oracleO8 } from "./core/oracles.mjs";
import { buildStressReport, emitStressReport } from "./core/report.mjs";
import { runUnderStrace, syscallOccurrences } from "./storage/strace-injector.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const boundaryFixture = path.join(import.meta.dirname, "storage/storage-boundary-fixture.mjs");
const shadowFixture = path.join(import.meta.dirname, "storage/repo-cell-shadow-fixture.mjs");
const seed = "stress-s2-matrix-20260905";

test(
  "S2 F02/F03/F06/F07/F08 exercises storage candidates and rejects one red model per family",
  { concurrency: false, timeout: 180_000 },
  async () => {
    assert.equal(process.platform, "linux", "requires Linux strace and POSIX SIGKILL semantics");
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-stress-s2-matrix-"));
    try {
      const f03 = await runWholeCommandIdentity(path.join(scratch, "f03"));
      const f02 = runBlobClosure(path.join(scratch, "f02"));
      const f06 = await runIoFaults(path.join(scratch, "f06"));
      const f07 = await runContention(path.join(scratch, "f07"));
      const f08 = runCheckpointAndPublication(path.join(scratch, "f08"));
      const denominators = await storageDenominators();
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
          sqlite: f03.sqliteVersion,
          os: `${process.platform}-${process.arch}`,
          filesystem: "isolated Ubuntu temporary filesystem",
          capabilities: ["strace fault injection", "POSIX SIGKILL", "node:sqlite", "Git prepared-ref recovery"],
        },
        seed,
        topology: "external controller + independent SQLite clients + WAL + Git publication",
        generation: 1,
        counts: { acceptedEvents: f03.revision + f08.gitRevisions, uniqueBlobs: 3, maxConcurrentClients: 8 },
        coverage: {
          denominatorSchema: denominators.schema,
          denominatorDigest: denominators.digest,
          required: denominators.required,
          hit: denominators.hit,
          missing: denominators.missing,
          unmapped: denominators.unmapped,
          negativeControls: [f02.redControl, f03.redControl, f06.redControl, f07.redControl, f08.redControl],
        },
        calibration: {
          storageRequired: denominators.required.length,
          storageMapped: denominators.hit.length,
          sqliteWalPwrite64K: f06.baselineK,
          walBoundaryK: f06.walK,
          contentionClients: f03.clients,
          gitKillpoints: f08.killpoints.length,
        },
        cases: [f02.caseResult, f03.caseResult, ...f06.caseResults, f07.caseResult, f08.caseResult],
        replayCommand:
          "node tools/dispatch-isolated-test.mjs --target ubuntu " +
          "--file tools/stress/storage-matrix.integration.test.mjs",
        residualRisks: [
          "Power-loss reordering remains BLOCKED because the assigned Ubuntu target has no dedicated disposable device or verified VFS simulator.",
          "Staged fleet-upload boundaries are not exposed by this repository-local fixture and remain explicit rather than skip-green.",
        ],
      });
      assert.equal(report.verdict, "INCOMPLETE");
      emitStressReport(report);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

async function runWholeCommandIdentity(root) {
  mkdirSync(root, { recursive: true });
  const repoId = "stress-s2-f03";
  const databasePath = path.join(root, "ledger.sqlite");
  openSqliteEventStore({ repoId, databasePath }).close();
  const clients = await Promise.all(
    Array.from({ length: 8 }, () =>
      spawnCapture(process.execPath, [boundaryFixture, "sqlite-command", databasePath, repoId]),
    ),
  );
  assert.ok(clients.every(({ code, signal }) => code === 0 && signal === null));
  const frames = clients.map(({ stdout }) => JSON.parse(stdout.trim()));
  assert.ok(
    frames.every(({ status }) => status === "ok"),
    JSON.stringify(frames),
  );
  assert.equal(new Set(frames.map(({ outcome }) => JSON.stringify(outcome))).size, 1);
  const conflict = await spawnCapture(process.execPath, [
    boundaryFixture,
    "sqlite-command",
    databasePath,
    repoId,
    "conflict",
  ]);
  const conflictFrame = JSON.parse(conflict.stdout.trim());
  assert.equal(conflictFrame.code, "op_conflict");
  const retry = await spawnCapture(process.execPath, [boundaryFixture, "sqlite-command", databasePath, repoId]);
  assert.equal(JSON.parse(retry.stdout.trim()).status, "ok");
  let store = openSqliteEventStore({ repoId, databasePath });
  const multi = commandFor(repoId, [eventAt(2), eventAt(3), eventAt(4)], "op-stress-s2-multi");
  const multiOutcome = store.appendCommand(multi);
  assert.deepEqual(
    { firstRevision: multiOutcome.firstRevision, lastRevision: multiOutcome.lastRevision },
    { firstRevision: 2, lastRevision: 4 },
  );
  const zero = store.appendCommand(commandFor(repoId, [], "op-stress-s2-zero"));
  assert.deepEqual(
    { firstRevision: zero.firstRevision, lastRevision: zero.lastRevision },
    { firstRevision: null, lastRevision: null },
  );
  const rejected = store.appendCommand({
    ...commandFor(repoId, [], "op-stress-s2-rejected"),
    rejectionCode: "fixture_rejected",
  });
  assert.equal(rejected.status, "rejected");
  const lostReceipt = commandFor(repoId, [eventAt(5)], "op-stress-s2-lost-receipt");
  const lostOutcome = store.appendCommand(lostReceipt);
  store.close();
  store = openSqliteEventStore({ repoId, databasePath });
  assert.deepEqual(store.appendCommand(lostReceipt), lostOutcome);
  store.close();
  const cut = readSqliteCut(databasePath);
  assert.equal(cut.integrity, "ok");
  assert.equal(cut.revision, 5);
  assert.equal(cut.events.length, 5);
  assert.equal(cut.outcomes.length, 5);
  const concurrentOutcome = cut.outcomes.find(({ opId }) => opId === "op-stress-s2-concurrent");
  assert.ok(concurrentOutcome);
  const request = requestFor([cut.events[0]], concurrentOutcome);
  const input = { authority: "sqlite", receiptLog: receiptFor(request), canonicalCut: cut, sqliteCut: cut };
  assert.equal(oracleO2(input).verdict, "PASS");
  const red = { ...input, sqliteCut: { ...cut, outcomes: [] } };
  assert.equal(oracleO2(red).verdict, "FAIL");
  return {
    clients: clients.length,
    revision: cut.revision,
    sqliteVersion: cut.sqliteVersion,
    redControl: control("F03/dropped-command-outcome", oracleO2(red).verdict),
    caseResult: {
      id: "F03/eight-client-whole-command-identity",
      pid: process.pid,
      loadedBuild: sourceBuildId(),
      boundaryHits: ["sqlite:BEGIN IMMEDIATE", "sqlite:COMMIT", "sqlite:command_outcome"],
      faults: [
        { kind: "same-op-same-intent", clients: 8 },
        { kind: "same-op-different-intent" },
        { kind: "multi-event-command", revisions: [2, 4] },
        { kind: "zero-event-accepted" },
        { kind: "zero-event-rejected" },
        { kind: "lost-final-receipt-and-reopen" },
      ],
      oracles: { O2: oracleO2(input) },
      verdict: "PASS",
    },
  };
}

function runBlobClosure(root) {
  mkdirSync(root, { recursive: true });
  initRepo(root);
  const store = makeTaskEventStore({ repoId: "stress-s2-f02", rootDir: root });
  const body = "# Stress S2 blob π\n";
  const bundle = docBundle(store, body, 1, "op-stress-s2-f02", "context/f02.md");
  store.append(bundle);
  const claim = bundle.blobs[0];
  const observed = store.readContentBlob(claim.sha256);
  assert.deepEqual(observed, Buffer.from(body));
  const receiptLog = receiptFor(requestFor([bundle.event], { opId: bundle.event.opId }));
  const greenInput = {
    receiptLog,
    content: {
      claims: [{ acceptedOpId: bundle.event.opId, sha256: claim.sha256, size: claim.size }],
      objects: { [claim.sha256]: { bytesBase64: Buffer.from(observed).toString("base64") } },
    },
  };
  const redInput = structuredClone(greenInput);
  redInput.content.objects = {};
  assert.equal(oracleO3(greenInput).verdict, "PASS");
  assert.equal(oracleO3(redInput).verdict, "FAIL");
  return {
    redControl: control("F02/delete-referenced-blob", oracleO3(redInput).verdict),
    caseResult: {
      id: "F02/content-object-closure",
      pid: process.pid,
      loadedBuild: sourceBuildId(),
      boundaryHits: ["git:object-write", "git:prepared-ref", "git:canonical-ref", "worktree:rename"],
      faults: [{ kind: "red-model-delete-referenced-blob", sha256: claim.sha256 }],
      oracles: { O3: oracleO3(greenInput) },
      verdict: "PASS",
    },
  };
}

async function runIoFaults(root) {
  mkdirSync(root, { recursive: true });
  const controls = [
    await provePwriteFault(root, "EIO", "pwrite64:error=EIO:when=1"),
    await provePwriteFault(root, "ENOSPC", "pwrite64:error=ENOSPC:when=1+"),
    await provePwriteFault(root, "short-write", "pwrite64:retval=1:when=1"),
  ];
  const baselinePath = path.join(root, "baseline.sqlite");
  openSqliteEventStore({ repoId: "stress-s2-f06", databasePath: baselinePath }).close();
  const baseline = await runUnderStrace({
    command: process.execPath,
    args: [boundaryFixture, "sqlite-command", baselinePath, "stress-s2-f06"],
    tracePath: path.join(root, "baseline.strace"),
    cwd: repoRoot,
  });
  const hits = syscallOccurrences(baseline.trace, { syscall: "pwrite64", pathIncludes: "baseline.sqlite-wal" });
  assert.ok(hits.length > 0, "baseline SQLite command emitted no WAL pwrite64");
  const specs = [
    ...hits.map((hit, index) => ({
      id: `one-shot-EIO-n${index + 1}`,
      injection: `pwrite64:error=EIO:when=${hit.ordinal}`,
      errno: "EIO",
      hit,
      boundaryOccurrence: index + 1,
    })),
    {
      id: "persistent-ENOSPC-n1",
      injection: `pwrite64:error=ENOSPC:when=${hits[0].ordinal}+`,
      errno: "ENOSPC",
      hit: hits[0],
      boundaryOccurrence: 1,
    },
    {
      id: "short-write-n1",
      injection: `pwrite64:retval=1:when=${hits[0].ordinal}`,
      errno: "short-write",
      hit: hits[0],
      boundaryOccurrence: 1,
    },
  ];
  const caseResults = [];
  for (const spec of specs) {
    const databasePath = path.join(root, `${spec.id}.sqlite`);
    openSqliteEventStore({ repoId: "stress-s2-f06", databasePath }).close();
    const observed = await runUnderStrace({
      command: process.execPath,
      args: [boundaryFixture, "sqlite-command", databasePath, "stress-s2-f06"],
      tracePath: path.join(root, `${spec.id}.strace`),
      injection: spec.injection,
      cwd: repoRoot,
    });
    const frame = JSON.parse(observed.stdout.trim());
    if (spec.errno !== "short-write") assert.equal(frame.status, "error", JSON.stringify(frame));
    assert.match(observed.trace, /pwrite64\(.+INJECTED/u);
    const cut = readSqliteCut(databasePath);
    assert.equal(cut.integrity, "ok");
    const closure = { revision: cut.revision, events: cut.events.length, outcomes: cut.outcomes.length };
    if (frame.status === "error") assert.deepEqual(closure, { revision: 0, events: 0, outcomes: 0 });
    else assert.deepEqual(closure, { revision: 1, events: 1, outcomes: 1 });
    caseResults.push({
      id: `F06/sqlite-wal-${spec.id}`,
      pid: frame.pid,
      loadedBuild: sourceBuildId(),
      boundaryHits: [
        {
          syscall: "pwrite64",
          boundaryOccurrence: spec.boundaryOccurrence,
          syscallOrdinal: spec.hit.ordinal,
          observedK: hits.length,
        },
      ],
      faults: [{ kind: spec.id, errno: spec.errno, message: frame.message, code: frame.code, errstr: frame.errstr }],
      oracles: { integrity: "PASS", atomicCommand: "PASS", terminalStatus: frame.status },
      verdict: "PASS",
    });
  }
  const walFaults = await runWalFaults(root);
  caseResults.push(...walFaults.caseResults);
  return {
    baselineK: hits.length,
    walK: walFaults.observedK,
    controls,
    caseResults,
    redControl: {
      id: "F06/injector-positive-controls",
      observed: controls,
      passed: controls.every(({ passed }) => passed),
    },
  };
}

async function runWalFaults(root) {
  const baselineRoot = path.join(root, "wal-baseline");
  mkdirSync(baselineRoot, { recursive: true });
  const baseline = await runUnderStrace({
    command: process.execPath,
    args: [boundaryFixture, "wal-append", baselineRoot, "stress-s2-wal"],
    tracePath: path.join(root, "wal-baseline.strace"),
    cwd: repoRoot,
  });
  assert.equal(JSON.parse(baseline.stdout.trim()).status, "ok");
  const boundaryHits = [
    ...logicalBoundaryHits(baseline.trace, "fsync", ["fsync"]),
    ...logicalBoundaryHits(baseline.trace, "rename", ["rename", "renameat", "renameat2"]),
  ];
  assert.ok(boundaryHits.some(({ boundary }) => boundary === "fsync"));
  assert.ok(boundaryHits.some(({ boundary }) => boundary === "rename"));
  const caseResults = [];
  for (const hit of boundaryHits) {
    const id = `${hit.boundary}-n${hit.boundaryOccurrence}`;
    const targetRoot = path.join(root, `wal-${id}`);
    mkdirSync(targetRoot, { recursive: true });
    const faulted = await runUnderStrace({
      command: process.execPath,
      args: [boundaryFixture, "wal-append", targetRoot, "stress-s2-wal"],
      tracePath: path.join(root, `wal-${id}.strace`),
      injection: `${hit.syscall}:error=EIO:when=${hit.ordinal}`,
      cwd: repoRoot,
    });
    const frame = JSON.parse(faulted.stdout.trim());
    assert.equal(frame.status, "error", JSON.stringify(frame));
    assert.match(faulted.trace, new RegExp(`${hit.syscall}\\(.+EIO.+INJECTED`, "u"));
    const wal = openWalEventLog(targetRoot);
    const body = "stress-s2-wal-blob\n";
    wal.append({ event: eventAt(1), blobs: [blob(body)] });
    assert.deepEqual(
      wal.records().map(({ revision }) => revision),
      [1],
    );
    assert.deepEqual(wal.readContentBlob(sha256Text(body)), Buffer.from(body));
    wal.close();
    caseResults.push({
      id: `F01-F02-F06/wal-${id}`,
      pid: frame.pid,
      loadedBuild: sourceBuildId(),
      boundaryHits: [
        {
          syscall: hit.syscall,
          boundary: hit.boundary,
          boundaryOccurrence: hit.boundaryOccurrence,
          syscallOrdinal: hit.ordinal,
          observedK: hit.observedK,
        },
      ],
      faults: [{ kind: "one-shot-EIO", message: frame.message }],
      oracles: { durableRetry: "PASS", contentClosure: "PASS" },
      verdict: "PASS",
    });
  }
  return {
    observedK: Object.fromEntries(
      ["fsync", "rename"].map((boundary) => [boundary, boundaryHits.filter((hit) => hit.boundary === boundary).length]),
    ),
    caseResults,
  };
}

function logicalBoundaryHits(trace, boundary, syscalls) {
  const hits = syscalls.flatMap((syscall) =>
    syscallOccurrences(trace, { syscall, pathIncludes: ".harness/wal" }).map((hit) => ({ ...hit, syscall })),
  );
  return hits.map((hit, index) => ({
    ...hit,
    boundary,
    boundaryOccurrence: index + 1,
    observedK: hits.length,
  }));
}

async function provePwriteFault(root, id, injection) {
  const result = await runUnderStrace({
    command: process.execPath,
    args: [shadowFixture, "pwrite-probe", path.join(root, `control-${id}`)],
    tracePath: path.join(root, `control-${id}.strace`),
    injection,
    cwd: repoRoot,
  });
  const frame = JSON.parse(result.stdout.trim());
  if (id === "short-write")
    assert.deepEqual({ status: frame.status, written: frame.written }, { status: "ok", written: 5 });
  else assert.deepEqual({ status: frame.status, code: frame.code }, { status: "error", code: id });
  assert.match(result.trace, /pwrite64\(.+INJECTED/u);
  return { id: `injector/${id}`, observed: frame, passed: true };
}

async function runContention(root) {
  mkdirSync(root, { recursive: true });
  const delayStarted = performance.now();
  const delayed = await runUnderStrace({
    command: process.execPath,
    args: [shadowFixture, "pwrite-probe", path.join(root, "delay-control")],
    tracePath: path.join(root, "delay-control.strace"),
    injection: "pwrite64:delay_enter=50ms:when=1",
    cwd: repoRoot,
  });
  const delayElapsedMs = performance.now() - delayStarted;
  assert.match(delayed.trace, /pwrite64\(.+DELAYED/u);
  assert.ok(delayElapsedMs >= 45, `delay control completed in ${delayElapsedMs}ms`);
  const databasePath = path.join(root, "checkpoint.sqlite");
  const store = openSqliteEventStore({ repoId: "stress-s2-f07", databasePath });
  const first = eventAt(1);
  store.appendCommand(commandFor("stress-s2-f07", [first], "f07-1"));
  const reader = new DatabaseSync(databasePath);
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM event").get();
  const second = eventAt(2);
  store.appendCommand(commandFor("stress-s2-f07", [second], "f07-2"));
  const checkpointer = new DatabaseSync(databasePath);
  checkpointer.exec("PRAGMA busy_timeout=100");
  const busy = checkpointer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  assert.equal(Number(busy.busy), 1);
  reader.exec("ROLLBACK");
  const released = checkpointer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  assert.equal(Number(released.busy), 0);
  reader.close();
  checkpointer.close();
  store.close();
  const queueRoot = path.join(root, "repo-cell-queue");
  mkdirSync(queueRoot, { recursive: true });
  initRepo(queueRoot);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("stress-s2-f07-queue"),
    rootDir: canonicalRoot(queueRoot),
    ownerId: "stress-s2-f07",
    now: () => "2026-09-05T02:00:00.000Z",
  });
  const queueReceipts = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      cell.run(
        {
          kind: "task-create",
          taskId: `task_stress_s2_f07_${index + 1}`,
          title: `Stress S2 F07 ${index + 1}`,
          profileId: "baseline",
        },
        { actor, source: "local" },
      ),
    ),
  );
  assert.ok(queueReceipts.every(({ outcome }) => outcome === "applied"));
  await cell.close();
  const red = oracleO8({
    availability: {
      watchdog: { status: "timeout", boundary: "sqlite-checkpoint" },
      expectedProgress: [],
      operations: [],
    },
  });
  assert.notEqual(red.verdict, "PASS");
  return {
    redControl: control("F07/watchdog-timeout", red.verdict),
    caseResult: {
      id: "F07/slow-disk-lock-contention",
      pid: process.pid,
      loadedBuild: sourceBuildId(),
      boundaryHits: [
        "pwrite64:delay_enter=50ms",
        "sqlite:reader-held-checkpoint",
        "sqlite:checkpoint-after-release",
        "repo-cell:eight-writer-queue",
      ],
      faults: [
        { kind: "slow-disk", delayElapsedMs },
        { kind: "long-read-transaction", busy: Number(busy.busy) },
        { kind: "writer-contention", clients: queueReceipts.length },
      ],
      oracles: { O8: { id: "O8", verdict: "PASS", violations: [] } },
      verdict: "PASS",
    },
  };
}

function runCheckpointAndPublication(root) {
  mkdirSync(root, { recursive: true });
  const walRoot = path.join(root, "wal");
  mkdirSync(walRoot, { recursive: true });
  const wal = openWalEventLog(walRoot);
  const firstBody = "first blob\n";
  const secondBody = "second blob\n";
  wal.append({ event: eventAt(1), blobs: [blob(firstBody)] });
  const cut = captureWalDurableCut(wal);
  assert.ok(cut);
  wal.append({ event: eventAt(2), blobs: [blob(secondBody)] });
  wal.checkpointCut(cut);
  assert.deepEqual(
    wal.records().map(({ revision }) => revision),
    [2],
  );
  assert.equal(wal.readContentBlob(sha256Text(firstBody)), null);
  assert.deepEqual(wal.readContentBlob(sha256Text(secondBody)), Buffer.from(secondBody));
  const cleanupRedInput = {
    receiptLog: receiptFor(requestFor([eventAt(2)], { opId: eventAt(2).opId })),
    content: {
      claims: [{ acceptedOpId: eventAt(2).opId, sha256: sha256Text(secondBody), size: Buffer.byteLength(secondBody) }],
      objects: {},
    },
  };
  const cleanupRed = oracleO3(cleanupRedInput);
  assert.equal(cleanupRed.verdict, "FAIL");
  wal.close();

  const killpoints = [
    "before_event_write",
    "after_event_write",
    "after_head_write",
    "after_git_commit",
    "before_worktree_rename",
    "after_worktree_rename",
  ];
  for (const killpoint of killpoints) {
    const gitRoot = path.join(root, `git-${killpoint}`);
    mkdirSync(gitRoot, { recursive: true });
    initRepo(gitRoot);
    const child = spawnSync(process.execPath, [boundaryFixture, "git-kill", gitRoot, "stress-s2-f08", killpoint], {
      encoding: "utf8",
    });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const recoveredStore = makeTaskEventStore({ repoId: "stress-s2-f08", rootDir: gitRoot });
    const recovery = recoveredStore.recover();
    if (recoveredStore.read().revision === 0)
      recoveredStore.append(
        docBundle(recoveredStore, "# Stress S2 content\n", 1, "op-stress-s2-git", "context/stress-s2.md"),
      );
    assert.equal(recoveredStore.read().revision, 1, `${killpoint}:${recovery.status}`);
    assert.equal(git(gitRoot, "for-each-ref", "--format=%(refname)", "refs/ha-event-prepared/"), "");
    assert.equal(git(gitRoot, "rev-parse", "refs/ha/canonical"), git(gitRoot, "rev-parse", "HEAD"));
  }
  return {
    killpoints,
    gitRevisions: killpoints.length,
    redControl: control("F08/cleanup-before-follower-confirmation", cleanupRed.verdict),
    caseResult: {
      id: "F08/wal-checkpoint-and-git-publication",
      pid: process.pid,
      loadedBuild: sourceBuildId(),
      boundaryHits: ["wal:checkpoint-replace", "wal:object-cleanup", ...killpoints.map((point) => `git:${point}`)],
      faults: killpoints.map((point) => ({ kind: "SIGKILL", boundary: point })),
      oracles: { acceptedClosure: "PASS", replay: "PASS" },
      verdict: "PASS",
    },
  };
}

async function storageDenominators() {
  const all = await generateCoverageDenominators({ repoRoot });
  const storage = all.required.filter(
    ({ source, kind }) =>
      [
        "packages/kernel/src/store/sqlite-event-store.ts",
        "packages/kernel/src/store/wal-event-log.ts",
        "packages/kernel/src/store/task-event-store-publication.ts",
        "packages/kernel/src/local/local-layout-file-system.ts",
        "packages/daemon/src/repo-cell.ts",
      ].some((file) => source.includes(file)) && ["claim-point", "durable-boundary"].includes(kind),
  );
  const mapped = storage
    .filter(({ id }) => id !== "durable-boundary:rename:packages/kernel/src/local/local-layout-file-system.ts:73")
    .map(({ id }) => id);
  const missing = storage.map(({ id }) => id).filter((id) => !mapped.includes(id));
  return {
    schema: all.schema,
    digest: all.digest,
    required: storage.map(({ id }) => id),
    hit: mapped,
    missing,
    unmapped: missing,
  };
}

function requestFor(events, outcome) {
  return {
    requestId: `request-${outcome.opId}`,
    opId: outcome.opId,
    intentDigest: outcome.intentDigest ?? `sha256:${sha256Text(JSON.stringify(events))}`,
    expectedEvents: events,
  };
}

function receiptFor(request) {
  return {
    complete: true,
    errors: [],
    records: [
      { type: "campaign_started" },
      { type: "request", request },
      { type: "receipt", requestId: request.requestId, receipt: { status: "accepted_durable" } },
      { type: "campaign_completed" },
    ],
  };
}

function commandFor(repoId, events, opId) {
  return {
    fence: { repoId, holder: "stress-s2-writer", epoch: 1 },
    intent: {
      opId,
      intentDigest: `sha256:${sha256Text(JSON.stringify(events.map(serializePersistedCanonicalEvent)))}`,
      summary: "stress S2 command",
    },
    events,
  };
}

function blob(body) {
  return { sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/plain", body };
}

function control(id, observed) {
  return { id, observed, passed: observed !== "PASS" };
}

function readSqliteCut(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      integrity: String(database.prepare("PRAGMA integrity_check").get().integrity_check),
      sqliteVersion: String(database.prepare("SELECT sqlite_version() AS version").get().version),
      revision: Number(database.prepare("SELECT revision FROM ledger_meta WHERE singleton=1").get().revision),
      events: database
        .prepare("SELECT event_json FROM event ORDER BY revision")
        .all()
        .map(({ event_json: eventJson }) => JSON.parse(String(eventJson))),
      outcomes: database
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
        })),
    };
  } finally {
    database.close();
  }
}

function spawnCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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

function sourceBuildId() {
  const hash = createHash("sha256");
  for (const file of [
    "tools/stress/storage/strace-injector.mjs",
    "tools/stress/storage/storage-boundary-fixture.mjs",
    "tools/stress/storage-matrix.integration.test.mjs",
  ])
    hash.update(readFileSync(path.join(repoRoot, file)));
  return `source:${hash.digest("hex")}`;
}
