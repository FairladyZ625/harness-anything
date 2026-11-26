// harness-test-tier: integration
import { waitForDurableValue } from "../../../tools/fixtures/event-arrival.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { submissionDigest } from "@harness-anything/kernel";

import { openFleetEdgeRuntime } from "../src/daemon-host/fleet-edge-runtime.ts";
import { dualSyncFixture } from "./fleet-dual-sync.fixture.ts";
import { appendRuntimeWorkerRecord, readDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { recordStoppedFixtureContainment } from "./fixtures/runtime-process.ts";
import { scheduleRuntimePorts, definition } from "./schedule-actions.fixtures.ts";

for (const persistedIdentity of ["valid", "expired", "foreign-person"] as const)
  test(`edge restart recovers carried reviewer identity (${persistedIdentity})`, { timeout: 120_000 }, async (t) => {
    const fixture = await dualSyncFixture(scheduleRuntimePorts().runtimeInstances());
    t.after(() => fixture.close());
    const created = await fixture.createTask(
        "node-one",
        "task-edge-review-recovery",
        "Edge review recovery",
        "docs-task",
      ),
      executionId = "execution-edge-review-recovery",
      started = await fixture.edgeTask("node-one", { kind: "task-start", taskId: created.taskId, executionId });
    assert.equal(started.ok, true, JSON.stringify(started));
    writeFileSync(path.join(fixture.repo, "verification.md"), "Verified the center submitted cut.\n");
    const artifact = await fixture.centerRun({
      kind: "task-artifact-add",
      taskId: created.taskId,
      source: "verification.md",
      destination: "verification.md",
    });
    assert.equal(artifact.outcome, "applied", JSON.stringify(artifact));
    await fixture.waitPublished(String(artifact.opId));
    assert.equal((await fixture.edgeDocSync("node-one")).ok, true);
    fixture.writeWorktree(
      "node-one",
      `${created.packagePath}/closeout.md`,
      "# Closeout\n\n## Summary\n\nSubmitted edge review recovery cut.\n\n" +
        "## Verification\n\nChecked the task artifact.\n\n## Residual Risk\n\nNone.\n\n" +
        "## Same Mechanism Elsewhere\n\nFleet review recovery.\n",
    );
    const submitted = await fixture.edgeTask("node-one", { kind: "task-submit", taskId: created.taskId, executionId });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal((await fixture.edgeDocSync("node-one")).ok, true);

    const config = fixture.channel("node-one"),
      launched: { readonly output: (chunk: string) => void; readonly exit: (code: number | null) => void }[] = [];
    const createRuntime = () =>
      openFleetEdgeRuntime({
        readBinding: () => fixture.owners.binding("node-one"),
        readAccessToken: fixture.owners.readAccessToken("node-one"),
        controlBinding: () => fixture.owners.binding("node-one"),
        resolveLocation: () => ({ ...config, method: "repo.agentRuntime.spawn", action: {} }),
        daemonGeneration: 1,
        daemonRoute: {
          userRoot: path.join(fixture.root, "edge-user"),
          daemonId: "edge-review-recovery",
          endpoint: path.join(fixture.root, "edge-review-recovery.sock"),
        },
        ports: scheduleRuntimePorts(),
        launch: () => {
          let output: ((chunk: string) => void) | null = null,
            exit: ((code: number | null) => void) | null = null;
          const launchedProcess = {
            output: (chunk: string) => output?.(chunk),
            exit: (code: number | null) => exit?.(code),
          };
          launched.push(launchedProcess);
          return {
            pid: 2_147_483_647,
            onOutput: (listener: (chunk: string) => void) => {
              output = listener;
            },
            onErrorOutput: () => undefined,
            onExit: (listener: (code: number | null) => void) => {
              exit = listener;
            },
            terminate: () => undefined,
          };
        },
      });
    let runtime = createRuntime();
    t.after(() => runtime.close());
    const spawned = await runtime.run("repo.agentRuntime.spawn", {
      taskId: created.taskId,
      role: "reviewer",
      runtimeInstanceId: definition.instanceId,
      cwd: { scope: "repo-root" },
      prompt: "Review the submitted cut.",
      dispatchKey: "edge-review-recovery",
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const dispatchId = String(spawned.dispatchId),
      runtimeSessionId = String(spawned.runtimeSessionId),
      reportPath = `${created.packagePath}/artifacts/reports/${dispatchId}.md`;
    fixture.writeWorktree("node-one", reportPath, "# Review\n\nVerified the submitted cut from the edge.\n");
    fixture.writeWorktree(
      "node-one",
      reportPath.replace(/\.md$/u, ".json"),
      JSON.stringify({
        verdict: "approved",
        reason: "Verified the submitted cut from the edge.",
        evidenceChecked: ["submitted execution", "closeout.md"],
        findings: [],
      }),
    );
    const recordedBefore = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo })
      .read()
      .events.filter(
        (event) => event.type === "review_recorded" && event.payload.review.reviewId === `review-${dispatchId}`,
      );
    assert.equal(recordedBefore.length, 0, "the test must begin settlement with no canonical Review");
    const provider = launched.at(-1)!;
    provider.output(`${JSON.stringify({ type: "thread.started", thread_id: "edge-review-provider" })}\n`);
    provider.output(
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Review completed." } })}\n`,
    );
    provider.output(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
    await waitForDurableValue(() =>
      makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo })
        .read()
        .events.some(
          (event) =>
            event.type === "runtime_session_liveness_changed" && event.payload.runtimeSessionId === runtimeSessionId,
        )
        ? true
        : null,
    );
    const stream = readDispatchStream(config.workspaceRoot, dispatchId)!;
    const persisted = stream.records.find((record) => record.kind === "execution_principal");
    assert.ok(persisted, "spawn must persist the reviewer principal before restart");
    assert.equal(persisted.role, "reviewer");
    assert.equal(persisted.runtimeSessionId, runtimeSessionId);
    assert.equal(persisted.dispatchId, dispatchId);
    runtime.close();
    // The independent worker exits while its daemon is down. Reopening creates a fresh
    // executionCredentials map; only the dispatch stream can carry this review to the center.
    recordStoppedFixtureContainment({ rootDir: config.workspaceRoot, dispatchId }, 2_147_483_647);
    appendRuntimeWorkerRecord(config.workspaceRoot, dispatchId, {
      kind: "process_exit",
      exitCode: 0,
      signal: null,
      occurredAt: new Date().toISOString(),
    });
    if (persistedIdentity !== "valid")
      appendRuntimeWorkerRecord(config.workspaceRoot, dispatchId, {
        ...persisted,
        ...(persistedIdentity === "expired"
          ? { expiresAt: "2020-01-01T00:00:00.000Z" }
          : { personId: "foreign-person" }),
      });
    const recoveryFailures: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => recoveryFailures.push(args.map(String).join(" ")));
    runtime = createRuntime();
    await runtime.reconcile();

    // The daemon-side parked wait is the settlement event: it returns when the center records the
    // session's terminal outcome, so the ledger read below cannot miss the append it waits for.
    await fixture.awaitRuntimeSessions([runtimeSessionId]);
    const events = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo }).read().events,
      review = events.find(
        (event) => event.type === "review_recorded" && event.payload.review.reviewId === `review-${dispatchId}`,
      ),
      terminal = events.find(
        (event) =>
          event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
      );
    assert.equal(
      events.filter(
        (event) => event.type === "review_recorded" && event.payload.review.reviewId === `review-${dispatchId}`,
      ).length,
      persistedIdentity === "valid" ? 1 : 0,
      JSON.stringify(recoveryFailures),
    );
    if (persistedIdentity !== "valid") {
      assert.ok(terminal?.type === "runtime_session_outcome_observed");
      assert.equal(terminal.payload.outcome, "failed");
      assert.match(
        recoveryFailures.join("\n"),
        persistedIdentity === "expired" ? /expired at 2020-01-01/u : /does not match the recorded principal/u,
      );
      return;
    }
    assert.ok(review?.type === "review_recorded");
    assert.ok(terminal?.type === "runtime_session_outcome_observed");
    assert.equal(review.payload.review.actor.executor?.id, `runtime-session:${runtimeSessionId}`);
    assert.deepEqual(review.source, { kind: "node", nodeId: "node-one" });
    const submittedEvent = events.find(
      (event) => event.type === "execution_submitted" && event.payload.execution.executionId === executionId,
    );
    assert.ok(submittedEvent?.type === "execution_submitted" && submittedEvent.payload.execution.submission);
    assert.equal(review.payload.review.submissionDigest, submissionDigest(submittedEvent.payload.execution.submission));
    assert.ok(
      review.workspaceRevision < terminal.workspaceRevision,
      "the canonical Review must precede terminal outcome",
    );
    assert.equal(terminal.payload.outcome, "succeeded");
    assert.deepEqual(review.payload.review.actor.principal, { personId: persisted.personId });
    assert.deepEqual(
      review.actor,
      review.payload.review.actor,
      "canonical event and review must name the recovered runtime actor",
    );
    await runtime.reconcile();
    const replayed = makeTaskEventReader({ repoId: "dual-repo", rootDir: fixture.repo }).read().events;
    assert.equal(
      replayed.filter(
        (event) => event.type === "review_recorded" && event.payload.review.reviewId === `review-${dispatchId}`,
      ).length,
      1,
    );
    assert.equal(
      replayed.filter(
        (event) =>
          event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
      ).length,
      1,
    );
    assert.equal(
      readFileSync(path.join(fixture.repo, "harness", reportPath), "utf8"),
      "# Review\n\nVerified the submitted cut from the edge.\n",
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(fixture.repo, "harness", reportPath.replace(/\.md$/u, ".json")), "utf8"))
        .verdict,
      "approved",
      "review settlement accepts the JSON packet together with its Markdown report",
    );
  });
