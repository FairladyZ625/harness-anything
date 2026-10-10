// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "@harness-anything/kernel";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { definition, initHarnessRepo, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

test(
  "Fleet rejects a missing or retired Schedule Agent before leaving an active claim",
  { timeout: 60_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-fleet-agent-")),
      repo = path.join(root, "center-repo"),
      userRoot = path.join(root, "center-user"),
      stateRoot = path.join(root, "center-state"),
      keyFile = path.join(root, "tls.key"),
      certFile = path.join(root, "tls.crt"),
      repoId = "schedule-fleet-agent",
      scheduleId = "missing-agent-schedule",
      subject = {
        nodeId: "edge-one",
        repoId,
      };
    let center: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      host: Awaited<ReturnType<typeof openDaemonHost>> | null = null,
      edge: ReturnType<typeof openFleetEdgeRuntime> | null = null;
    try {
      initHarnessRepo(repo, "schedule-fleet-agent-center");
      registerDaemonRepo({
        canonicalRoot: repo,
        repoId,
        mode: "remote-center",
        userRoot,
        createConvenienceLinks: false,
      });
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
      const runtimeInstallation = {
        installationId: definition.installationId,
        kindId: definition.kindId,
        executablePath: process.execPath,
        version: "fixture",
        observedAt: "2026-09-12T00:00:00.000Z",
      } as const;
      await openRuntimeInstanceStore({ userRoot, discover: () => [runtimeInstallation] }).command({
        kind: "runtime-instance-create",
        instanceId: definition.instanceId,
        name: "Schedule Codex",
        kindId: definition.kindId,
        installationId: definition.installationId,
        providerId: definition.providerId,
        models: [definition.model],
        authMode: "subscription",
      });
      host = await openDaemonHost({
        daemonId: "schedule-fleet-agent-center",
        userRoot,
        runtimeDiscover: () => [runtimeInstallation],
      });
      await host.attachmentsSettled();
      const owners = await fleetNodeOwners({ userRoot, owners: { "edge-one": "operator-one" }, repoIds: [repoId] });
      // Retire an installed Agent before the center starts holding the writer epoch.
      owners.signIn(userRoot, "edge-one");
      const retiredAgentId = "retired-schedule-agent";
      const installed = await host.run(
        repoId,
        {
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id: retiredAgentId,
            name: "Retired Schedule Agent",
            instructions: "Never receives a Schedule claim after retirement.",
            runtimes: [{ type: "codex" }],
          },
          expectedVersion: 0,
          idempotencyKey: "retired-agent-install",
        },
        localAuthFixture(),
      );
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
      const retired = await host.run(
        repoId,
        {
          kind: "agent-retire",
          agentId: retiredAgentId,
          reason: "Retired before its Schedule claims.",
          idempotencyKey: "retired-agent-retire",
        },
        localAuthFixture(),
      );
      assert.equal(retired.outcome, "applied", JSON.stringify(retired));
      const certificate = readFileSync(certFile);
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
      const workspaceRoot = path.join(root, "edge-workspace"),
        viewRoot = path.join(root, "edge-view");
      initHarnessRepo(workspaceRoot, "schedule-fleet-agent-edge");
      edge = openFleetEdgeRuntime({
        readBinding: () => owners.binding(subject.nodeId),
        request: {
          host: "127.0.0.1",
          port: center.port,
          caPath: certFile,
          servername: "localhost",
          nodeId: subject.nodeId,
          credential: `credential-${subject.nodeId}`,
          repoId,
          viewRoot,
          quotaBytes: 64 * 1024 * 1024,
          workspaceRoot,
          method: "repo.schedule.run",
          action: {},
        },
        daemonGeneration: 1,
        daemonRoute: {
          userRoot: path.join(root, "edge-user"),
          daemonId: "schedule-fleet-agent-edge",
          endpoint: path.join(root, "edge-user", "daemon.sock"),
        },
        ports: scheduleRuntimePorts(),
        launch: () => {
          throw new Error("missing Schedule Agent must not launch");
        },
      });
      const created = await edge.run("repo.schedule.run", {
        kind: "schedule-create",
        scheduleId,
        name: "Missing agent schedule",
        mode: "detect",
        everyMs: 300_000,
        agentId: "missing-agent",
        mission: "This must be rejected before claim publication.",
        idempotencyKey: "missing-agent-create",
      });
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const rejected = await edge.run("repo.schedule.run", {
        kind: "schedule-run-now",
        scheduleId,
        idempotencyKey: "missing-agent-run",
      });
      assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
      assert.equal((rejected.error as { readonly code?: string } | undefined)?.code, "schedule_agent_unavailable");
      const shown = await edge.run("repo.schedule.run", { kind: "schedule-show", scheduleId });
      assert.equal((shown.schedule as { readonly status: { readonly activeRun: unknown } }).status.activeRun, null);

      // A retired Agent is refused at the same center claim, before any dispatch, and the Schedule stays idle.
      const retiredScheduleId = "retired-agent-schedule";
      const retiredCreated = await edge.run("repo.schedule.run", {
        kind: "schedule-create",
        scheduleId: retiredScheduleId,
        name: "Retired agent schedule",
        mode: "detect",
        everyMs: 300_000,
        agentId: retiredAgentId,
        mission: "This must be rejected at claim because the Agent is retired.",
        idempotencyKey: "retired-agent-create",
      });
      assert.equal(retiredCreated.outcome, "applied", JSON.stringify(retiredCreated));
      const retiredRun = await edge.run("repo.schedule.run", {
        kind: "schedule-run-now",
        scheduleId: retiredScheduleId,
        idempotencyKey: "retired-agent-run",
      });
      assert.equal(retiredRun.outcome, "op_rejected", JSON.stringify(retiredRun));
      assert.equal((retiredRun.error as { readonly code?: string } | undefined)?.code, "agent_retired");
      const retiredShown = await edge.run("repo.schedule.run", {
        kind: "schedule-show",
        scheduleId: retiredScheduleId,
      });
      assert.equal(
        (retiredShown.schedule as { readonly status: { readonly activeRun: unknown } }).status.activeRun,
        null,
      );
    } finally {
      edge?.close();
      await center?.close();
      await host?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
