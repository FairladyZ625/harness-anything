// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { sha256Text, submissionDigest } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { dispatchStreamPath } from "../src/daemon-host/dispatch-stream.ts";
import { applyFleetMirrorCut } from "../src/daemon-host/fleet-edge-mirror.ts";
import { openFleetEdgeRuntime } from "../src/daemon-host/fleet-edge-runtime.ts";
import { runFleetEdgeTask } from "../src/daemon-host/fleet-edge-task.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { fleetFixture, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { catchUpReplica, startResidentReplicaSync } from "./replica-catch-up.fixture.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

for (const reviewer of [false, true])
  test(
    reviewer
      ? "a center owner can abandon an unreachable reviewer after an amended cut"
      : "a center owner ruling durably closes an unreachable edge attempt without claiming a physical stop",
    { timeout: 120_000 },
    async (t) => {
      const fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"]),
        { repoId, nodeId } = fixture.subject,
        owner = localAuthFixture(),
        cut = reviewer ? await submitReviewerTask(fixture, owner) : null;
      const center = await fixture.center(),
        workspaceRoot = path.join(fixture.root, "unreachable-edge"),
        viewRoot = path.join(fixture.root, "unreachable-view"),
        quotaBytes = 64 * 1024 * 1024;
      mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true });
      writeFileSync(
        path.join(workspaceRoot, "harness/harness.yaml"),
        "schema: harness-anything/v1\nname: unreachable-edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
      );
      const connection = {
        readAccessToken: fixture.owners.readAccessToken(fixture.subject.nodeId),
        port: center.port,
        ca: fixture.cert,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        diskQuotaBytes: quotaBytes,
      };
      await catchUpReplica(connection);
      const resident = startResidentReplicaSync({ ...connection, hostname: "127.0.0.1" });
      fixture.track(resident.close);
      applyFleetMirrorCut(viewRoot, fixture.subject.repoId, workspaceRoot, "pull");
      let executionCredential: string | undefined;
      const runtime = openFleetEdgeRuntime({
        readBinding: () => fixture.owners.binding(fixture.subject.nodeId),
        readAccessToken: fixture.owners.readAccessToken(fixture.subject.nodeId),
        controlBinding: () => fixture.owners.binding(fixture.subject.nodeId),
        resolveLocation: () => ({
          host: "127.0.0.1",
          port: center.port,
          caPath: fixture.certFile,
          nodeId: fixture.subject.nodeId,
          credential: "machine-secret",
          repoId: fixture.subject.repoId,
          viewRoot,
          quotaBytes,
          workspaceRoot,
          method: "repo.agentRuntime.spawn",
          action: {},
        }),
        daemonGeneration: 1,
        daemonRoute: {
          userRoot: path.join(fixture.root, "unreachable-edge-user"),
          daemonId: "unreachable-edge",
          endpoint: path.join(fixture.root, "unreachable-edge.sock"),
        },
        ports: scheduleRuntimePorts(),
        launch: (prepared) => {
          executionCredential = prepared.env.HARNESS_EXECUTION_CREDENTIAL;
          return {
            pid: 2_147_483_647,
            onOutput: () => undefined,
            onErrorOutput: () => undefined,
            onExit: () => undefined,
            terminate: () => undefined,
          };
        },
      });
      fixture.track(() => runtime.close());
      const launched = await runtime.run("repo.agentRuntime.spawn", {
        taskId: cut?.taskId ?? fixture.subject.taskId,
        ...(reviewer ? { role: "reviewer" } : {}),
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Remain on the unreachable edge.",
        dispatchKey: "center-owner-ruling",
      });
      assert.equal(launched.outcome, "applied", JSON.stringify(launched));
      const runtimeSessionId = String(launched.runtimeSessionId),
        dispatchId = String(launched.dispatchId);
      runtime.close();
      assert.equal(existsSync(dispatchStreamPath(fixture.repo, dispatchId)), false);
      if (cut) {
        writeFileSync(cut.closeoutPath, cut.closeout + "\nAmended evidence after reviewer admission.\n");
        const amended = await fixture.host.run(
          repoId,
          { kind: "task-submit", taskId: cut.taskId, executionId: cut.executionId, amend: true },
          owner,
        );
        assert.equal(amended.outcome, "applied", JSON.stringify(amended));
        const events = makeTaskEventReader({ repoId, rootDir: fixture.repo }).read().events,
          dispatch = events.find(
            (event) => event.type === "runtime_dispatch_requested" && event.payload.dispatchId === dispatchId,
          ),
          amendedCut = events.findLast(
            (event) => event.type === "execution_submitted" && event.payload.execution.executionId === cut.executionId,
          );
        assert.ok(dispatch?.type === "runtime_dispatch_requested" && dispatch.payload.reviewTarget?.kind === "task");
        assert.ok(amendedCut?.type === "execution_submitted" && amendedCut.payload.execution.submission);
        assert.notEqual(
          dispatch.payload.reviewTarget.digest,
          submissionDigest(amendedCut.payload.execution.submission),
        );

        assert.ok(executionCredential);
        const channel = {
          host: "127.0.0.1",
          port: center.port,
          caPath: fixture.certFile,
          nodeId,
          repoId,
          credential: "machine-secret",
          executionCredential,
          viewRoot,
          quotaBytes,
          workspaceRoot,
        };
        const reportPath = path.join(
            workspaceRoot,
            "harness",
            cut.packagePath,
            "artifacts",
            "reports",
            `${dispatchId}.md`,
          ),
          packet = {
            verdict: "approved",
            reason: "Reviewed the original cut.",
            evidenceChecked: ["closeout.md"],
            findings: [],
          };
        mkdirSync(path.dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, "# Review\n\nReviewed the original cut.\n");
        writeFileSync(reportPath.replace(/\.md$/u, ".json"), JSON.stringify(packet));
        const review = await runFleetEdgeTask(
          {
            payload: {
              ...channel,
              action: {
                kind: "task-review-execution",
                taskId: cut.taskId,
                executionId: cut.executionId,
                reviewId: `review-${dispatchId}`,
                ...packet,
              },
            },
          },
          connection.readAccessToken,
        );
        assert.equal(review.code, "execution_credential_rejected", JSON.stringify(review));
        assert.match(String(review.rejectionExplanation ?? review.summary), /amended\/superseded/u);
        const businessWrite = await runFleetEdgeTask(
          {
            payload: {
              ...channel,
              action: {
                kind: "task-progress-append",
                taskId: cut.taskId,
                text: "A stale reviewer cannot write new task progress.",
              },
            },
          },
          connection.readAccessToken,
        );
        assert.equal(businessWrite.code, "execution_credential_rejected", JSON.stringify(businessWrite));
        await assert.rejects(fixture.host.cancelRuntime(repoId, { runtimeSessionId }, owner), {
          code: "execution_scope_mismatch",
        });
      }
      const unprovenBody = "An observation without physical stop proof is not an owner ruling.",
        unprovenSha = sha256Text(unprovenBody),
        outcomeAction = {
          kind: "event",
          type: "runtime_session_outcome_observed",
          opId: "ordinary-unproven-outcome",
          payload: {
            runtimeSessionId,
            dispatchId,
            outcome: cut ? "succeeded" : "unknown",
            exitCode: null,
            resultRef: `artifact:runtime-result/sha256/${unprovenSha}`,
            result: {
              sha256: unprovenSha,
              size: Buffer.byteLength(unprovenBody),
              mediaType: "text/plain; charset=utf-8",
            },
          },
          resultBody: unprovenBody,
        } as const;
      if (cut) {
        const auth = fixture.owners.auth(fixture.subject);
        for (const action of [
          outcomeAction,
          {
            ...outcomeAction,
            opId: "untrusted-owner-abandonment",
            payload: { ...outcomeAction.payload, outcome: "unknown", reasonCode: "ruling_resolved" },
          },
        ]) {
          await assert.rejects(fixture.host.runtimeIngress(repoId, action, auth), {
            code: "execution_credential_rejected",
            message: /withdrawn or superseded/u,
          });
        }
      } else {
        const unproven = await fixture.host.runtimeIngress(repoId, outcomeAction, fixture.owners.auth(fixture.subject));
        assert.equal(unproven.outcome, "op_rejected", JSON.stringify(unproven));
        assert.equal(unproven.code, "runtime_process_group_unproven", JSON.stringify(unproven));
      }
      await resident.close();
      const receipt = await fixture.host.cancelRuntime(
        fixture.subject.repoId,
        { runtimeSessionId, ruling: "The edge is unreachable; explicitly abandon this attempt." },
        owner,
      );
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      assert.equal(receipt.detail, "ruling_resolved");
      const lifecycle = await fixture.host.readDispatchLifecycle(
        fixture.subject.repoId,
        { by: "session", runtimeSessionId },
        owner,
      );
      assert.equal(lifecycle.status, "ready");
      if (lifecycle.status !== "ready") assert.fail("canonical lifecycle must be available");
      assert.equal(lifecycle.rows[0]?.groupPhase, "closed");
      assert.equal(lifecycle.rows[0]?.attempt.stopProof, "unproven");
      assert.equal(lifecycle.rows[0]?.policy.groupSettled, true);
      const repeated = await fixture.host.cancelRuntime(
        fixture.subject.repoId,
        { runtimeSessionId, ruling: "The same owner retries the explicit abandonment." },
        owner,
      );
      assert.equal(repeated.ok, true, JSON.stringify(repeated));
      assert.equal(repeated.detail, "already-exited");
      const events = makeTaskEventReader({ repoId: fixture.subject.repoId, rootDir: fixture.repo }).read().events,
        outcome = events.find(
          (event) =>
            event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
        );
      assert.equal(
        events.filter(
          (event) =>
            event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
        ).length,
        1,
      );
      assert.ok(outcome?.type === "runtime_session_outcome_observed");
      assert.equal(outcome.payload.reasonCode, "ruling_resolved");
      assert.equal(outcome.actor.principal.personId, "person-owner");
      assert.equal(outcome.actor.executor, null);
      assert.deepEqual(outcome.source, { kind: "node", nodeId: fixture.subject.nodeId });
      if (cut) {
        assert.ok(
          !events.some(
            (event) => event.type === "review_recorded" && event.payload.review.reviewId === `review-${dispatchId}`,
          ),
        );
      } else {
        assert.equal(
          events.filter((event) => event.type === "lease_released" && event.taskId === fixture.subject.taskId).length,
          1,
        );
      }
    },
  );

async function submitReviewerTask(
  fixture: Awaited<ReturnType<typeof fleetFixture>>,
  owner: ReturnType<typeof localAuthFixture>,
) {
  const repoId = fixture.subject.repoId,
    taskId = "task-unreachable-reviewer",
    executionId = "execution-unreachable-reviewer";
  const created = await fixture.host.run(
    repoId,
    {
      kind: "task-create",
      taskId,
      title: "Unreachable reviewer",
      presetId: "docs-task",
    },
    owner,
  );
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFleetPublication(fixture.host, repoId, created.opId, owner);
  const packagePath = String(created.packagePath);
  await realizeTaskPlanFixture(fixture.repo, packagePath, (planPath) =>
    fixture.host.run(repoId, { kind: "doc-submit", paths: [planPath] }, owner),
  );
  const started = await fixture.host.run(repoId, { kind: "task-start", taskId, executionId }, owner);
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  const evidence = await fixture.host.run(
    repoId,
    {
      kind: "task-artifact-add",
      taskId,
      content: "Reviewed evidence for the first cut.",
      destination: "evidence.md",
    },
    owner,
  );
  assert.equal(evidence.outcome, "applied", JSON.stringify(evidence));
  const closeoutPath = path.join(fixture.repo, "harness", packagePath, "closeout.md"),
    closeout =
      "# Closeout\n\n## Summary\nFirst cut.\n\n## Verification\nChecked the evidence.\n\n## Residual Risk\nNone.\n\n## Same Mechanism Elsewhere\nReviewer settlement.\n";
  writeFileSync(closeoutPath, closeout);
  const submitted = await fixture.host.run(repoId, { kind: "task-submit", taskId, executionId }, owner);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  await waitForFleetPublication(fixture.host, repoId, submitted.opId, owner);
  return { taskId, executionId, packagePath, closeoutPath, closeout };
}
