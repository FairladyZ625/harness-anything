// harness-test-tier: contract
import assert from "node:assert/strict";
import { emptyCompletionContract } from "../../kernel/test/domain/completion.fixtures.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { getExecutableEntityAction, readSettingsFacet, reviewDigest, submissionDigest } from "@harness-anything/kernel";
import { compileRepoTaskPackage } from "@harness-anything/preset";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import type { RepoCellBinding, Snapshot } from "../src/repo-cell-types.ts";
import { completeTask } from "../src/repo-cell-task-progress.ts";
import { completionSettlement, completionStopped, projectionReady } from "../src/repo-cell-settlement.ts";
import { deriveActionResult } from "../src/entity-action-catalog-executor.ts";

const actor = { principal: { personId: "owner" }, executor: null } as const;
const binding = { actor, source: "local" } as RepoCellBinding;
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}
function init(root: string): string {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "commit", "--allow-empty", "-qm", `initial ${path.basename(root)}`);
  return git(root, "rev-parse", "HEAD");
}
const publicRoot = mkdtempSync(path.join(tmpdir(), "ha-public-evidence-"));
const publicSha = init(publicRoot);
after(() => rmSync(publicRoot, { recursive: true, force: true }));
function execution(commitSha: string, deliverables: string[] = []): Snapshot["executions"][number] {
  const current = {
    schema: "execution/v1",
    executionId: "execution",
    taskId: "task",
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor,
    claimedAt: "2026-09-12T00:00:00.000Z",
    submittedAt: "2026-09-12T00:01:00.000Z",
    closedAt: null,
    gateRuns: [],
    submission: {
      completionClaim: "Done",
      commitSha,
      deliverables,
      outputs: ["Deleted-Production-Paths: old.ts"],
      verificationNotes: ["Tests passed"],
      knownGaps: [],
      residualRisks: [],
      evidenceRefs: [],
      completionContract: emptyCompletionContract,
    },
  } as Snapshot["executions"][number];
  return current;
}

function fixture(rootDir: string, submitted: Snapshot["executions"][number]) {
  const snapshot = {
      revision: 1,
      task: { iteration: submitted.iteration, completionGateIds: [] },
      executions: [submitted],
      gateWitnesses: [],
    } as unknown as Snapshot,
    read = { snapshot, packagePath: "harness/tasks/task", status: "ready", watermark: 1, sourceRevision: 1 },
    calls: unknown[] = [],
    cell = {
      rootDir,
      projectionReady,
      projection: {},
      service: { read: async () => read },
      lifecycleAction: async (action: unknown) => {
        calls.push(action);
        return { outcome: "applied", opId: "reconcile" };
      },
    } as unknown as RepoCellOperationalContext;
  return { cell, snapshot, calls };
}

test("complete needs no code/doc step: the retired gate is out of the completion path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-complete-reconcile-"));
  try {
    init(root);
    mkdirSync(path.join(root, "packages/daemon/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/daemon/src/live.ts"), "export {};\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "deliverable");
    const sha = git(root, "rev-parse", "HEAD"),
      deliverables = ["packages/daemon/src/live.ts"],
      submitted = execution(sha, deliverables),
      pinned = submissionDigest(submitted.submission!),
      review = {
        schema: "review/v1",
        reviewId: "review-complete",
        taskId: "task",
        executionId: "execution",
        verdict: "approved",
        actor,
        capabilityRef: "default@5",
        reason: "Approved.",
        evidenceChecked: ["tests"],
        commitSha: sha,
        iteration: 0,
        contentDigest: `sha256:${"1".repeat(64)}`,
        submissionDigest: pinned,
        reviewedAt: "2026-09-12T00:02:00.000Z",
      } as Snapshot["reviews"][number],
      settings = readSettingsFacet(""),
      packagePath = "tasks/task-complete-reconcile",
      presetSnapshotDigest = compileRepoTaskPackage({
        rootDir: root,
        settings,
        taskId: "task",
        action: { kind: "task-create", title: "Complete Reconcile Criterion" },
      }).snapshot.digest,
      // A historical task still naming the retired gate in completionGateIds must not change the
      // outcome: the gate is dropped when the contract is resolved.
      snapshot = {
        revision: 1,
        task: {
          taskId: "task",
          status: "in_review",
          currentNode: "review",
          iteration: 0,
          completionGateIds: ["code-doc-reconciliation"],
          createdBy: actor,
          taskClass: "standard",
          presetSnapshotDigest,
        },
        executions: [submitted],
        reviews: [review],
        consents: [
          {
            schema: "review-consent/v1",
            consentId: "consent-complete",
            taskId: "task",
            executionId: "execution",
            reviewId: "review-complete",
            reviewDigest: reviewDigest(review),
            contentDigest: review.contentDigest,
            submissionDigest: pinned,
            actor,
            source: "local",
            consentedAt: "2026-09-12T00:03:00.000Z",
          },
        ],
        gateWitnesses: [],
        lease: null,
        decisionRelations: [],
      } as unknown as Snapshot,
      read = { snapshot, packagePath, status: "ready", watermark: 2, sourceRevision: 2 },
      calls: unknown[] = [],
      readiness = {
        closeout: "ready",
        closeoutPath: `${packagePath}/closeout.md`,
        eligibleDirtyPaths: [],
        projectionStatus: "ready",
        closeoutGates: { review: false, consent: false, factDisposition: false },
      },
      cell = {
        rootDir: root,
        projectionReady,
        input: { repoId: "repo" },
        settings: { read: () => settings, readRepository: () => settings },
        requiredCellText: (value: string) => value,
        operationId: () => "facade-op",
        store: { readContentBlob: () => null, publication: () => "published" },
        completeRetryCommand: () => "ha task complete task",
        completionContext: () => readiness,
        completionStopped,
        completionSettlement,
        lifecycleReceipt: () => ({ outcome: "applied", opId: "completed-op" }),
        receiptProof: () => ({ durable: true, canonicalVisible: true, worktreeVisible: true }),
        completionApplied: (value: unknown, _snapshot: unknown, _execution: unknown, steps: unknown[]) => ({
          ...(value as Record<string, unknown>),
          steps,
        }),
        service: { read: async () => read },
        projection: {
          read: () => read,
          getEntity: () => null,
          readTaskChildCounts: () => ({}),
          readTaskCompletion: () => null,
          readPresetSnapshot: () => ({ status: "ready", snapshot: { profile: { outputShape: "repository-diff" } } }),
          readRelationQuery: (query: { readonly relationType?: string }) =>
            query.relationType === "produces"
              ? { rows: [{ targetRef: "fact/one", state: "active" }], status: "ready" }
              : { rows: [], status: "ready" },
          readDecisions: () => ({ decisions: [], status: "ready" }),
          readDocument: (target: string) => ({
            watermark: 2,
            sourceRevision: 2,
            document: {
              path: target,
              blobSha256: "0".repeat(64),
              body: target.endsWith("task-contract.json")
                ? JSON.stringify({
                    title: "Complete Reconcile Criterion",
                    documents: [
                      {
                        slot: "task.closeout",
                        path: "closeout.md",
                        templateRef: "template://planning/closeout@1",
                        locale: "en-US",
                      },
                    ],
                  })
                : "## Summary\nDone.\n## Verification\nVerified.\n## Residual Risk\nNone.\n" +
                  "## Same Mechanism Elsewhere\nChecked.\n",
            },
          }),
        },
        cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
        lifecycleAction: async (action: unknown) => {
          calls.push(action);
          return { outcome: "applied", opId: "completed-op" };
        },
      } as unknown as RepoCellOperationalContext,
      action = { kind: "task-complete", taskId: "task", executionId: "execution" };
    const receipt = (await completeTask(cell, action, {
      ...binding,
      authorizationDecision: { outcome: "allowed" },
    } as RepoCellBinding)) as unknown as Record<string, unknown>;
    // No reconcile action is issued on the task's behalf, and completion is not stopped on a
    // witness that no longer exists.
    assert.deepEqual(calls, [{ kind: "task-complete", taskId: "task", executionId: "execution" }]);
    assert.notEqual(receipt.code, "code_doc_missing");
    assert.notEqual(receipt.outcome, "op_rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replayed complete retries archiveOnComplete through the regular archive action; baseline and archived tasks skip it", async () => {
  const setup = (overrides: Record<string, unknown>, archiveTasks: RepoCellOperationalContext["archiveTasks"]) => {
    const current = execution(publicSha),
      prepared = fixture(publicRoot, current);
    Object.assign(prepared.snapshot.task!, { taskId: "task", status: "done", createdBy: actor, ...overrides });
    const read = {
      snapshot: prepared.snapshot,
      packagePath: "harness/tasks/task",
      status: "ready",
      watermark: 2,
      sourceRevision: 2,
    };
    Object.assign(prepared.cell, {
      input: { repoId: "repo" },
      requiredCellText: (value: string) => value,
      service: { read: async () => read },
      operationId: () => "retry-operation",
      store: { readContentBlob: () => null, publication: () => "published" },
      publicPublication: (value: unknown) => value,
      lifecycleReceipt: () => ({ outcome: "applied", opId: "completed-original" }),
      receiptProof: () => ({ durable: true, canonicalVisible: true, worktreeVisible: true }),
      completionApplied: (value: unknown, _snapshot: unknown, _execution: unknown, steps: unknown[]) => ({
        ...(value as Record<string, unknown>),
        steps,
      }),
      archiveTasks,
    });
    Object.assign(prepared.cell.projection, {
      read: () => read,
      getEntity: () => null,
      readTaskChildCounts: () => ({}),
      readTaskCompletion: () => ({ opId: "completed-original" }),
      readRelationQuery: () => ({ rows: [], status: "ready" }),
      readDocument: (target: string) => ({
        watermark: 2,
        sourceRevision: 2,
        document: {
          body: target.endsWith("task-contract.json")
            ? JSON.stringify({
                documents: [
                  {
                    slot: "task.closeout",
                    path: "closeout.md",
                    templateRef: "template://planning/closeout@1",
                    locale: "en-US",
                  },
                ],
              })
            : "## Summary\nDone.\n## Verification\nVerified.\n## Residual Risk\nNone.\n" +
              "## Same Mechanism Elsewhere\nChecked.\n",
        },
      }),
    });
    return prepared;
  };
  const complete = (cell: RepoCellOperationalContext) =>
    completeTask(cell, { kind: "task-complete", taskId: "task", executionId: "execution" }, {
      ...binding,
      authorizationDecision: { outcome: "allowed" },
    } as RepoCellBinding) as Promise<Record<string, unknown>>;

  const archived = setup({ archiveOnComplete: true }, (action: unknown) => {
    assert.deepEqual(action, {
      kind: "task-archive",
      taskIds: ["task"],
      reason: "Archived automatically: the task's preset profile declares archiveOnComplete.",
    });
    return { outcome: "applied", opId: "archived" } as ReturnType<RepoCellOperationalContext["archiveTasks"]>;
  });
  assert.deepEqual((await complete(archived.cell)).steps, [{ outcome: "applied", opId: "archived" }]);

  const failed = setup({ archiveOnComplete: true }, () => {
    throw Object.assign(new Error("archive conflict"), { code: "invalid_disposition" });
  });
  const failedReceipt = await complete(failed.cell);
  assert.equal(failedReceipt.outcome, "applied");
  assert.match((failedReceipt.warnings as string[])[0]!, /Auto-archive after completion failed: archive conflict/u);

  const baseline = setup({}, () => assert.fail("baseline tasks never auto-archive"));
  assert.deepEqual((await complete(baseline.cell)).steps, []);

  const alreadyArchived = setup({ archiveOnComplete: true, packageDisposition: "archived" }, () =>
    assert.fail("an already-archived task skips the archive write"),
  );
  assert.deepEqual((await complete(alreadyArchived.cell)).steps, []);
});
