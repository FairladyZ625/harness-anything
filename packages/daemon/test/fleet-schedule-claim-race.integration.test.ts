// harness-test-tier: integration
// TC-FLEET-CHAOS-02 (design: harness/tasks/task_0f452959ff91b5dcaa78604f61-fleet/artifacts/
// fleet-concurrency-test-design.md §3.2): two edge nodes release their claims for the same Schedule
// occurrence through one barrier; the center's single write queue must admit exactly one holder,
// reject the other, and never mint a second claim fence. The frame opId is each request's own
// random correlation id; the occurrence business key rides action.idempotencyKey. A retry with the
// winner's own business key is the *same* occurrence, so it replays the winning receipt instead of
// claiming again. Reusing a frame opId under a different business key must not replay anything:
// the transport id is not a business dedup key.
//
// Both edges speak the production edge write port (runFleetScheduleCommandClient), the same call
// fleet-edge-runtime's schedule ingress makes. The center is registered `remote-center`, so a won
// claim is not dispatched here; the subject under test is the claim itself.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { type ScheduleEventV1 } from "@harness-anything/kernel";
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
      alphaOpId = randomUUID(),
      betaOpId = randomUUID(),
      claims = [
        claimAfter(gate.promise, fixture, "edge-alpha", occurrenceKey, alphaOpId),
        claimAfter(gate.promise, fixture, "edge-beta", occurrenceKey, betaOpId),
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
      winnerOpId = winner.nodeId === "edge-alpha" ? alphaOpId : betaOpId,
      claimed = activeRun(winner.result);
    assert.equal(claimed.nodeId, winner.nodeId, "the recorded holder is the node that won");
    assert.match(claimed.claimFence, /^claim_[0-9a-f]{24}$/u);
    // Both requests carry their own random correlation id (never a repo/schedule/session string),
    // while the occurrence business key is action.idempotencyKey. The center therefore derives one
    // occurrence identity for the tick; single flight, not occurrence identity, rejects the loser.
    assert.notEqual(alphaOpId, betaOpId, "each request has its own operation id");
    for (const opId of [alphaOpId, betaOpId]) {
      assert.match(opId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      assert.equal(opId.includes(repoId) || opId.includes(scheduleId) || opId.includes(occurrenceKey), false);
    }
    const expected = expectedOccurrenceId(occurrenceKey);
    assert.equal(
      claimed.occurrenceId,
      expected,
      "both edges carry the same business key, so the center derives one occurrence",
    );

    // One canonical claim event, not two: a losing attempt writes no schedule event.
    assert.equal(fixture.eventCount(), before + 1, "the race appended exactly one canonical event");
    assert.deepEqual(fixture.claimEvents(), [claimed.claimFence]);

    // Idempotent replay of the winner's own key: same action content, same occurrence, same fence.
    const replay = await fixture.claim(winner.nodeId, occurrenceKey, winnerOpId);
    assert.equal(replay.outcome, "applied", JSON.stringify(replay));
    assert.equal(activeRun(replay).claimFence, claimed.claimFence, "a retry replays the winning fence");
    assert.equal(fixture.eventCount(), before + 1, "a replayed claim appends nothing");

    // Reusing the same frame opId for a different business intent is a different request. If the
    // center still used frame.opId as the business key it would replay the winner's applied
    // receipt; it must instead reach the Schedule single-flight check and reject.
    const reused = await fixture.claim(winner.nodeId, `${occurrenceKey}:different-intent`, winnerOpId);
    assert.equal(reused.outcome, "op_rejected", JSON.stringify(reused));
    assert.equal(reused.code, "schedule_single_flight_active");
    assert.equal(fixture.eventCount(), before + 1, "a different intent under the same frame opId appends nothing");
  },
);

test(
  "a losing edge's retry with its own key is still refused while the winner holds the occurrence",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await claimRaceFixture(t);
    const winner = await fixture.claim("edge-alpha", occurrenceKey, randomUUID()),
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

test(
  "a schedule frame without the caller's business key is rejected instead of borrowing the request id",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await claimRaceFixture(t);
    await assert.rejects(
      fixture.command("edge-alpha", { kind: "schedule-run-now", scheduleId, scheduledFor }, randomUUID()),
      (error: unknown) => (error as { readonly code?: unknown }).code === "invalid_field",
    );
  },
);

function claimAfter(
  gate: Promise<void>,
  fixture: Awaited<ReturnType<typeof claimRaceFixture>>,
  nodeId: string,
  key: string,
  opId: string,
): Promise<ClaimResult> {
  return gate.then(() => fixture.claim(nodeId, key, opId));
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
 * The occurrence id the center derives from the caller's business key. The frame opId is not part
 * of this hash: it correlates the request, and the same tick key from two edges names one occurrence.
 */
function expectedOccurrenceId(key: string): string {
  const hash = createHash("sha256").update(`${scheduleId}\0scheduled\0${scheduledFor}\0${key}`).digest("hex");
  return `occurrence_${hash.slice(0, 24)}`;
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
  const owners = await fleetNodeOwners({
      userRoot,
      owners: { "edge-alpha": "person-alpha", "edge-beta": "person-beta" },
      repoIds: [repoId],
    }),
    host = await openDaemonHost({
      daemonId: "schedule-claim-race",
      userRoot,
      runtimeDiscover: () => [installation],
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
  const command = (nodeId: string, action: Readonly<Record<string, unknown>>, opId: string): Promise<ClaimResult> =>
      runFleetScheduleCommandClient({
        port: center!.port,
        ca: certificate,
        servername: "localhost",
        nodeId,
        credential: `credential-${nodeId}`,
        readAccessToken: owners.readAccessToken(nodeId),
        opId,
        repoId,
        scheduleId,
        action: action as { readonly kind: string } & Readonly<Record<string, unknown>>,
      }),
    claim = (nodeId: string, key: string, opId = randomUUID()): Promise<ClaimResult> =>
      command(nodeId, { kind: "schedule-run-now", scheduleId, scheduledFor, idempotencyKey: key }, opId);
  return {
    claim,
    command,
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
