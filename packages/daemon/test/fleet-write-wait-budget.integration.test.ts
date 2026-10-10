// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { registerDaemonRepo } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { initHarnessRepo, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

// A mutating center round trip settles when the single-writer queue applies the operation, so the
// edge's write sessions carry the configured center wait budget instead of the read path's flat
// transport deadline. This pins that contract: a center whose write admission stalls for six
// seconds — longer than the 5s read deadline the write clients previously inherited — must not
// fail the edge write. The stall's wall time is asserted so the injection cannot silently stop
// exercising the wait.
test("edge write round trips wait out a briefly stalled center", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-write-wait-")),
    repo = path.join(root, "center-repo"),
    userRoot = path.join(root, "center-user"),
    stateRoot = path.join(root, "center-state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    repoId = "fleet-write-wait",
    nodeId = "edge-one";
  let center: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
    host: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
    edge: ReturnType<typeof openFleetEdgeRuntime> | null = null;
  try {
    initHarnessRepo(repo, "fleet-write-wait-center");
    registerDaemonRepo({ canonicalRoot: repo, repoId, mode: "remote-center", userRoot, createConvenienceLinks: false });
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
    host = await openDaemonHost({ daemonId: "fleet-write-wait-center", userRoot });
    await host.attachmentsSettled();
    const owners = await fleetNodeOwners({ userRoot, owners: { [nodeId]: "operator-one" }, repoIds: [repoId] });
    initHarnessRepo(path.join(root, "edge-workspace"), "fleet-write-wait-edge");
    // The edge pulls before its first command, so the center needs one published cut: warm the
    // ledger with an unstalled local write before any fleet session exists.
    signInPolicyTestUser(userRoot, "operator-one", [repoId], "admin");
    const warmed = await host.run(
      repoId,
      {
        kind: "schedule-create",
        scheduleId: "warmup-schedule",
        name: "Warmup schedule",
        mode: "detect",
        everyMs: 300_000,
        agentId: "missing-agent",
        mission: "Publish the first center cut before the edge pulls.",
        idempotencyKey: "warmup-write-create",
      },
      localAuthFixture(),
    );
    assert.equal(warmed.outcome, "applied", JSON.stringify(warmed));
    let stalledOnce = false;
    const stalledWrite = async (action: unknown): Promise<void> => {
      if (
        !stalledOnce &&
        (action as { readonly kind?: unknown; readonly scheduleId?: unknown }).kind === "schedule-create" &&
        (action as { readonly scheduleId?: unknown }).scheduleId === "stalled-write-schedule"
      ) {
        stalledOnce = true;
        await new Promise((resolve) => setTimeout(resolve, 6_000));
      }
    };
    center = await listenFleetTls({
      host: {
        ...host,
        run: async (...args: Parameters<typeof host.run>) => {
          await stalledWrite(args[1]);
          return host!.run(...args);
        },
      },
      stateRoot,
      key: readFileSync(keyFile),
      cert: readFileSync(certFile),
      replicaDiskQuotaBytes: 64 * 1024 * 1024,
      authenticate: (node, credential) => credential === `credential-${node}`,
      nodeOwner: owners.nodeOwner,
    });
    const workspaceRoot = path.join(root, "edge-workspace");
    edge = openFleetEdgeRuntime({
      request: {
        host: "127.0.0.1",
        port: center.port,
        caPath: certFile,
        servername: "localhost",
        nodeId,
        credential: `credential-${nodeId}`,
        repoId,
        viewRoot: path.join(root, "edge-view"),
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot,
        method: "repo.schedule.run",
        action: {},
      },
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(root, "edge-user"),
        daemonId: "fleet-write-wait-edge",
        endpoint: path.join(root, "edge-user", "daemon.sock"),
      },
      ports: scheduleRuntimePorts(),
      launch: () => {
        throw new Error("the write-budget probe must not launch a runtime");
      },
    });
    const stalledStarted = performance.now(),
      created = await edge.run("repo.schedule.run", {
        kind: "schedule-create",
        scheduleId: "stalled-write-schedule",
        name: "Stalled write schedule",
        mode: "detect",
        everyMs: 300_000,
        agentId: "missing-agent",
        mission: "The write must outwait the stall.",
        idempotencyKey: "stalled-write-create",
      }),
      stalledElapsedMs = performance.now() - stalledStarted;
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.ok(stalledElapsedMs >= 6_000, `the stalled write returned in ${stalledElapsedMs.toFixed(0)}ms`);
    const control = await edge.run("repo.schedule.run", {
      kind: "schedule-create",
      scheduleId: "control-write-schedule",
      name: "Control write schedule",
      mode: "detect",
      everyMs: 300_000,
      agentId: "missing-agent",
      mission: "An unstalled write applies as before.",
      idempotencyKey: "control-write-create",
    });
    assert.equal(control.outcome, "applied", JSON.stringify(control));
  } finally {
    edge?.close();
    await center?.close();
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
