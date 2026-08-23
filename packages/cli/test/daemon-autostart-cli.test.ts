// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonRpcLineClient, connectSocket, requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { streamAgentRuntimeAt } from "../../daemon/src/client/local-json-rpc-stream.ts";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { openDaemonLifecycleLog, readDaemonLifecycleRecords } from "../../daemon/src/lifecycle-log.ts";
import { currentDaemonProtocolVersion } from "../../daemon/src/protocol/version.ts";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { canonicalEventWritePlan, makeTaskEventStore, registerDaemonRepo, REPLAY_TASK_GRAPH, taskLifecycleWritePlan, type AgentDefinitionSnapshot, type AgentRuntimeEventV1, type TaskEventV1 } from "../../kernel/src/index.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("registered workspace CLI command auto-starts the daemon, retries, and succeeds", () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "autostart");
    const status = run(fixture.root, fixture.userRoot, ["daemon", "status"]);
    assert.deepEqual(status.target, { endpoint: localUserDaemonEndpoint(fixture.userRoot, "default"), daemonId: "default", userRoot: fixture.userRoot, repoId: "autostart", canonicalRoot: realpathSync.native(fixture.root) });
    for (const value of Object.values(status.target as Record<string, unknown>)) assert.match(String(status.summary), new RegExp(escapeRegExp(String(value)), "u"));
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", "task-autostart", "--admin", "--title", "Auto"]).outcome, "applied");
    const previousPid = readDaemonPid(fixture.userRoot, "default"); assert.ok(previousPid);
    // The autostart seam probes first: a live daemon is reused, never respawned.
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "list"]).outcome, "applied");
    assert.equal(readDaemonPid(fixture.userRoot, "default"), previousPid, "a reachable daemon must not be replaced by a second spawn");
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
    assert.equal(readDaemonPid(fixture.userRoot, "default"), null); assert.equal(existsSync(localUserDaemonEndpoint(fixture.userRoot, "default")), false, "stop receipt settles only after pid and socket are gone");
    const lifecycle = readDaemonLifecycleRecords(fixture.userRoot, "default");
    assert.equal(lifecycle.some((record) => record.event === "process_start"), true);
    assert.equal(lifecycle.some((record) => record.event === "socket_bound"), true);
    assert.equal(lifecycle.some((record) => record.event === "process_exit" && record.outcome === "stop_requested"), true);
    // The daemon is gone; a plain CLI command must bring it back and still answer.
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = JSON.parse(result.stdout) as { ok: boolean; outcome: string; error?: { code: string } };
    assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(receipt.outcome, "applied");
    const restartedPid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(restartedPid, "autostart must leave a resident daemon pid file"); assert.notEqual(restartedPid, previousPid);
    const restartedLifecycle = readDaemonLifecycleRecords(fixture.userRoot, "default"), generationStart = restartedLifecycle.findLastIndex((record) => record.event === "process_start"), bound = restartedLifecycle.findIndex((record, index) => index > generationStart && record.event === "socket_bound"), attach = restartedLifecycle.findIndex((record, index) => index > generationStart && record.event === "repo_attach_started");
    assert.ok(generationStart >= 0 && bound > generationStart && attach > bound, "the resident socket must bind before the cold registry starts attaching");
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("a blocked vertical script keeps handshakes, snapshots, and same-repo writes live", async (context) => {
  const fixture = setup(), repoId = "vertical-wedge", taskId = "task-vertical-wedge", blocker = path.join(fixture.parent, "vertical-script.block"), started = `${blocker}.started`, endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
  let client: JsonRpcLineClient | undefined, readClient: JsonRpcLineClient | undefined, queuedClient: JsonRpcLineClient | undefined, scriptRequest: Promise<Record<string, unknown>> | undefined, queuedWrite: Promise<Record<string, unknown>> | undefined;
  try {
    writeFileSync(blocker, "blocked\n", "utf8");
    const launched = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "daemon", "start", "--service"], { encoding: "utf8", env: { ...cliEnv(fixture.root, fixture.userRoot), HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE: blocker } });
    assert.equal(launched.status, 0, `${launched.stderr}\n${launched.stdout}\n${existsSync(path.join(fixture.userRoot, "logs", "daemon-default.log")) ? readFileSync(path.join(fixture.userRoot, "logs", "daemon-default.log"), "utf8") : "daemon log missing"}`);
    register(fixture.root, fixture.userRoot, repoId);
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Vertical Wedge"]).outcome, "applied");

    const socket = await connectSocket(endpoint, 2_000); client = new JsonRpcLineClient(socket, socket);
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    scriptRequest = client.request("repo.script.run", { repo: { repoId }, payload: { scriptId: "vertical:software-coding:repository-audit", taskId, inputs: {}, dryRun: true } }) as Promise<Record<string, unknown>>;
    await waitForFileContent(started);

    const probeStarted = performance.now(); let handshake: Record<string, unknown>;
    try { const response = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 250); handshake = { ok: true, elapsedMs: Math.round(performance.now() - probeStarted), daemonPid: response.pid }; }
    catch (error) { handshake = { ok: false, elapsedMs: Math.round(performance.now() - probeStarted), code: coded(error), message: error instanceof Error ? error.message : String(error) }; }
    context.diagnostic(`blocked vertical script handshake probe: ${JSON.stringify(handshake)}`);
    assert.equal(handshake.ok, true, JSON.stringify(handshake));

    const readSocket = await connectSocket(endpoint, 2_000); readClient = new JsonRpcLineClient(readSocket, readSocket);
    await readClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    const readStarted = performance.now(), readWhileBlocked = await Promise.race([readClient.request("repo.tasks.list", { repo: { repoId }, payload: {} }).then((receipt) => ({ state: "settled" as const, receipt })), delay(250, { state: "pending" as const, receipt: null })]);
    const snapshotTaskIds = Array.isArray(readWhileBlocked.receipt?.rows) ? readWhileBlocked.receipt.rows.map((row) => String((row as Record<string, unknown>).taskId)) : null, snapshotWhileBlocked = { state: readWhileBlocked.state, elapsedMs: Math.round(performance.now() - readStarted), readStatus: readWhileBlocked.receipt?.status, taskIds: snapshotTaskIds };
    context.diagnostic(`same-repo snapshot probe while script blocked: ${JSON.stringify(snapshotWhileBlocked)}`);
    assert.deepEqual({ state: readWhileBlocked.state, readStatus: readWhileBlocked.receipt?.status }, { state: "settled", readStatus: "ready" }, JSON.stringify(snapshotWhileBlocked));
    assert.deepEqual(snapshotTaskIds, [taskId], "the concurrent read must return the committed pre-write snapshot");

    const queuedSocket = await connectSocket(endpoint, 2_000); queuedClient = new JsonRpcLineClient(queuedSocket, queuedSocket);
    await queuedClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    queuedWrite = queuedClient.request("repo.task.create", { repo: { repoId }, payload: { taskId: "task-queued-write", title: "Queued Write" } }) as Promise<Record<string, unknown>>;
    const orderingStarted = performance.now(), beforeRelease = await Promise.race([queuedWrite.then(() => "settled" as const), delay(2_000, "pending" as const)]), orderingWhileBlocked = { state: beforeRelease, elapsedMs: Math.round(performance.now() - orderingStarted) };
    context.diagnostic(`same-repo write ordering probe while script blocked: ${JSON.stringify(orderingWhileBlocked)}`);
    assert.equal(beforeRelease, "settled", JSON.stringify(orderingWhileBlocked));

    rmSync(blocker, { force: true });
    const [scriptReceipt, writeReceipt] = await Promise.all([scriptRequest, queuedWrite]);
    const orderingAfterRelease = { scriptOutcome: scriptReceipt.outcome, writeOutcome: writeReceipt.outcome, writeRevision: writeReceipt.revision };
    context.diagnostic(`vertical settlement after independent same-repo write: ${JSON.stringify(orderingAfterRelease)}`);
    assert.deepEqual({ scriptOutcome: scriptReceipt.outcome, writeOutcome: writeReceipt.outcome }, { scriptOutcome: "pending", writeOutcome: "applied" });
    assert.equal((scriptReceipt.proof as { readonly canonicalVisible?: unknown }).canonicalVisible, false);
  } finally {
    rmSync(blocker, { force: true });
    await Promise.all([scriptRequest?.catch(() => undefined), queuedWrite?.catch(() => undefined)]); client?.close(); readClient?.close(); queuedClient?.close();
    stop(fixture.root, fixture.userRoot); rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("runtime stream attach stays live before, during, and after a blocked vertical script", async (context) => {
  const fixture = setup(), repoId = "runtime-attach-live", taskId = "task-runtime-attach-live", runtimeSessionId = "runtime-session-attach-live", blocker = path.join(fixture.parent, "vertical-attach.block"), started = `${blocker}.started`, endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
  let client: JsonRpcLineClient | undefined, scriptRequest: Promise<Record<string, unknown>> | undefined;
  try {
    seedAttachableRuntime(fixture.root, repoId, runtimeSessionId);
    writeFileSync(blocker, "blocked\n", "utf8");
    const launched = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "daemon", "start", "--service"], { encoding: "utf8", env: { ...cliEnv(fixture.root, fixture.userRoot), HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE: blocker } });
    assert.equal(launched.status, 0, `${launched.stderr}\n${launched.stdout}\n${existsSync(path.join(fixture.userRoot, "logs", "daemon-default.log")) ? readFileSync(path.join(fixture.userRoot, "logs", "daemon-default.log"), "utf8") : "daemon log missing"}`);
    register(fixture.root, fixture.userRoot, repoId);
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Runtime Attach Live"]).outcome, "applied");

    const idle = await probeRuntimeAttach(endpoint, repoId, runtimeSessionId);

    const socket = await connectSocket(endpoint, 2_000); client = new JsonRpcLineClient(socket, socket);
    await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    scriptRequest = client.request("repo.script.run", { repo: { repoId }, payload: { scriptId: "vertical:software-coding:repository-audit", taskId, inputs: {}, dryRun: true } }) as Promise<Record<string, unknown>>;
    await waitForFileContent(started);

    const readStarted = performance.now(), read = await requestDaemonJsonRpcAt(endpoint, "repo.agentRuntime.sessions.read", { repo: { repoId }, payload: { runtimeSessionId } }, 2_000, 500), loaded = await probeRuntimeAttach(endpoint, repoId, runtimeSessionId);
    const snapshot = { elapsedMs: Math.round(performance.now() - readStarted), revision: read.sourceRevision, runtimeSessionId: (read.session as Record<string, unknown>).runtimeSessionId };

    rmSync(blocker, { force: true }); const scriptReceipt = await scriptRequest;
    const recovered = await probeRuntimeAttach(endpoint, repoId, runtimeSessionId);
    context.diagnostic(`runtime attach three-point control: ${JSON.stringify({ idle, loaded: { snapshot, attach: loaded }, recovered, scriptOutcome: scriptReceipt.outcome })}`);

    assert.equal(idle.status, "attached", JSON.stringify(idle));
    assert.equal(snapshot.runtimeSessionId, runtimeSessionId, JSON.stringify(snapshot));
    assert.equal(loaded.status, "attached", JSON.stringify(loaded));
    assert.equal(recovered.status, "attached", JSON.stringify(recovered));
  } finally {
    rmSync(blocker, { force: true }); await scriptRequest?.catch(() => undefined); client?.close();
    stop(fixture.root, fixture.userRoot); rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("disconnecting a blocked vertical script client terminates its child after same-repo writes advance", async (context) => {
  const fixture = setup(), otherRoot = setupRepository(fixture.parent, "other-repo"), blockedRepoId = "vertical-disconnect", otherRepoId = "vertical-unaffected", taskId = "task-vertical-disconnect", blocker = path.join(fixture.parent, "vertical-disconnect.block"), started = `${blocker}.started`, endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
  let actionSocket: Socket | undefined, queuedClient: JsonRpcLineClient | undefined, scriptRequest: Promise<Record<string, unknown>> | undefined, queuedWrite: Promise<Record<string, unknown>> | undefined;
  try {
    writeFileSync(blocker, "blocked\n", "utf8");
    const launched = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "daemon", "start", "--service"], { encoding: "utf8", env: { ...cliEnv(fixture.root, fixture.userRoot), HARNESS_TEST_VERTICAL_SCRIPT_BLOCK_FILE: blocker } });
    assert.equal(launched.status, 0, `${launched.stderr}\n${launched.stdout}`);
    register(fixture.root, fixture.userRoot, blockedRepoId); register(otherRoot, fixture.userRoot, otherRepoId);
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Vertical Disconnect"]).outcome, "applied");

    actionSocket = await connectSocket(endpoint, 2_000); const actionClient = new JsonRpcLineClient(actionSocket, actionSocket);
    await actionClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    scriptRequest = actionClient.request("repo.script.run", { repo: { repoId: blockedRepoId }, payload: { scriptId: "vertical:software-coding:repository-audit", taskId, inputs: {}, dryRun: true } }) as Promise<Record<string, unknown>>;
    void scriptRequest.catch(() => undefined);
    const childPid = Number(await waitForFileContent(started));
    assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true, `invalid vertical child pid: ${childPid}`);
    assert.equal(processAlive(childPid), true, `vertical child ${childPid} must be alive before disconnect`);

    const unaffected = await requestDaemonJsonRpcAt(endpoint, "repo.tasks.list", { repo: { repoId: otherRepoId }, payload: {} }, 2_000, 500);
    context.diagnostic(`other-repo read while vertical script blocked: ${JSON.stringify({ status: unaffected.status, rowCount: Array.isArray(unaffected.rows) ? unaffected.rows.length : null })}`);
    assert.equal(unaffected.status, "ready");

    const queuedSocket = await connectSocket(endpoint, 2_000); queuedClient = new JsonRpcLineClient(queuedSocket, queuedSocket);
    await queuedClient.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
    queuedWrite = queuedClient.request("repo.task.create", { repo: { repoId: blockedRepoId }, payload: { taskId: "task-after-disconnect", title: "After Disconnect" } }) as Promise<Record<string, unknown>>;
    const beforeDisconnect = await Promise.race([queuedWrite.then(() => "settled" as const), delay(2_000, "pending" as const)]);
    context.diagnostic(`same-repo write before client disconnect: ${JSON.stringify({ state: beforeDisconnect })}`);
    assert.equal(beforeDisconnect, "settled");

    actionSocket.destroy();
    await waitForProcessExit(childPid);
    const writeReceipt = await queuedWrite;
    context.diagnostic(`vertical child after client disconnect: ${JSON.stringify({ writeOutcome: writeReceipt.outcome, blockerStillPresent: existsSync(blocker), childAlive: processAlive(childPid) })}`);
    assert.equal(existsSync(blocker), true, "the test blocker must still be present when cancellation terminates the child");
    assert.equal(processAlive(childPid), false, "the disconnected client's vertical child must be terminated");
    assert.equal(writeReceipt.outcome, "applied");
  } finally {
    actionSocket?.destroy(); rmSync(blocker, { force: true });
    await queuedWrite?.catch(() => undefined); queuedClient?.close();
    stop(fixture.root, fixture.userRoot); rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("receipt show diagnoses a missing daemon without starting one", () => {
  const fixture = setup();
  try {
    registerDaemonRepo({ canonicalRoot: fixture.root, repoId: "diagnostic", userRoot: fixture.userRoot, createConvenienceLinks: false });
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "receipt", "show", "op-missing"], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.notEqual(result.status, 0); const receipt = JSON.parse(result.stdout) as { error: { code: string } };
    assert.equal(receipt.error.code, "daemon_unavailable"); assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "a diagnostic read must not autostart the daemon");
  } finally { stop(fixture.root, fixture.userRoot); rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("CLI reports lifecycle attach progress and waits through a slow warming repository", async () => {
  const fixture = setup(), repoId = "slow-warming", socketPath = localUserDaemonEndpoint(fixture.userRoot, "default"), lifecycle = openDaemonLifecycleLog({ userRoot: fixture.userRoot, daemonId: "default" });
  registerDaemonRepo({ canonicalRoot: fixture.root, repoId, userRoot: fixture.userRoot, createConvenienceLinks: false }); lifecycle.record({ event: "process_start", endpoint: socketPath }); lifecycle.record({ event: "socket_bound", endpoint: socketPath }); lifecycle.record({ event: "repo_attach_started", repoId, attachIndex: 2, attachTotal: 5 });
  let requests = 0; const server = createServer((socket) => { let buffered = ""; socket.on("data", (chunk) => { buffered += String(chunk); for (;;) { const newline = buffered.indexOf("\n"); if (newline < 0) break; const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1); const request = JSON.parse(line) as { id: number; method: string }; requests += request.method === "protocol.hello" ? 0 : 1; if (requests === 2) lifecycle.record({ event: "repo_attach_completed", repoId, attachIndex: 2, attachTotal: 5, durationMs: 1_000 }); const result = request.method === "protocol.hello" ? { protocolVersion: 1 } : requests >= 2 ? { schema: "command-receipt/v2", ok: true, command: "task-list", outcome: "applied", summary: "task list: 0" } : { schema: "command-receipt/v2", ok: false, command: "task-list", outcome: "op_rejected", code: "repo_warming", nextAction: "wait for attach" }; socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`); } }); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    const result = await spawnCli(fixture.root, fixture.userRoot, ["task", "list"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); assert.equal((JSON.parse(result.stdout) as { outcome: string }).outcome, "applied"); assert.ok(requests >= 2, "the original command must retry after the warming receipt");
    assert.match(result.stderr, /daemon is starting; waited \d+s \(repo 2\/5: slow-warming\)/u);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("semantic sources and agent execution cross the daemon before transport-bound human review completes", () => {
  const fixture = setup(), taskId = "task-executor-axis", executionId = "exec-executor-axis", reviewId = "review-executor-axis";
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "executor-axis");
    const created = run(fixture.root, fixture.userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Executor Axis"]);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(created.packagePath), closeoutPath = `${packagePath}/closeout.md`;

    assert.equal(run(fixture.root, fixture.userRoot, ["task", "start", taskId, "--execution-id", executionId], "agent:claude-code").outcome, "applied");
    writeFileSync(path.join(fixture.root, "harness", closeoutPath), "# Closeout\n\n## Summary\n\nExecutor attribution restored.\n\n## Verification\n\nEnd-to-end daemon flow.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNot applicable to this fixture.\n", "utf8");
    assert.equal(run(fixture.root, fixture.userRoot, ["doc", "sync", "--submit", "--execution-id", executionId, "--path", closeoutPath], "agent:claude-code").outcome, "applied");
    const commitSha = git(fixture.root, "rev-parse", "HEAD");

    writeFileSync(path.join(fixture.root, "submission.json"), JSON.stringify({ completionClaim: "Executor axis is covered.", deliverables: ["daemon actor binding"], outputs: [closeoutPath], verificationNotes: ["end-to-end daemon flow"], knownGaps: [], residualRisks: [], commitSha }));
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "submit", taskId, "--execution-id", executionId, "--from-file", "submission.json"], "agent:claude-code").outcome, "applied");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "code-doc", "reconcile", taskId, "--execution-id", executionId, "--commit-sha", commitSha, "--iteration", "0", "--path", "README.md"], "agent:claude-code").outcome, "applied");

    writeFileSync(path.join(fixture.root, "review.json"), JSON.stringify({ verdict: "approved", reason: "Human review accepted the agent execution.", evidenceChecked: ["end-to-end daemon flow"] }));
    const reviewed = run(fixture.root, fixture.userRoot, ["task", "review-execution", taskId, "--execution-id", executionId, "--review-id", reviewId, "--from-file", "review.json"]);
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    writeFileSync(path.join(fixture.root, "consent.json"), JSON.stringify({ reviewDigest: reviewed.reviewDigest, contentDigest: reviewed.contentDigest }));
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "review-consent", taskId, "--execution-id", executionId, "--review-id", reviewId, "--consent-id", "consent-executor-axis", "--from-file", "consent.json"]).outcome, "applied");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "complete", taskId, "--execution-id", executionId, "--ci", "passed"]).outcome, "applied");

    const shown = run(fixture.root, fixture.userRoot, ["task", "show", taskId]), snapshot = JSON.parse(String(shown.evidence)) as { task: { status: string; createdBy: unknown }; executions: { actor: unknown }[]; reviews: { actor: unknown }[] };
    assert.equal(snapshot.task.status, "done");
    assert.deepEqual(snapshot.task.createdBy, { principal: { personId: "owner" }, executor: null });
    assert.deepEqual(snapshot.executions[0]?.actor, { principal: { personId: "owner" }, executor: { kind: "agent", id: "claude-code" } });
    assert.deepEqual(snapshot.reviews[0]?.actor, { principal: { personId: "owner" }, executor: null });
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", "task-source", "--admin", "--title", "Source"], "agent:codex").outcome, "applied");
    const sourceTask = JSON.parse(String(run(fixture.root, fixture.userRoot, ["task", "show", "task-source"]).evidence)) as { task: { createdBy: unknown } };
    assert.deepEqual(sourceTask.task.createdBy, { principal: { personId: "owner" }, executor: { kind: "agent", id: "codex" } });
    writeFileSync(path.join(fixture.root, "artifact.md"), "# Artifact\n", "utf8");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "artifact", "add", "task-source", "--source", "artifact.md", "--destination", "proof.md"]).outcome, "applied");
    assert.equal(run(fixture.root, fixture.userRoot, ["relation", "list", "--source", "task/task-source"]).outcome, "applied");
  } finally {
    stop(fixture.root, fixture.userRoot);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("cancelled task reinstates to planned through the CLI and daemon", () => {
  const fixture = setup(), taskId = "task-reinstate";
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "reinstate");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "create", "--id", taskId, "--admin", "--title", "Reinstate"]).outcome, "applied");
    assert.equal(run(fixture.root, fixture.userRoot, ["task", "transition", taskId, "cancelled", "--force", "--reason", "Erroneous batch cleanup"]).outcome, "applied");
    assert.equal(statusOf(fixture.root, fixture.userRoot, taskId), "cancelled");

    // A reinstate without the auditable reason is refused by the CLI before it can reach the daemon.
    const bare = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "transition", taskId, "planned"], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.equal(bare.status, 2, `${bare.stderr}\n${bare.stdout}`);
    const bareReceipt = JSON.parse(bare.stdout) as { ok: boolean; error?: { code: string } };
    assert.equal(bareReceipt.ok, false);
    assert.equal(bareReceipt.error?.code, "missing_field");

    const reinstated = run(fixture.root, fixture.userRoot, ["task", "transition", taskId, "planned", "--reason", "Owner adjudicated rollback of the batch cancellation"]);
    assert.equal(reinstated.outcome, "applied", JSON.stringify(reinstated));
    assert.equal(statusOf(fixture.root, fixture.userRoot, taskId), "planned");
  } finally {
    stop(fixture.root, fixture.userRoot);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("dry-run contract migration prints each manual task once", () => {
  const fixture = setup(), repoId = "contract-receipt", taskId = "task_legacy_l1";
  try {
    seedLegacyTask(fixture.root, repoId, taskId);
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, repoId);
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "task", "contract", "migrate", "--dry-run", "--task", taskId], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal((result.stdout.match(new RegExp(taskId, "gu")) ?? []).length, 1, result.stdout);
    const receipt = run(fixture.root, fixture.userRoot, ["task", "contract", "migrate", "--dry-run", "--task", taskId]);
    const evidence = JSON.parse(String(receipt.evidence)) as { report: readonly { taskId: string; status: string; reason: string }[]; manual: readonly { taskId: string; status: string; reason: string }[] };
    assert.deepEqual(evidence.manual, [evidence.report[0]], "JSON keeps the manual subset for machine consumers");
  } finally {
    stop(fixture.root, fixture.userRoot);
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("autostart fails fast when its single-flight lock cannot be created", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "requires POSIX non-root permission semantics" : false }, () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.root, fixture.userRoot, "autostart-fail");
    assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "stop"]).ok, true);
    waitForDaemonDown(fixture.userRoot);
    // The lock is the first mutating step. A read-only user root must fail there
    // with the permission cause instead of spawning or waiting for a bind timeout.
    chmodSync(fixture.userRoot, 0o555);
    const result = spawnSync(process.execPath, [cli, "--root", fixture.root, "--json", "task", "list"], { encoding: "utf8", env: cliEnv(fixture.root, fixture.userRoot) });
    assert.notEqual(result.status, 0);
    const receipt = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; hint: string } };
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, "daemon_spawn_permission");
    assert.match(receipt.error.hint, /permission was denied/u);
    assert.match(receipt.error.hint, /daemon serve/u);
    assert.equal(readDaemonPid(fixture.userRoot, "default"), null, "no daemon may claim to be resident after failed starts");
  } finally { chmodSync(fixture.userRoot, 0o755); rmSync(fixture.parent, { recursive: true, force: true }); }
});

function cliEnv(root: string, userRoot: string, actor?: string): NodeJS.ProcessEnv { const { HARNESS_ACTOR: _actor, HARNESS_DAEMON_ENDPOINT: _endpoint, HARNESS_DAEMON_REPO_ID: _repoId, HARNESS_DAEMON_ID: _daemonId, ...base } = process.env; return { ...base, HOME: path.join(root, ".home"), GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot, ...(actor ? { HARNESS_ACTOR: actor } : {}) }; }
function setup(): { parent: string; root: string; userRoot: string } { const parent = mkdtempSync(path.join(tmpdir(), "ha-autostart-")), root = setupRepository(parent, "repo"), userRoot = path.join(parent, "user"); return { parent, root, userRoot }; }
function setupRepository(parent: string, name: string): string { const root = path.join(parent, name);
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(path.join(root, "harness/people.yaml"), `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`, "utf8");
  git(root, "init", "--quiet"); git(root, "config", "user.name", "Autostart Test"); git(root, "config", "user.email", "autostart@example.test");
  git(root, "add", "README.md", "harness/harness.yaml", "harness/people.yaml"); git(root, "commit", "--quiet", "-m", "fixture"); return root; }
function register(root: string, userRoot: string, repoId: string): void { assert.equal(run(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]).ok, true); }
function run(root: string, userRoot: string, args: readonly string[], actor?: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env: cliEnv(root, userRoot, actor) });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); return JSON.parse(result.stdout) as Record<string, unknown>; }
function waitForDaemonDown(userRoot: string): void { const socketPath = localUserDaemonEndpoint(userRoot, "default");
  for (let attempt = 0; attempt < 200; attempt += 1) { if (readDaemonPid(userRoot, "default") === null && !existsSync(socketPath)) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  throw new Error("previous daemon did not drain before the autostart probe"); }
async function waitForFileContent(target: string): Promise<string> { const deadline = Date.now() + 5_000; for (;;) { const content = existsSync(target) ? readFileSync(target, "utf8").trim() : ""; if (content) return content; if (Date.now() >= deadline) throw new Error(`timed out waiting for content in ${target}`); await new Promise((resolve) => setTimeout(resolve, 10)); } }
async function waitForProcessExit(pid: number): Promise<void> { const deadline = Date.now() + 2_000; while (processAlive(pid)) { if (Date.now() >= deadline) throw new Error(`timed out waiting for process ${pid} to exit`); await new Promise((resolve) => setTimeout(resolve, 10)); } }
function delay<T>(milliseconds: number, value: T): Promise<T> { return new Promise((resolve) => setTimeout(() => resolve(value), milliseconds)); }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function coded(error: unknown): string | null { return typeof error === "object" && error !== null && "code" in error ? String((error as { readonly code: unknown }).code) : null; }
function stop(root: string, userRoot: string): void { if (readDaemonPid(userRoot, "default") !== null) spawnSync(process.execPath, [cli, "--root", root, "--json", "daemon", "stop"], { encoding: "utf8", env: cliEnv(root, userRoot) }); }
function statusOf(root: string, userRoot: string, taskId: string): string { const shown = run(root, userRoot, ["task", "show", taskId]); return (JSON.parse(String(shown.evidence)) as { task: { status: string } }).task.status; }
function git(root: string, ...args: string[]): string { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function seedLegacyTask(root: string, repoId: string, taskId: string): void {
  const actor = { principal: { personId: "owner" }, executor: null } as const, event: TaskEventV1 = { schema: "task-event/v1", eventId: "event-contract-receipt", workspaceRevision: 1, opId: "op-contract-receipt", taskId, type: "task_created", actor, source: "local", occurredAt: "2026-08-18T00:00:00.000Z", payload: { task: { schema: "task/v1", taskId, title: "Legacy contract receipt", taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null } } };
  makeTaskEventStore({ repoId, rootDir: root }).append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
}
function seedAttachableRuntime(root: string, repoId: string, runtimeSessionId: string): void {
  const actor = { principal: { personId: "owner" }, executor: null } as const, definition: AgentDefinitionSnapshot = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "runtime-instance-attach-live", installationId: "runtime-installation-attach-live", kindId: "codex", providerId: "openai", model: "runtime-test-model", reasoningEffort: null, baseUrl: null, authMode: "subscription" }, at = (revision: number) => `2026-08-23T00:00:0${revision}.000Z`;
  const events: AgentRuntimeEventV1[] = [
    { schema: "agent-runtime-event/v1", eventId: "event-runtime-installation-attach-live", workspaceRevision: 1, opId: "op-runtime-installation-attach-live", type: "runtime_installation_observed", actor, source: "local", occurredAt: at(1), payload: { installationId: definition.installationId, kindId: definition.kindId, protocolFamily: "codex", hostRef: "host:local", version: "runtime-test", discoverySource: "wrapper", capabilities: ["structured_witness", "attach"] } },
    { schema: "agent-runtime-event/v1", eventId: "event-runtime-dispatch-attach-live", workspaceRevision: 2, opId: "op-runtime-dispatch-attach-live", type: "runtime_dispatch_requested", actor, source: "local", occurredAt: at(2), payload: { dispatchId: "dispatch-runtime-attach-live", runtimeSessionId, instanceId: definition.instanceId, installationId: definition.installationId, kindId: definition.kindId, idempotencyKey: "runtime-attach-live", definitionSnapshotRef: "artifact:runtime-definition/attach-live", definitionSnapshot: definition } },
    { schema: "agent-runtime-event/v1", eventId: "event-runtime-started-attach-live", workspaceRevision: 3, opId: "op-runtime-started-attach-live", type: "runtime_session_started", actor, source: "local", occurredAt: at(3), payload: { runtimeSessionId, instanceId: definition.instanceId, installationId: definition.installationId, kindId: definition.kindId, definitionSnapshotRef: "artifact:runtime-definition/attach-live", launchGeneration: 1, attachable: true } }
  ];
  const store = makeTaskEventStore({ repoId, rootDir: root }); for (const event of events) store.append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
}
async function probeRuntimeAttach(endpoint: string, repoId: string, runtimeSessionId: string): Promise<{ readonly status: string; readonly elapsedMs: number; readonly initialValues: number }> {
  const started = performance.now(); let initialValues = 0;
  try { const detach = await streamAgentRuntimeAt({ socketPath: endpoint, repoId, payload: { runtimeSessionId, afterCursor: "stream:0" }, onValue: () => { initialValues += 1; }, timeoutMs: 2_000 }); detach(); return { status: "attached", elapsedMs: Math.round(performance.now() - started), initialValues }; }
  catch (error) { return { status: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - started), initialValues }; }
}
function spawnCli(root: string, userRoot: string, args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> { return new Promise((resolve) => { const child = spawn(process.execPath, [cli, "--root", root, "--json", ...args], { env: cliEnv(root, userRoot), stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; }); child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; }); child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() })); }); }
