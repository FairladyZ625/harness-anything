// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, sha256Text, taskLifecycleWritePlan } from "../../packages/kernel/src/index.ts";
import { openSqliteEventStore } from "../../packages/kernel/src/store/sqlite-event-store.ts";
import { eventAt } from "../../packages/kernel/test/store/task-event-store.fixtures.ts";
import { initRepo } from "../../packages/daemon/test/task-surface.fixtures.ts";
import { buildStressReport, emitStressReport } from "./core/report.mjs";
import { generateCoverageDenominators } from "./core/denominators.mjs";
import { oracleO2 } from "./core/oracles.mjs";
import { runUnderStrace, syscallOccurrences } from "./storage/strace-injector.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../.."),
  fixture = path.join(import.meta.dirname, "storage/repo-cell-shadow-fixture.mjs"),
  repoId = "stress-s2-sqlite-accept",
  opId = "stress-s2-accept-command",
  seed = "stress-s2-seed-20260906";

test("S2 injects the accepting SQLite boundary and keeps Git failure post-accept", { timeout: 300_000 }, async () => {
  assert.equal(process.platform, "linux", "requires Linux strace fault injection");
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-stress-s2-"));
  try {
    const positiveControl = await nativeInjectionControl(scratch),
      baselineRoot = path.join(scratch, "baseline");
    prepareRoot(baselineRoot);
    const baseline = await tracedCommand(baselineRoot, path.join(scratch, "baseline.strace")),
      baselineFrame = frame(baseline.stdout),
      writes = syscallOccurrences(baseline.trace, {
        syscall: "pwrite64",
        pathIncludes: path.join("store", "generations", "1", "ledger.sqlite-wal"),
      });
    assert.equal(baseline.code, 0, baseline.stderr);
    assert.equal(baselineFrame.outcome.status, "accepted_durable");
    assert.ok(writes.length > 0, "accepting SQLite WAL emitted no injectable pwrite64 boundary");
    const cases = [];
    for (const [index, write] of writes.entries()) {
      const root = path.join(scratch, `fault-${index + 1}`),
        tracePath = path.join(scratch, `fault-${index + 1}.strace`);
      prepareRoot(root);
      const result = await tracedCommand(root, tracePath, `pwrite64:error=EIO:when=${write.ordinal}`),
        observed = frame(result.stdout),
        databasePath = ledgerPath(root),
        reopened = openSqliteEventStore({ repoId, databasePath }),
        outcome = reopened.readCommandOutcome(opId),
        events = reopened.events();
      reopened.close();
      const injected = result.trace.split(/\r?\n/u).find((line) => line.includes("EIO") && line.includes("INJECTED"));
      assert.ok(injected, `pwrite64 occurrence ${index + 1} was not injected`);
      assert.equal(events.length === 0 || (events.length === 1 && outcome?.status === "accepted_durable"), true);
      assert.equal(events.length === 0, outcome === null, "event and outcome must commit atomically");
      assert.equal(observed.outcome?.status === "accepted_durable", outcome?.status === "accepted_durable");
      cases.push({
        id: `F01/sqlite-accept-pwrite64-EIO/n=${index + 1}`,
        boundaryHits: [{ syscall: "pwrite64", ordinal: write.ordinal }],
        faults: [{ kind: "one-shot-io", errno: "EIO", trace: injected.trim() }],
        observations: {
          acceptedReceipt: observed.outcome?.status === "accepted_durable",
          reopenedOutcome: outcome?.status ?? "unknown",
          reopenedEvents: events.length,
        },
        oracles: { atomicEventOutcome: "PASS", reopenOpIdResolution: "PASS", honestReceipt: "PASS" },
        verdict: "PASS",
      });
    }
    const f08 = await gitFailureAfterAcceptance(path.join(scratch, "git-failure"));
    cases.push(f08);
    const acceptedMissing = oracleO2(acceptedButMissingInput());
    assert.equal(acceptedMissing.verdict, "FAIL");
    const denominators = await storageDenominators();
    const negativeControls = [
      { id: "injector/pwrite64-EIO", observed: positiveControl.code, passed: true },
      {
        id: "F01/accepted-but-missing",
        observed: acceptedMissing.verdict,
        passed: acceptedMissing.verdict === "FAIL",
        violations: acceptedMissing.violations,
      },
    ];
    const report = buildStressReport({
      campaignComplete: true,
      source: { head: process.env.HARNESS_BUILD_COMMIT ?? null, base: null, loadedBuild: "source", dirty: null },
      environment: {
        node: process.version,
        sqlite: baselineFrame.sqliteVersion ?? null,
        os: `${process.platform}-${process.arch}`,
        filesystem: "isolated Ubuntu temporary filesystem",
        capabilities: ["strace pwrite64 injection", "fresh SQLite reopen", "Git follower failure"],
      },
      seed,
      topology: "external controller + SQLite accepting transaction + post-accept Git follower",
      generation: 1,
      counts: { acceptedEvents: 1, uniqueBlobs: 0, maxConcurrentClients: 1 },
      coverage: {
        denominatorSchema: denominators.schema,
        denominatorDigest: denominators.digest,
        required: denominators.required,
        hit: denominators.hit,
        missing: denominators.missing,
        unmapped: denominators.missing,
        negativeControls,
      },
      calibration: { pwrite64Occurrences: writes.length },
      cases,
      replayCommand: "node tools/dispatch-isolated-test.mjs --file tools/stress/storage-campaign.integration.test.mjs",
      residualRisks: [],
    });
    assert.equal(report.verdict, "PASS");
    emitStressReport(report);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

async function tracedCommand(root, tracePath, injection) {
  return runUnderStrace({
    command: process.execPath,
    args: [fixture, "command", root, repoId, opId],
    tracePath,
    ...(injection ? { injection } : {}),
    cwd: repoRoot,
  });
}

function acceptedButMissingInput() {
  const event = eventAt(1),
    request = {
      requestId: "accepted-but-missing",
      opId: event.opId,
      intentDigest: `sha256:${sha256Text(JSON.stringify(event))}`,
      expectedEvents: [event],
    },
    emptyCut = { generation: 1, revision: 0, events: [], outcomes: [] };
  return {
    authority: "sqlite",
    canonicalCut: emptyCut,
    sqliteCut: emptyCut,
    receiptLog: {
      complete: true,
      errors: [],
      records: [
        { type: "campaign_started" },
        { type: "request", request },
        { type: "receipt", requestId: request.requestId, receipt: { status: "accepted_durable" } },
        { type: "campaign_completed" },
      ],
    },
  };
}

async function storageDenominators() {
  const all = await generateCoverageDenominators({ repoRoot }),
    required = all.required.filter(
      ({ source, kind }) =>
        kind === "durable-boundary" &&
        ["sqlite-event-store.ts", "sqlite-task-event-store.ts", "local-layout-file-system.ts"].some((name) =>
          source.endsWith(name),
        ),
    ),
    hit = required
      .filter(({ source, boundary }) => source.endsWith("sqlite-event-store.ts") && boundary === "commit")
      .map(({ id }) => id);
  return {
    schema: all.schema,
    digest: all.digest,
    required: required.map(({ id }) => id),
    hit,
    missing: required.map(({ id }) => id).filter((id) => !hit.includes(id)),
  };
}

function prepareRoot(root) {
  mkdirSync(root, { recursive: true });
  const store = openSqliteEventStore({ repoId, databasePath: ledgerPath(root) });
  store.close();
}

function ledgerPath(root) {
  return path.join(root, ".harness", "store", "generations", "1", "ledger.sqlite");
}

async function nativeInjectionControl(scratch) {
  const result = await runUnderStrace({
    command: process.execPath,
    args: [fixture, "pwrite-probe", path.join(scratch, "probe")],
    tracePath: path.join(scratch, "probe.strace"),
    injection: "pwrite64:error=EIO:when=1",
    cwd: repoRoot,
  });
  const observed = frame(result.stdout);
  assert.equal(observed.code, "EIO");
  return { code: observed.code };
}

async function gitFailureAfterAcceptance(root) {
  mkdirSync(root, { recursive: true });
  initRepo(root);
  execFileSync("git", ["-C", root, "checkout", "--detach", "--quiet"]);
  const store = makeTaskEventStore({ repoId: "stress-s2-git-pending", rootDir: root }),
    event = eventAt(1),
    receipt = store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }),
    follower = store.followerStatus();
  assert.equal(receipt.revision, 1);
  assert.equal(follower.git.status, "pending");
  assert.equal(store.readHead().revision, 1);
  await store.drain();
  return {
    id: "F08/post-accept-git-pending",
    boundaryHits: ["SQLite transaction commit", "Git follower branch resolution"],
    faults: [{ kind: "Git failure", boundary: "after accepted transaction" }],
    observations: { revision: receipt.revision, git: follower.git.status, reason: follower.git.reason },
    oracles: { acceptedLedgerDurable: "PASS", gitFacetPending: "PASS" },
    verdict: "PASS",
  };
}

function frame(stdout) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  return JSON.parse(lines.at(-1));
}
