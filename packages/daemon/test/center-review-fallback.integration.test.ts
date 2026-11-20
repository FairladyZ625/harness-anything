// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { submissionDigest } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { waitForDurableValue } from "../../../tools/fixtures/event-arrival.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { applyFleetMirrorCut } from "../src/daemon-host/fleet-edge-mirror.ts";
import { openFleetEdgeRuntime } from "../src/daemon-host/fleet-edge-runtime.ts";
import { runFleetEdgeTask } from "../src/daemon-host/fleet-edge-task.ts";
import { readFleetOperationalClient } from "../src/daemon-host/fleet/peer.ts";
import { parseNodeAutoDispatchSnapshot } from "../src/daemon-host/node-auto-dispatch.ts";
import { fleetFixture, git, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { catchUpReplica, startResidentReplicaSync } from "./replica-catch-up.fixture.ts";
import { registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function runtimeProcess() {
  return {
    pid: process.pid,
    onOutput: () => undefined,
    onErrorOutput: () => undefined,
    onExit: () => undefined,
    terminate: () => undefined,
  };
}

async function submitFromEdge(t: TestContext, delivery: "git" | "ledger", edgeReviewerUnavailable = false) {
  const launches: { cwd: string; credential: string | undefined }[] = [],
    installation = {
      installationId: definition.installationId,
      kindId: definition.kindId,
      executablePath: "/usr/bin/true",
      version: "1.0.0",
      observedAt: "2026-11-07T00:00:00.000Z",
    },
    f = await fleetFixture(
      t,
      ["tasks", "agents"],
      [installation],
      "local",
      undefined,
      undefined,
      false,
      undefined,
      (prepared) => {
        launches.push({ cwd: prepared.cwd, credential: prepared.env.HARNESS_EXECUTION_CREDENTIAL });
        return runtimeProcess();
      },
    ),
    { repoId, nodeId } = f.subject,
    taskId = "task-center-review",
    local = localAuthFixture(),
    remote = path.join(f.root, "origin.git"),
    edgeRoot = path.join(f.root, "edge"),
    viewRoot = path.join(f.root, "edge-view"),
    code = delivery === "git";
  git(f.repo, "branch", "-M", "main");
  writeFileSync(path.join(f.repo, ".gitignore"), "/harness/\n/.harness/\n/.worktrees/\n");
  git(f.repo, "rm", "-r", "--cached", "--", "harness");
  git(f.repo, "add", ".gitignore");
  git(f.repo, "commit", "-qm", "test: ignore the private ledger");
  git(f.repo, "init", "--bare", "-q", "--initial-branch=main", remote);
  git(f.repo, "remote", "add", "origin", pathToFileURL(remote).href);
  git(f.repo, "push", "-qu", "origin", "main");
  git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(f.root, "clone", "-q", pathToFileURL(remote).href, edgeRoot);
  git(edgeRoot, "config", "user.name", "Fleet Test");
  git(edgeRoot, "config", "user.email", "fleet@example.invalid");
  await registerFixtureRuntimeInstance(f.host, repoId, local, {
    instanceId: definition.instanceId,
    name: "Center review fixture",
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
        instructions: "Inspect the accepted delivery.",
        runtimes: [{ type: "codex", model: definition.model }],
        instance: definition.instanceId,
        role: "reviewer",
      },
    },
    local,
  );
  assert.equal(installed.outcome, "applied", JSON.stringify(installed));
  const created = await f.host.run(
    repoId,
    {
      kind: "task-create",
      taskId,
      title: "Center review of edge cut",
      presetId: code ? "standard-task" : "docs-task",
    },
    f.auth,
  );
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  const packagePath = String(created.packagePath);
  await realizeTaskPlanFixture(f.repo, packagePath, (planPath) =>
    f.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, local),
  );
  const started = await f.host.run(repoId, { kind: "task-start", taskId }, f.auth);
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  const port = await unusedPort(),
    center = await f.host.fleet.startCenter(
      {
        repoId,
        port,
        bind: "127.0.0.1",
        stateRoot: f.stateRoot,
        keyPath: path.join(f.root, "tls.key"),
        certPath: f.certFile,
        quotaBytes: 64 * 1024 * 1024,
      },
      local,
    );
  assert.equal(center.outcome, "applied", JSON.stringify(center));
  const channel = {
      host: "127.0.0.1",
      port,
      caPath: f.certFile,
      nodeId,
      credential: `secret-${nodeId}`,
      principalId: "person-owner",
      repoId,
      viewRoot,
      quotaBytes: 64 * 1024 * 1024,
      workspaceRoot: edgeRoot,
    },
    readAccessToken = f.owners.readAccessToken(nodeId),
    replica = { ...channel, hostname: channel.host, readAccessToken, ca: f.cert, diskQuotaBytes: channel.quotaBytes };
  await catchUpReplica(replica);
  assert.equal(applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull").outcome, "applied");
  const sync = startResidentReplicaSync(replica);
  t.after(() => sync.close());
  let credential: string | undefined;
  let edgeLaunchCount = 0;
  const runtime = openFleetEdgeRuntime({
    readBinding: () => f.owners.binding(nodeId),
    readAccessToken,
    controlBinding: () => f.owners.binding(nodeId),
    resolveLocation: () => ({ ...channel, method: "repo.agentRuntime.spawn", action: {} }),
    daemonGeneration: 1,
    daemonRoute: {
      userRoot: path.join(f.root, "edge-user"),
      daemonId: "edge-worker",
      endpoint: path.join(f.root, "edge.sock"),
    },
    ports: scheduleRuntimePorts(),
    launch: (prepared) => {
      edgeLaunchCount++;
      if (edgeReviewerUnavailable && edgeLaunchCount > 1)
        throw Object.assign(new Error("The edge reviewer slot is occupied."), { code: "runtime_capacity_exhausted" });
      credential = prepared.env.HARNESS_EXECUTION_CREDENTIAL;
      return runtimeProcess();
    },
  });
  t.after(() => runtime.close());
  const worker = await runtime.run("repo.agentRuntime.spawn", {
    taskId,
    runtimeInstanceId: definition.instanceId,
    ...(code ? {} : { cwd: { scope: "repo-root" } }),
    prompt: "Submit the work from the edge.",
    dispatchKey: "center-fallback-worker",
  });
  assert.equal(worker.outcome, "applied", JSON.stringify(worker));
  assert.ok(credential);
  const workerRoot = code ? path.join(edgeRoot, ".worktrees", taskId) : edgeRoot,
    workerPackage = path.join(workerRoot, "harness", packagePath);
  if (code) {
    writeFileSync(path.join(workerRoot, "delivery.txt"), "frozen edge delivery\n");
    git(workerRoot, "add", "delivery.txt");
    git(workerRoot, "commit", "-qm", "feat: publish frozen edge delivery");
  }
  writeFileSync(
    path.join(workerPackage, "closeout.md"),
    "## 摘要\n\n边缘交付。\n\n## 验证\n\n验证冻结交付。\n\n## Summary\n\nEdge delivery.\n\n## Verification\n\nVerified frozen delivery.\n",
  );
  mkdirSync(path.join(workerPackage, "artifacts"), { recursive: true });
  writeFileSync(path.join(workerPackage, "artifacts", "delivery.md"), "Frozen Edge evidence.\n");
  const submitted = await runFleetEdgeTask(
    { payload: { ...channel, executionCredential: credential, action: { kind: "task-submit", taskId } } },
    readAccessToken,
  );
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  const reader = makeTaskEventReader({ repoId, rootDir: f.repo });
  t.after(() => reader.drain());
  const events = () => reader.read().events,
    frozen = events().findLast((event) => event.type === "execution_submitted" && event.taskId === taskId);
  assert.ok(frozen?.type === "execution_submitted" && frozen.payload.execution.submission);
  const cut = frozen.payload.execution.submission;
  assert.deepEqual(frozen.source, { kind: "node", nodeId });
  const candidates = parseNodeAutoDispatchSnapshot(
    await readFleetOperationalClient({
      hostname: channel.host,
      ...replica,
      method: "repo.tasks.autoDispatchCandidates",
      payload: {},
    }),
  ).candidates;
  const edgeCandidate = candidates.find((candidate) => candidate.taskId === taskId);
  assert.ok(edgeCandidate, JSON.stringify(submitted));
  assert.equal(edgeCandidate.requiredNodeId, nodeId);
  assert.equal(launches.length, 0, "the connected edge retains priority");
  let edgeReviewFailureRecorded = false;
  if (edgeReviewerUnavailable) {
    const failure = {
      executionId: edgeCandidate.executionId,
      dispatchKey: edgeCandidate.dispatchKey,
      code: "runtime_capacity_exhausted",
      message: `Node ${nodeId}: The edge reviewer slot is occupied.`,
      failedAt: new Date().toISOString(),
    };
    const receipt = await runFleetEdgeTask(
      {
        payload: {
          ...channel,
          principalId: "person-owner",
          action: {
            kind: "task-amend",
            taskId,
            patches: [{ field: "reviewDispatchFailure", value: JSON.stringify(failure) }],
          },
        },
      },
      readAccessToken,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    edgeReviewFailureRecorded = true;
  }
  const reviewDispatch = () =>
    events().findLast(
      (event) =>
        event.type === "runtime_dispatch_requested" &&
        event.payload.taskId === taskId &&
        event.payload.role === "reviewer",
    );
  return {
    ...f,
    taskId,
    packagePath,
    local,
    remote,
    launches,
    reviewDispatch,
    events,
    cut,
    worker,
    sync,
    edgeCandidate,
    edgeLaunchCount: () => edgeLaunchCount,
    edgeReviewFailureRecorded: () => edgeReviewFailureRecorded,
  };
}

test(
  "a disconnected edge's published cut is independently reviewed at its exact origin SHA",
  { timeout: 90_000 },
  async (t) => {
    const f = await submitFromEdge(t, "git"),
      { repoId } = f.subject,
      sha = f.cut.commitSha;
    assert.ok(sha);
    assert.equal(git(f.remote, "rev-parse", `refs/heads/${f.taskId}`), sha);
    await f.sync.close();
    const dispatch = await waitForDurableValue(() => f.reviewDispatch() ?? null);
    assert.ok(dispatch.type === "runtime_dispatch_requested");
    assert.deepEqual(dispatch.source, "local");
    assert.equal(dispatch.payload.agentId, "closeout-reviewer");
    assert.notEqual(dispatch.payload.runtimeSessionId, f.worker.runtimeSessionId);
    assert.deepEqual(dispatch.payload.reviewTarget, {
      kind: "task",
      taskId: f.taskId,
      executionId: f.edgeCandidate.executionId,
      digest: submissionDigest(f.cut),
    });
    const launch = await waitForDurableValue(() => f.launches[0] ?? null);
    assert.equal(launch.cwd, path.join(f.repo, ".worktrees", ".review", f.taskId, sha));
    assert.equal(git(launch.cwd, "rev-parse", "HEAD"), sha);
    assert.equal(git(launch.cwd, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.ok(launch.credential);
    const prefix = `${f.packagePath}/artifacts/reports/${dispatch.payload.dispatchId}`,
      report = path.join(launch.cwd, "harness", `${prefix}.md`),
      packet = path.join(launch.cwd, "harness", `${prefix}.json`);
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, "# Review\n\nIndependently inspected the exact Git delivery.\n");
    writeFileSync(
      packet,
      JSON.stringify({
        verdict: "approved",
        reason: "Inspected the frozen commit.",
        evidenceChecked: [`${sha}:delivery.txt`],
        findings: [],
        resolutions: [],
      }),
    );
    const reviewed = await f.host.run(
      repoId,
      {
        kind: "task-review-execution",
        taskId: f.taskId,
        executionId: f.edgeCandidate.executionId,
        reviewId: `review-${dispatch.payload.dispatchId}`,
        fromFile: packet,
      },
      { ...f.local, executionPrincipal: await f.owners.authenticateExecutionPrincipal(launch.credential) },
    );
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    assert.ok(f.events().some((event) => event.type === "review_recorded" && event.taskId === f.taskId));
    assert.equal(f.launches.length, 1);
    console.log("[center-review-exact-cut]", {
      sha,
      runtimeSessionId: dispatch.payload.runtimeSessionId,
      outcome: reviewed.outcome,
    });
  },
);

test(
  "a disconnected edge's locally cached but unreachable SHA never launches a reviewer",
  { timeout: 90_000 },
  async (t) => {
    const f = await submitFromEdge(t, "git"),
      sha = f.cut.commitSha;
    assert.ok(sha);
    git(f.remote, "update-ref", "-d", `refs/heads/${f.taskId}`, sha);
    git(f.remote, "prune", "--expire=now");
    assert.throws(() => git(f.remote, "cat-file", "-e", `${sha}^{commit}`));
    assert.notEqual(git(f.remote, "rev-parse", "refs/heads/main"), sha);
    assert.equal(git(f.repo, "rev-parse", `${sha}^{commit}`), sha, "canonical admission already retained the object");
    await f.sync.close();
    const failure = await waitForDurableValue(() => {
      const amended = f.events().findLast((event) => event.type === "task_amended" && event.taskId === f.taskId);
      return amended?.type === "task_amended" ? (amended.payload.task.reviewDispatchFailure ?? null) : null;
    });
    assert.equal(failure.code, "review_checkout_commit_unavailable");
    assert.match(failure.message, new RegExp(sha, "u"));
    assert.equal(f.reviewDispatch(), undefined);
    assert.deepEqual(f.launches, []);
    console.log("[center-review-rejected-cut]", { sha, code: failure.code, launches: f.launches.length });
  },
);

test(
  "a connected edge without a reviewer slot hands synced ledger evidence to Center",
  { timeout: 90_000 },
  async (t) => {
    const f = await submitFromEdge(t, "ledger", true);
    assert.equal(f.cut.commitSha, null);
    assert.ok(f.cut.artifacts?.some((artifact) => artifact.path.endsWith("/artifacts/delivery.md")));
    const dispatch = await waitForDurableValue(() => f.reviewDispatch() ?? null);
    assert.ok(dispatch.type === "runtime_dispatch_requested");
    assert.equal(dispatch.source, "local");
    assert.notEqual(dispatch.payload.runtimeSessionId, f.worker.runtimeSessionId);
    const launch = await waitForDurableValue(() => f.launches[0] ?? null);
    assert.equal(f.edgeReviewFailureRecorded(), true, "the edge capacity failure is persisted before Center fallback");
    assert.equal(launch.cwd, path.join(f.repo, "harness", f.packagePath));
    assert.equal(readFileSync(path.join(launch.cwd, "artifacts", "delivery.md"), "utf8"), "Frozen Edge evidence.\n");
    console.log("[center-review-ledger-fallback]", {
      runtimeSessionId: dispatch.payload.runtimeSessionId,
      source: dispatch.source,
      edgeLaunchAttempts: f.edgeLaunchCount(),
      artifact: "Frozen Edge evidence.",
    });
  },
);
