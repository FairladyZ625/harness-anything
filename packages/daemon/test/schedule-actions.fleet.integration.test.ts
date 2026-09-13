// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "../../kernel/src/index.ts";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { listenFleetTls, type FleetAssignmentRecord } from "../src/fleet/center.ts";
import { definition, initHarnessRepo, pullScheduleView, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

test(
  "Fleet Schedule forwarding fences a stale disabled view and lets only one edge launch",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-schedule-fleet-")),
      repo = path.join(root, "center-repo"),
      userRoot = path.join(root, "center-user"),
      stateRoot = path.join(root, "center-state"),
      keyFile = path.join(root, "tls.key"),
      certFile = path.join(root, "tls.crt"),
      repoId = "schedule-fleet",
      scheduleId = "e2e-probe",
      assignments: FleetAssignmentRecord[] = ["one", "two"].map((suffix) => ({
        nodeId: `edge-${suffix}`,
        assignmentId: `schedule-assignment-${suffix}`,
        repoId,
        viewId: `schedule-view-${suffix}`,
        scope: { kind: "schedule", scheduleId, paths: ["agents", "schedules"] },
        expiresAt: "2099-01-01T00:00:00.000Z",
        actor: {
          principal: { personId: `operator-${suffix}` },
          executor: { kind: "agent", id: `edge-${suffix}` },
        },
      }));
    let center: Awaited<ReturnType<typeof listenFleetTls>> | null = null,
      host: Awaited<ReturnType<typeof openDaemonHost>> | null = null;
    const edgeRuntimes: ReturnType<typeof openFleetEdgeRuntime>[] = [];
    try {
      initHarnessRepo(repo, "schedule-center");
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
        daemonId: "schedule-center",
        userRoot,
        runtimeDiscover: () => [runtimeInstallation],
      });
      await host.attachmentsSettled();
      const assignmentAuth = { transportKind: "fleet-tls" as const, assignmentBinding: assignments[0]! };
      assert.equal(
        (
          await host.run(
            repoId,
            {
              kind: "agent-install",
              declaration: {
                schema: "agent-declaration/v1",
                id: "probe-agent",
                name: "Probe Agent",
                instructions: "Run the exact probe mission.",
                runtime_type: "codex",
                instance: definition.instanceId,
              },
            },
            assignmentAuth,
          )
        ).outcome,
        "applied",
      );
      const certificate = readFileSync(certFile),
        byId = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]));
      center = await listenFleetTls({
        host,
        stateRoot,
        key: readFileSync(keyFile),
        cert: certificate,
        replicaDiskQuotaBytes: 64 * 1024 * 1024,
        authenticate: (nodeId, credential) => credential === `credential-${nodeId}`,
        resolveAssignment: (assignmentId) => byId.get(assignmentId) ?? null,
      });
      const launches = [0, 0],
        workspaces = assignments.map((assignment, index) => {
          const workspaceRoot = path.join(root, `edge-${index + 1}`),
            viewRoot = path.join(root, `view-${index + 1}`);
          initHarnessRepo(workspaceRoot, `schedule-edge-${index + 1}`);
          const runtime = openFleetEdgeRuntime({
            request: {
              host: "127.0.0.1",
              port: center!.port,
              caPath: certFile,
              servername: "localhost",
              nodeId: assignment.nodeId,
              credential: `credential-${assignment.nodeId}`,
              assignmentId: assignment.assignmentId,
              repoId,
              viewRoot,
              quotaBytes: 64 * 1024 * 1024,
              workspaceRoot,
              method: "repo.schedule.run",
              action: {},
            },
            daemonGeneration: index + 1,
            daemonRoute: {
              userRoot: path.join(root, `edge-user-${index + 1}`),
              daemonId: `schedule-edge-${index + 1}`,
              endpoint: path.join(root, `edge-user-${index + 1}`, "daemon.sock"),
            },
            ports: scheduleRuntimePorts(),
            launch: () => {
              launches[index] += 1;
              return {
                pid: 4300 + index,
                onOutput: () => undefined,
                onErrorOutput: () => undefined,
                onExit: () => undefined,
                terminate: () => undefined,
              };
            },
          });
          edgeRuntimes.push(runtime);
          return { assignment, runtime, workspaceRoot, viewRoot };
        });
      const created = await workspaces[0]!.runtime.run("repo.schedule.run", {
        kind: "schedule-create",
        scheduleId,
        name: "E2E probe",
        mode: "detect",
        everyMs: 300_000,
        agentId: "probe-agent",
        runtimeInstanceId: definition.instanceId,
        mission: "Inspect the repository and report success.",
        idempotencyKey: "fleet-create",
      });
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const listed = await workspaces[0]!.runtime.run("repo.schedule.run", { kind: "schedule-list" });
      assert.equal(listed.outcome, "applied");
      assert.equal((listed.schedules as readonly unknown[] | undefined)?.length, 1);
      await pullScheduleView(workspaces[1]!, center.port, certificate);
      assert.match(
        readFileSync(path.join(workspaces[1]!.workspaceRoot, "harness/schedules/e2e-probe.json"), "utf8"),
        /"state": "armed"/u,
      );
      assert.equal(
        (
          await workspaces[0]!.runtime.run("repo.schedule.run", {
            kind: "schedule-disable",
            scheduleId,
            idempotencyKey: "fleet-disable",
          })
        ).outcome,
        "applied",
      );
      const stale = await workspaces[1]!.runtime.run("repo.schedule.run", {
        kind: "schedule-run-now",
        scheduleId,
        idempotencyKey: "stale-disabled-claim",
      });
      assert.equal(stale.outcome, "op_rejected");
      assert.equal((stale.error as { code?: string } | undefined)?.code, "schedule_paused");
      assert.deepEqual(launches, [0, 0]);
      assert.equal(
        (
          await workspaces[0]!.runtime.run("repo.schedule.run", {
            kind: "schedule-enable",
            scheduleId,
            idempotencyKey: "fleet-enable",
          })
        ).outcome,
        "applied",
      );
      const raced = await Promise.all(
        workspaces.map((edge, index) =>
          edge.runtime.run("repo.schedule.run", {
            kind: "schedule-run-now",
            scheduleId,
            idempotencyKey: `dual-edge-${index + 1}`,
          }),
        ),
      );
      assert.deepEqual(raced.map((receipt) => receipt.outcome).sort(), ["applied", "op_rejected"]);
      assert.equal(launches[0] + launches[1], 1);
      const winner = raced.findIndex((receipt) => receipt.outcome === "applied"),
        loser = winner === 0 ? 1 : 0;
      assert.equal(launches[winner], 1);
      assert.equal(launches[loser], 0);
      assert.equal((raced[loser]!.error as { code?: string } | undefined)?.code, "schedule_single_flight_active");
      const localAuth = {
          transportKind: "unix-socket" as const,
          unixSocketOwnerBoundary: {
            ownerUid: process.getuid?.() ?? 0,
            source: "unix-socket-filesystem-owner-boundary" as const,
          },
        },
        centerLocal = await host.run(
          repoId,
          { kind: "schedule-run-now", scheduleId, idempotencyKey: "center-local-rejected" },
          localAuth,
        );
      assert.equal(centerLocal.outcome, "op_rejected");
    } finally {
      for (const runtime of edgeRuntimes) runtime.close();
      await center?.close();
      await host?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
