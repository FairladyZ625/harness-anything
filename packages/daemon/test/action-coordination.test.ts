// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActorIdentity, TaskLifecycleSnapshot } from "../../kernel/src/index.ts";
import { authorizeAction, createAuthorizationActionEnvelope } from "../src/authorization.ts";
import { coordinateAction, executeActionCoordination } from "../src/action-coordination.ts";
import { buildCommand } from "../src/repo-cell-command.ts";
import { openFleetLeaseBroker } from "../src/lease-broker.ts";
import { resolveTaskLifecycleIntent, resolveUniqueCatalogActionByIntent } from "../src/repo-cell-lifecycle-intent.ts";
import type { RepoCellBinding, RepoTaskAction } from "../src/repo-cell-types.ts";

const lifecycleActor: ActorIdentity = {
  principal: { personId: "person-lifecycle-intent" },
  executor: null,
};
const lifecycleBinding: RepoCellBinding = {
  actor: lifecycleActor,
  source: "local",
};
const lifecycleSubmission = {
  completionClaim: "implemented",
  deliverables: ["resolver"],
  outputs: ["tests"],
  verificationNotes: ["checked"],
  knownGaps: [],
  residualRisks: [],
  commitSha: "a".repeat(40),
};
const lifecycleReview = {
  schema: "review/v1" as const,
  reviewId: "review-intent",
  taskId: "task-intent",
  executionId: "execution-intent",
  verdict: "approved" as const,
  actor: lifecycleActor,
  capabilityRef: "test-reviewer",
  reason: "checked",
  evidenceChecked: ["test"],
  commitSha: lifecycleSubmission.commitSha,
  iteration: 0 as const,
  contentDigest: `sha256:${"b".repeat(64)}` as const,
  reviewedAt: "2026-08-25T00:00:00.000Z",
};
const lifecycleSnapshot = {
  revision: 3,
  task: { iteration: 0 },
  executions: [
    {
      schema: "execution/v1",
      executionId: "execution-intent",
      taskId: "task-intent",
      nodeId: "implementation",
      iteration: 0,
      state: "submitted",
      actor: lifecycleActor,
      claimedAt: "2026-08-25T00:00:00.000Z",
      submittedAt: "2026-08-25T00:01:00.000Z",
      closedAt: null,
      submission: lifecycleSubmission,
    },
  ],
  reviews: [lifecycleReview],
  consents: [],
  codeDocWitnesses: [],
  gateWitnesses: [],
  edgesTaken: [],
  lease: null,
} as unknown as TaskLifecycleSnapshot;

test("lifecycle ingress resolution is the single kind-to-intent adapter used by buildCommand", () => {
  const cases: readonly {
    readonly action: RepoTaskAction;
    readonly intentId: string;
  }[] = [
    {
      action: { kind: "task-start", taskId: "task-intent", executionId: "execution-intent" },
      intentId: "StartExecution",
    },
    {
      action: { kind: "task-transition", taskId: "task-intent", status: "blocked", reason: "blocked" },
      intentId: "TransitionTask",
    },
    {
      action: {
        kind: "task-submit",
        taskId: "task-intent",
        executionId: "execution-intent",
        submission: lifecycleSubmission,
      },
      intentId: "SubmitExecution",
    },
    {
      action: {
        kind: "task-review-execution",
        taskId: "task-intent",
        executionId: "execution-intent",
        reviewId: "review-next",
        jsonInput: JSON.stringify({ verdict: "approved", reason: "checked", evidenceChecked: ["test"] }),
      },
      intentId: "RecordReview",
    },
    {
      action: {
        kind: "task-review-consent",
        taskId: "task-intent",
        executionId: "execution-intent",
        reviewId: "review-intent",
        consentId: "consent-intent",
      },
      intentId: "RecordReviewConsent",
    },
    {
      action: {
        kind: "task-code-doc-reconcile",
        taskId: "task-intent",
        executionId: "execution-intent",
        commitSha: "c".repeat(40),
        iteration: 0,
        paths: ["packages/daemon/src/repo-cell-command.ts"],
      },
      intentId: "ReconcileCodeDoc",
    },
    {
      action: {
        kind: "task-code-doc-repoint",
        taskId: "task-intent",
        record: "record-intent",
        commitSha: "d".repeat(40),
        paths: ["packages/daemon/src/repo-cell-command.ts"],
        reason: "move the witness",
      },
      intentId: "RepointCodeDoc",
    },
    {
      action: { kind: "task-complete", taskId: "task-intent", executionId: "execution-intent" },
      intentId: "CompleteTask",
    },
  ];
  for (const { action, intentId } of cases) {
    const resolution = resolveTaskLifecycleIntent(action);
    assert.equal(resolution.type, "participant", action.kind);
    if (resolution.type !== "participant") assert.fail(`${action.kind} did not resolve`);
    assert.equal(resolution.intentId, intentId, action.kind);
    assert.equal(
      buildCommand(action, "task-intent", lifecycleBinding, "repo-intent", 3, ".", lifecycleSnapshot).type,
      resolution.intentId,
      action.kind,
    );
  }
});

test("lifecycle ingress resolver explicitly classifies non-participants and invalid ingress", () => {
  for (const kind of ["task-create", "task-progress-append", "task-release", "task-show"])
    assert.deepEqual(resolveTaskLifecycleIntent({ kind }), {
      type: "non-participant",
      ingressKind: kind,
    });
  assert.deepEqual(resolveTaskLifecycleIntent({}), {
    type: "unknown",
    ingressKind: null,
  });
});

test("catalog intent lookup fails closed unless exactly one Action matches", () => {
  const unique = { intentId: "StartExecution", coordination: { marker: "unique" } };
  assert.deepEqual(resolveUniqueCatalogActionByIntent([unique], "StartExecution"), {
    type: "matched",
    intentId: "StartExecution",
    action: unique,
  });
  assert.deepEqual(resolveUniqueCatalogActionByIntent([], "StartExecution"), {
    type: "missing",
    intentId: "StartExecution",
  });
  assert.deepEqual(resolveUniqueCatalogActionByIntent([unique, { ...unique }], "StartExecution"), {
    type: "ambiguous",
    intentId: "StartExecution",
    matches: 2,
  });
});

test("fleet dry-run consumes the catalog plan without reserving or defaulting TTL", async () => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "ha-action-coordination-"));
  const observed: Readonly<Record<string, unknown>>[] = [];
  const assignment = {
    nodeId: "node-dry-run",
    assignmentId: "assignment-dry-run",
    repoId: "repo-dry-run",
    taskId: "task-dry-run",
    executionId: "execution-dry-run",
    paths: [],
    viewId: "view-dry-run",
    expiresAt: "2099-01-01T00:00:00.000Z",
    actor: lifecycleActor,
  } as const;
  const broker = openFleetLeaseBroker({
    stateRoot,
    host: {
      run: (async (_repoId: string, action: Readonly<Record<string, unknown>>) => {
        observed.push(action);
        return action.kind === "task-show"
          ? {
              outcome: "applied",
              opId: "show-dry-run",
              revision: 0,
              evidence: JSON.stringify({ lease: null }),
            }
          : {
              outcome: "pending",
              opId: "preview-dry-run",
              revision: 0,
              code: null,
            };
      }) as never,
    },
    resolveAssignment: (assignmentId) => (assignmentId === assignment.assignmentId ? assignment : null),
    now: () => "2026-08-25T00:00:00.000Z",
  });
  try {
    const result = await broker.handleTaskCommand(
      assignment.nodeId,
      {
        schema: "fleet.task.command/v1",
        messageId: "message-dry-run",
        assignmentId: assignment.assignmentId,
        writerEpoch: 1,
        opId: "operation-dry-run",
        repoId: assignment.repoId,
        taskId: assignment.taskId,
        action: {
          kind: "task-start",
          taskId: assignment.taskId,
          dryRun: true,
        },
        waitMs: 1_000,
        docChanges: null,
        mirrorBaseCut: null,
      },
      () => false,
    );
    assert.equal(result.outcome, "op_rejected");
    assert.deepEqual(broker.status().leases, []);
    assert.equal(observed[1]?.kind, "task-start");
    assert.equal(Object.hasOwn(observed[1]!, "ttlMs"), false);
  } finally {
    broker.close();
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("coordination plan distinguishes each facet mutation", () => {
  const disabled = {
      dryRun: "disabled",
      wipAdmission: null,
      fleetProvisionalReservation: "disabled",
      fifo: "disabled",
    } as const,
    runtime = { dryRunRequested: true },
    baseline = coordinateAction(disabled, runtime);
  assert.deepEqual(baseline, {
    execution: "execute",
    wipAdmission: null,
    fleetProvisionalReservation: "skip",
    fifo: "bypass",
  });

  const mutations = [
    {
      name: "dryRun",
      facet: { ...disabled, dryRun: "supported" as const },
      field: "execution",
      expected: "preview",
    },
    {
      name: "wipAdmission",
      facet: { ...disabled, wipAdmission: { nextStatus: "active" as const } },
      field: "wipAdmission",
      expected: { nextStatus: "active" },
    },
    {
      name: "fleetProvisionalReservation",
      facet: { ...disabled, fleetProvisionalReservation: "required" as const },
      field: "fleetProvisionalReservation",
      expected: "reserve",
    },
    {
      name: "fifo",
      facet: { ...disabled, fifo: "required" as const },
      field: "fifo",
      expected: "enqueue",
    },
  ] as const;
  for (const mutation of mutations) {
    const plan = coordinateAction(mutation.facet, runtime);
    assert.notDeepEqual(plan, baseline, mutation.name);
    assert.deepEqual(plan[mutation.field], mutation.expected, mutation.name);
  }

  assert.deepEqual(
    coordinateAction(
      {
        dryRun: "supported",
        wipAdmission: { nextStatus: "active" },
        fleetProvisionalReservation: "required",
        fifo: "required",
      },
      runtime,
    ),
    {
      execution: "preview",
      wipAdmission: { nextStatus: "active" },
      fleetProvisionalReservation: "skip",
      fifo: "enqueue",
    },
  );
});

test("coordination consumes declared WIP and dry-run facets without an action-kind branch", async () => {
  const calls: string[] = [];
  const result = await executeActionCoordination(
    coordinateAction(
      {
        dryRun: "supported",
        wipAdmission: { nextStatus: "active" },
        fleetProvisionalReservation: "required",
        fifo: "required",
      },
      {
        dryRunRequested: true,
      },
    ),
    {
      admitWip: (nextStatus) => calls.push(`wip:${nextStatus}`),
      preview: () => {
        calls.push("preview");
        return "previewed";
      },
      execute: () => {
        calls.push("execute");
        return "executed";
      },
    },
  );
  assert.equal(result, "previewed");
  assert.deepEqual(calls, ["wip:active", "preview"]);
});

test("disabled coordination values execute without dry-run or WIP hooks", async () => {
  const calls: string[] = [];
  const result = await executeActionCoordination(
    coordinateAction(
      {
        dryRun: "disabled",
        wipAdmission: null,
        fleetProvisionalReservation: "disabled",
        fifo: "disabled",
      },
      {
        dryRunRequested: true,
      },
    ),
    {
      admitWip: () => calls.push("wip"),
      preview: () => {
        calls.push("preview");
        return "previewed";
      },
      execute: () => {
        calls.push("execute");
        return "executed";
      },
    },
  );
  assert.equal(result, "executed");
  assert.deepEqual(calls, ["execute"]);
});

test("daemon authorization keeps attempt identity independent from caller idempotency", () => {
  const actor: ActorIdentity = {
    principal: { personId: "person-authorization" },
    executor: null,
  };
  const action = createAuthorizationActionEnvelope(
    "task.complete",
    "task/task_authorization",
    actor,
    "authorization-attempt-1",
    "caller-operation-1",
  );
  assert.equal(action.actionId, "authorization-attempt-1");
  assert.equal(action.idempotencyKey, "caller-operation-1");
  assert.notEqual(action.actionId, action.idempotencyKey);
  const retried = createAuthorizationActionEnvelope(
    "task.complete",
    "task/task_authorization",
    actor,
    "authorization-attempt-2",
    "caller-operation-1",
  );
  const separate = createAuthorizationActionEnvelope(
    "task.complete",
    "task/task_authorization",
    actor,
    "authorization-attempt-2",
    "caller-operation-2",
  );
  assert.notEqual(retried.actionId, action.actionId);
  assert.equal(retried.idempotencyKey, action.idempotencyKey);
  assert.notEqual(separate.idempotencyKey, action.idempotencyKey);
  assert.equal(
    authorizeAction(
      "task.complete",
      "task/task_authorization",
      actor,
      "authorization-attempt-3",
      "caller-operation-1",
      { target: { owner: actor }, evaluatedAtCut: "canonical:1" },
    ).outcome,
    "allowed",
  );
});
