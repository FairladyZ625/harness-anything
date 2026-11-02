// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { openNodeAutoClaimLoop } from "../src/node-auto-claim.ts";
import { readNodeAutoClaimDiagnostics, writeNodeAutoClaimPolicy } from "../src/node-auto-claim-config.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { eventually } from "./fixtures/runtime-ingress.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";

test("two same-owner nodes auto-claim through one canonical task lease", { timeout: 60_000 }, async (t) => {
  const fixture = await fleetNodeClaimFixture(t),
    userRoots = ["node-one", "node-two"].map((nodeId) => mkdtempSync(path.join(tmpdir(), `ha-auto-claim-${nodeId}-`))),
    taskId = "task-auto-claim-race";
  t.after(() => userRoots.forEach((userRoot) => rmSync(userRoot, { recursive: true, force: true })));
  assert.equal(
    (await fixture.command("node-one", { kind: "settings-update", fleetClaimScope: "reserved" })).outcome,
    "applied",
  );
  assert.equal(
    (await fixture.command("node-one", { kind: "task-create", taskId, title: "Auto-claim race" })).outcome,
    "applied",
  );
  const shown = await fixture.host.run("lease-repo", { kind: "task-show", taskId }, localAuthFixture()),
    snapshot = JSON.parse(String(shown.evidence)),
    expiresAt = new Date(Date.now() + 60_000).toISOString(),
    assigned = await fixture.command("node-one", {
      kind: "task-assign",
      taskId,
      personId: "person-one",
      expiresAt,
      expectedVersion: snapshot.revision,
    });
  assert.equal(assigned.outcome, "applied", JSON.stringify(assigned));

  for (const userRoot of userRoots)
    writeNodeAutoClaimPolicy(userRoot, {
      schema: "node-auto-claim/v1",
      enabled: true,
      allowedSources: { personIds: [], teamIds: [] },
      allowedAgentIds: ["auto-agent"],
      maxConcurrent: 1,
    });

  const started: { readonly nodeId: string; readonly outcome: string; readonly code?: string }[] = [];
  const claimCommands: Promise<Awaited<ReturnType<typeof fixture.command>>>[] = [];
  const loops = ["node-one", "node-two"].map((nodeId, index) =>
    openNodeAutoClaimLoop({
      userRoot: userRoots[index]!,
      now: () => new Date().toISOString(),
      ownerPersonIdFor: async () => "person-one",
      repos: () => ["lease-repo"],
      repoIdOf: (repo) => repo,
      candidates: async () => {
        const result = await fixture.host.read(
          "lease-repo",
          "repo.tasks.claimable",
          {},
          fixture.owners.auth({ nodeId }),
        );
        return result.tasks;
      },
      taskIdOf: (candidate) => candidate.taskId,
      assignmentOf: async (candidate) =>
        candidate.taskId === taskId
          ? { taskId, workspaceRevision: 1, expiresAt, assignedByPersonId: "person-one", assignedByTeamIds: [] }
          : null,
      activeTaskKeys: async () => [],
      agentIds: () => ["auto-agent"],
      claimAndRun: async (_repo, candidate) => {
        const command = fixture.command(nodeId, {
          kind: "task-start",
          taskId: candidate.taskId,
          executionId: `execution-${nodeId}`,
        });
        claimCommands.push(command);
        const receipt = await command;
        started.push({ nodeId, outcome: String(receipt.outcome), ...(receipt.code ? { code: receipt.code } : {}) });
      },
    }),
  );
  try {
    const candidates = await Promise.all(
      ["node-one", "node-two"].map((nodeId) =>
        fixture.host.read("lease-repo", "repo.tasks.claimable", {}, fixture.owners.auth({ nodeId })),
      ),
    );
    assert.deepEqual(
      candidates.map((result) => result.tasks.map((task) => task.taskId)),
      [[taskId], [taskId]],
    );
    await Promise.all(loops.map((loop) => loop.trigger("same-replica-candidate")));
    await Promise.all(claimCommands);
    assert.equal(started.filter((row) => row.outcome === "applied").length, 1, JSON.stringify(started));
    assert.equal(started.filter((row) => row.code === "lease_conflict").length, 1, JSON.stringify(started));
    const task = await fixture.host.run("lease-repo", { kind: "task-show", taskId }, localAuthFixture());
    assert.equal(JSON.parse(String(task.evidence)).lease.phase, "held");
  } finally {
    await Promise.all(loops.map((loop) => loop.close()));
  }
});

test(
  "production edge hosts enforce source policy and expiry, then run assigned work through Fleet settlement",
  { timeout: 180_000 },
  async (t) => {
    const installation: RuntimeInstallationWitness = {
        installationId: "auto-claim-codex-installation",
        kindId: "codex",
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-11-02T00:00:00.000Z",
      },
      fixture = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true, {
        runtimeDiscover: () => [installation],
      }),
      localAuth = localAuthFixture(),
      runtime = {
        instanceId: "auto-claim-codex",
        name: "Auto Claim Codex",
        kindId: installation.kindId,
        installationId: installation.installationId,
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        codex: { reasoningEffort: "medium" },
        authMode: "subscription",
      },
      launches: Array<{
        readonly taskId: string;
        readonly ready: Promise<void>;
        finish: () => Promise<void>;
        readonly child: ChildProcess;
      }> = [];
    const vertical = await fixture.host.run("lease-repo", { kind: "vertical-declaration-migrate" }, localAuth);
    assert.equal(vertical.outcome, "applied", JSON.stringify(vertical));
    t.after(async () => {
      await Promise.allSettled(launches.map((launch) => launch.finish()));
    });
    const runtimeLaunch = (
      prepared: Parameters<NonNullable<Parameters<typeof fleetEdgeHostFixture>[2]["runtimeLaunch"]>>[0],
    ) => {
      let output: ((chunk: string) => void) | undefined,
        exit: ((code: number | null) => void) | undefined,
        finishing: Promise<void> | null = null,
        readyResolve!: () => void,
        outputReady = false,
        exitReady = false;
      const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      const markReady = () => {
        if (outputReady && exitReady) readyResolve();
      };
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
        }),
        taskId = path.basename(prepared.cwd),
        launch = {
          taskId,
          ready,
          child,
          finish: () => {
            if (finishing) return finishing;
            finishing = (async () => {
              output?.(
                `${JSON.stringify({ type: "thread.started", thread_id: `auto-claim-${taskId}` })}\n` +
                  `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } })}\n` +
                  `${JSON.stringify({ type: "turn.completed" })}\n`,
              );
              if (!child.pid) throw new Error("fixture runtime process did not expose a pid");
              if (child.exitCode === null && child.signalCode === null) {
                const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
                child.kill("SIGTERM");
                await stopped;
              }
              exit?.(0);
            })();
            return finishing;
          },
        };
      if (!child.pid) throw new Error("fixture runtime process did not expose a pid");
      launches.push(launch);
      return {
        pid: child.pid,
        onOutput: (listener: (chunk: string) => void) => {
          output = listener;
          outputReady = true;
          markReady();
        },
        onErrorOutput: () => undefined,
        onExit: (listener: (code: number | null) => void) => {
          exit = listener;
          exitReady = true;
          markReady();
        },
        release: () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        },
        terminate: () => {
          void launch.finish();
        },
      };
    };
    const waitForLaunch = async (edge: Awaited<ReturnType<typeof fleetEdgeHostFixture>>, taskId: string) => {
      try {
        await eventually(() => launches.some((candidate) => candidate.taskId === taskId));
        await launches.find((candidate) => candidate.taskId === taskId)!.ready;
      } catch (error) {
        const detail = readNodeAutoClaimDiagnostics(edge.edgeUser).slice(-20),
          centerTask = await fixture.host.read(
            "lease-repo",
            "repo.tasks.runtimeContext.read",
            { taskId },
            fixture.owners.auth({ nodeId: "node-one" }),
          ),
          centerRuntime = await fixture.host.read(
            "lease-repo",
            "repo.agentRuntime.overview",
            { taskId },
            fixture.owners.auth({ nodeId: "node-one" }),
          );
        throw new Error(
          `waiting for ${taskId}: ${error instanceof Error ? error.message : String(error)}; ` +
            `auto-claim=${JSON.stringify(detail)}; lease=${JSON.stringify(centerTask.snapshot.lease)}; ` +
            `runtime=${JSON.stringify(centerRuntime.sessions)}`,
        );
      }
    };
    const createAssignedTask = async (
      taskId: string,
      assigner: "node-one" | "node-two",
      assigneeNode: "node-one" | "node-two",
      expiresAt = new Date(Date.now() + 3_600_000).toISOString(),
    ) => {
      const created = await fixture.command("node-one", { kind: "task-create", taskId, title: taskId });
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const shown = await fixture.host.run("lease-repo", { kind: "task-show", taskId }, localAuth),
        revision = Number(JSON.parse(String(shown.evidence)).revision),
        assigned = await fixture.command(assigner, {
          kind: "task-assign",
          taskId,
          nodeId: assigneeNode,
          expiresAt,
          expectedVersion: revision,
        });
      assert.equal(assigned.outcome, "applied", JSON.stringify(assigned));
    };
    const source = path.join(fixture.repo, "source", "edge-worker");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(source, "agent.json"),
      `${JSON.stringify({
        schema: "agent-declaration/v1",
        id: "edge-worker",
        name: "Edge Worker",
        instructions: "Complete the assigned task.",
        runtimes: [{ type: "codex" }],
        role: "worker",
      })}\n`,
    );
    await registerFixtureRuntimeInstance(fixture.host, "lease-repo", localAuth, runtime);
    const installed = await fixture.host.run(
      "lease-repo",
      { kind: "agent-install", packageSource: source, expectedVersion: 0, dispatchKey: "auto-claim-agent" },
      localAuth,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const tasks = {
      offline: "task-00-offline-same-owner",
      denied: "task-10-different-owner",
      expired: "task-20-expired",
      next: "task-40-next-after-terminal",
    };
    await createAssignedTask(tasks.offline, "node-two", "node-one");
    fixture.owners.reassign("node-two", "person-two");
    await createAssignedTask(tasks.denied, "node-two", "node-one");
    await createAssignedTask(tasks.expired, "node-two", "node-one", new Date(Date.now() + 30_000).toISOString());
    const edgeNow = new Date(Date.now() + 60_000).toISOString();

    const remote = path.join(fixture.root, "auto-claim-origin.git");
    execFileSync("git", ["-C", fixture.root, "clone", "--bare", "-q", fixture.repo, remote]);
    execFileSync("git", ["-C", fixture.repo, "remote", "add", "origin", remote]);
    execFileSync("git", ["-C", fixture.repo, "fetch", "-q", "origin"]);
    const branch = execFileSync("git", ["-C", fixture.repo, "branch", "--show-current"], { encoding: "utf8" }).trim(),
      setupEdgeGit = (edgeRoot: string) => {
        execFileSync("git", ["-C", edgeRoot, "remote", "add", "origin", remote]);
        execFileSync("git", ["-C", edgeRoot, "fetch", "-q", "origin"]);
        execFileSync("git", ["-C", edgeRoot, "branch", "--set-upstream-to", `origin/${branch}`]);
        execFileSync("git", ["-C", edgeRoot, "reset", "--hard", `origin/${branch}`]);
      },
      activeEdge = await fleetEdgeHostFixture(t, fixture, {
        name: "auto-claim-active-node",
        nodeId: "node-two",
        personId: "person-two",
        runtimeDiscover: () => [installation],
        runtimeLaunch,
        beforeOpen: setupEdgeGit,
      });
    const catchUpEdge = (edge: Awaited<ReturnType<typeof fleetEdgeHostFixture>>, nodeId: string) =>
      catchUpReplica({
        readAccessToken: async () => `device-token-${nodeId}`,
        port: fixture.center.port,
        ca: readFileSync(path.join(fixture.root, "tls.crt")),
        nodeId,
        credential: `secret-${nodeId}`,
        repoId: "lease-repo",
        viewRoot: edge.viewRoot,
        diskQuotaBytes: 64 * 1024 * 1024,
      });
    await registerFixtureRuntimeInstance(activeEdge.host, "lease-repo", localAuth, runtime, {
      allowHost: fixture.host,
    });

    const edge = await fleetEdgeHostFixture(t, fixture, {
      name: "auto-claim-node-one",
      nodeId: "node-one",
      now: () => edgeNow,
      runtimeDiscover: () => [installation],
      runtimeLaunch,
      beforeOpen: setupEdgeGit,
    });
    assert.equal(existsSync(path.join(edge.edgeUser, "rbac/config.json")), false);
    assert.equal(existsSync(path.join(edge.edgeUser, "rbac/center-client-secret")), false);
    assert.equal(existsSync(path.join(activeEdge.edgeUser, "rbac/config.json")), false);
    assert.equal(existsSync(path.join(activeEdge.edgeUser, "rbac/center-client-secret")), false);
    await registerFixtureRuntimeInstance(edge.host, "lease-repo", localAuth, runtime, { allowHost: fixture.host });
    await catchUpEdge(edge, "node-one");
    const configure = (allowedPersonIds: readonly string[], maxConcurrent = 1) =>
      edge.host.configureNodeAutoClaim(
        {
          schema: "node-auto-claim/v1",
          enabled: true,
          allowedSources: { personIds: [...allowedPersonIds], teamIds: [] },
          allowedAgentIds: ["edge-worker"],
          maxConcurrent,
        },
        localAuth,
      );

    try {
      await configure([], 2);
      await waitForLaunch(edge, tasks.offline);
      assert.deepEqual(
        launches.map((launch) => launch.taskId),
        [tasks.offline],
      );

      await createAssignedTask("task-a-node-runtime", "node-two", "node-two");
      await catchUpEdge(activeEdge, "node-two");
      const activeTask = await activeEdge.host.fleet.edgeRuntime(
        {
          ...activeEdge.config,
          workspaceRoot: activeEdge.edgeRoot,
          method: "repo.agentRuntime.spawn",
          action: {
            agentId: "edge-worker",
            taskId: "task-a-node-runtime",
            dispatchKey: "node-two-active-runtime",
          },
        },
        localAuth,
      );
      assert.equal(activeTask.outcome, "applied", JSON.stringify(activeTask));
      const otherNodeLease = await fixture.host.read(
        "lease-repo",
        "repo.tasks.runtimeContext.read",
        { taskId: "task-a-node-runtime" },
        fixture.owners.auth({ nodeId: "node-one" }),
      );
      assert.equal(
        otherNodeLease.snapshot.lease?.source && typeof otherNodeLease.snapshot.lease.source === "object"
          ? otherNodeLease.snapshot.lease.source.nodeId
          : null,
        "node-two",
      );
      await launches.find((launch) => launch.taskId === tasks.offline)!.finish();
      await eventually(async () => {
        const status = await edge.host.system(localAuth);
        const autoClaim = status.nodeAutoClaim as {
          readonly recent: readonly { readonly taskId: string | null; readonly reason: string }[];
        };
        return autoClaim.recent.some((row) => row.taskId === tasks.denied && row.reason === "source_not_allowed");
      });
      try {
        await eventually(async () => {
          const context = await fixture.host.read(
            "lease-repo",
            "repo.tasks.runtimeContext.read",
            { taskId: tasks.offline },
            fixture.owners.auth({ nodeId: "node-one" }),
          );
          return context.snapshot.lease === null || context.snapshot.lease.phase === "released";
        });
      } catch (error) {
        const context = await fixture.host.read(
            "lease-repo",
            "repo.tasks.runtimeContext.read",
            { taskId: tasks.offline },
            fixture.owners.auth({ nodeId: "node-one" }),
          ),
          overview = await fixture.host.read(
            "lease-repo",
            "repo.agentRuntime.overview",
            { taskId: tasks.offline },
            fixture.owners.auth({ nodeId: "node-one" }),
          );
        throw new Error(
          `offline lease did not settle: ${error instanceof Error ? error.message : String(error)}; ` +
            `context=${JSON.stringify(context.snapshot)}; overview=${JSON.stringify(overview.sessions)}; ` +
            `diagnostics=${JSON.stringify(readNodeAutoClaimDiagnostics(edge.edgeUser).slice(-20))}`,
        );
      }
      assert.equal(
        launches.some((launch) => launch.taskId === tasks.denied),
        false,
      );
      assert.equal(
        launches.some((launch) => launch.taskId === tasks.expired),
        false,
      );

      await eventually(async () => {
        const overview = await fixture.host.read(
          "lease-repo",
          "repo.agentRuntime.overview",
          { taskId: tasks.offline },
          fixture.owners.auth({ nodeId: "node-one" }),
        );
        return overview.sessions.some((session) => session.activity.outcome !== null);
      });
      await configure(["person-two"], 2);
      await waitForLaunch(edge, tasks.denied);
      assert.deepEqual(
        launches.map((launch) => launch.taskId),
        [tasks.offline, "task-a-node-runtime", tasks.denied],
        "B starts its own task while A's runtime is still active, without charging A's lease against B",
      );
      await launches.find((launch) => launch.taskId === "task-a-node-runtime")!.finish();
      await eventually(async () => {
        const overview = await fixture.host.read(
          "lease-repo",
          "repo.agentRuntime.overview",
          { taskId: "task-a-node-runtime" },
          fixture.owners.auth({ nodeId: "node-one" }),
        );
        return overview.sessions.some((session) => session.activity.outcome !== null);
      });
      await launches.find((launch) => launch.taskId === tasks.denied)!.finish();
      await eventually(async () => {
        const context = await fixture.host.read(
          "lease-repo",
          "repo.tasks.runtimeContext.read",
          { taskId: tasks.denied },
          fixture.owners.auth({ nodeId: "node-one" }),
        );
        return context.snapshot.lease === null || context.snapshot.lease.phase === "released";
      });
      await eventually(async () => {
        const overview = await fixture.host.read(
          "lease-repo",
          "repo.agentRuntime.overview",
          { taskId: tasks.denied },
          fixture.owners.auth({ nodeId: "node-one" }),
        );
        return overview.sessions.some((session) => session.activity.outcome !== null);
      });

      await configure(["person-two"], 1);
      await createAssignedTask(tasks.next, "node-one", "node-one");
      await catchUpEdge(edge, "node-one");
      await configure(["person-two"], 1);
      await waitForLaunch(edge, tasks.next);
      await createAssignedTask("task-50-waits-for-b-slot", "node-one", "node-one");
      await catchUpEdge(edge, "node-one");
      await configure(["person-two"], 1);
      assert.equal(
        launches.some((launch) => launch.taskId === "task-50-waits-for-b-slot"),
        false,
      );
      await launches.find((launch) => launch.taskId === tasks.next)!.finish();
      await waitForLaunch(edge, "task-50-waits-for-b-slot");
      let startedOnB: Awaited<ReturnType<typeof fixture.host.read>>;
      try {
        startedOnB = await fixture.host.read(
          "lease-repo",
          "repo.tasks.runtimeContext.read",
          { taskId: "task-50-waits-for-b-slot" },
          fixture.owners.auth({ nodeId: "node-one" }),
        );
      } catch (error) {
        throw new Error(`reading queued task lease failed: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
      assert.deepEqual(
        {
          phase: startedOnB.snapshot.lease?.phase,
          nodeId:
            startedOnB.snapshot.lease?.source && typeof startedOnB.snapshot.lease.source === "object"
              ? startedOnB.snapshot.lease.source.nodeId
              : null,
        },
        { phase: "held", nodeId: "node-one" },
        "Fleet terminal settlement released B's first lease and admitted the next assigned task",
      );
      await launches.find((launch) => launch.taskId === "task-50-waits-for-b-slot")!.finish();
      await eventually(async () => {
        const overview = await fixture.host.read(
          "lease-repo",
          "repo.agentRuntime.overview",
          { taskId: "task-50-waits-for-b-slot" },
          fixture.owners.auth({ nodeId: "node-one" }),
        );
        return overview.sessions.some((session) => session.activity.outcome !== null);
      });
      await catchUpEdge(edge, "node-one");
      await Promise.allSettled(launches.map((launch) => launch.finish()));
    } finally {
      await Promise.allSettled(launches.map((launch) => launch.finish()));
      await edge.host.close();
      await activeEdge.host.close();
    }
  },
);
