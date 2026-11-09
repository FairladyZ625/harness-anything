// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { submissionDigest, type RuntimeExecutionPrincipal } from "@harness-anything/kernel";
import { requireCurrentExecutionScope, requireExecutionActionScope } from "../src/runtime-execution-scope.ts";
import { reviewerArtifactFiles, reviewerArtifactsForReview } from "../src/reviewer-artifact-publication.ts";

for (const source of ["local", { kind: "node", nodeId: "edge-one" }] as const)
  test(`reviewer ${JSON.stringify(source)} can register its own disk packet or carried report`, (t) => {
    const principal: RuntimeExecutionPrincipal = {
        personId: "person-worker",
        repoId: "repo",
        runtimeSessionId: "runtime-reviewer",
        dispatchId: "dispatch-reviewer",
        taskId: "task-reviewed",
        executionId: "execution-reviewed",
        role: "reviewer",
        source,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      actor = {
        principal: { personId: principal.personId },
        executor: { kind: "agent" as const, id: `runtime-session:${principal.runtimeSessionId}` },
      },
      submission = {} as Parameters<typeof submissionDigest>[0],
      packagePath = "tasks/task-reviewed-package",
      packet = `${packagePath}/artifacts/reports/${principal.dispatchId}.json`,
      action = {
        kind: "task-review-execution",
        taskId: principal.taskId,
        executionId: principal.executionId,
        reviewId: `review-${principal.dispatchId}`,
        fromFile: path.resolve("harness", packet),
      },
      input = {
        action,
        binding: { executionPrincipal: principal, actor, source },
        now: "2026-11-02T00:00:00.000Z",
        projection: {
          read: () => ({ packagePath, snapshot: { executions: [{ executionId: principal.executionId, submission }] } }),
          readRuntimeSession: () => ({
            liveness: "live",
            outcome: null,
            taskBindings: [{ taskId: principal.taskId, executionId: principal.executionId }],
          }),
          readRuntimeDispatch: () => ({
            actor,
            source,
            payload: {
              dispatchId: principal.dispatchId,
              role: "reviewer",
              reviewTarget: {
                kind: "task",
                taskId: principal.taskId,
                executionId: principal.executionId,
                digest: submissionDigest(submission),
              },
            },
          }),
        } as never,
      };
    assert.doesNotThrow(() => requireCurrentExecutionScope(input));
    const report = { path: `${packagePath}/artifacts/reports/${principal.dispatchId}.md` };
    assert.doesNotThrow(() =>
      requireCurrentExecutionScope({ ...input, action: { ...action, fromFile: undefined, docChanges: [report] } }),
    );
    for (const changed of [
      { taskId: "task-other" },
      { reviewId: "review-other" },
      { fromFile: "harness/tasks/task-other/artifacts/reports/other.json" },
      { docChanges: [{ path: `${packagePath}/artifacts/reports/other.md` }] },
      { docChanges: [report, report] },
      { docChanges: [] },
    ])
      assert.throws(() => requireCurrentExecutionScope({ ...input, action: { ...action, ...changed } }), {
        code: "execution_credential_rejected",
      });
    assert.throws(() => requireCurrentExecutionScope({ ...input, action: { ...action, reviewId: "review-other" } }), {
      code: "execution_credential_rejected",
      message: new RegExp(`--review-id review-${principal.dispatchId}.*--from-file`, "u"),
    });
    try {
      requireCurrentExecutionScope({ ...input, action: { ...action, taskId: "task-other" } });
      assert.fail("cross-task review must be rejected");
    } catch (error) {
      assert.equal((error as { code?: string }).code, "execution_credential_rejected");
      t.diagnostic(
        `Cross-task negative control: ${(error as Error & { code: string }).code}: ${(error as Error).message}`,
      );
    }
    assert.throws(() => requireExecutionActionScope({ ...principal, role: "implementation" }, action), {
      code: "execution_credential_rejected",
    });
  });

test("a worker cannot dispatch a reviewer and receives the CEO recovery route", () => {
  const principal: RuntimeExecutionPrincipal = {
    personId: "person-worker",
    repoId: "repo",
    runtimeSessionId: "runtime-worker",
    dispatchId: "dispatch-worker",
    taskId: "task-worker",
    executionId: "execution-worker",
    role: "implementation",
    source: "local",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  assert.throws(
    () => requireExecutionActionScope(principal, { kind: "task-dispatch-review", taskIds: [principal.taskId] }),
    { code: "execution_credential_rejected", message: /CEO.*ha task dispatch-review task-worker/u },
  );
  // An unbound owner session keeps its ordinary repository authorization; this hint only limits task workers.
  assert.doesNotThrow(() =>
    requireExecutionActionScope(
      { ...principal, role: "session", taskId: null, executionId: null },
      { kind: "task-dispatch-review", taskIds: [principal.taskId] },
    ),
  );
});

test("a dispatched reviewer packet is published from the checkout path the mission assigned", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-review-publication-")),
    checkout = path.join(root, ".worktrees", ".review", "task-reviewed", "a".repeat(40)),
    packagePath = "tasks/task-reviewed-package",
    dispatchId = "dispatch-reviewer",
    report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
    packet = `${packagePath}/artifacts/reports/${dispatchId}.json`,
    packetPath = path.join(checkout, "harness", ...packet.split("/")),
    reportPath = path.join(checkout, "harness", ...report.split("/")),
    projection = {
      read: () => ({ packagePath, snapshot: { executions: [] } }),
      readRuntimeSession: () => ({ liveness: "live", outcome: null }),
      readRuntimeDispatch: () => ({ payload: { dispatchId } }),
      readDocument: () => ({ document: null }),
    },
    cell = {
      rootDir: root,
      requiredCellText: (value: unknown) => String(value),
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      projection,
    } as never,
    action = {
      kind: "task-review-execution",
      taskId: "task-reviewed",
      executionId: "execution-reviewed",
      reviewId: `review-${dispatchId}`,
      fromFile: packetPath,
    },
    binding = {
      actor: {
        principal: { personId: "person-reviewer" },
        executor: { kind: "agent", id: "runtime-session:runtime-reviewer" },
      },
    } as never;
  try {
    mkdirSync(path.dirname(packetPath), { recursive: true });
    writeFileSync(reportPath, "# Independent review\n\nThe frozen cut was inspected.\n");
    writeFileSync(
      packetPath,
      JSON.stringify({
        verdict: "approved",
        reason: "Checked the frozen cut.",
        evidenceChecked: ["closeout.md"],
        findings: [],
        resolutions: [],
      }),
    );
    const artifacts = reviewerArtifactsForReview(cell, action as never, binding);
    assert.ok(artifacts, "the checkout packet is a reviewer artifact");
    assert.deepEqual(
      reviewerArtifactFiles({ rootDir: root, packagePath, dispatchId, fromFile: packetPath }),
      { packet, report, packetAbsolute: packetPath, reportAbsolute: reportPath },
      "the mission pair resolves to the checkout files",
    );
    assert.equal(
      reviewerArtifactFiles({
        rootDir: root,
        packagePath,
        dispatchId,
        fromFile: path.join(path.dirname(root), "outside", ...packet.split("/")),
      }),
      null,
      "a pair outside the workspace never resolves",
    );
    assert.deepEqual(
      artifacts.changes.map((change) => change.path),
      [packet, report],
      "publication keeps the canonical logical paths",
    );
    assert.deepEqual(
      artifacts.blobs.map((blob) => blob.body),
      [
        JSON.stringify({
          verdict: "approved",
          reason: "Checked the frozen cut.",
          evidenceChecked: ["closeout.md"],
          findings: [],
          resolutions: [],
        }),
        "# Independent review\n\nThe frozen cut was inspected.\n",
      ],
      "publication carries the bytes written in the checkout",
    );
    // Negative control: the same dispatch identity cannot read a packet outside the workspace.
    assert.equal(
      reviewerArtifactsForReview(
        cell,
        { ...action, fromFile: path.join(tmpdir(), "outside", ...packet.split("/")) } as never,
        binding,
      ),
      null,
      "a packet outside the workspace is not a reviewer artifact",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
