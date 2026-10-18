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
import { completeTask, prepareSubmissionEvidence } from "../src/repo-cell-task-progress.ts";
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
const codeDocRequirement = {
  gateId: "code-doc-reconciliation",
  appliesTo: "code",
  witness: { kind: "internal", adapterId: "code-doc-reconciliation", adapterOptions: {} },
} as const;
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
      completionContract: { ...emptyCompletionContract, gates: [codeDocRequirement] },
    },
  } as Snapshot["executions"][number];
  return current;
}

function fixture(
  rootDir: string,
  submitted: Snapshot["executions"][number],
  codeDocWitnesses: Snapshot["codeDocWitnesses"] = [],
) {
  const snapshot = {
      revision: 1,
      task: { iteration: submitted.iteration, completionGateIds: ["code-doc-reconciliation"] },
      executions: [submitted],
      codeDocWitnesses,
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

test("pure deletion reconciles empty paths and surviving deliverables reconcile without deletion output", async () => {
  for (const paths of [[], ["packages/daemon/src/live.ts"]]) {
    const current = execution(publicSha, paths),
      prepared = fixture(publicRoot, current);
    const steps = await prepareSubmissionEvidence(prepared.cell, "task", "execution", binding);
    assert.deepEqual(prepared.calls[0], { kind: "task-code-doc-reconcile", taskId: "task", paths });
    assert.deepEqual(
      steps.map((step) => step.opId),
      ["reconcile"],
    );
  }
});
test("retry after a lost response reuses canonical cut witnesses without another append", async () => {
  const current = execution(publicSha),
    prepared = fixture(publicRoot, current, [
      {
        schema: "code-doc-witness/v1",
        witnessId: "reconciled",
        taskId: "task",
        executionId: "execution",
        iteration: 0,
        commitSha: current.submission!.commitSha!,
        paths: [],
        actor,
        source: "local",
        reconciledAt: "2026-09-12T00:02:00.000Z",
      },
    ]);
  assert.deepEqual(await prepareSubmissionEvidence(prepared.cell, "task", "execution", binding), []);
  assert.deepEqual(prepared.calls, []);
});

test("complete without a code-doc witness stops on code_doc_missing under its own criterion", async () => {
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
        codeDocWitnesses: [],
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
        producesFactCount: 1,
        projectionStatus: "ready",
        closeoutGates: { review: false, consent: false, fact: true, factDisposition: false, codeDoc: true },
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
        service: { read: async () => read },
        projection: {
          read: () => read,
          getEntity: () => null,
          readTaskChildCounts: () => ({}),
          readTaskCompletion: () => null,
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
          return {
            outcome: "op_rejected",
            opId: "reconcile-op",
            code: "invalid_command",
            unmetCriteria: [
              {
                ref: "task-lifecycle-review-transitions/reconcile.validate",
                failureCode: "invalid_proof",
                explain: "The witness binds canonical document paths to the submitted commit.",
              },
            ],
          };
        },
      } as unknown as RepoCellOperationalContext,
      action = { kind: "task-complete", taskId: "task", executionId: "execution" };
    const receipt = (await completeTask(cell, action, {
      ...binding,
      authorizationDecision: { outcome: "allowed" },
    } as RepoCellBinding)) as unknown as Record<string, unknown>;
    // The facade receipt settles under the complete Action's own criteria; a leaked
    // reconcile criterion used to abort settlement with invalid_store.
    const settled = deriveActionResult(
      getExecutableEntityAction("task-complete")!,
      action as Parameters<typeof deriveActionResult>[1],
      receipt as Parameters<typeof deriveActionResult>[2],
    );
    assert.deepEqual(calls, []);
    assert.equal(receipt.outcome, "op_rejected");
    assert.equal(receipt.code, "code_doc_missing");
    assert.match(String(receipt.rejectionExplanation), /no canonical code\/doc witness/u);
    assert.match(
      String((receipt.next as { readonly action: string }[])[0]?.action),
      /ha task code-doc reconcile task --path 'packages\/daemon\/src\/live\.ts'/u,
    );
    assert.deepEqual(
      settled.unmetCriteria?.map(({ ref }) => ref),
      ["closeout-readiness/closeoutReadiness"],
    );
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
