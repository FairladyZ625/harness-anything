// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActorIdentity, WriteReceipt } from "../../kernel/src/index.ts";
import { runTaskCloseoutAction, type CloseoutStep } from "../../application/src/task-closeout-action.ts";
import { readWorkspaceText } from "../src/workspace-text-port.ts";

const taskId = "task-closeout",
  executionId = "execution-closeout",
  commitSha = "a".repeat(40),
  caller = actor("worker-agent"),
  owner = actor("owner-agent"),
  worker = actor("worker-agent");
function actor(id: string): ActorIdentity {
  return { principal: { personId: "owner" }, executor: { kind: "agent", id } };
}
function judgment() {
  return {
    submission: {
      completionClaim: "Complete.",
      deliverables: ["command"],
      outputs: ["CLI"],
      verificationNotes: ["tests"],
      knownGaps: [],
      residualRisks: [],
      commitSha,
    },
    review: {
      verdict: "approved",
      reason: "Approved.",
      evidenceChecked: ["tests"],
    },
    consent: { approved: true },
    completion: {
      ci: "not_applicable",
      codeDocPaths: ["packages/application/src/task-closeout-action.ts"],
    },
  };
}
function execution(id = executionId, state: "active" | "submitted" = "active") {
  return {
    schema: "execution/v1",
    executionId: id,
    taskId,
    nodeId: "implementation",
    iteration: 0,
    state,
    actor: worker,
    claimedAt: "2026-08-22T00:00:00.000Z",
    submittedAt: state === "submitted" ? "2026-08-22T00:01:00.000Z" : null,
    closedAt: null,
    submission: state === "submitted" ? judgment().submission : null,
  };
}
function snapshot(state: "active" | "in_review" = "active", executions = [execution()]) {
  return {
    revision: 2,
    task: {
      schema: "task/v1",
      taskId,
      title: "Closeout",
      taskClass: "standard",
      status: state,
      graph: { maxIterations: 1, nodes: [], edges: [] },
      currentNode: state === "active" ? "implementation" : "review",
      iteration: 0,
      createdBy: owner,
      completionGateIds: [],
      presetSnapshotDigest: null,
    },
    executions,
    reviews: [],
    consents: [],
    codeDocWitnesses: [],
    gateWitnesses: [],
    edgesTaken: [],
    lease:
      state === "active"
        ? {
            schema: "lease/v1",
            taskId,
            executionId,
            actor: worker,
            source: "local",
            phase: "held",
            expiresAt: "2026-08-22T01:00:00.000Z",
            ttlMs: 1,
            version: 0,
          }
        : null,
    decisionRelations: [],
  };
}
function applied(stage: string): WriteReceipt {
  return {
    outcome: "applied",
    opId: `op-${stage}`,
    revision: 3,
    evidence: `event:${stage}`,
    visibility: "center",
    proof: {
      committedRevision: 3,
      appliedCut: 3,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: true,
    },
  };
}
function setup(initial = snapshot(), rejectStage?: CloseoutStep, setupCaller = caller) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-closeout-action-")),
    fromFile = "judgment.json";
  writeFileSync(path.join(rootDir, fromFile), JSON.stringify(judgment()));
  const calls: Array<{
      readonly stage: CloseoutStep;
      readonly action: Readonly<Record<string, unknown>>;
      readonly actor: ActorIdentity;
    }> = [],
    run = () =>
      runTaskCloseoutAction({
        rootDir,
        action: { kind: "task-closeout", taskId, fromFile },
        caller: setupCaller,
        opId: "op-closeout",
        readWorkspaceText,
        read: async () => initial as never,
        invoke: async (stage, action, stepActor) => {
          calls.push({ stage, action, actor: stepActor });
          return stage === rejectStage
            ? {
                outcome: "op_rejected",
                opId: `op-${stage}`,
                code: `${stage}-rejected`,
                origin: "daemon",
                evidence: `rejection:${stage}`,
                nextAction: "No command supplied.",
              }
            : applied(stage);
        },
      });
  return { rootDir, calls, run };
}

test("closeout runs four canonical leaf commands with derived actor postures and no system-known selector", async () => {
  const value = setup();
  try {
    const receipt = await value.run();
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.authorizationDecision?.policyRef, "default@2");
    assert.equal(receipt.authorizationDecision?.outcome, "allowed");
    assert.equal(
      receipt.authorizationDecision?.bindingsUsed.some(
        (binding) => binding.predicate === "holdsExecutionLease" && binding.satisfied === true,
      ),
      true,
    );
    assert.deepEqual(
      value.calls.map(({ stage }) => stage),
      ["submit", "review-execution", "review-consent", "complete"],
    );
    assert.ok(value.calls.every(({ action }) => action.executionId === undefined));
    assert.deepEqual(
      value.calls.map(({ actor }) => actor.executor?.id ?? null),
      ["worker-agent", null, "owner-agent", "owner-agent"],
    );
    assert.deepEqual(value.calls.at(-1)?.action.paths, ["packages/application/src/task-closeout-action.ts"]);
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});
test("a submitted execution resumes at review instead of rejecting P2-06", async () => {
  const value = setup(snapshot("in_review", [execution(executionId, "submitted")]));
  try {
    assert.equal((await value.run()).outcome, "applied");
    assert.deepEqual(
      value.calls.map(({ stage }) => stage),
      ["review-execution", "review-consent", "complete"],
    );
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});
test("active closeout requires the exact execution lease holder", async () => {
  const value = setup(snapshot(), undefined, actor("other-agent"));
  try {
    const receipt = await value.run();
    assert.equal(receipt.outcome, "op_rejected");
    assert.equal(receipt.code, "actor_unauthorized");
    assert.equal(receipt.authorizationDecision?.outcome, "denied");
    assert.equal(value.calls.length, 0);
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});
test("an unblocked reviewed execution with no executor points closeout at audited executor repair", async () => {
  const reviewed = snapshot("in_review", [
      {
        ...execution(executionId, "submitted"),
        actor: { principal: owner.principal, executor: null },
      },
    ]),
    value = setup({
      ...reviewed,
      task: { ...reviewed.task, status: "active" },
    } as never);
  try {
    const receipt = await value.run();
    assert.equal(receipt.code, "executor_missing");
    assert.match(
      String(receipt.nextAction),
      /ha task declare-executor task-closeout --execution-id execution-closeout/u,
    );
    assert.equal(value.calls.length, 0);
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});
for (const stage of ["submit", "review-execution", "review-consent", "complete"] as const)
  test(`${stage} refusal names the next ha command`, async () => {
    const value = setup(snapshot(), stage);
    try {
      const receipt = (await value.run()) as WriteReceipt & {
        readonly stoppedAt?: string;
      };
      assert.equal(receipt.outcome, "op_rejected");
      assert.equal(receipt.stoppedAt, stage);
      assert.match(String(receipt.nextAction), /\bha\s/u);
    } finally {
      rmSync(value.rootDir, { recursive: true, force: true });
    }
  });
test("ambiguous submitted cuts fail closed with explicit closeout candidates", async () => {
  const value = setup(
    snapshot("in_review", [execution("execution-a", "submitted"), execution("execution-b", "submitted")]),
  );
  try {
    const receipt = await value.run();
    assert.equal(receipt.code, "ambiguous_execution");
    assert.match(
      String(receipt.nextAction),
      /ha task closeout task-closeout --from-file judgment\.json --execution-id execution-a/u,
    );
    assert.match(String(receipt.nextAction), /--execution-id execution-b/u);
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});
test("closeout rejects judgment intent it would otherwise have to invent", async () => {
  const value = setup();
  writeFileSync(
    path.join(value.rootDir, "judgment.json"),
    JSON.stringify({ ...judgment(), consent: { approved: false } }),
  );
  try {
    const receipt = await value.run();
    assert.equal(receipt.code, "invalid_judgment");
    assert.match(String(receipt.nextAction), /ha task closeout/u);
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});
