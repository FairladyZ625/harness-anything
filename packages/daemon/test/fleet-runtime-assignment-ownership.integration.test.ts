// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { fleetFixture, git, initRepo, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { scheduleRuntimePorts, definition } from "./schedule-actions.fixtures.ts";

for (const firstExitCode of [0, 1]) {
  test(`same-node assignments settle independently (first exit=${firstExitCode})`, { timeout: 60_000 }, async (t) => {
    const fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"]);
    const second = {
      ...fixture.assignment,
      assignmentId: "assignment-two",
      taskId: "task-second",
      executionId: "execution-second",
      viewId: "node-one_task-second",
      paths: ["tasks/task-second-second"],
    };
    const auth = fixture.owners.auth(second);
    const created = await fixture.host.run(
      second.repoId,
      { kind: "task-create", taskId: second.taskId, title: "Second" },
      auth,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFleetPublication(fixture.host, second.repoId, created.opId, auth);
    await realizeTaskPlanFixture(
      fixture.repo,
      String(created.packagePath),
      (planPath) => fixture.host.run(second.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
      "Second",
    );
    const started = await fixture.host.run(
      second.repoId,
      { kind: "task-start", taskId: second.taskId, executionId: second.executionId },
      auth,
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFleetPublication(fixture.host, second.repoId, started.opId, auth);

    const sequence: string[] = [];
    const counts = new Map<string, { archive: number; release: number; terminal: number }>();
    const terminals = new Map<string, () => void>();
    const settled = new Map<string, () => void>();
    const completion = [fixture.assignment, second].map(
      (assignment) =>
        new Promise<void>((resolve) => {
          settled.set(assignment.taskId, resolve);
          counts.set(assignment.taskId, { archive: 0, release: 0, terminal: 0 });
        }),
    );
    const sessionTasks = new Map<string, string>();
    const center = await fixture.hold(
      listenFleetTls({
        host: {
          ...fixture.host,
          runtimeIngress: async (...args: Parameters<typeof fixture.host.runtimeIngress>) => {
            const command = args[1];
            if (command.kind === "archive") {
              const taskId = command.archive.taskId;
              counts.get(taskId)!.archive += 1;
              sequence.push(`${taskId}:archive`);
            }
            const receipt = await fixture.host.runtimeIngress(...args);
            if (command.kind === "event" && command.type === "runtime_session_outcome_observed") {
              const taskId = sessionTasks.get(String(command.payload.runtimeSessionId))!;
              counts.get(taskId)!.terminal += 1;
              sequence.push(`${taskId}:terminal`);
              settled.get(taskId)!();
            }
            return receipt;
          },
          run: async (...args: Parameters<typeof fixture.host.run>) => {
            if (args[1].kind === "task-release") {
              counts.get(args[1].taskId)!.release += 1;
              sequence.push(`${args[1].taskId}:release`);
            }
            return fixture.host.run(...args);
          },
        },
        ...fixture.writerOptions,
        stateRoot: fixture.stateRoot,
        key: fixture.key,
        cert: fixture.cert,
        replicaDiskQuotaBytes: 64 * 1024 * 1024,
        authenticate: (nodeId, credential) => nodeId === fixture.assignment.nodeId && credential === "machine-secret",
        nodeOwner: fixture.owners.nodeOwner,
        resolveAssignment: (id) => [fixture.assignment, second].find((item) => item.assignmentId === id) ?? null,
      }),
    );
    const workspaceRoot = path.join(fixture.root, "edge");
    mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    const open = (assignment: typeof fixture.assignment) => {
      const runtime = openFleetEdgeRuntime({
        request: {
          host: "127.0.0.1",
          port: center.port,
          caPath: fixture.certFile,
          nodeId: assignment.nodeId,
          credential: "machine-secret",
          assignmentId: assignment.assignmentId,
          repoId: assignment.repoId,
          viewRoot: path.join(fixture.root, assignment.viewId),
          quotaBytes: 64 * 1024 * 1024,
          workspaceRoot,
          method: "repo.agentRuntime.spawn",
          action: {},
        },
        daemonGeneration: 1,
        daemonRoute: {
          userRoot: path.join(fixture.root, "edge-user"),
          daemonId: "edge",
          endpoint: path.join(fixture.root, "edge.sock"),
        },
        ports: scheduleRuntimePorts(),
        launch: () => {
          let output: ((chunk: string) => void) | undefined;
          return {
            pid: 81234,
            onOutput: (listener) => {
              output = listener;
            },
            onErrorOutput: () => undefined,
            onExit: (listener) => {
              terminals.set(assignment.taskId, () => {
                output?.(
                  `${JSON.stringify({ type: "thread.started", thread_id: `provider-${assignment.taskId}` })}\n${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "Task completed." } })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
                );
                listener(assignment.taskId === fixture.assignment.taskId ? firstExitCode : 0);
              });
            },
            terminate: () => {
              throw new Error("another assignment must not terminate this process");
            },
          };
        },
      });
      fixture.track(() => runtime.close());
      return runtime;
    };
    for (const assignment of [fixture.assignment, second]) {
      const viewRoot = path.join(fixture.root, assignment.viewId);
      await runFleetReplicaPullClient({
        port: center.port,
        ca: fixture.cert,
        nodeId: assignment.nodeId,
        credential: "machine-secret",
        assignmentId: assignment.assignmentId,
        viewRoot,
        diskQuotaBytes: 64 * 1024 * 1024,
      });
      applyFleetMirrorCut(viewRoot, assignment.repoId, workspaceRoot, "pull");
    }
    initRepo(workspaceRoot);
    const remote = path.join(fixture.root, "worker-remote.git");
    git(workspaceRoot, "init", "--bare", remote);
    git(workspaceRoot, "remote", "add", "origin", remote);
    for (const assignment of [fixture.assignment, second]) {
      const workerRoot = path.join(workspaceRoot, ".worktrees", assignment.taskId);
      git(workspaceRoot, "worktree", "add", "-b", assignment.taskId, workerRoot);
      writeFileSync(path.join(workerRoot, "delivery.txt"), assignment.taskId);
      git(workerRoot, "add", "delivery.txt");
      git(workerRoot, "commit", "-qm", "feat: deliver task result");
    }
    const first = open(fixture.assignment);
    const a = await first.run("repo.agentRuntime.spawn", {
      taskId: fixture.assignment.taskId,
      runtimeInstanceId: definition.instanceId,
      cwd: { scope: "repo-relative", path: `.worktrees/${fixture.assignment.taskId}` },
      prompt: "Finish first.",
      idempotencyKey: "first",
    });
    assert.equal(a.outcome, "applied", JSON.stringify(a));
    sessionTasks.set(String(a.runtimeSessionId), fixture.assignment.taskId);
    const relay = path.join(workspaceRoot, ".harness", `r-${String(a.dispatchId).slice("dispatch_".length)}.sock`);
    writeFileSync(relay, "owner callback");
    const other = open(second);
    try {
      await other.run("repo.agentRuntime.overview", {});
    } finally {
      t.diagnostic(
        JSON.stringify({ checkpoint: "second-assignment-open", callbackExists: existsSync(relay), sequence }),
      );
    }
    assert.deepEqual(
      counts.get(fixture.assignment.taskId),
      { archive: 0, release: 0, terminal: 0 },
      JSON.stringify(sequence),
    );
    assert.equal(existsSync(relay), true, "opening another assignment preserves the owner's callback");
    await other.run("repo.agentRuntime.cancel", { runtimeSessionId: a.runtimeSessionId });
    assert.equal(existsSync(relay), true, "cross-assignment cancellation preserves the owner's callback");
    const b = await other.run("repo.agentRuntime.spawn", {
      taskId: second.taskId,
      runtimeInstanceId: definition.instanceId,
      cwd: { scope: "repo-relative", path: `.worktrees/${second.taskId}` },
      prompt: "Finish second.",
      idempotencyKey: "second",
    });
    assert.equal(b.outcome, "applied", JSON.stringify(b));
    sessionTasks.set(String(b.runtimeSessionId), second.taskId);
    terminals.get(fixture.assignment.taskId)!();
    await completion[0];
    first.close();
    await open(fixture.assignment).run("repo.agentRuntime.overview", {});
    assert.deepEqual(
      counts.get(second.taskId),
      { archive: 0, release: 0, terminal: 0 },
      "first owner restart must leave the second live task alone",
    );
    terminals.get(second.taskId)!();
    await Promise.all(completion);
    other.close();
    writeFileSync(relay, "owner callback after terminal");
    await open(second).run("repo.agentRuntime.overview", {});
    assert.equal(existsSync(relay), true, "another assignment must not remove a terminal owner callback");
    for (const [taskId, count] of counts)
      assert.deepEqual(count, { archive: 1, release: 1, terminal: 1 }, `${taskId}: ${JSON.stringify(sequence)}`);
    const events = makeTaskEventReader({ repoId: second.repoId, rootDir: fixture.repo }).read().events;
    for (const [runtimeSessionId, expected] of [
      [a.runtimeSessionId, firstExitCode === 0 ? "succeeded" : "failed"],
      [b.runtimeSessionId, "succeeded"],
    ]) {
      const outcomes = events.filter(
        (event) =>
          event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
      );
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]?.payload.outcome, expected);
    }
    t.diagnostic(JSON.stringify({ sequence, counts: Object.fromEntries(counts) }));
  });
}
