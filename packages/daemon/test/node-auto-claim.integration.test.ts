// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { openNodeAutoClaimLoop } from "../src/node-auto-claim.ts";
import { writeNodeAutoClaimPolicy } from "../src/node-auto-claim-config.ts";
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
          ? { taskId, expiresAt, assignedByPersonId: "person-one", assignedByTeamIds: [] }
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
      launches: Array<{ readonly taskId: string; finish: () => void }> = [];
    const vertical = await fixture.host.run("lease-repo", { kind: "vertical-declaration-migrate" }, localAuth);
    assert.equal(vertical.outcome, "applied", JSON.stringify(vertical));
    t.after(() => {
      for (const launch of launches) launch.finish();
    });
    const runtimeLaunch = (
      prepared: Parameters<NonNullable<Parameters<typeof fleetEdgeHostFixture>[2]["runtimeLaunch"]>>[0],
    ) => {
      let output: ((chunk: string) => void) | undefined,
        exit: ((code: number | null) => void) | undefined,
        finished = false;
      const taskId = path.basename(prepared.cwd),
        launch = {
          taskId,
          finish: () => {
            if (finished) return;
            finished = true;
            output?.(
              `${JSON.stringify({ type: "thread.started", thread_id: `auto-claim-${taskId}` })}\n` +
                `${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } })}\n` +
                `${JSON.stringify({ type: "turn.completed" })}\n`,
            );
            exit?.(0);
          },
        };
      launches.push(launch);
      return {
        pid: 90_200 + launches.length,
        onOutput: (listener: (chunk: string) => void) => {
          output = listener;
        },
        onErrorOutput: () => undefined,
        onExit: (listener: (code: number | null) => void) => {
          exit = listener;
        },
        terminate: () => launch.finish(),
      };
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
        centerUserRoot: fixture.userRoot,
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
      centerUserRoot: fixture.userRoot,
      runtimeDiscover: () => [installation],
      runtimeLaunch,
      beforeOpen: setupEdgeGit,
    });
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
      await eventually(() => launches.some((launch) => launch.taskId === tasks.offline));
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
      launches.find((launch) => launch.taskId === tasks.offline)!.finish();
      await eventually(async () => {
        const status = await edge.host.system(localAuth);
        const autoClaim = status.nodeAutoClaim as {
          readonly recent: readonly { readonly taskId: string | null; readonly reason: string }[];
        };
        return autoClaim.recent.some((row) => row.taskId === tasks.denied && row.reason === "source_not_allowed");
      });
      await eventually(async () => {
        const context = await fixture.host.read(
          "lease-repo",
          "repo.tasks.runtimeContext.read",
          { taskId: tasks.offline },
          fixture.owners.auth({ nodeId: "node-one" }),
        );
        return context.snapshot.lease === null || context.snapshot.lease.phase === "released";
      });
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
      await eventually(() => launches.some((launch) => launch.taskId === tasks.denied));
      assert.deepEqual(
        launches.map((launch) => launch.taskId),
        [tasks.offline, "task-a-node-runtime", tasks.denied],
        "B starts its own task while A's runtime is still active, without charging A's lease against B",
      );
      launches.find((launch) => launch.taskId === tasks.denied)!.finish();
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
      try {
        await eventually(() => launches.some((launch) => launch.taskId === tasks.next));
      } catch (error) {
        const status = await edge.host.system(localAuth);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; auto-claim=${JSON.stringify(status.nodeAutoClaim)}`,
        );
      }
      await createAssignedTask("task-50-waits-for-b-slot", "node-one", "node-one");
      assert.equal(
        launches.some((launch) => launch.taskId === "task-50-waits-for-b-slot"),
        false,
      );
      launches.find((launch) => launch.taskId === tasks.next)!.finish();
      await eventually(() => launches.some((launch) => launch.taskId === "task-50-waits-for-b-slot"));
      const startedOnB = await fixture.host.read(
        "lease-repo",
        "repo.tasks.runtimeContext.read",
        { taskId: "task-50-waits-for-b-slot" },
        fixture.owners.auth({ nodeId: "node-one" }),
      );
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
    } finally {
      for (const launch of launches) launch.finish();
    }
  },
);
