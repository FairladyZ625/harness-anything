// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { CiRunObservationEventV3, CompletionEvidenceV1 } from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import type { RepoCellBinding, Snapshot } from "../src/repo-cell-types.ts";
import { completeTask, prepareSubmissionEvidence, readLatestCiEvidence } from "../src/repo-cell-task-progress.ts";
import { projectionReady } from "../src/repo-cell-settlement.ts";

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
  return {
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
    submission: {
      completionClaim: "Done",
      commitSha,
      deliverables,
      outputs: ["Deleted-Production-Paths: old.ts"],
      verificationNotes: ["Tests passed"],
      knownGaps: [],
      residualRisks: [],
      evidenceRefs: [],
    },
  } as Snapshot["executions"][number];
}
function observation(
  sha: string,
  revision = 1,
  conclusion: string | null = "success",
  workflow = "rewrite-ci",
  branch = "main",
): CiRunObservationEventV3 {
  return {
    schema: "ci-run-observation/v3",
    eventId: `event-${revision}`,
    opId: `op-${revision}`,
    workspaceRevision: revision,
    type: "ci_run_observed",
    actor,
    source: "local",
    occurredAt: "2026-09-12T00:00:00.000Z",
    payload: {
      run: { runId: `run-${revision}`, sha, branch, prNumber: null, job: workflow, wallclockMs: 0, runner: "test" },
      verification:
        conclusion === null
          ? null
          : {
              source: workflow === "ledger-publication" ? "write-coordinator" : "github-actions",
              workflow,
              runId: `run-${revision}`,
              attempt: 1,
              headSha: sha,
              conclusion,
            },
      tests: [],
      gates: [],
    },
  };
}
function fixture(
  rootDir: string,
  submitted: Snapshot["executions"][number],
  events: CiRunObservationEventV3[],
  gates = ["ci", "code-doc-reconciliation"],
) {
  const snapshot = {
    revision: 1,
    task: { iteration: 0, completionGateIds: gates },
    executions: [submitted],
    codeDocWitnesses: [],
    gateWitnesses: [],
  } as unknown as Snapshot;
  const read = { snapshot, packagePath: "harness/tasks/task" },
    calls: unknown[] = [];
  const cell = {
    rootDir,
    projectionReady,
    service: { read: async () => read },
    projection: {
      read: () => read,
      readCiRunObservations: () => ({ status: "ready", events, watermark: 2, sourceRevision: 2 }),
    },
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    lifecycleAction: async (action: unknown) => {
      calls.push(action);
      return { outcome: "applied", opId: "reconcile" };
    },
    publishCiWitness: (
      _task: string,
      _execution: string,
      _snapshot: unknown,
      _path: unknown,
      _binding: unknown,
      evidence: CompletionEvidenceV1,
    ) => {
      calls.push(evidence);
      return { outcome: "applied", opId: "witness" };
    },
  } as unknown as RepoCellOperationalContext;
  return { cell, snapshot, calls };
}

test("automatic CI evidence selects exact and descendant main runs, excluding unrelated runs and rejecting non-main descendants", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-evidence-"));
  try {
    const submitted = init(root),
      current = execution(submitted);
    git(root, "commit", "--allow-empty", "-qm", "descendant");
    const descendant = git(root, "rev-parse", "HEAD");
    assert.equal(readLatestCiEvidence(fixture(root, current, [observation(submitted)]).cell, current)?.result, "pass");
    assert.equal(readLatestCiEvidence(fixture(root, current, [observation(descendant)]).cell, current)?.result, "pass");
    assert.equal(readLatestCiEvidence(fixture(root, current, [observation("f".repeat(40))]).cell, current), null);
    assert.throws(
      () =>
        readLatestCiEvidence(
          fixture(root, current, [observation(descendant, 1, "success", "rewrite-ci", "feature")]).cell,
          current,
        ),
      { code: "invalid_proof" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unverified latest observation rejects and latest real red never falls back to older green", async () => {
  const current = execution(publicSha);
  const unverified = fixture(publicRoot, current, [
    observation(current.submission!.commitSha, 2, null),
    observation(current.submission!.commitSha),
  ]);
  assert.throws(() => readLatestCiEvidence(unverified.cell, current), { code: "invalid_proof" });
  const red = fixture(publicRoot, current, [
    observation(current.submission!.commitSha, 2, "failure"),
    observation(current.submission!.commitSha),
  ]);
  Object.assign(red.snapshot, {
    gateWitnesses: [
      {
        ...readLatestCiEvidence(
          fixture(publicRoot, current, [observation(current.submission!.commitSha)]).cell,
          current,
        ),
        executionId: "execution",
        iteration: 0,
        commitSha: current.submission!.commitSha,
      },
    ],
  });
  assert.equal(readLatestCiEvidence(red.cell, current)?.result, "fail");
  await assert.rejects(prepareSubmissionEvidence(red.cell, "task", "execution", binding), { code: "invalid_proof" });
  assert.deepEqual(red.calls, []);
});

test("private ledger ancestor observation supports its cut and pending publication provides no witness", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-ledger-evidence-"));
  try {
    init(root);
    const ledger = path.join(root, "harness"),
      submitted = init(ledger),
      current = execution(submitted);
    git(ledger, "commit", "--allow-empty", "-qm", "published");
    const published = git(ledger, "rev-parse", "HEAD"),
      observed = fixture(root, current, [observation(published, 1, "success", "ledger-publication", "ledger")]);
    assert.equal(readLatestCiEvidence(observed.cell, current)?.result, "pass");
    const pending = fixture(root, current, []);
    assert.equal(readLatestCiEvidence(pending.cell, current), null);
    await prepareSubmissionEvidence(pending.cell, "task", "execution", binding);
    assert.deepEqual(pending.calls, [{ kind: "task-code-doc-reconcile", taskId: "task", paths: [] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public and private cuts reject cross-kind exact and descendant witnesses", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-cut-kind-"));
  try {
    const publicCommit = init(root),
      ledger = path.join(root, "harness"),
      privateCommit = init(ledger);
    git(root, "commit", "--allow-empty", "-qm", "public descendant");
    git(ledger, "commit", "--allow-empty", "-qm", "private descendant");
    for (const [cut, sha, workflow, branch] of [
      [publicCommit, publicCommit, "ledger-publication", "ledger"],
      [publicCommit, git(root, "rev-parse", "HEAD"), "ledger-publication", "main"],
      [privateCommit, privateCommit, "rewrite-ci", "main"],
      [privateCommit, git(ledger, "rev-parse", "HEAD"), "rewrite-ci", "main"],
      [publicCommit, publicCommit, "rewrite-ci", "feature"],
    ]) {
      const current = execution(cut!);
      assert.throws(
        () =>
          readLatestCiEvidence(
            fixture(root, current, [observation(sha!, 2, "success", workflow, branch)]).cell,
            current,
          ),
        { code: "invalid_proof" },
      );
    }
    const current = execution(privateCommit);
    assert.equal(
      readLatestCiEvidence(
        fixture(root, current, [observation(privateCommit, 1, "success", "ledger-publication", "ledger")]).cell,
        current,
      )?.result,
      "pass",
    );
    // If both object stores contain a commit, the public witness boundary wins.
    git(root, "fetch", ledger, "HEAD");
    assert.throws(
      () =>
        readLatestCiEvidence(
          fixture(root, current, [observation(privateCommit, 1, "success", "ledger-publication", "ledger")]).cell,
          current,
        ),
      { code: "invalid_proof" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pure deletion reconciles empty paths and surviving deliverables reconcile without deletion output", async () => {
  for (const paths of [[], ["packages/daemon/src/live.ts"]]) {
    const current = execution(publicSha, paths),
      prepared = fixture(publicRoot, current, [observation(current.submission!.commitSha)]);
    const steps = await prepareSubmissionEvidence(prepared.cell, "task", "execution", binding);
    assert.deepEqual(prepared.calls[0], { kind: "task-code-doc-reconcile", taskId: "task", paths });
    assert.deepEqual(
      steps.map((step) => step.opId),
      ["reconcile", "witness"],
    );
  }
});

test("retry after a lost response reuses canonical cut witnesses without another append", async () => {
  const current = execution(publicSha),
    prepared = fixture(publicRoot, current, [observation(current.submission!.commitSha)]),
    evidence = readLatestCiEvidence(prepared.cell, current)!;
  Object.assign(prepared.snapshot, {
    codeDocWitnesses: [
      {
        schema: "code-doc-witness/v1",
        executionId: "execution",
        iteration: 0,
        commitSha: current.submission!.commitSha,
        paths: [],
        witnessId: "reconciled",
      },
    ],
    gateWitnesses: [{ ...evidence, executionId: "execution", iteration: 0, commitSha: current.submission!.commitSha }],
  });
  assert.deepEqual(await prepareSubmissionEvidence(prepared.cell, "task", "execution", binding), []);
  assert.deepEqual(prepared.calls, []);
});

test("pending projection cannot select stale green and failed reconciliation stops before CI publication", async () => {
  const current = execution(publicSha),
    pending = fixture(publicRoot, current, [observation(current.submission!.commitSha)]);
  Object.assign(pending.cell.projection, {
    readCiRunObservations: () => ({ status: "pending", events: [], watermark: 1, sourceRevision: 2 }),
  });
  assert.throws(() => readLatestCiEvidence(pending.cell, current), { code: "content_not_ready" });
  const rejected = fixture(publicRoot, current, [observation(current.submission!.commitSha)]);
  Object.assign(rejected.cell, {
    lifecycleAction: async () => ({ outcome: "commit_unknown", code: "publication_indeterminate", opId: "reconcile" }),
  });
  const steps = await prepareSubmissionEvidence(rejected.cell, "task", "execution", binding);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.code, "publication_indeterminate");
  assert.deepEqual(rejected.calls, []);
});

test("completed receipt replay does not inspect a newer red or unavailable CI observation", async () => {
  const current = execution(publicSha),
    prepared = fixture(publicRoot, current, [observation(current.submission!.commitSha, 2, "failure")]);
  Object.assign(prepared.snapshot.task!, { taskId: "task", status: "done", createdBy: actor });
  const packagePath = "harness/tasks/task",
    completedEvent = { opId: "completed-original" },
    receipt = { outcome: "applied", opId: completedEvent.opId },
    proof = { durable: true, canonicalVisible: true, worktreeVisible: true },
    read = { snapshot: prepared.snapshot, packagePath, status: "ready", watermark: 2, sourceRevision: 2 };
  Object.assign(prepared.cell, {
    input: { repoId: "repo" },
    requiredCellText: (value: string) => value,
    service: { read: async () => read },
    operationId: () => "retry-operation",
    store: { publication: () => "published" },
    publicPublication: (value: unknown) => value,
    lifecycleReceipt: (event: unknown) => {
      assert.equal(event, completedEvent);
      return receipt;
    },
    receiptProof: () => proof,
    completionApplied: (value: unknown) => value,
  });
  Object.assign(prepared.cell.projection, {
    read: () => read,
    readTaskCompletion: () => completedEvent,
    readCiRunObservations: () => {
      assert.fail("completed replay must not read newer CI observations");
    },
    readRelationQuery: () => ({ rows: [], status: "ready" }),
    readDocument: (target: string) => ({
      watermark: 2,
      sourceRevision: 2,
      document: {
        body: target.endsWith("task-contract.json")
          ? JSON.stringify({ documents: [{ slot: "task.closeout", path: "closeout.md" }] })
          : "## Summary\nDone.\n## Verification\nVerified.\n## Residual Risk\nNone.\n" +
            "## Same Mechanism Elsewhere\nChecked.\n",
      },
    }),
  });
  assert.equal(
    await completeTask(prepared.cell, { kind: "task-complete", taskId: "task", executionId: "execution" }, {
      ...binding,
      authorizationDecision: { outcome: "allowed" },
    } as RepoCellBinding),
    receipt,
  );
});
