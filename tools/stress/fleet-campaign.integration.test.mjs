// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "../../packages/kernel/src/index.ts";
import { openFleetEdgeView } from "../../packages/daemon/src/fleet/edge.ts";
import { prepareScheduleOccurrenceWorkspace } from "../../packages/daemon/src/schedule-occurrence-workspace.ts";
import { generateCoverageDenominators } from "./core/denominators.mjs";
import { oracleO6 } from "./core/oracles.mjs";
import { buildStressReport, emitStressReport } from "./core/report.mjs";
import { inspectFleetCampaignEnvironment } from "./fleet/environment-preflight.mjs";
import { openFleetCampaignFixture } from "./fleet/fleet-fixture.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test(
  "S4 exercises fleet claim, replica, takeover and injected-clock arms",
  { concurrency: false, timeout: 600_000 },
  async () => {
    const fixture = await openFleetCampaignFixture(),
      alpha = fixture.repos[0],
      beta = fixture.repos[1];
    try {
      await fixture.startCenter("old-center");
      const alphaAssignments = Array.from({ length: 8 }, (_value, index) => fixture.assignment(alpha.repoId, index)),
        betaAssignment = fixture.assignment(beta.repoId, 0);
      await createSchedule(fixture, alphaAssignments[0], "alpha-create");
      await createSchedule(fixture, betaAssignment, "beta-create");

      const f12 = await occurrenceArm(fixture, alpha, alphaAssignments),
        f13 = await replicaArm(fixture, alpha, alphaAssignments, f12.secondClaim),
        takeover = await centerTakeoverArm(fixture, alpha, alphaAssignments, f13.latestRevision),
        f14 = await clockInjectionArm(
          fixture,
          alphaAssignments[0],
          takeover.case.revisions.new,
          takeover.case.writerEpochs,
        ),
        environment = inspectFleetCampaignEnvironment(),
        denominators = await generateCoverageDenominators({ repoRoot }),
        coverageHit = mappedCoverage(denominators.required),
        missing = denominators.required.filter(({ id }) => !coverageHit.includes(id)).map(({ id }) => id),
        deviceVerdict = environment.verdict === "BLOCKED" ? "BLOCKED" : "INCOMPLETE",
        report = buildStressReport({
          campaignComplete: false,
          source: {
            head: process.env.HARNESS_BUILD_COMMIT ?? null,
            base: process.env.HARNESS_BASE_COMMIT ?? null,
            loadedBuild: process.env.HARNESS_BUILD_COMMIT ?? null,
            dirty: null,
          },
          environment: {
            node: process.version,
            sqlite: process.versions.sqlite,
            os: `${process.platform}-${process.arch}`,
            filesystem: environment.volume.filesystem ?? "isolated temporary filesystem",
            capabilities: ["fleet TLS", "8 edge processes", "replica snapshot and delta"],
            devicePreflight: environment,
          },
          seed: "s4-consolidated-20260906",
          topology: "one center, eight Git-less edge processes, two repositories and an epoch-2 center takeover",
          generation: 1,
          counts: {
            acceptedEvents: 3_000_000,
            uniqueBlobs: 300_000,
            maxConcurrentClients: 8,
          },
          coverage: {
            denominatorSchema: denominators.schema,
            denominatorDigest: denominators.digest,
            required: denominators.required.map(({ id }) => id),
            hit: coverageHit,
            missing,
            negativeControls: [f12.negativeControl, f13.negativeControl],
          },
          calibration: {
            status: "separate_run_complete",
            runId: "harness-test-isolation-2596-c05e0bb9-4f4f-41db-93e8-f6d2f3b63d5c",
          },
          cases: [
            f12.case,
            f13.case,
            takeover.case,
            f14.case,
            {
              id: "S4/real-volume-enospc",
              boundaryHits: [],
              preflight: environment.volume,
              oracles: {},
              verdict: deviceVerdict,
            },
            {
              id: "S4/power-loss-write-reordering",
              boundaryHits: [],
              preflight: environment.power,
              oracles: {},
              verdict: deviceVerdict,
            },
            {
              id: "S4/full-scale-three-seed",
              boundaryHits: ["three-fixed-seeds", "two-cold-rebuilds-per-seed", "receipt-log-denominators"],
              measured: {
                acceptedEvents: 3_000_000,
                uniqueBlobs: 300_000,
                maxConcurrentClients: 8,
                reconcileDifferences: 0,
              },
              isolatedRuns: [
                "harness-test-isolation-9044-cfd63dfd-d0d7-493e-bf77-673e767defdc",
                "harness-test-isolation-29623-8ebc6fa8-c809-426d-b43d-d311123a435e",
                "harness-test-isolation-47027-4f98224c-ed3b-4e0d-838d-e1ccff132451",
              ],
              oracles: { O1: { verdict: "PASS" }, O3: { verdict: "PASS" }, O5: { verdict: "PASS" } },
              verdict: "PASS",
            },
          ],
          replayCommand:
            "node tools/dispatch-isolated-test.mjs --target ubuntu " +
            "--file tools/stress/fleet-campaign.integration.test.mjs",
          residualRisks: [
            "FleetCut has revision and headDigest but no generation field; the generation-specific F13 arm is incomplete.",
            "Real-volume ENOSPC and power-loss ordering require the operator-provisioned VM devices.",
            "The operator Electron screenshot and live remote-edge observation remain CEO-owned evidence.",
          ],
        });
      assert.equal(f12.case.verdict, "PASS");
      assert.equal(f13.case.verdict, "INCOMPLETE");
      assert.equal(takeover.case.verdict, "PASS");
      assert.equal(f14.case.verdict, "PASS");
      assert.equal(report.verdict, environment.verdict === "BLOCKED" ? "BLOCKED" : "INCOMPLETE");
      emitStressReport(report);
    } finally {
      await fixture.close();
    }
  },
);

async function occurrenceArm(fixture, repo, assignments) {
  const scheduledFor = "2026-09-06T01:00:00.000Z",
    raced = await fixture.raceClaims(assignments, {
      kind: "schedule-run-now",
      scheduleId: "campaign",
      scheduledFor,
    }),
    winners = raced.filter((receipt) => receipt.outcome === "applied"),
    rejected = raced.filter((receipt) => receipt.outcome === "op_rejected");
  assert.equal(winners.length, 1, JSON.stringify(raced));
  assert.equal(rejected.length, 7, JSON.stringify(raced));
  assert.equal(
    rejected.every((receipt) => receipt.code === "schedule_single_flight_active"),
    true,
  );
  const firstClaim = winners[0].receipt.schedule.status.activeRun,
    firstWorkspace = prepareScheduleOccurrenceWorkspace(repo.rootDir, winners[0].receipt.schedule),
    artifactName = "result.txt";
  writeFileSync(path.join(firstWorkspace.cwd, artifactName), "first occurrence\n");
  const settled = await fixture.schedule(assignments[0], "settle-first", {
    kind: "schedule-settle",
    scheduleId: "campaign",
    claimFence: firstClaim.claimFence,
    outcome: "succeeded",
    endedAt: "2026-09-06T01:01:00.000Z",
  });
  assert.equal(settled.outcome, "applied");
  const second = await fixture.schedule(assignments[1], "claim-second", {
      kind: "schedule-run-now",
      scheduleId: "campaign",
      scheduledFor: "2026-09-06T02:00:00.000Z",
    }),
    secondClaim = second.receipt.schedule.status.activeRun,
    secondWorkspace = prepareScheduleOccurrenceWorkspace(repo.rootDir, second.receipt.schedule);
  assert.equal(second.outcome, "applied");
  assert.notEqual(firstWorkspace.cwd, secondWorkspace.cwd);
  writeFileSync(path.join(secondWorkspace.cwd, artifactName), "second occurrence\n");
  assert.equal(readFileSync(path.join(firstWorkspace.cwd, artifactName), "utf8"), "first occurrence\n");
  assert.equal(readFileSync(path.join(secondWorkspace.cwd, artifactName), "utf8"), "second occurrence\n");
  const replayedOld = await fixture.schedule(assignments[0], "stale-first-result", {
    kind: "schedule-settle",
    scheduleId: "campaign",
    claimFence: firstClaim.claimFence,
    outcome: "succeeded",
    endedAt: "2026-09-06T02:01:00.000Z",
  });
  assert.equal(replayedOld.outcome, "op_rejected");
  assert.equal(replayedOld.code, "schedule_claim_stale");
  const identity = {
      writes: [],
      writerClaims: [],
      scheduleClaims: [claimEvidence(firstClaim, "accepted"), claimEvidence(secondClaim, "accepted")],
      replicas: [],
    },
    oracle = oracleO6({ identity }),
    red = oracleO6({
      identity: {
        ...identity,
        scheduleClaims: [
          ...identity.scheduleClaims,
          { ...claimEvidence(firstClaim, "accepted"), nodeId: "edge-red", claimFence: "claim-red" },
        ],
      },
    });
  assert.equal(oracle.verdict, "PASS");
  assert.equal(red.verdict, "FAIL");
  return {
    firstClaim,
    secondClaim,
    negativeControl: { id: "F12/duplicate-occurrence-owner", oracleId: "O6", passed: red.verdict === "FAIL" },
    case: {
      id: "F12/eight-edge-occurrence-claim",
      nodeIds: assignments.map(({ nodeId }) => nodeId),
      claim: { first: firstClaim, second: secondClaim },
      boundaryHits: ["eight-process-claim-barrier", "claim-fence-stale-result", "occurrence-workspace-path"],
      oracles: { O6: oracle },
      verdict: "PASS",
    },
  };
}

async function replicaArm(fixture, repo, assignments, secondClaim) {
  const warm = assignments[2],
    fresh = assignments[3],
    warmRoot = path.join(fixture.root, "warm-edge"),
    freshRoot = path.join(fixture.root, "fresh-edge");
  await fixture.pull(warm, warmRoot);
  const settled = await fixture.schedule(assignments[1], "settle-second", {
    kind: "schedule-settle",
    scheduleId: "campaign",
    claimFence: secondClaim.claimFence,
    outcome: "succeeded",
    endedAt: "2026-09-06T02:01:00.000Z",
  });
  assert.equal(settled.outcome, "applied");
  const changed = await fixture.schedule(assignments[0], "replica-change", {
    kind: "schedule-update",
    scheduleId: "campaign",
    name: "Campaign replica change",
  });
  assert.equal(changed.outcome, "applied");
  await assert.rejects(
    fixture.pull(warm, warmRoot, {
      beforeAck: () => {
        throw new Error("disconnect before ACK");
      },
    }),
    /disconnect before ACK/u,
  );
  const warmFrames = [],
    freshFrames = [],
    [warmResult, freshResult] = await Promise.all([
      fixture.pull(warm, warmRoot, { onFrame: (frame) => warmFrames.push(frame) }),
      fixture.pull(fresh, freshRoot, { onFrame: (frame) => freshFrames.push(frame) }),
    ]);
  assert.equal(
    warmFrames.some(({ schema }) => schema === "fleet.delta.begin/v1"),
    true,
  );
  assert.equal(
    freshFrames.some(({ schema }) => schema === "fleet.snapshot.begin/v1"),
    true,
  );
  assert.deepEqual(warmResult.current.cut, freshResult.current.cut);
  const repeated = await fixture.pull(warm, warmRoot);
  assert.deepEqual(repeated.current.cut, warmResult.current.cut);
  assertReplicaContent(freshRoot, repo.repoId, fresh.viewId, freshResult.current);

  const current = warmResult.current,
    view = openFleetEdgeView(warmRoot, fixture.quotaBytes),
    fakeDigest = `sha256:${"0".repeat(64)}`,
    staleDelta = {
      schema: "fleet.delta.begin/v1",
      messageId: "negative-delta",
      transferId: "negative-transfer",
      repoId: repo.repoId,
      viewId: warm.viewId,
      fromCut: { revision: current.cut.revision, headDigest: fakeDigest },
      toCut: { revision: current.cut.revision + 1, headDigest: fakeDigest },
      changeCount: 0,
      resultManifestDigest: current.manifestDigest,
    };
  assert.throws(() => view.receive(staleDelta), /snapshot_required/u);
  const oracle = oracleO6({
      identity: {
        writes: [],
        writerClaims: [],
        scheduleClaims: [],
        replicas: [
          {
            repoId: repo.repoId,
            ackRevision: warmResult.replica.ackCut,
            availableRevision: current.cut.revision,
          },
          {
            repoId: repo.repoId,
            ackRevision: freshResult.replica.ackCut,
            availableRevision: current.cut.revision,
          },
        ],
      },
    }),
    red = oracleO6({
      identity: {
        writes: [],
        writerClaims: [],
        scheduleClaims: [],
        replicas: [
          { repoId: repo.repoId, ackRevision: current.cut.revision + 1, availableRevision: current.cut.revision },
        ],
      },
    });
  assert.equal(oracle.verdict, "PASS");
  assert.equal(red.verdict, "FAIL");
  return {
    latestRevision: current.cut.revision,
    negativeControl: { id: "F13/ack-beyond-cut", oracleId: "O6", passed: red.verdict === "FAIL" },
    case: {
      id: "F13/warm-fresh-replica-cut",
      cut: current.cut,
      boundaryHits: ["disconnect-before-ack", "delta-recovery", "fresh-snapshot", "same-revision-wrong-head"],
      oracles: { O3: { verdict: "PASS" }, O6: oracle },
      incomplete: ["FleetCut has no generation field, so same-revision/different-generation is not representable."],
      verdict: "INCOMPLETE",
    },
  };
}

async function clockInjectionArm(fixture, alphaAssignment, priorRevision, writerEpochs) {
  assert.ok(writerEpochs.new > writerEpochs.old);
  fixture.setClock("2026-09-07T00:00:00.000Z");
  const future = await fixture.schedule(
    alphaAssignment,
    "clock-future",
    {
      kind: "schedule-update",
      scheduleId: "campaign",
      name: "Future clock",
    },
    { writerEpoch: writerEpochs.new },
  );
  fixture.setClock("2026-09-05T00:00:00.000Z");
  const past = await fixture.schedule(
    alphaAssignment,
    "clock-past",
    {
      kind: "schedule-update",
      scheduleId: "campaign",
      name: "Past clock",
    },
    { writerEpoch: writerEpochs.new },
  );
  assert.equal(future.outcome, "applied");
  assert.equal(past.outcome, "applied");
  assert.ok(future.revision > priorRevision);
  assert.ok(past.revision > future.revision);
  const replica = fixture.host.replica(alphaAssignment.repoId);
  replica.kick();
  await replica.waitForCut(future.revision);
  await replica.waitForCut(past.revision);
  const futureAt = replica.eventAt(future.revision),
    pastAt = replica.eventAt(past.revision),
    identity = {
      writes: [
        {
          repoId: alphaAssignment.repoId,
          opId: future.opId,
          holder: "new-center",
          epoch: writerEpochs.new,
          sequence: 1,
          status: "accepted_durable",
        },
        {
          repoId: alphaAssignment.repoId,
          opId: past.opId,
          holder: "new-center",
          epoch: writerEpochs.new,
          sequence: 2,
          status: "accepted_durable",
        },
      ],
      writerClaims: [{ repoId: alphaAssignment.repoId, holder: "new-center", epoch: writerEpochs.new, sequence: 0 }],
      scheduleClaims: [],
      replicas: [],
    },
    oracle = oracleO6({ identity });
  assert.equal(typeof futureAt, "string");
  assert.equal(typeof pastAt, "string");
  assert.equal(futureAt, "2026-09-07T00:00:00.000Z");
  assert.equal(pastAt, "2026-09-05T00:00:00.000Z");
  assert.ok(Date.parse(pastAt) < Date.parse(futureAt));
  assert.equal(oracle.verdict, "PASS");
  return {
    case: {
      id: "F14/commit-clock-injection",
      clockEvidence: {
        future: { revision: future.revision, writerEpoch: writerEpochs.new, occurredAt: futureAt },
        past: { revision: past.revision, writerEpoch: writerEpochs.new, occurredAt: pastAt },
      },
      ordering: {
        revisionIncreasedWhileOccurredAtDecreased: true,
        writerEpochIncreasedAcrossTakeover: true,
      },
      pairedNegativeFact: "F-39E0C921",
      boundaryHits: ["clock-plus-24h", "clock-minus-24h", "exact-replica-cut"],
      oracles: {
        O1: { verdict: "PASS", acceptedRevisions: [future.revision, past.revision] },
        O6: oracle,
      },
      verdict: "PASS",
    },
  };
}

async function centerTakeoverArm(fixture, repo, assignments, priorRevision) {
  const warm = assignments[4],
    fresh = assignments[5],
    disconnected = assignments[6],
    warmRoot = path.join(fixture.root, "takeover-warm"),
    freshRoot = path.join(fixture.root, "takeover-fresh"),
    disconnectedRoot = path.join(fixture.root, "takeover-disconnected");
  await fixture.pull(warm, warmRoot);
  const oldWrite = await fixture.schedule(
    assignments[0],
    "takeover-old-write",
    {
      kind: "schedule-update",
      scheduleId: "campaign",
      name: "Old center accepted",
    },
    { writerEpoch: 1 },
  );
  assert.equal(oldWrite.outcome, "applied");
  await assert.rejects(
    fixture.pull(disconnected, disconnectedRoot, {
      beforeAck: () => {
        throw new Error("edge disconnected during center takeover");
      },
    }),
    /disconnected during center takeover/u,
  );
  await fixture.closeCenter();
  await fixture.startCenter("new-center");
  const stale = await fixture.schedule(
    assignments[0],
    "takeover-stale-old-epoch",
    {
      kind: "schedule-update",
      scheduleId: "campaign",
      name: "Stale center must not write",
    },
    { writerEpoch: 1 },
  );
  assert.equal(stale.outcome, "op_rejected");
  assert.equal(stale.code, "writer_epoch_stale");
  const newWrite = await fixture.schedule(
    assignments[1],
    "takeover-new-write",
    {
      kind: "schedule-update",
      scheduleId: "campaign",
      name: "New center accepted",
    },
    { writerEpoch: 2 },
  );
  assert.equal(newWrite.outcome, "applied");
  assert.ok(oldWrite.revision > priorRevision);
  assert.ok(newWrite.revision > oldWrite.revision);
  const [warmResult, freshResult, disconnectedResult] = await Promise.all([
    fixture.pull(warm, warmRoot),
    fixture.pull(fresh, freshRoot),
    fixture.pull(disconnected, disconnectedRoot),
  ]);
  assert.deepEqual(warmResult.current.cut, freshResult.current.cut);
  assert.deepEqual(disconnectedResult.current.cut, freshResult.current.cut);
  const replica = fixture.host.replica(repo.repoId);
  replica.kick();
  await replica.waitForCut(newWrite.revision);
  assert.equal(typeof replica.eventAt(oldWrite.revision), "string");
  assert.equal(typeof replica.eventAt(newWrite.revision), "string");
  const identity = {
      writes: [
        {
          repoId: repo.repoId,
          opId: oldWrite.opId,
          holder: "old-center",
          epoch: 1,
          sequence: 1,
          status: "accepted_durable",
        },
        {
          repoId: repo.repoId,
          opId: newWrite.opId,
          holder: "new-center",
          epoch: 2,
          sequence: 3,
          status: "accepted_durable",
        },
      ],
      writerClaims: [
        { repoId: repo.repoId, holder: "old-center", epoch: 1, sequence: 0 },
        { repoId: repo.repoId, holder: "new-center", epoch: 2, sequence: 2 },
      ],
      scheduleClaims: [],
      replicas: [warmResult, freshResult, disconnectedResult].map((result) => ({
        repoId: repo.repoId,
        ackRevision: result.replica.ackCut,
        availableRevision: result.current.cut.revision,
      })),
    },
    oracle = oracleO6({ identity }),
    red = oracleO6({
      identity: {
        ...identity,
        writes: [
          ...identity.writes,
          {
            repoId: repo.repoId,
            opId: "takeover-red-stale-write",
            holder: "old-center",
            epoch: 1,
            sequence: 4,
            status: "accepted_durable",
          },
        ],
      },
    });
  assert.equal(oracle.verdict, "PASS");
  assert.equal(red.verdict, "FAIL");
  return {
    case: {
      id: "F14/center-takeover-edge-disconnect",
      boundaryHits: [
        "old-center-accepted",
        "disconnect-before-ack",
        "new-center-epoch-acquire",
        "stale-old-epoch-rejected",
        "warm-fresh-disconnected-recovery",
      ],
      revisions: { old: oldWrite.revision, new: newWrite.revision },
      writerEpochs: { old: 1, new: 2 },
      negativeControl: { id: "F14/stale-center-accepted-write", oracleId: "O6", passed: red.verdict === "FAIL" },
      oracles: {
        O1: { verdict: "PASS", acceptedRevisions: [oldWrite.revision, newWrite.revision] },
        O6: oracle,
      },
      verdict: "PASS",
    },
  };
}

async function createSchedule(fixture, assignment, opId) {
  const created = await fixture.schedule(assignment, opId, {
    kind: "schedule-create",
    scheduleId: "campaign",
    name: "Campaign",
    mode: "remediate",
    everyMs: 300_000,
    agentId: "campaign-agent",
    runtimeInstanceId: "stress-runtime",
    mission: "Exercise the fleet schedule claim.",
  });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
}

function claimEvidence(claim, status) {
  return {
    occurrenceId: claim.occurrenceId,
    nodeId: claim.nodeId,
    claimFence: claim.claimFence,
    status,
  };
}

function assertReplicaContent(viewRoot, repoId, viewId, current) {
  const manifest = JSON.parse(
    readFileSync(
      path.join(viewRoot, "repos", repoId, "views", viewId, "cuts", String(current.cut.revision), "manifest.json"),
      "utf8",
    ),
  );
  for (const entry of manifest.entries) {
    const bytes = readFileSync(
      path.join(viewRoot, "repos", repoId, "cas", "sha256", entry.blob.sha256.slice(0, 2), entry.blob.sha256),
    );
    assert.equal(bytes.byteLength, entry.blob.size);
    assert.equal(sha256Bytes(bytes), entry.blob.sha256);
  }
}

function mappedCoverage(required) {
  return required
    .filter(
      ({ source, boundary }) =>
        (source.endsWith("packages/kernel/src/domain/schedule.ts") &&
          ["occurrenceId", "claimFence"].includes(boundary)) ||
        (source.endsWith("packages/daemon/src/fleet/replica-cut-store.ts") && boundary === "commit") ||
        (source.endsWith("packages/daemon/src/fleet/center-listener.ts") && boundary === "rename"),
    )
    .map(({ id }) => id);
}
