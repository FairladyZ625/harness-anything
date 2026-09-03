// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActorIdentity, AuthorizationDecision, WriteReceipt } from "../../kernel/src/index.ts";
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
const authorizationDecision: AuthorizationDecision = {
  policyRef: "default@5",
  actor: caller,
  subject: `task/${taskId}`,
  bindingsUsed: [{ predicate: "hasRoleBinding", satisfied: true, role: "repo-write", matched: null }],
  outcome: "allowed",
  reasonCodes: ["authorization_allowed"],
  nextActions: [],
  evaluatedAtCut: "canonical:2",
};
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
      schema: "task/v2",
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
      pinned: false,
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
    authorizationDecision,
  };
}
function setup(
  initial = snapshot(),
  rejectStage?: CloseoutStep,
  setupCaller = caller,
  closeoutAction: Readonly<Record<string, unknown>> = {
    kind: "task-closeout",
    taskId,
    fromFile: "judgment.json",
  },
  presetSnapshotCurrent = true,
) {
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
        action: closeoutAction,
        caller: setupCaller,
        authorizationDecision: { ...authorizationDecision, actor: setupCaller },
        opId: "op-closeout",
        readPacket: () => readWorkspaceText(rootDir, fromFile, "fromFile"),
        read: async () => initial as never,
        presetSnapshotCurrent: () => presetSnapshotCurrent,
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

test("closeout runs four canonical leaf commands without impersonating the creator's executor", async () => {
  const value = setup();
  try {
    const receipt = await value.run();
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.authorizationDecision?.policyRef, "default@5");
    assert.equal(receipt.authorizationDecision?.outcome, "allowed");
    assert.equal(
      receipt.authorizationDecision?.bindingsUsed.some(
        (binding) => binding.predicate === "hasRoleBinding" && binding.satisfied === true,
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
      ["worker-agent", null, "worker-agent", "worker-agent"],
    );
    assert.deepEqual(value.calls.at(-1)?.action.paths, ["packages/application/src/task-closeout-action.ts"]);
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});
test("closeout upgrades a stale preset snapshot before the first lifecycle mutation", async () => {
  const value = setup(snapshot(), undefined, caller, undefined, false);
  try {
    const receipt = await value.run();
    assert.equal(receipt.outcome, "applied");
    assert.deepEqual(
      value.calls.map(({ stage }) => stage),
      ["preset-upgrade", "submit", "review-execution", "review-consent", "complete"],
    );
    assert.deepEqual(value.calls[0]?.action, { kind: "preset-upgrade", taskId });
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
test("a submitted execution resumes when the packet omits its locked submission", async () => {
  const value = setup(snapshot("in_review", [execution(executionId, "submitted")])),
    { submission: _locked, ...resumePacket } = judgment();
  writeFileSync(path.join(value.rootDir, "judgment.json"), JSON.stringify(resumePacket));
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
test("a mismatched resubmission reports the locked content and the omission repair", async () => {
  const value = setup(snapshot("in_review", [execution(executionId, "submitted")]));
  writeFileSync(
    path.join(value.rootDir, "judgment.json"),
    JSON.stringify({
      ...judgment(),
      submission: { ...judgment().submission, completionClaim: "Different but valid." },
    }),
  );
  try {
    const receipt = await value.run();
    assert.equal(receipt.code, "submission_mismatch");
    assert.match(JSON.stringify(receipt.diagnostic), /\\"completionClaim\\":\\"Complete\.\\"/u);
    assert.match(guidanceCommands(receipt), /ha task closeout/u);
    assert.equal(value.calls.length, 0);
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});
test("one invalid closeout response names every bad field", async () => {
  const value = setup();
  writeFileSync(
    path.join(value.rootDir, "judgment.json"),
    JSON.stringify({
      submission: {
        completionClaim: "",
        deliverables: "command",
        outputs: ["CLI"],
        verificationNotes: ["tests"],
        knownGaps: [],
        residualRisks: [],
        commitSha: "short",
      },
      review: { verdict: "PASS", reason: "", evidenceChecked: "tests" },
      consent: { approved: false },
      completion: { ci: "green", codeDocPaths: ["../escape"] },
    }),
  );
  try {
    const receipt = await value.run(),
      report = JSON.stringify(receipt.diagnostic);
    assert.equal(receipt.code, "invalid_judgment");
    for (const field of [
      "packet.submission.completionClaim",
      "packet.submission.deliverables",
      "packet.submission.commitSha",
      "packet.review.verdict",
      "packet.review.reason",
      "packet.review.evidenceChecked",
      "packet.consent.approved",
      "packet.completion.ci",
      "packet.completion.codeDocPaths[0]",
    ])
      assert.equal(report.includes(field), true, report);
    assert.match(report, /Closeout packet has 9 error\(s\)/u);
    assert.equal(value.calls.length, 0);
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});
test("the task-aware template omits submission after submit and selects the contract CI value", async () => {
  const value = setup(snapshot("in_review", [execution(executionId, "submitted")]), undefined, caller, {
    kind: "task-closeout",
    taskId,
    printTemplate: true,
  });
  try {
    const receipt = await value.run(),
      template = JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
    assert.equal(receipt.outcome, "applied");
    assert.equal(Object.hasOwn(template, "submission"), false);
    assert.deepEqual(template.completion, { ci: "not_applicable", codeDocPaths: ["path/to/code-or-doc"] });
    assert.equal(value.calls.length, 0);
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
    assert.equal(receipt.authorizationDecision?.outcome, "allowed");
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
      guidanceCommands(receipt),
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
      assert.match(guidanceCommands(receipt), /\bha\s/u);
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
      guidanceCommands(receipt),
      /ha task closeout task-closeout --from-file judgment\.json --execution-id execution-a/u,
    );
    assert.match(guidanceCommands(receipt), /--execution-id execution-b/u);
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
    assert.match(guidanceCommands(receipt), /ha task closeout/u);
  } finally {
    rmSync(value.rootDir, { recursive: true, force: true });
  }
});

function guidanceCommands(receipt: WriteReceipt): string {
  return (receipt.guidance ?? [])
    .flatMap((entry) => (typeof entry.args.command === "string" ? [entry.args.command] : []))
    .join("\n");
}
