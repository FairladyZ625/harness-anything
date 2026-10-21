// harness-test-tier: integration
// TC-FLEET-CHAOS-02 (design: harness/tasks/task_0f452959ff91b5dcaa78604f61-fleet/artifacts/
// fleet-concurrency-test-design.md §3.2): two edge nodes release their claims for the same Schedule
// occurrence through one barrier; the center's single write queue must admit exactly one holder,
// reject the other, and never mint a second claim fence. A retry of the winner's own idempotency
// key is the *same* occurrence, so it replays the winning receipt instead of claiming again.
//
// Both edges speak the production edge write port (runFleetScheduleCommandClient), the same call
// fleet-edge-runtime's schedule ingress makes. The center is registered `remote-center`, so a won
// claim is not dispatched here; the subject under test is the claim itself.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { makeTaskEventReader, type ScheduleEventV1 } from "@harness-anything/kernel";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import { definition, initHarnessRepo } from "./schedule-actions.fixtures.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls, type FleetTlsCenter } from "../src/fleet/center.ts";
import { runFleetScheduleCommandClient } from "../src/fleet/peer.ts";

const repoId = "schedule-claim-race",
  scheduleId = "claim-race",
  scheduledFor = "2026-10-21T18:00:00.000Z",
  // The scheduler's own occurrence key: both nodes wake for the same tick, so the key matches.
  occurrenceKey = `schedule-timer:${repoId}:${scheduleId}:${scheduledFor}`;

type ClaimResult = Awaited<ReturnType<typeof runFleetScheduleCommandClient>>;

test(
  "two edges claim one Schedule occurrence concurrently and exactly one holds it",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await claimRaceFixture(t),
      before = fixture.eventCount(),
      gate = Promise.withResolvers<void>(),
      claims = [
        claimAfter(gate.promise, fixture, "edge-alpha", occurrenceKey),
        claimAfter(gate.promise, fixture, "edge-beta", occurrenceKey),
      ];
    gate.resolve();
    const [alpha, beta] = await Promise.all(claims);

    // Strict exclusivity: one applied, one rejected for single flight. Neither outcome may be
    // "applied" twice, and the loser must carry a code the edge runtime can act on.
    const results = [
        { nodeId: "edge-alpha", result: alpha },
        { nodeId: "edge-beta", result: beta },
      ],
      winners = results.filter(({ result }) => result.outcome === "applied"),
      losers = results.filter(({ result }) => result.outcome !== "applied");
    assert.equal(winners.length, 1, JSON.stringify(results.map(({ nodeId, result }) => [nodeId, result])));
    assert.equal(losers.length, 1, JSON.stringify(results.map(({ nodeId, result }) => [nodeId, result])));
    assert.equal(losers[0]!.result.outcome, "op_rejected");
    assert.equal(
      losers[0]!.result.code,
      "schedule_single_flight_active",
      "the loser is told the occurrence is taken, not handed a generic failure",
    );

    // The holder the winner observed is the node that actually claimed: no cross-node claim.
    const winner = winners[0]!,
      claimed = activeRun(winner.result);
    assert.equal(claimed.nodeId, winner.nodeId, "the recorded holder is the node that won");
    assert.match(claimed.claimFence, /^claim_[0-9a-f]{24}$/u);
    // The center rewrites the action's idempotency key to the frame opId, and an edge's opId is
    // derived from repo+nodeId+key. Two different edges therefore derive *different* occurrence ids
    // for the same tick; what prevents a second live run is single flight on the Schedule, not
    // occurrence identity. Pin that: the ids differ, yet only one holder exists.
    const perEdge = expectedOccurrenceIds();
    assert.equal(new Set(Object.values(perEdge)).size, 2, "two edges derive two occurrence ids");
    assert.equal(claimed.occurrenceId, perEdge[winner.nodeId], "the winner holds its own derived occurrence");

    // One canonical claim event, not two: a losing attempt writes no schedule event.
    assert.equal(fixture.eventCount(), before + 1, "the race appended exactly one canonical event");
    assert.deepEqual(fixture.claimEvents(), [claimed.claimFence]);

    // Idempotent replay of the winner's own key: same occurrence, same fence, still one event.
    const replay = await fixture.claim(winner.nodeId, occurrenceKey);
    assert.equal(replay.outcome, "applied", JSON.stringify(replay));
    assert.equal(activeRun(replay).claimFence, claimed.claimFence, "a retry replays the winning fence");
    assert.equal(fixture.eventCount(), before + 1, "a replayed claim appends nothing");
  },
);

test(
  "a losing edge's retry with its own key is still refused while the winner holds the occurrence",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await claimRaceFixture(t);
    const winner = await fixture.claim("edge-alpha", occurrenceKey),
      fence = activeRun(winner).claimFence,
      heldEvents = fixture.eventCount();
    // A different idempotency key is a different occurrence, but single flight counts occurrences of
    // the Schedule, so the second attempt must not start work next to the live one.
    const retried = await fixture.claim("edge-beta", `${occurrenceKey}:retry`);
    assert.equal(retried.outcome, "op_rejected", JSON.stringify(retried));
    assert.equal(retried.code, "schedule_single_flight_active");
    assert.equal(fixture.eventCount(), heldEvents, "a refused claim appends no event");
    assert.deepEqual(fixture.claimEvents(), [fence]);
  },
);

function claimAfter(
  gate: Promise<void>,
  fixture: Awaited<ReturnType<typeof claimRaceFixture>>,
  nodeId: string,
  key: string,
): Promise<ClaimResult> {
  return gate.then(() => fixture.claim(nodeId, key));
}

function activeRun(result: ClaimResult): {
  readonly occurrenceId: string;
  readonly nodeId: string;
  readonly claimFence: string;
} {
  const run = (result.receipt as { readonly schedule?: { readonly status?: { readonly activeRun?: unknown } } })
    .schedule?.status?.activeRun as
    | { readonly occurrenceId: string; readonly nodeId: string; readonly claimFence: string }
    | null
    | undefined;
  assert.ok(run, JSON.stringify(result.receipt));
  return run;
}

/**
 * Per-edge occurrence ids as the center derives them. `runFleetScheduleCommandClient` sends the
 * frame opId, and the schedule ingress substitutes `{ ...frame.action, idempotencyKey: frame.opId }`
 * before compiling, so the domain hashes the caller's op id — which carries the node id.
 */
function expectedOccurrenceIds(): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const nodeId of ["edge-alpha", "edge-beta"]) {
    const opId = `schedule-${createHash("sha256").update(`${repoId}\0${nodeId}\0${occurrenceKey}`).digest("hex").slice(0, 32)}`,
      hash = createHash("sha256").update(`${scheduleId}\0scheduled\0${scheduledFor}\0${opId}`).digest("hex");
    ids[nodeId] = `occurrence_${hash.slice(0, 24)}`;
  }
  return ids;
}

async function claimRaceFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-claim-race-")),
    repo = path.join(root, "center-repo"),
    userRoot = path.join(root, "center-user"),
    stateRoot = path.join(root, "center-state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt");
  initHarnessRepo(repo, "schedule-claim-race");
  registerDaemonRepo({ canonicalRoot: repo, repoId, mode: "remote-center", userRoot, createConvenienceLinks: false });
  tlsCertificate(keyFile, certFile);
  const installation = {
      installationId: definition.installationId,
      kindId: definition.kindId,
      executablePath: process.execPath,
      version: "fixture",
      observedAt: "2026-10-21T00:00:00.000Z",
    },
    instances = openRuntimeInstanceStore({ userRoot, discover: () => [installation] });
  await instances.command({
    kind: "runtime-instance-create",
    instanceId: definition.instanceId,
    name: "Schedule Codex",
    kindId: definition.kindId,
    installationId: definition.installationId,
    providerId: definition.providerId,
    models: [definition.model],
    authMode: "subscription",
  });
  const host = await openDaemonHost({
      daemonId: "schedule-claim-race",
      userRoot,
      runtimeDiscover: () => [installation],
    }),
    owners = await fleetNodeOwners({
      userRoot,
      owners: { "edge-alpha": "person-alpha", "edge-beta": "person-beta" },
      repoIds: [repoId],
    }),
    certificate = readFileSync(certFile);
  let center: FleetTlsCenter | null = null;
  t.after(async () => {
    try {
      await center?.close();
    } finally {
      try {
        await host.close();
      } finally {
        await owners.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  await host.attachmentsSettled();
  const installed = await host.run(
    repoId,
    {
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "race-agent",
        name: "Race Agent",
        instructions: "Claim the occurrence but never run in this fixture.",
        runtimes: [{ type: "codex" }],
        instance: definition.instanceId,
      },
    },
    owners.auth({ nodeId: "edge-alpha" }),
  );
  assert.equal(installed.outcome, "applied", JSON.stringify(installed));
  center = await listenFleetTls({
    host,
    stateRoot,
    key: readFileSync(keyFile),
    cert: certificate,
    replicaDiskQuotaBytes: 64 * 1024 * 1024,
    authenticate: (nodeId, credential) => credential === `credential-${nodeId}`,
    nodeOwner: owners.nodeOwner,
    verifyHuman: owners.verifyHuman,
  });
  const created = await host.run(
    repoId,
    {
      kind: "schedule-create",
      scheduleId,
      name: "Claim race",
      mode: "detect",
      everyMs: 300_000,
      agentId: "race-agent",
      mission: "Occupy the single-flight slot.",
      idempotencyKey: "race-create",
    },
    owners.auth({ nodeId: "edge-alpha" }),
  );
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  const claim = async (nodeId: string, key: string): Promise<ClaimResult> =>
    runFleetScheduleCommandClient({
      port: center!.port,
      ca: certificate,
      servername: "localhost",
      nodeId,
      credential: `credential-${nodeId}`,
      readAccessToken: owners.readAccessToken(nodeId),
      opId: scheduleOpId(nodeId, key),
      repoId,
      scheduleId,
      action: { kind: "schedule-run-now", scheduleId, scheduledFor, idempotencyKey: key },
    });
  return {
    claim,
    eventCount: () => makeTaskEventReader({ rootDir: repo, repoId }).read().events.length,
    claimEvents: () =>
      makeTaskEventReader({ rootDir: repo, repoId })
        .read()
        .events.filter(
          (event): event is ScheduleEventV1 =>
            event.schema === "schedule-event/v1" && event.type === "schedule_occurrence_claimed",
        )
        .map((event) => event.payload.schedule.status.activeRun?.claimFence ?? ""),
  };
}

/** fleet-edge-runtime's own op id derivation, so a retry by the same node reuses its receipt. */
function scheduleOpId(nodeId: string, key: string): string {
  return `schedule-${createHash("sha256").update(`${repoId}\0${nodeId}\0${key}`).digest("hex").slice(0, 32)}`;
}

function tlsCertificate(keyFile: string, certFile: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
}
