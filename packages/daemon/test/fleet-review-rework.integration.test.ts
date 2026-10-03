// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { dualSyncFixture, ledgerRevision } from "./fleet-dual-sync.fixture.ts";
import { scheduleRuntimePorts, definition } from "./schedule-actions.fixtures.ts";

test(
  "edge reviewer binds each resubmitted canonical iteration and rejects historical explicit ids",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await dualSyncFixture();
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task-rework", "Review rework", "docs-task");
    const config = fixture.channel("node-one");
    let launches = 0;
    const runtime = openFleetEdgeRuntime({
      request: { ...config, method: "repo.agentRuntime.spawn", action: {} },
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(fixture.root, "edge-user"),
        daemonId: "edge",
        endpoint: path.join(fixture.root, "edge.sock"),
      },
      ports: scheduleRuntimePorts(),
      launch: () => {
        launches += 1;
        return {
          pid: 91200 + launches,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    t.after(() => runtime.close());
    const spawn = (key: string, executionId?: string, role = "reviewer") =>
      runtime.run("repo.agentRuntime.spawn", {
        taskId: created.taskId,
        role,
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Review this submitted cut.",
        idempotencyKey: key,
        ...(executionId === undefined ? {} : { executionId }),
      });
    const boundExecution = (dispatchId: unknown) => {
      const event = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo })
        .read()
        .events.find((event) => event.type === "runtime_dispatch_requested" && event.payload.dispatchId === dispatchId);
      assert.ok(event && event.type === "runtime_dispatch_requested");
      return event.payload.executionId;
    };
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const executionId = `execution-rework-${iteration}`;
      const started = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId });
      assert.equal(started.ok, true, JSON.stringify(started));
      // Real artifacts and class-A submit cross TLS, not a fabricated task-show response.
      writeFileSync(path.join(fixture.repo, "verification.md"), `Verified iteration ${iteration}.\n`);
      const artifact = await fixture.centerRun({
        kind: "task-artifact-add",
        taskId: created.taskId,
        source: "verification.md",
        destination: `verification-${iteration}.md`,
      });
      assert.equal(artifact.outcome, "applied", JSON.stringify(artifact));
      await fixture.waitPublished(String(artifact.opId));
      assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
      fixture.writeWorktree(
        "node-one",
        `${created.packagePath}/closeout.md`,
        `# Closeout\n\n## Summary\n\nIteration ${iteration} delivery.\n\n## Verification\n\nChecked iteration ${iteration} artifact.\n\n## Residual Risk\n\nReal provider unverified.\n\n## Same Mechanism Elsewhere\n\nCanonical review selection.\n`,
      );
      const submitted = await fixture.edgeTask("node-one", {
        kind: "task-submit",
        taskId: created.taskId,
        executionId,
      });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      const forward = await fixture.centerRun({
        kind: "task-adjudicate",
        taskId: created.taskId,
        executionId,
        forward: true,
        reason: "Review this iteration.",
      });
      assert.equal(forward.outcome, "applied", JSON.stringify(forward));
      for (const explicit of [false, true]) {
        const result = await spawn(`review-${iteration}-${explicit}`, explicit ? executionId : undefined);
        assert.equal(result.outcome, "applied", JSON.stringify(result));
        assert.equal(boundExecution(result.dispatchId), executionId);
      }
      if (iteration > 0) {
        const before = ledgerRevision(fixture),
          launchCount = launches;
        await assert.rejects(spawn(`stale-${iteration}`, "execution-rework-0"), { code: "review_target_missing" });
        assert.equal(ledgerRevision(fixture), before);
        assert.equal(launches, launchCount);
      }
      if (iteration < 2) {
        const returned = await fixture.centerRun({
          kind: "task-adjudicate",
          taskId: created.taskId,
          executionId,
          return: true,
          reason: "Revise the delivery.",
        });
        assert.equal(returned.outcome, "applied", JSON.stringify(returned));
      }
    }
    // No held implementation lease remains after submission.
    await assert.rejects(spawn("implementation", undefined, "implementation"), { code: "execution_missing" });
    assert.equal(launches, 6);
  },
);
