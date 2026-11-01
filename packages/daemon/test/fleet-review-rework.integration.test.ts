// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";

import { openFleetEdgeRuntime } from "../src/fleet-edge-runtime.ts";
import { dualSyncFixture, ledgerRevision } from "./fleet-dual-sync.fixture.ts";
import { scheduleRuntimePorts, definition } from "./schedule-actions.fixtures.ts";

test(
  "concurrent edge task starts use distinct operation keys and preserve the center rejection",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await dualSyncFixture(scheduleRuntimePorts().runtimeInstances());
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task-start-race", "Start race", "docs-task");
    const results = await Promise.all([
      fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId }),
      fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId }),
    ]);
    assert.equal(results.filter((result) => result.outcome === "applied").length, 1, JSON.stringify(results));
    assert.equal(
      results.filter((result) => result.outcome === "no_changes" && result.code === "no_changes").length,
      1,
      JSON.stringify(results),
    );
    assert.notEqual(results[0]!.opId, results[1]!.opId, "each edge request must have its own operation key");
  },
);

test(
  "edge reviewer binds each resubmitted canonical iteration and rejects historical explicit ids",
  { timeout: 90_000 },
  async (t) => {
    const fixture = await dualSyncFixture(scheduleRuntimePorts().runtimeInstances());
    t.after(() => fixture.close());
    const created = await fixture.createTask("node-one", "task-rework", "Review rework", "docs-task");
    const config = fixture.channel("node-one");
    let launches = 0;
    const launchedPrompts: string[] = [];
    const runtime = openFleetEdgeRuntime({
      readBinding: () => fixture.owners.binding("node-one"),
      controlBinding: () => fixture.owners.binding("node-one"),
      request: { ...config, method: "repo.agentRuntime.spawn", action: {} },
      daemonGeneration: 1,
      daemonRoute: {
        userRoot: path.join(fixture.root, "edge-user"),
        daemonId: "edge",
        endpoint: path.join(fixture.root, "edge.sock"),
      },
      ports: scheduleRuntimePorts(),
      launch: (prepared) => {
        launches += 1;
        launchedPrompts.push(prepared.prompt);
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
        dispatchKey: key,
        ...(executionId === undefined ? {} : { executionId }),
      });
    const boundExecution = (dispatchId: unknown) => {
      const event = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo })
        .read()
        .events.find((event) => event.type === "runtime_dispatch_requested" && event.payload.dispatchId === dispatchId);
      assert.ok(event && event.type === "runtime_dispatch_requested");
      return event.payload.executionId;
    };
    // A spawn receipt returns before the edge runtime's pending-work tail publishes the dispatch's
    // runtime_session_liveness_changed event, so a ledger sample taken straight after the receipt
    // still races that append. Wait for the discrete landed event instead of tolerating a drift.
    const waitLivenessPublished = async (runtimeSessionIds: readonly string[]): Promise<void> => {
      const deadline = performance.now() + 15_000;
      for (;;) {
        const live = new Set(
          makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo })
            .read()
            .events.flatMap((event) =>
              event.type === "runtime_session_liveness_changed" && event.payload.liveness === "live"
                ? [event.payload.runtimeSessionId]
                : [],
            ),
        );
        if (runtimeSessionIds.every((runtimeSessionId) => live.has(runtimeSessionId))) return;
        if (performance.now() >= deadline)
          throw new Error(`Runtime liveness did not publish for ${runtimeSessionIds.join(", ")}.`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    // A changes_requested review verdict reopens each rework round automatically
    // (dec_E369B861 CH3); the reviewer records under its own agent actor.
    const reviewAuth = {
      transportKind: "unix-socket" as const,
      unixSocketOwnerBoundary: {
        ownerUid: process.getuid?.() ?? 501,
        source: "unix-socket-filesystem-owner-boundary" as const,
      },
      sessionEnvironment: { HARNESS_ACTOR: "agent:fleet-reviewer" },
    };
    const recordVerdict = async (iteration: number, executionId: string, verdict: "approved" | "changes_requested") => {
      const stem = `rework-${iteration}`;
      mkdirSync(path.join(fixture.repo, "harness", created.packagePath, "artifacts", "reports"), { recursive: true });
      writeFileSync(
        path.join(fixture.repo, "harness", created.packagePath, "artifacts", "reports", `${stem}.md`),
        `# Review ${stem}\n\nEdge rework round verdict.\n`,
      );
      writeFileSync(
        path.join(fixture.repo, "harness", `${stem}.json`),
        JSON.stringify({
          verdict,
          reason: `Round ${iteration} verdict.`,
          evidenceChecked: ["closeout.md"],
          findings:
            verdict === "changes_requested"
              ? [{ findingId: "fixture-finding", blocking: true, text: "Fixture review requires another pass." }]
              : [],
          resolutions:
            iteration > 0
              ? [{ reviewId: `review-rework-${iteration - 1}`, findingId: "fixture-finding", resolution: "withdrawn" }]
              : [],
        }),
      );
      const reviewed = (await fixture.host.run(
        "dual-repo",
        {
          kind: "task-review-execution",
          taskId: created.taskId,
          executionId,
          reviewId: `review-${stem}`,
          fromFile: `harness/${stem}.json`,
        } as never,
        reviewAuth as never,
      )) as Record<string, unknown>;
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed).slice(0, 1200));
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
      if (iteration > 0) {
        const responded = await fixture.edgeTask("node-one", {
          kind: "task-respond-review",
          taskId: created.taskId,
          executionId,
          responses: [
            {
              reviewId: `review-rework-${iteration - 1}`,
              findingId: "fixture-finding",
              disposition: "rebut",
              rationale: `Iteration ${iteration} explains why the prior finding is not present in this cut.`,
            },
          ],
        });
        assert.equal(responded.ok, true, JSON.stringify(responded));
      }
      const submitted = await fixture.edgeTask("node-one", {
        kind: "task-submit",
        taskId: created.taskId,
        executionId,
      });
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      // The edge runtime answers from the resident replica after the center-side submit lands.
      assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
      const reviewers: string[] = [];
      for (const explicit of [false, true]) {
        const result = await spawn(`review-${iteration}-${explicit}`, explicit ? executionId : undefined);
        assert.equal(result.outcome, "applied", JSON.stringify(result));
        assert.equal(boundExecution(result.dispatchId), executionId);
        reviewers.push(String(result.runtimeSessionId));
        assert.doesNotMatch(
          launchedPrompts.at(-1)!,
          /# Living Deliverable Protocol|最终代码 commit 后先运行 `ha task submit <task-id>` 冻结交付事实/u,
          "edge reviewer dispatches carry no worker delivery protocols",
        );
      }
      if (iteration === 1) {
        // A promptless reviewer derives its mission from the same mirrored package, but the
        // prior owner return belongs only to the implementation action.
        const derived = await runtime.run("repo.agentRuntime.spawn", {
          taskId: created.taskId,
          role: "reviewer",
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          dispatchKey: `derived-mission-${iteration}`,
        });
        assert.equal(derived.outcome, "applied", JSON.stringify(derived));
        const mission = launchedPrompts.at(-1)!;
        assert.doesNotMatch(mission, /# Owner rework instruction/u);
        assert.doesNotMatch(mission, /# Owner return for iteration 0/u);
        assert.doesNotMatch(mission, /Revise the delivery\./u);
        assert.doesNotMatch(
          mission,
          /# Living Deliverable Protocol|最终代码 commit 后先运行 `ha task submit <task-id>` 冻结交付事实/u,
        );
        assert.doesNotMatch(launchedPrompts[0]!, /# Owner rework instruction/u);
      }
      if (iteration > 0) {
        await waitLivenessPublished(reviewers);
        const before = ledgerRevision(fixture),
          launchCount = launches;
        await assert.rejects(spawn(`stale-${iteration}`, "execution-rework-0"), { code: "review_target_missing" });
        assert.equal(ledgerRevision(fixture), before);
        assert.equal(launches, launchCount);
      }
      // Below the budget the adverse verdict itself reopens the next round; the final round
      // approves and stays at the gate.
      await recordVerdict(iteration, executionId, iteration < 2 ? "changes_requested" : "approved");
      assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
    }
    // No held implementation lease remains after submission.
    await assert.rejects(spawn("implementation", undefined, "implementation"), { code: "execution_missing" });
    assert.equal(launches, 7);
  },
);
