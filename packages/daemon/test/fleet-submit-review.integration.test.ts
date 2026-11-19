// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isTaskEvent } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { waitForDurableValue } from "../../../tools/fixtures/event-arrival.ts";
import { RuntimeProcessStartRejected } from "../src/daemon-host/runtime-spawn-process.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openFleetEdgeRuntime } from "../src/daemon-host/fleet-edge-runtime.ts";
import {
  locateFleetMirrorView,
  applyFleetMirrorCut,
  scanEdgeTaskWorktrees,
} from "../src/daemon-host/fleet-edge-mirror.ts";
import { readFleetOperationalClient } from "../src/daemon-host/fleet/peer.ts";
import { openNodeAutoDispatchLoop, parseNodeAutoDispatchSnapshot } from "../src/daemon-host/node-auto-dispatch.ts";
import { runFleetEdgeTask } from "../src/daemon-host/fleet-edge-task.ts";
import { taskWorktreeDocumentBase } from "../src/daemon-host/worktree-setup.ts";
import { fleetFixture, git, initRepo, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { catchUpReplica, startResidentReplicaSync } from "./replica-catch-up.fixture.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";

test(
  "an edge worker credential submits its cut and automatically dispatches its reviewer",
  { timeout: 90_000 },
  async (t) => {
    const installation = {
        installationId: definition.installationId,
        kindId: definition.kindId,
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-11-07T00:00:00.000Z",
      },
      f = await fleetFixture(t, ["tasks", "agents"], [installation], "local", undefined, undefined, false),
      { repoId, nodeId } = f.subject,
      taskId = "task-edge-submit-review";
    t.after(() => f.close());
    await registerFixtureRuntimeInstance(f.host, repoId, localAuthFixture(), {
      instanceId: definition.instanceId,
      name: "Edge review fixture",
      kindId: definition.kindId,
      installationId: definition.installationId,
      providerId: definition.providerId,
      models: [definition.model],
      authMode: definition.authMode,
    });
    const installed = await f.host.run(
      repoId,
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "closeout-reviewer",
          name: "Independent reviewer",
          instructions: "Review the accepted cut.",
          runtimes: [{ type: "codex", model: definition.model }],
          instance: definition.instanceId,
          role: "reviewer",
        },
      },
      localAuthFixture(),
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const created = await f.host.run(
      repoId,
      { kind: "task-create", taskId, title: "Edge submit review", presetId: "docs-task" },
      f.auth,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(created.packagePath);
    await realizeTaskPlanFixture(f.repo, packagePath, (planPath) =>
      f.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
    );
    const started = await f.host.run(repoId, { kind: "task-start", taskId }, f.auth);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const center = await f.center(),
      edgeRoot = path.join(f.root, "submit-edge"),
      viewRoot = path.join(f.root, "submit-view"),
      channel = {
        host: "127.0.0.1",
        port: center.port,
        caPath: f.certFile,
        nodeId,
        credential: "machine-secret",
        principalId: "person-owner",
        repoId,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: edgeRoot,
      },
      readAccessToken = f.owners.readAccessToken(nodeId),
      replica = {
        readAccessToken,
        port: center.port,
        ca: f.cert,
        nodeId,
        credential: "machine-secret",
        principalId: "person-owner",
        repoId,
        viewRoot,
        diskQuotaBytes: channel.quotaBytes,
      };
    mkdirSync(edgeRoot);
    initRepo(edgeRoot);
    await catchUpReplica(replica);
    assert.equal(applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull").outcome, "applied");
    const sync = startResidentReplicaSync(replica);
    t.after(() => sync.close());
    let executionCredential: string | undefined;
    const runtime = openFleetEdgeRuntime({
      readBinding: () => f.owners.binding(nodeId),
      readAccessToken: f.owners.readAccessToken(nodeId),
      controlBinding: () => f.owners.binding(nodeId),
      resolveLocation: () => ({ ...channel, method: "repo.agentRuntime.spawn", action: {} }),
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(f.root, "edge-user"),
        daemonId: "edge-submit",
        endpoint: path.join(f.root, "edge.sock"),
      },
      ports: scheduleRuntimePorts(),
      launch: (prepared) => {
        executionCredential = prepared.env.HARNESS_EXECUTION_CREDENTIAL;
        return {
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    t.after(() => runtime.close());
    const spawned = await runtime.run("repo.agentRuntime.spawn", {
      taskId,
      runtimeInstanceId: definition.instanceId,
      cwd: { scope: "repo-root" },
      prompt: "Submit the completed task.",
      dispatchKey: "edge-submit-worker",
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    assert.ok(executionCredential);
    writeFileSync(
      path.join(edgeRoot, "harness", packagePath, "closeout.md"),
      "## Summary\nEdge worker delivery.\n## Verification\nFleet center accepted the cut.\n",
    );
    mkdirSync(path.join(edgeRoot, "harness", packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(edgeRoot, "harness", packagePath, "artifacts", "delivery.md"), "Edge delivery evidence.\n");
    const submitted = await runFleetEdgeTask(
      { payload: { ...channel, executionCredential, action: { kind: "task-submit", taskId } } },
      readAccessToken,
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const readCandidates = async (signal: AbortSignal) =>
      parseNodeAutoDispatchSnapshot(
        await readFleetOperationalClient({
          hostname: channel.host,
          port: center.port,
          ca: f.cert,
          nodeId,
          credential: channel.credential,
          repoId,
          readAccessToken,
          method: "repo.tasks.autoDispatchCandidates",
          payload: {},
          connectionSignal: signal,
        }),
      ).candidates;
    const autoDispatchLoop = openNodeAutoDispatchLoop({
      read: readCandidates,
      spawn: async (candidate, signal) => {
        assert.equal(candidate.requiredNodeId, nodeId);
        const receipt = await runtime.run("repo.agentRuntime.spawn", candidate.payload, signal);
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      },
    });
    t.after(() => autoDispatchLoop.close());
    await autoDispatchLoop.trigger("edge-submit");
    const reader = makeTaskEventReader({ repoId, rootDir: f.repo });
    const events = reader.read().events,
      accepted = events.find((event) => event.type === "execution_submitted" && event.taskId === taskId),
      implementation = events.find(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.taskId === taskId &&
          event.payload.executionId === accepted?.payload.execution.executionId &&
          event.payload.role !== "reviewer",
      ),
      declaration = events.find(
        (event) =>
          event.type === "execution_executor_declared" &&
          event.payload.execution.executionId === accepted?.payload.execution.executionId,
      ),
      review = events.find(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.taskId === taskId &&
          event.payload.role === "reviewer",
      );
    assert.ok(accepted, "the center accepts the worker submission first");
    assert.ok(
      implementation?.type === "runtime_dispatch_requested",
      `the center must retain the implementation dispatch: ${JSON.stringify(
        events.filter((event) => event.type === "runtime_dispatch_requested"),
      )}`,
    );
    assert.ok(
      declaration?.type === "execution_executor_declared",
      `the submit must declare its implementation executor: ${JSON.stringify(
        events.filter(
          (event) =>
            (event.type === "execution_submitted" && event.taskId === taskId) ||
            (event.type === "execution_executor_declared" &&
              event.payload.execution.executionId === accepted?.payload.execution.executionId) ||
            (event.type === "runtime_dispatch_requested" && event.payload.taskId === taskId),
        ),
      )}; receipt=${JSON.stringify(submitted)}`,
    );
    assert.deepEqual(
      declaration?.type === "execution_executor_declared" ? declaration.payload.execution.actor.executor : undefined,
      declaration?.type === "execution_executor_declared"
        ? {
            kind: "agent",
            id: `runtime-session:${
              implementation?.type === "runtime_dispatch_requested" ? implementation.payload.runtimeSessionId : ""
            }`,
          }
        : undefined,
      "an edge implementation submit must retain its authoring executor",
    );
    assert.ok(review, `automatic reviewer dispatch must follow edge submit: ${JSON.stringify(submitted)}`);
    const recovered = await f.host.run(repoId, { kind: "task-show", taskId }, f.auth);
    const recoveredTask = JSON.parse(String(recovered.evidence)) as {
      readonly task?: { readonly reviewDispatchFailure?: unknown };
    };
    assert.equal(recoveredTask.task?.reviewDispatchFailure, undefined, "a successful retry clears the durable failure");
  },
);

test(
  "the real edge host persists auto-review launch failures and dispatches after explicit retry",
  { timeout: 120_000 },
  async (t) => {
    const installation = {
        installationId: definition.installationId,
        kindId: definition.kindId,
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-11-07T00:00:00.000Z",
      },
      f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, false, {
        runtimeDiscover: () => [installation],
      }),
      repoId = "lease-repo",
      taskId = "task-real-replica-review",
      executionId = "execution-real-replica-review";
    await registerFixtureRuntimeInstance(f.host, repoId, localAuthFixture(), {
      instanceId: definition.instanceId,
      name: "Replica review fixture",
      kindId: definition.kindId,
      installationId: definition.installationId,
      providerId: definition.providerId,
      models: [definition.model],
      authMode: definition.authMode,
    });
    for (const declaration of [
      {
        id: "replica-submit-worker",
        name: "Replica submit worker",
        instructions: "Implement and submit the task.",
        role: "worker" as const,
      },
      {
        id: "closeout-reviewer",
        name: "Replica closeout reviewer",
        instructions: "Review the submitted cut.",
        role: "reviewer" as const,
      },
    ]) {
      const installed = await f.host.run(
        repoId,
        {
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            ...declaration,
            runtimes: [{ type: "codex", model: definition.model }],
            instance: definition.instanceId,
          },
        },
        localAuthFixture(),
      );
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    }
    const created = await f.command("node-one", {
      kind: "task-create",
      taskId,
      title: "Real replica reviewer dispatch",
      presetId: "docs-task",
    });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(
      (created.receipt as Record<string, unknown> | undefined)?.packagePath ?? created.packagePath,
    );
    assert.ok(packagePath && packagePath !== "undefined", JSON.stringify(created));
    const launches: { readonly prompt: string; readonly env: NodeJS.ProcessEnv; readonly dispatchId: string }[] = [];
    let reviewerLaunched!: () => void;
    const reviewerReady = new Promise<void>((resolve) => {
      reviewerLaunched = resolve;
    });
    const launched: { workerDispatchId?: string } = {};
    let rejectReviewer = true;
    const edge = await fleetEdgeHostFixture(t, f, {
      name: "real-replica-review-edge",
      repoId,
      runtimeDiscover: () => [installation],
      runtimeLaunch: (prepared, persistence) => {
        launches.push({ prompt: prepared.prompt, env: prepared.env, dispatchId: persistence.dispatchId });
        if (launched.workerDispatchId !== undefined && persistence.dispatchId !== launched.workerDispatchId) {
          if (rejectReviewer)
            throw new RuntimeProcessStartRejected(
              Object.assign(new Error("reviewer executable is unavailable"), { code: "ENOENT" }),
            );
          reviewerLaunched();
        }
        return {
          pid: 94000 + launches.length,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    await catchUpReplica({ ...f.peer("node-one"), viewRoot: edge.viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
    await registerFixtureRuntimeInstance(edge.host, repoId, localAuthFixture(), {
      instanceId: definition.instanceId,
      name: "Replica review fixture",
      kindId: definition.kindId,
      installationId: definition.installationId,
      providerId: definition.providerId,
      models: [definition.model],
      authMode: definition.authMode,
    });
    const started = await edge.command({ kind: "task-start", taskId, executionId });
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const worker = await edge.host.spawnRuntime(
      repoId,
      {
        taskId,
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Implement and submit the task.",
        dispatchKey: "real-replica-submit-worker",
      },
      localAuthFixture(),
    );
    assert.equal(worker.outcome, "applied", JSON.stringify(worker));
    launched.workerDispatchId = worker.dispatchId;
    const workerCredential = launches.find((launch) => launch.dispatchId === worker.dispatchId)?.env
      .HARNESS_EXECUTION_CREDENTIAL;
    assert.ok(workerCredential, "the edge worker must receive an execution credential");
    mkdirSync(path.dirname(path.join(edge.edgeRoot, "harness", packagePath, "closeout.md")), { recursive: true });
    writeFileSync(
      path.join(edge.edgeRoot, "harness", packagePath, "closeout.md"),
      "## Summary\nEdge worker delivery.\n## Verification\nReplica callback coverage.\n" +
        "## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nReplica callback.\n",
    );
    const submitted = await edge.command({ kind: "task-submit", taskId, executionId }, workerCredential);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    // Observe the production openDaemonHost onFailure, not a test-created dispatch loop.
    const failure = await waitForDurableValue(async () => {
      const shown = await f.host.run(repoId, { kind: "task-show", taskId }, localAuthFixture());
      const snapshot = JSON.parse(String(shown.evidence));
      return snapshot.task?.reviewDispatchFailure ?? null;
    });
    assert.equal(failure.executionId, executionId);
    assert.equal(failure.code, "ENOENT");
    assert.match(failure.message, /Node node-one:.*reviewer executable is unavailable/u);
    assert.ok(failure.dispatchKey.startsWith("task-review:"), JSON.stringify(failure));
    assert.ok(failure.failedAt);
    const agenda = await f.host.read(repoId, "repo.agenda.read", { limit: 50 }, f.owners.auth({ nodeId: "node-one" }));
    assert.match(JSON.stringify(agenda), /review dispatch failed.*ENOENT.*reviewer executable is unavailable/u);
    rejectReviewer = false;
    const retried = await edge.command({ kind: "task-dispatch-review", taskIds: [taskId] });
    assert.match(JSON.stringify(retried), /Previous attempt:.*ENOENT.*reviewer executable is unavailable/u);
    await reviewerReady;
    const events = makeTaskEventReader({ repoId, rootDir: f.repo }).read().events,
      accepted = events.find(
        (event) => event.type === "execution_submitted" && event.payload.execution.executionId === executionId,
      ),
      declaration = events.find(
        (event) => event.type === "execution_executor_declared" && event.payload.execution.executionId === executionId,
      ),
      review = events.find(
        (event) =>
          event.type === "runtime_dispatch_requested" &&
          event.payload.taskId === taskId &&
          event.payload.role === "reviewer",
      );
    assert.ok(accepted?.type === "execution_submitted", "the center must record the edge submit");
    assert.ok(
      declaration?.type === "execution_executor_declared",
      `the edge submit must retain its authoring executor: ${JSON.stringify(
        events.filter(
          (event) =>
            event.taskId === taskId &&
            ["execution_submitted", "execution_executor_declared", "runtime_dispatch_requested"].includes(event.type),
        ),
      )}`,
    );
    assert.deepEqual(declaration.payload.execution.actor.executor, {
      kind: "agent",
      id: `runtime-session:${worker.runtimeSessionId}`,
    });
    assert.ok(review, "the production replica confirmation callback must dispatch a reviewer");
    assert.deepEqual(review?.source, { kind: "node", nodeId: "node-one" });
    await waitForDurableValue(async () => {
      const shown = await f.host.run(repoId, { kind: "task-show", taskId }, localAuthFixture());
      return JSON.parse(String(shown.evidence)).task?.reviewDispatchFailure == null ? true : null;
    });
  },
);

test(
  "hosted edge automatic review publishes and confirms its frozen PR head before launch",
  { timeout: 90_000 },
  async (t) => {
    const installation = {
      installationId: definition.installationId,
      kindId: definition.kindId,
      executablePath: "/fixture/reviewer",
      version: "1.0.0",
      observedAt: "2026-11-07T00:00:00.000Z",
    };
    const f = await fleetFixture(t, ["tasks", "agents"], [installation], "local", undefined, undefined, false);
    const { repoId, nodeId } = f.subject,
      taskId = "task-hosted-edge-review",
      remote = path.join(f.root, "origin.git"),
      edgeRoot = path.join(f.root, "hosted-edge"),
      viewRoot = path.join(f.root, "hosted-view");
    git(f.repo, "branch", "-M", "main");
    // Reproduce the deployed ignored-ledger layout, rather than Git-owned ledger contents.
    writeFileSync(path.join(f.repo, ".gitignore"), "/harness/\n/.harness/\n/.worktrees/\n");
    git(f.repo, "rm", "-r", "--cached", "--", "harness");
    git(f.repo, "add", ".gitignore");
    git(f.repo, "commit", "-qm", "test: ignored task ledger");
    git(f.repo, "init", "--bare", "-q", "--initial-branch=main", remote);
    git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
    git(f.repo, "push", "-qu", "origin", "main");
    git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(f.root, "clone", "-q", pathToFileURL(remote).href, edgeRoot);
    git(edgeRoot, "config", "user.name", "Fleet Test");
    git(edgeRoot, "config", "user.email", "fleet@example.invalid");
    const previous = git(edgeRoot, "rev-parse", "HEAD");
    await registerFixtureRuntimeInstance(f.host, repoId, localAuthFixture(), {
      instanceId: definition.instanceId,
      name: "Hosted edge review",
      kindId: definition.kindId,
      installationId: definition.installationId,
      providerId: definition.providerId,
      models: [definition.model],
      authMode: definition.authMode,
    });
    assert.equal(
      (
        await f.host.run(
          repoId,
          {
            kind: "agent-install",
            declaration: {
              schema: "agent-declaration/v1",
              id: "closeout-reviewer",
              name: "Edge reviewer",
              instructions: "Review the frozen delivery.",
              role: "reviewer",
              runtimes: [{ type: "codex", model: definition.model }],
              instance: definition.instanceId,
            },
          },
          localAuthFixture(),
        )
      ).outcome,
      "applied",
    );
    const created = await f.host.run(
      repoId,
      { kind: "task-create", taskId, title: "Hosted edge review", presetId: "standard-task" },
      f.auth,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFleetPublication(f.host, repoId, created.opId, f.auth);
    const packagePath = String(created.packagePath);
    await realizeTaskPlanFixture(f.repo, packagePath, (planPath) =>
      f.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
    );
    assert.equal((await f.host.run(repoId, { kind: "task-start", taskId }, f.auth)).outcome, "applied");
    const center = await f.center(),
      channel = {
        host: "127.0.0.1",
        port: center.port,
        caPath: f.certFile,
        nodeId,
        credential: "machine-secret",
        principalId: "person-owner",
        repoId,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: edgeRoot,
      },
      readAccessToken = f.owners.readAccessToken(nodeId),
      replica = {
        readAccessToken,
        port: center.port,
        ca: f.cert,
        nodeId,
        credential: "machine-secret",
        principalId: "person-owner",
        repoId,
        viewRoot,
        diskQuotaBytes: channel.quotaBytes,
      };
    await catchUpReplica(replica);
    assert.equal(applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull").outcome, "applied");
    const sync = startResidentReplicaSync(replica);
    t.after(() => sync.close());
    let credential: string | undefined,
      frozen = "",
      visibleHead = previous,
      prExists = false,
      reviewerStarts = 0,
      expectedPlan = "";
    const order: string[] = [],
      observed: { frozen: string; branchHead: string; prHead: string }[] = [];
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit = {}) => {
      if (!String(url).startsWith("https://api.github.com/")) return realFetch(url, options);
      const method = options.method ?? "GET";
      if (!String(url).includes("/pulls")) return Response.json({ default_branch: "main" });
      order.push(`hosting:${method}:${visibleHead}`);
      const pr = { number: 42, html_url: "https://github.com/acme/repo/pull/42", head: { sha: visibleHead } };
      if (method === "GET" && !String(url).endsWith("/42")) return Response.json(prExists ? [pr] : []);
      prExists = true;
      return Response.json(pr);
    });
    const runtime = openFleetEdgeRuntime({
      readBinding: () => f.owners.binding(nodeId),
      readAccessToken: f.owners.readAccessToken(nodeId),
      controlBinding: () => f.owners.binding(nodeId),
      resolveLocation: () => ({ ...channel, method: "repo.agentRuntime.spawn", action: {} }),
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(f.root, "edge-user"),
        daemonId: "hosted-edge",
        endpoint: path.join(f.root, "edge.sock"),
      },
      ports: {
        ...scheduleRuntimePorts(),
        prepareDaemonGitEnvironment: async () => ({ GH_TOKEN: "fixture-hosting-token" }),
      },
      launch: (prepared) => {
        if (credential === undefined) credential = prepared.env.HARNESS_EXECUTION_CREDENTIAL;
        else {
          reviewerStarts++;
          assert.equal(
            readFileSync(path.join(prepared.cwd, "harness", packagePath, "task_plan.md"), "utf8"),
            expectedPlan,
          );
          assert.match(prepared.prompt, /CEO rework/u, "the reviewer mission reads the latest authoritative plan");
          assert.match(
            readFileSync(path.join(prepared.cwd, "harness", packagePath, "closeout.md"), "utf8"),
            /Hosted edge delivery/u,
          );
          const heads = { frozen, branchHead: git(remote, "rev-parse", `refs/heads/${taskId}`), prHead: visibleHead };
          observed.push(heads);
          order.push(`review:${visibleHead}`);
          console.log("[edge-review-launch-head]", JSON.stringify(heads));
        }
        return {
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    t.after(() => runtime.close());
    const worker = await runtime.run("repo.agentRuntime.spawn", {
      taskId,
      runtimeInstanceId: definition.instanceId,
      prompt: "Implement the delivery.",
      dispatchKey: "hosted-edge-worker",
    });
    assert.equal(worker.outcome, "applied", JSON.stringify(worker));
    assert.ok(credential);
    const workerRoot = path.join(edgeRoot, ".worktrees", taskId);
    writeFileSync(path.join(workerRoot, "delivery.txt"), "edge frozen delivery\n");
    git(workerRoot, "add", "delivery.txt");
    git(workerRoot, "commit", "-qm", "feat: edge delivery");
    frozen = git(workerRoot, "rev-parse", "HEAD");
    // The replica advances while both physical mirrors still hold the old task plan.
    const planPath = `${packagePath}/task_plan.md`,
      planV1 = readFileSync(path.join(workerRoot, "harness", planPath), "utf8"),
      planV2 = `${planV1}\n## CEO rework\nRead the updated canonical cut.\n`;
    expectedPlan = planV2;
    writeFileSync(path.join(f.repo, "harness", planPath), planV2);
    const planUpdate = await f.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture());
    assert.equal(planUpdate.outcome, "applied", JSON.stringify(planUpdate));
    await waitForFleetPublication(f.host, repoId, planUpdate.opId, localAuthFixture());
    await catchUpReplica(replica);
    const view = locateFleetMirrorView(viewRoot, repoId, nodeId);
    assert.ok(view);
    assert.equal(
      scanEdgeTaskWorktrees({ view, workspaceRoot: edgeRoot, taskId, packagePath }).changes.some(
        (c) => c.path === planPath,
      ),
      false,
      "neither unchanged old workspace nor unchanged old worktree can author a rollback",
    );
    writeFileSync(
      path.join(workerRoot, "harness", packagePath, "closeout.md"),
      "## Summary\nHosted edge delivery.\n## Verification\nFrozen head verified.\n## 摘要\n边缘交付。\n## 验证\n冻结head。\n",
    );
    const artifactPath = `${packagePath}/artifacts/new-evidence.png`,
      artifactBytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    mkdirSync(path.join(workerRoot, "harness", packagePath, "artifacts"), { recursive: true });
    writeFileSync(path.join(workerRoot, "harness", artifactPath), artifactBytes);
    const scan = scanEdgeTaskWorktrees({ view, workspaceRoot: edgeRoot, taskId, packagePath });
    assert.ok(scan.changes.some((c) => c.path === `${packagePath}/closeout.md` && c.worktreeRoot === workerRoot));
    assert.ok(scan.changes.some((c) => c.path === artifactPath));
    // Hosting is a local fixture declaration; all Git traffic stays on the private file remote.
    for (const root of [f.repo, edgeRoot]) {
      const config = path.join(root, "harness", "harness.yaml");
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace(
          "settings:\n",
          "settings:\n  hosting:\n    provider: github\n    host: github.com\n",
        ),
      );
    }
    const submitted = await runFleetEdgeTask(
      { payload: { ...channel, executionCredential: credential, action: { kind: "task-submit", taskId } } },
      readAccessToken,
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.equal(
      git(remote, "rev-parse", `refs/heads/${taskId}`),
      frozen,
      "the holder/CAS path already published the exact Git ref",
    );
    assert.equal(prExists, false, "the node still needs to create its hosted PR before review");
    assert.equal(readFileSync(path.join(f.repo, "harness", planPath), "utf8"), planV2);
    assert.equal(
      readFileSync(path.join(f.repo, "harness", packagePath, "closeout.md"), "utf8"),
      readFileSync(path.join(workerRoot, "harness", packagePath, "closeout.md"), "utf8"),
      "one submit accepts the worktree closeout",
    );
    assert.deepEqual(readFileSync(path.join(f.repo, "harness", artifactPath)), artifactBytes);
    const eventReader = makeTaskEventReader({ repoId, rootDir: f.repo });
    const frozenEvent = eventReader
      .read()
      .events.find((e) => isTaskEvent(e) && e.type === "execution_submitted" && e.taskId === taskId);
    assert.ok(frozenEvent && isTaskEvent(frozenEvent) && frozenEvent.type === "execution_submitted");
    assert.ok(frozenEvent.payload.execution.submission?.artifacts?.some((a) => a.path === artifactPath));
    await eventReader.drain();
    assert.equal(
      readFileSync(taskWorktreeDocumentBase(workerRoot, `${packagePath}/closeout.md`), "utf8"),
      readFileSync(path.join(workerRoot, "harness", packagePath, "closeout.md"), "utf8"),
      "the edge acknowledges accepted worker bytes as the only next base",
    );
    const persistFailure = async (failure: Record<string, string> | null) => {
      const receipt = await runFleetEdgeTask(
        {
          payload: {
            ...channel,
            action: {
              kind: "task-amend",
              taskId,
              patches: [{ field: "reviewDispatchFailure", value: JSON.stringify(failure) }],
            },
          },
        },
        readAccessToken,
        "domain",
      );
      assert.ok(["applied", "no_changes"].includes(String(receipt.outcome)), JSON.stringify(receipt));
    };
    const loop = openNodeAutoDispatchLoop({
      read: async (signal) =>
        parseNodeAutoDispatchSnapshot(
          await readFleetOperationalClient({
            hostname: channel.host,
            port: center.port,
            ca: f.cert,
            nodeId,
            credential: channel.credential,
            repoId,
            readAccessToken,
            method: "repo.tasks.autoDispatchCandidates",
            payload: {},
            connectionSignal: signal,
          }),
        ).candidates,
      spawn: async (candidate, signal) => {
        assert.equal(candidate.requiredNodeId, nodeId);
        const receipt = await runtime.run("repo.agentRuntime.spawn", candidate.payload, signal);
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      },
      onFailure: async (candidate, error) => {
        assert.equal((error as { readonly code?: string }).code, "delivery_publish_failed");
        order.push("publication:failed");
        await persistFailure({
          executionId: candidate.executionId,
          dispatchKey: candidate.dispatchKey,
          code: "delivery_publish_failed",
          message: "The hosted head does not match the frozen cut; the owner must explicitly retry.",
          failedAt: new Date().toISOString(),
        });
      },
      onSuccess: () => persistFailure(null),
    });
    t.after(() => loop.close());
    await assert.rejects(loop.trigger("edge-submit-stale-head"), /PR head.*does not match the frozen delivery/u);
    assert.equal(reviewerStarts, 0, "a stale hosted head must not launch any reviewer");
    assert.equal(prExists, true, "the first node review creates its PR before validating its head");
    visibleHead = frozen;
    const staleOrder = [...order];
    await loop.trigger("replica-changed");
    assert.deepEqual(order, staleOrder, "durable failure prevents automatic hosting retries even after head changes");
    assert.equal(reviewerStarts, 0);
    const retry = await f.host.run(repoId, { kind: "task-dispatch-review", taskIds: [taskId] }, f.auth);
    assert.equal(retry.outcome, "pending", JSON.stringify(retry));
    await loop.trigger("explicit-owner-retry");
    assert.equal(reviewerStarts, 1);
    assert.deepEqual(observed, [{ frozen, branchHead: frozen, prHead: frozen }]);
    assert.equal(order.at(-1), `review:${frozen}`);
    await loop.trigger("duplicate-confirmation");
    assert.equal(reviewerStarts, 1, "the same frozen cut launches only once");
    console.log("[edge-publication-order]", JSON.stringify(order));
  },
);

test(
  "hosted edge review resolves hosting credentials when execution uses declare-executor without runtime-session",
  { timeout: 120_000 },
  async (t) => {
    const installations = [
      {
        installationId: definition.installationId,
        kindId: definition.kindId,
        executablePath: "/fixture/reviewer",
        version: "1.0.0",
        observedAt: "2026-11-07T00:00:00.000Z",
      },
      {
        installationId: `${definition.installationId}-agy-yr`,
        kindId: definition.kindId,
        executablePath: "/fixture/reviewer-agy-yr",
        version: "1.0.0",
        observedAt: "2026-11-07T00:00:00.000Z",
      },
    ];
    const f = await fleetFixture(t, ["tasks", "agents"], installations, "local", undefined, undefined, false);
    const { repoId, nodeId } = f.subject,
      taskId = "task-declare-executor-edge-review",
      remote = path.join(f.root, "origin.git"),
      edgeRoot = path.join(f.root, "hosted-declare-edge"),
      viewRoot = path.join(f.root, "hosted-declare-view");
    git(f.repo, "branch", "-M", "main");
    writeFileSync(path.join(f.repo, ".gitignore"), "/harness/\n/.harness/\n/.worktrees/\n");
    git(f.repo, "rm", "-r", "--cached", "--", "harness");
    git(f.repo, "add", ".gitignore");
    git(f.repo, "commit", "-qm", "test: ignored task ledger");
    git(f.repo, "init", "--bare", "-q", "--initial-branch=main", remote);
    git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
    git(f.repo, "push", "-qu", "origin", "main");
    git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(f.root, "clone", "-q", pathToFileURL(remote).href, edgeRoot);
    git(edgeRoot, "config", "user.name", "Fleet Test");
    git(edgeRoot, "config", "user.email", "fleet@example.invalid");

    for (const [index, instanceId] of ["unconfigured-instance", "agy-yr"].entries()) {
      await registerFixtureRuntimeInstance(f.host, repoId, localAuthFixture(), {
        instanceId,
        name: `Hosted ${instanceId}`,
        kindId: definition.kindId,
        installationId: installations[index]!.installationId,
        providerId: definition.providerId,
        models: [definition.model],
        authMode: definition.authMode,
      });
    }
    assert.equal(
      (
        await f.host.run(
          repoId,
          {
            kind: "agent-install",
            declaration: {
              schema: "agent-declaration/v1",
              id: "carbon-worker",
              name: "Carbon worker",
              instructions: "Implement externally and submit.",
              role: "worker",
              runtimes: [{ type: "codex", model: definition.model }],
            },
          },
          localAuthFixture(),
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await f.host.run(
          repoId,
          {
            kind: "agent-install",
            declaration: {
              schema: "agent-declaration/v1",
              id: "closeout-reviewer",
              name: "Edge reviewer",
              instructions: "Review the frozen delivery.",
              role: "reviewer",
              runtimes: [],
            },
          },
          localAuthFixture(),
        )
      ).outcome,
      "applied",
    );
    const created = await f.host.run(
      repoId,
      { kind: "task-create", taskId, title: "Declare-executor hosted edge review", presetId: "standard-task" },
      f.auth,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFleetPublication(f.host, repoId, created.opId, f.auth);
    const packagePath = String(created.packagePath);
    await realizeTaskPlanFixture(f.repo, packagePath, (planPath) =>
      f.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
    );
    const center = await f.center(),
      channel = {
        host: "127.0.0.1",
        port: center.port,
        caPath: f.certFile,
        nodeId,
        credential: "machine-secret",
        principalId: "person-owner",
        repoId,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: edgeRoot,
      },
      readAccessToken = f.owners.readAccessToken(nodeId),
      replica = {
        readAccessToken,
        port: center.port,
        ca: f.cert,
        nodeId,
        credential: "machine-secret",
        principalId: "person-owner",
        repoId,
        viewRoot,
        diskQuotaBytes: channel.quotaBytes,
      };
    await catchUpReplica(replica);
    assert.equal(applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull").outcome, "applied");
    const sync = startResidentReplicaSync(replica);
    t.after(() => sync.close());

    const started = await runFleetEdgeTask(
      { payload: { ...channel, action: { kind: "task-start", taskId } } },
      readAccessToken,
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const workerRoot = path.join(edgeRoot, ".worktrees", taskId);
    git(edgeRoot, "worktree", "add", "-B", taskId, workerRoot, "main");
    git(workerRoot, "config", "user.name", "Fleet Test");
    git(workerRoot, "config", "user.email", "fleet@example.invalid");
    writeFileSync(path.join(workerRoot, "delivery.txt"), "declare-executor edge delivery\n");
    git(workerRoot, "add", "delivery.txt");
    git(workerRoot, "commit", "-qm", "feat: declare-executor delivery");
    const frozen = git(workerRoot, "rev-parse", "HEAD");
    for (const root of [f.repo, edgeRoot]) {
      const config = path.join(root, "harness", "harness.yaml");
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace(
          "settings:\n",
          "settings:\n  hosting:\n    provider: github\n    host: github.com\n",
        ),
      );
    }
    mkdirSync(path.join(workerRoot, "harness", packagePath), { recursive: true });
    writeFileSync(
      path.join(workerRoot, "harness", packagePath, "closeout.md"),
      "## Summary\nDeclared-executor delivery.\n## Verification\nHosted PR pre-publish.\n" +
        "## 摘要\n显式声明执行器交付。\n## 验证\n评审前预发布。\n",
    );
    const submitted = await runFleetEdgeTask(
      { payload: { ...channel, action: { kind: "task-submit", taskId } } },
      readAccessToken,
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const submittedExecutionId = String(
      makeTaskEventReader({ repoId, rootDir: f.repo })
        .read()
        .events.findLast((event) => event.type === "execution_submitted" && event.taskId === taskId)?.payload.execution
        .executionId,
    );
    const declared = await f.host.run(
      repoId,
      {
        kind: "task-declare-executor",
        taskId,
        executionId: submittedExecutionId,
        agent: "carbon-worker",
        reason: "External carbon-worker implementation.",
      },
      f.auth,
    );
    assert.equal(declared.outcome, "applied", JSON.stringify(declared));
    await catchUpReplica(replica);

    let allowHostingCredential = false,
      prExists = false,
      reviewerStarts = 0;
    const probedInstances: string[] = [];
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit = {}) => {
      if (!String(url).startsWith("https://api.github.com/")) return realFetch(url, options);
      const method = options.method ?? "GET";
      if (!String(url).includes("/pulls")) return Response.json({ default_branch: "main" });
      const pr = { number: 77, html_url: "https://github.com/acme/repo/pull/77", head: { sha: frozen } };
      if (method === "GET" && !String(url).endsWith("/77")) return Response.json(prExists ? [pr] : []);
      prExists = true;
      return Response.json(pr);
    });
    const basePorts = scheduleRuntimePorts();
    const baseInstance = basePorts.runtimeInstances()[0]!;
    const runtime = openFleetEdgeRuntime({
      readBinding: () => f.owners.binding(nodeId),
      readAccessToken: f.owners.readAccessToken(nodeId),
      controlBinding: () => f.owners.binding(nodeId),
      resolveLocation: () => ({ ...channel, method: "repo.agentRuntime.spawn", action: {} }),
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(f.root, "edge-declare-user"),
        daemonId: "hosted-declare-edge",
        endpoint: path.join(f.root, "edge-declare.sock"),
      },
      ports: {
        ...basePorts,
        runtimeInstances: () => [
          { ...baseInstance, instanceId: "unconfigured-instance", name: "Unconfigured" },
          {
            ...baseInstance,
            instanceId: "agy-yr",
            name: "Configured Edge",
            hostingCredentialState: "configured",
          },
        ],
        prepareDaemonGitEnvironment: async (instanceId, provider, repo) => {
          probedInstances.push(instanceId);
          if (allowHostingCredential && instanceId === "agy-yr" && provider === "github" && repo === repoId)
            return { GH_TOKEN: "fixture-hosting-token" };
          return null;
        },
      },
      launch: () => {
        reviewerStarts++;
        return {
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    t.after(() => runtime.close());
    const readCandidate = async () => {
      const snapshot = parseNodeAutoDispatchSnapshot(
        await readFleetOperationalClient({
          hostname: channel.host,
          port: center.port,
          ca: f.cert,
          nodeId,
          credential: channel.credential,
          repoId,
          readAccessToken,
          method: "repo.tasks.autoDispatchCandidates",
          payload: {},
        }),
      );
      return snapshot.candidates.find((row) => row.taskId === taskId && row.kind === "review");
    };
    const firstCandidate = await readCandidate();
    assert.ok(firstCandidate, "declare-executor submitted task must produce an edge review candidate");

    // Negative control: without a configured hosting credential on any edge instance, pre-publication fails closed.
    const selectedInstanceId =
      typeof firstCandidate.payload.runtimeInstanceId === "string" ? firstCandidate.payload.runtimeInstanceId : null;
    await assert.rejects(
      runtime.run("repo.agentRuntime.spawn", firstCandidate.payload),
      /PR publication requires the daemon-held hosting credential/u,
    );
    assert.equal(reviewerStarts, 0);
    assert.deepEqual(
      probedInstances,
      selectedInstanceId === "unconfigured-instance"
        ? ["unconfigured-instance", "agy-yr"]
        : ["agy-yr", "unconfigured-instance"],
    );

    // Positive path: with hosting credential configured on agy-yr, edge pre-publication succeeds and launches reviewer.
    probedInstances.length = 0;
    allowHostingCredential = true;
    const spawned = await runtime.run("repo.agentRuntime.spawn", firstCandidate.payload);
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    assert.equal(reviewerStarts, 1);
    assert.equal(prExists, true);
    assert.deepEqual(
      probedInstances,
      selectedInstanceId === "unconfigured-instance" ? ["unconfigured-instance", "agy-yr"] : ["agy-yr"],
    );
  },
);
