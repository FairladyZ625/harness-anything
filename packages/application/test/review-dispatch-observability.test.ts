// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { preflightNodeReviewDispatch } from "../src/commands/node-review-dispatch-preflight.ts";
import {
  dispatchLifecycleView,
  submissionDigest,
  type AgentRuntimeEventV1,
  type DispatchLifecycleGroup,
  type ExecutionV1,
} from "@harness-anything/kernel";
import {
  activeCutReviewDispatches,
  cutReviewTargetKey,
  providerFallbackDispatchKey,
  readCutReviewDispatchState,
  readCutReviewDispatchStates,
  reviewDispatchDiagnostic,
  reviewDispatchFailureWarning,
  reviewDispatchKey,
  reviewResumeFallbackDispatchKey,
  withReviewDispatchFailures,
  type CutReviewDispatchProjection,
} from "../src/queries/review-dispatch-failure-read.ts";
import { fleetVersionWarningMessages } from "../src/queries/fleet-version-warning-read.ts";

const candidate = { taskId: "task-review", executionId: "execution-review", dispatchKey: "review:cut:one" },
  now = () => "2026-11-17T01:00:00.000Z";

for (const code of ["human_confirmation_required", "authentication_required", "oidc_device_expired"]) {
  test(`${code} preserves the provider explanation and adds provider-neutral login recovery`, () => {
    const message = "The configured identity provider rejected the expired session.",
      diagnostic = reviewDispatchDiagnostic({ code, message });
    assert.equal(diagnostic.code, code);
    assert.ok(diagnostic.message.startsWith(message));
    assert.match(diagnostic.message, /ha bootstrap --operation login.*sync this node/u);
    assert.doesNotMatch(diagnostic.message, /Keycloak/iu);
  });
}

for (const [code, message, expected] of [
  [
    "protocol_version_unsupported",
    "Node edge-one build=aaaa differs from center build=bbbb. Run git pull --ff-only, then build CLI and daemon.",
    /edge-one.*aaaa.*bbbb.*git pull --ff-only/u,
  ],
  [
    "edge_default_branch_behind",
    "Edge default branch is behind center main. Run git merge --ff-only origin/main.",
    /git merge --ff-only origin\/main/u,
  ],
  [
    "human_confirmation_required",
    "The command requires an active personal Keycloak access token issued for this center.",
    /Keycloak.*expired.*Sign in/u,
  ],
  ["execution_credential_rejected", "Execution credential rejected.", /credential.*expired.*Sign in/u],
] as const) {
  for (const command of ["task-submit", "task-dispatch-review"]) {
    test(`${command} keeps accepted cut and exposes ${code} in its receipt and canonical failure`, async () => {
      const published: unknown[] = [],
        error = Object.assign(new Error(message), { code }),
        observed = await preflightNodeReviewDispatch({
          candidates: [candidate],
          preflight: async () => {
            throw error;
          },
          diagnostic: (value) =>
            reviewDispatchDiagnostic({ code: (value as typeof error).code, message: (value as Error).message }),
          writeFailure: async (row, failure) => {
            published.push({ row, failure });
          },
          now,
        });
      const result = withReviewDispatchFailures(
        { outcome: "applied", command, opId: "accepted-submission", warnings: ["existing warning"] },
        observed.failures,
      );
      assert.equal(result.outcome, "applied");
      assert.equal(result.opId, "accepted-submission");
      assert.equal(published.length, 1);
      const failure = (result.reviewDispatchFailures as { code: string; message: string }[])[0]!;
      assert.equal(failure.code, code);
      assert.match(failure.message, expected);
      assert.match(String(result.warnings), expected);
      assert.match(reviewDispatchFailureWarning(failure), /review dispatch failed/u);
      assert.equal((result.warnings as string[])[0], "existing warning");
    });
  }
}

test("a healthy preflight or absent candidate adds no failure and performs no canonical write", async () => {
  for (const candidates of [[], [candidate]]) {
    let preflights = 0;
    const receipt = { outcome: "applied", opId: "healthy" };
    const result = await preflightNodeReviewDispatch({
      candidates,
      preflight: async () => {
        preflights++;
      },
      diagnostic: () => {
        throw new Error("unexpected diagnostic");
      },
      writeFailure: async () => {
        throw new Error("unexpected write");
      },
      now,
    });
    assert.equal(withReviewDispatchFailures(receipt, result.failures), receipt);
    assert.equal(preflights, candidates.length);
  }
});

test("failure publication rejection exposes both original preflight and expired login", async () => {
  const result = await preflightNodeReviewDispatch({
    candidates: [candidate],
    preflight: async () => {
      throw Object.assign(new Error("git merge --ff-only origin/main"), { code: "edge_default_branch_behind" });
    },
    diagnostic: (error) =>
      reviewDispatchDiagnostic({ code: (error as { code: string }).code, message: (error as Error).message }),
    writeFailure: async () => {
      throw Object.assign(new Error("Keycloak access token expired"), { code: "human_confirmation_required" });
    },
    now,
  });
  assert.equal(result.failures[0]?.code, "edge_default_branch_behind");
  assert.match(String(result.publicationWarnings), /human_confirmation_required.*Sign in/u);
});

test("fleet warnings identify node, role and repositories and isolate unrelated VM warnings", () => {
  const input = {
    warnings: [
      { nodeId: "edge-one", message: "build aaaa != bbbb" },
      { nodeId: "vm-old", message: "build old != bbbb" },
      { nodeId: "unbound", message: "build unknown" },
    ],
    sessions: [
      { nodeId: "edge-one", lastRepoId: "repo-current" },
      { nodeId: "vm-old", lastRepoId: "repo-other" },
    ],
    replicas: [{ nodeId: "edge-one", repoId: "repo-shared" }],
  };
  const all = fleetVersionWarningMessages(input);
  assert.equal(all.length, 3);
  assert.match(all[0]!, /node=edge-one.*role=edge.*repoIds=repo-current,repo-shared/u);
  assert.match(all[1]!, /node=vm-old.*repoIds=repo-other/u);
  assert.match(all[2]!, /repoIds=unknown/u);
  const current = fleetVersionWarningMessages({ ...input, repoId: "repo-current" });
  assert.equal(current.length, 1);
  assert.doesNotMatch(current.join("\n"), /vm-old|unbound|repo-other/u);
  assert.equal(fleetVersionWarningMessages({ ...input, repoId: "repo-empty" }).length, 0);
});

function makeSubmittedExecution(taskId: string, executionId: string, commitSha: string): ExecutionV1 {
  return {
    schema: "execution/v1",
    executionId,
    taskId,
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor: { principal: { personId: "owner" }, executor: null },
    claimedAt: "2026-11-21T00:00:00.000Z",
    submittedAt: "2026-11-21T00:05:00.000Z",
    closedAt: null,
    submission: {
      schema: "submission/v2",
      commitSha,
      baseCommitSha: "b".repeat(40),
      changedFiles: ["README.md"],
      deliverables: ["README.md"],
      summary: "Submitted cut",
      verification: "Verified",
      residualRisk: "None",
      sameMechanismElsewhere: "Checked",
      submittedAt: "2026-11-21T00:05:00.000Z",
    },
    gateRuns: [],
  } as unknown as ExecutionV1;
}

function makeReviewDispatchRow(input: {
  readonly taskId: string;
  readonly execution: ExecutionV1;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly dispatchKey: string;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
}) {
  return {
    event: {
      schema: "agent-runtime-event/v1",
      eventId: `ev-${input.dispatchId}`,
      workspaceRevision: input.workspaceRevision,
      opId: `op-${input.dispatchId}`,
      occurredAt: input.occurredAt,
      actor: { principal: { personId: "owner" }, executor: null },
      source: "local",
      type: "runtime_dispatch_requested",
      payload: {
        dispatchId: input.dispatchId,
        runtimeSessionId: input.runtimeSessionId,
        instanceId: "review-first",
        kindId: "codex",
        dispatchKey: input.dispatchKey,
        taskId: input.taskId,
        executionId: input.execution.executionId,
        role: "reviewer",
      },
    } as unknown as Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>,
  };
}

function makeSettledLifecycleView(input: {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped";
  readonly revision: number;
  readonly groupPhase?: DispatchLifecycleGroup["phase"];
  readonly controlLeafDispatchId?: string;
}) {
  const phase = input.groupPhase ?? "closed",
    closed = phase === "closed";
  return dispatchLifecycleView(
    {
      attemptGroupId: input.dispatchId,
      currentDispatchId: input.controlLeafDispatchId ?? input.dispatchId,
      phase,
      attempts: [
        {
          dispatchId: input.dispatchId,
          runtimeSessionId: input.runtimeSessionId,
          instanceId: "review-first",
          kindId: "codex",
          fence: { owner: "local", verified: true, token: 1, epoch: 1 },
          reservation: { reservationId: `res-${input.dispatchId}`, instanceId: "review-first", owner: "local" },
          task: null,
          workspaceRef: null,
          phase: closed || phase === "waiting_backoff" ? "closed" : "running",
          process: closed || phase === "waiting_backoff" ? "exited" : "alive",
          stopProof: closed || phase === "waiting_backoff" ? "proven_stopped" : "unproven",
          outcome: closed || phase === "waiting_backoff" ? input.outcome : null,
          effectivePermissionMode: "read-only",
          requestedPermissionMode: "read-only",
          permissionModeSource: "agent",
          admittedRevision: 1,
          eventIds: [],
        },
      ],
      successor: { admissible: !closed, dueAt: null },
      ruling: null,
      delivery: { status: "unregistered", targetRef: null, targetDigest: null, registeredRevision: null },
      revision: input.revision,
    },
    input.dispatchId,
  );
}

test("readCutReviewDispatchStates batches lifecycle reads across cuts, ignores cancelled/stopped, and ranks failures by terminal time", () => {
  const execA = makeSubmittedExecution("task-a", "exe-a", "1".repeat(40)),
    execB = makeSubmittedExecution("task-b", "exe-b", "2".repeat(40)),
    execC = makeSubmittedExecution("task-c", "exe-c", "3".repeat(40)),
    baseA = reviewDispatchKey("task-a", execA, "closeout-reviewer"),
    baseB = reviewDispatchKey("task-b", execB, "closeout-reviewer"),
    baseC = reviewDispatchKey("task-c", execC, "closeout-reviewer");

  assert.match(baseA, new RegExp(submissionDigest(execA.submission!), "u"));

  // task-a: earlier created group failed LATER (01:30), second created group failed EARLIER (01:10),
  // third created group was actively CANCELLED even later (02:00). Must select group 1 (01:30), never cancelled!
  const dispatchesByKey = new Map<string, ReturnType<typeof makeReviewDispatchRow>[]>([
    [
      "task-a:exe-a",
      [
        makeReviewDispatchRow({
          taskId: "task-a",
          execution: execA,
          dispatchId: "disp-a-failed-late",
          runtimeSessionId: "sess-a-1",
          dispatchKey: baseA,
          workspaceRevision: 10,
          occurredAt: "2026-11-21T01:00:00.000Z",
        }),
        makeReviewDispatchRow({
          taskId: "task-a",
          execution: execA,
          dispatchId: "disp-a-failed-early",
          runtimeSessionId: "sess-a-2",
          dispatchKey: `${baseA}:attempt1`,
          workspaceRevision: 20,
          occurredAt: "2026-11-21T01:05:00.000Z",
        }),
        makeReviewDispatchRow({
          taskId: "task-a",
          execution: execA,
          dispatchId: "disp-a-cancelled",
          runtimeSessionId: "sess-a-3",
          dispatchKey: `${baseA}:attempt2`,
          workspaceRevision: 30,
          occurredAt: "2026-11-21T01:50:00.000Z",
        }),
      ],
    ],
    // task-b: cancelled-only + stopped-only groups -> no provider failure reported.
    [
      "task-b:exe-b",
      [
        makeReviewDispatchRow({
          taskId: "task-b",
          execution: execB,
          dispatchId: "disp-b-cancelled",
          runtimeSessionId: "sess-b-1",
          dispatchKey: baseB,
          workspaceRevision: 40,
          occurredAt: "2026-11-21T01:00:00.000Z",
        }),
        makeReviewDispatchRow({
          taskId: "task-b",
          execution: execB,
          dispatchId: "disp-b-stopped",
          runtimeSessionId: "sess-b-2",
          dispatchKey: `${baseB}:attempt1`,
          workspaceRevision: 41,
          occurredAt: "2026-11-21T01:10:00.000Z",
        }),
      ],
    ],
    // task-c: unknown outcome with fallbackState=exhausted -> reported as exhausted failure.
    [
      "task-c:exe-c",
      [
        makeReviewDispatchRow({
          taskId: "task-c",
          execution: execC,
          dispatchId: "disp-c-unknown-exhausted",
          runtimeSessionId: "sess-c-1",
          dispatchKey: baseC,
          workspaceRevision: 50,
          occurredAt: "2026-11-21T01:00:00.000Z",
        }),
      ],
    ],
  ]);

  const outcomeEvents = new Map<string, AgentRuntimeEventV1[]>([
    [
      "sess-a-1",
      [
        {
          schema: "agent-runtime-event/v1",
          eventId: "out-a-1",
          workspaceRevision: 35,
          opId: "op-out-a-1",
          occurredAt: "2026-11-21T01:30:00.000Z",
          actor: { principal: { personId: "owner" }, executor: null },
          source: "local",
          type: "runtime_session_outcome_observed",
          payload: {
            runtimeSessionId: "sess-a-1",
            dispatchId: "disp-a-failed-late",
            outcome: "failed",
            exitCode: 1,
            resultRef: "artifact:none",
            result: null,
            endedAt: "2026-11-21T01:30:00.000Z",
            attempt: { classification: "provider_fault", reason: "later terminal outage", fallbackState: "exhausted" },
          },
        } as unknown as AgentRuntimeEventV1,
      ],
    ],
    [
      "sess-a-2",
      [
        {
          schema: "agent-runtime-event/v1",
          eventId: "out-a-2",
          workspaceRevision: 25,
          opId: "op-out-a-2",
          occurredAt: "2026-11-21T01:10:00.000Z",
          actor: { principal: { personId: "owner" }, executor: null },
          source: "local",
          type: "runtime_session_outcome_observed",
          payload: {
            runtimeSessionId: "sess-a-2",
            dispatchId: "disp-a-failed-early",
            outcome: "failed",
            exitCode: 1,
            resultRef: "artifact:none",
            result: null,
            endedAt: "2026-11-21T01:10:00.000Z",
            attempt: {
              classification: "provider_fault",
              reason: "earlier terminal outage",
              fallbackState: "exhausted",
            },
          },
        } as unknown as AgentRuntimeEventV1,
      ],
    ],
    [
      "sess-a-3",
      [
        {
          schema: "agent-runtime-event/v1",
          eventId: "out-a-3",
          workspaceRevision: 39,
          opId: "op-out-a-3",
          occurredAt: "2026-11-21T02:00:00.000Z",
          actor: { principal: { personId: "owner" }, executor: null },
          source: "local",
          type: "runtime_session_outcome_observed",
          payload: {
            runtimeSessionId: "sess-a-3",
            dispatchId: "disp-a-cancelled",
            outcome: "cancelled",
            exitCode: null,
            resultRef: "artifact:none",
            result: null,
            endedAt: "2026-11-21T02:00:00.000Z",
            attempt: { classification: "worker_stop", reason: "operator cancelled" },
          },
        } as unknown as AgentRuntimeEventV1,
      ],
    ],
    [
      "sess-c-1",
      [
        {
          schema: "agent-runtime-event/v1",
          eventId: "out-c-1",
          workspaceRevision: 55,
          opId: "op-out-c-1",
          occurredAt: "2026-11-21T01:20:00.000Z",
          actor: { principal: { personId: "owner" }, executor: null },
          source: "local",
          type: "runtime_session_outcome_observed",
          payload: {
            runtimeSessionId: "sess-c-1",
            dispatchId: "disp-c-unknown-exhausted",
            outcome: "unknown",
            exitCode: null,
            resultRef: "artifact:none",
            result: null,
            endedAt: "2026-11-21T01:20:00.000Z",
            attempt: {
              classification: "provider_fault",
              reason: "disconnected after all backups exhausted",
              fallbackState: "exhausted",
            },
          },
        } as unknown as AgentRuntimeEventV1,
      ],
    ],
  ]);

  const lifecycleViews = [
    makeSettledLifecycleView({
      dispatchId: "disp-a-failed-late",
      runtimeSessionId: "sess-a-1",
      outcome: "failed",
      revision: 35,
    }),
    makeSettledLifecycleView({
      dispatchId: "disp-a-failed-early",
      runtimeSessionId: "sess-a-2",
      outcome: "failed",
      revision: 25,
    }),
    makeSettledLifecycleView({
      dispatchId: "disp-a-cancelled",
      runtimeSessionId: "sess-a-3",
      outcome: "cancelled",
      revision: 39,
    }),
    makeSettledLifecycleView({
      dispatchId: "disp-b-cancelled",
      runtimeSessionId: "sess-b-1",
      outcome: "cancelled",
      revision: 42,
    }),
    makeSettledLifecycleView({
      dispatchId: "disp-b-stopped",
      runtimeSessionId: "sess-b-2",
      outcome: "stopped",
      revision: 43,
    }),
    makeSettledLifecycleView({
      dispatchId: "disp-c-unknown-exhausted",
      runtimeSessionId: "sess-c-1",
      outcome: "unknown",
      revision: 55,
    }),
  ];

  const lifecycleQueries: unknown[] = [];
  const projection: CutReviewDispatchProjection = {
    readRuntimeDispatchesByTaskExecution: (taskId, executionId) =>
      dispatchesByKey.get(`${taskId}:${executionId}`) ?? [],
    readRuntimeSessionEventsByType: (runtimeSessionId) => outcomeEvents.get(runtimeSessionId) ?? [],
    readDispatchLifecycle: (query) => {
      lifecycleQueries.push(query);
      return { status: "ready", watermark: 60, sourceRevision: 60, rows: lifecycleViews, nextCursor: null };
    },
  };

  const states = readCutReviewDispatchStates(projection, [
    { taskId: "task-a", execution: execA },
    { taskId: "task-b", execution: execB },
    { taskId: "task-c", execution: execC },
  ]);

  assert.equal(lifecycleQueries.length, 1, "must perform a single batched readDispatchLifecycle query across all cuts");
  assert.deepEqual(lifecycleQueries[0], {
    by: "dispatch-batch",
    dispatchIds: [
      "disp-a-failed-late",
      "disp-a-failed-early",
      "disp-a-cancelled",
      "disp-b-cancelled",
      "disp-b-stopped",
      "disp-c-unknown-exhausted",
    ],
  });

  const stateA = states.get(cutReviewTargetKey("task-a", "exe-a"));
  assert.equal(stateA?.activeDispatches.length, 0);
  assert.equal(stateA?.latestFailure?.dispatchId, "disp-a-failed-late");
  assert.equal(stateA?.latestFailure?.reason, "later terminal outage");
  assert.equal(stateA?.latestFailure?.failedAt, "2026-11-21T01:30:00.000Z");

  const stateB = states.get(cutReviewTargetKey("task-b", "exe-b"));
  assert.equal(stateB?.activeDispatches.length, 0);
  assert.equal(
    stateB?.latestFailure,
    null,
    "cancelled and stopped reviews must never be reported as provider failures",
  );

  const stateC = states.get(cutReviewTargetKey("task-c", "exe-c"));
  assert.equal(stateC?.activeDispatches.length, 0);
  assert.equal(stateC?.latestFailure?.dispatchId, "disp-c-unknown-exhausted");
  assert.match(stateC?.latestFailure?.reason ?? "", /disconnected after all backups exhausted/u);
});

test("pre-admission fallback exhaustion ranks by authoritative canonical terminal event time and revision over stale inherited payload.endedAt", () => {
  const exec = makeSubmittedExecution("task-exhaust", "exe-exhaust", "4".repeat(40)),
    base = reviewDispatchKey("task-exhaust", exec, "closeout-reviewer"),
    dispatches = [
      makeReviewDispatchRow({
        taskId: "task-exhaust",
        execution: exec,
        dispatchId: "disp-exhausted",
        runtimeSessionId: "sess-exhausted",
        dispatchKey: base,
        workspaceRevision: 10,
        occurredAt: "2026-11-21T09:59:00.000Z",
      }),
    ],
    // 10:00 primary failure scheduled fallback; 10:02 pre-admission fallback rejection emitted
    // canonical exhaustion reusing the 10:00 process payload.endedAt without rewriting history.
    outcomeEvents = new Map<string, AgentRuntimeEventV1[]>([
      [
        "sess-exhausted",
        [
          {
            schema: "agent-runtime-event/v1",
            eventId: "out-exhaust-scheduled",
            workspaceRevision: 20,
            opId: "op-out-exhaust-scheduled",
            occurredAt: "2026-11-21T10:00:00.000Z",
            actor: { principal: { personId: "owner" }, executor: null },
            source: "local",
            type: "runtime_session_outcome_observed",
            payload: {
              runtimeSessionId: "sess-exhausted",
              dispatchId: "disp-exhausted",
              outcome: "failed",
              exitCode: 1,
              resultRef: "artifact:none",
              result: null,
              endedAt: "2026-11-21T10:00:00.000Z",
              attempt: {
                classification: "provider_fault",
                reason: "primary provider failed at 10:00",
                fallbackState: "scheduled",
              },
            },
          } as unknown as AgentRuntimeEventV1,
          {
            schema: "agent-runtime-event/v1",
            eventId: "out-exhaust-final",
            workspaceRevision: 30,
            opId: "op-out-exhaust-final",
            occurredAt: "2026-11-21T10:02:00.000Z",
            actor: { principal: { personId: "owner" }, executor: null },
            source: "local",
            type: "runtime_session_outcome_observed",
            payload: {
              runtimeSessionId: "sess-exhausted",
              dispatchId: "disp-exhausted",
              outcome: "failed",
              exitCode: 1,
              resultRef: "artifact:none",
              result: null,
              endedAt: "2026-11-21T10:00:00.000Z",
              attempt: {
                classification: "provider_fault",
                reason: "Provider fallback could not launch review-second: pre-admission rejected",
                fallbackState: "exhausted",
              },
            },
          } as unknown as AgentRuntimeEventV1,
        ],
      ],
    ]),
    lifecycleView = makeSettledLifecycleView({
      dispatchId: "disp-exhausted",
      runtimeSessionId: "sess-exhausted",
      outcome: "failed",
      revision: 30,
    }),
    projection: CutReviewDispatchProjection = {
      readRuntimeDispatchesByTaskExecution: () => dispatches,
      readRuntimeSessionEventsByType: (sessionId) => outcomeEvents.get(sessionId) ?? [],
      readDispatchLifecycle: () => ({
        status: "ready",
        watermark: 35,
        sourceRevision: 35,
        rows: [lifecycleView],
        nextCursor: null,
      }),
    };

  // Intermediate routing failure snapshot written at 10:01 must NOT shadow the 10:02 exhaustion.
  const stateWithIntermediateSnapshot = readCutReviewDispatchState(projection, {
    taskId: "task-exhaust",
    execution: exec,
    recordedFailure: {
      executionId: "exe-exhaust",
      dispatchKey: base,
      code: "agent_runtime_unavailable",
      message: "intermediate routing failure at 10:01",
      failedAt: "2026-11-21T10:01:00.000Z",
    },
  });
  assert.equal(stateWithIntermediateSnapshot.activeDispatches.length, 0);
  assert.equal(stateWithIntermediateSnapshot.latestFailure?.dispatchId, "disp-exhausted");
  assert.equal(
    stateWithIntermediateSnapshot.latestFailure?.reason,
    "Provider fallback could not launch review-second: pre-admission rejected",
  );
  assert.equal(stateWithIntermediateSnapshot.latestFailure?.failedAt, "2026-11-21T10:02:00.000Z");

  // Conversely, a routing failure recorded AFTER exhaustion (10:03) still wins.
  const stateWithLaterSnapshot = readCutReviewDispatchState(projection, {
    taskId: "task-exhaust",
    execution: exec,
    recordedFailure: {
      executionId: "exe-exhaust",
      dispatchKey: `${base}:attempt1`,
      code: "agent_runtime_unavailable",
      message: "subsequent routing failure at 10:03",
      failedAt: "2026-11-21T10:03:00.000Z",
    },
  });
  assert.equal(stateWithLaterSnapshot.latestFailure?.dispatchId, undefined);
  assert.equal(stateWithLaterSnapshot.latestFailure?.reason, "subsequent routing failure at 10:03");
  assert.equal(stateWithLaterSnapshot.latestFailure?.failedAt, "2026-11-21T10:03:00.000Z");
});

test("recorded routing failures are attributed only to the current submission digest after amend", () => {
  const taskId = "task-amended",
    executionId = "exe-amended",
    original = makeSubmittedExecution(taskId, executionId, "1".repeat(40)),
    amended = makeSubmittedExecution(taskId, executionId, "2".repeat(40)),
    projection: CutReviewDispatchProjection = {
      readRuntimeDispatchesByTaskExecution: () => [],
      readRuntimeSessionEventsByType: () => [],
    },
    failure = {
      executionId,
      dispatchKey: reviewDispatchKey(taskId, original, "closeout-reviewer"),
      code: "agent_runtime_unavailable",
      message: "Original cut routing failed",
      failedAt: "2026-11-21T10:01:00.000Z",
    },
    read = (execution: typeof original, recordedFailure: typeof failure) =>
      readCutReviewDispatchState(projection, { taskId, execution, recordedFailure }).latestFailure;

  assert.equal(read(original, failure)?.reason, failure.message);
  assert.equal(read(amended, failure), null);
  assert.equal(read(amended, { ...failure, dispatchKey: "task-review:legacy-unscoped" }), null);

  const currentKey = reviewDispatchKey(taskId, amended);
  for (const dispatchKey of [
    currentKey,
    `${currentKey}:reviewer:closeout-reviewer:attempt1`,
    currentKey.replace(/^task-review:/u, "complete-review:"),
  ]) {
    const current = { ...failure, dispatchKey, message: "Amended cut routing failed" };
    assert.equal(read(amended, current)?.reason, current.message);
  }
});

test("shared review dispatch key suffix helpers recognize combined :resume-fallback:fallback:N and :fallback:N:resume-fallback keys in flight and exhausted", () => {
  const exec = makeSubmittedExecution("task-combo", "exe-combo", "5".repeat(40)),
    base = reviewDispatchKey("task-combo", exec, "closeout-reviewer"),
    attempt1 = `${base}:attempt1`,
    resumeFallbackKey = reviewResumeFallbackDispatchKey(attempt1),
    combinedForwardKey = providerFallbackDispatchKey(resumeFallbackKey, 1),
    combinedReverseKey = reviewResumeFallbackDispatchKey(providerFallbackDispatchKey(attempt1, 1));

  assert.equal(combinedForwardKey, `${base}:attempt1:resume-fallback:fallback:1`);
  assert.equal(combinedReverseKey, `${base}:attempt1:fallback:1:resume-fallback`);

  const rootRow = makeReviewDispatchRow({
      taskId: "task-combo",
      execution: exec,
      dispatchId: "disp-rf-root",
      runtimeSessionId: "sess-rf-root",
      dispatchKey: resumeFallbackKey,
      workspaceRevision: 10,
      occurredAt: "2026-11-21T10:00:00.000Z",
    }),
    leafRow = makeReviewDispatchRow({
      taskId: "task-combo",
      execution: exec,
      dispatchId: "disp-rf-leaf",
      runtimeSessionId: "sess-rf-leaf",
      dispatchKey: combinedForwardKey,
      workspaceRevision: 12,
      occurredAt: "2026-11-21T10:01:00.000Z",
    }),
    invalidRow = makeReviewDispatchRow({
      taskId: "task-combo",
      execution: exec,
      dispatchId: "disp-invalid",
      runtimeSessionId: "sess-invalid",
      dispatchKey: `${attempt1}:fallback:0`,
      workspaceRevision: 13,
      occurredAt: "2026-11-21T10:01:30.000Z",
    });

  // In-flight combined leaf: root is closed with controlLeafDispatchId pointing to the :resume-fallback:fallback:1 leaf.
  const inFlightProjection: CutReviewDispatchProjection = {
    readRuntimeDispatchesByTaskExecution: () => [rootRow, leafRow, invalidRow],
    readRuntimeSessionEventsByType: () => [],
    readDispatchLifecycle: () => ({
      status: "ready",
      watermark: 20,
      sourceRevision: 20,
      rows: [
        makeSettledLifecycleView({
          dispatchId: "disp-rf-root",
          runtimeSessionId: "sess-rf-root",
          outcome: "failed",
          revision: 12,
          groupPhase: "active",
          controlLeafDispatchId: "disp-rf-leaf",
        }),
        makeSettledLifecycleView({
          dispatchId: "disp-rf-leaf",
          runtimeSessionId: "sess-rf-leaf",
          outcome: "failed",
          revision: 12,
          groupPhase: "active",
          controlLeafDispatchId: "disp-rf-leaf",
        }),
      ],
      nextCursor: null,
    }),
  };
  const inFlightActive = activeCutReviewDispatches(inFlightProjection, "task-combo", exec);
  assert.deepEqual(
    inFlightActive.map(({ event }) => event.payload.dispatchId),
    ["disp-rf-leaf"],
  );
  const inFlightState = readCutReviewDispatchState(inFlightProjection, { taskId: "task-combo", execution: exec });
  assert.equal(inFlightState.activeDispatches.length, 1);
  assert.equal(inFlightState.latestFailure, null);

  // Exhausted combined leaf: failure reason must surface from disp-rf-leaf even though root is not the control leaf.
  const exhaustedOutcome = {
      schema: "agent-runtime-event/v1",
      eventId: "out-rf-leaf",
      workspaceRevision: 25,
      opId: "op-out-rf-leaf",
      occurredAt: "2026-11-21T10:05:00.000Z",
      actor: { principal: { personId: "owner" }, executor: null },
      source: "local",
      type: "runtime_session_outcome_observed",
      payload: {
        runtimeSessionId: "sess-rf-leaf",
        dispatchId: "disp-rf-leaf",
        outcome: "failed",
        exitCode: 1,
        resultRef: "artifact:none",
        result: null,
        endedAt: "2026-11-21T10:05:00.000Z",
        attempt: {
          classification: "provider_fault",
          reason: "backup after resume-fallback exhausted",
          fallbackState: "exhausted",
        },
      },
    } as unknown as AgentRuntimeEventV1,
    exhaustedProjection: CutReviewDispatchProjection = {
      readRuntimeDispatchesByTaskExecution: () => [rootRow, leafRow, invalidRow],
      readRuntimeSessionEventsByType: (sessionId) => (sessionId === "sess-rf-leaf" ? [exhaustedOutcome] : []),
      readDispatchLifecycle: () => ({
        status: "ready",
        watermark: 30,
        sourceRevision: 30,
        rows: [
          makeSettledLifecycleView({
            dispatchId: "disp-rf-root",
            runtimeSessionId: "sess-rf-root",
            outcome: "failed",
            revision: 25,
            groupPhase: "closed",
            controlLeafDispatchId: "disp-rf-leaf",
          }),
          makeSettledLifecycleView({
            dispatchId: "disp-rf-leaf",
            runtimeSessionId: "sess-rf-leaf",
            outcome: "failed",
            revision: 25,
            groupPhase: "closed",
            controlLeafDispatchId: "disp-rf-leaf",
          }),
        ],
        nextCursor: null,
      }),
    };
  const exhaustedState = readCutReviewDispatchState(exhaustedProjection, { taskId: "task-combo", execution: exec });
  assert.equal(exhaustedState.activeDispatches.length, 0);
  assert.equal(exhaustedState.latestFailure?.dispatchId, "disp-rf-leaf");
  assert.equal(exhaustedState.latestFailure?.reason, "backup after resume-fallback exhausted");

  // Reverse suffix ordering (:fallback:1:resume-fallback) is recognized identically.
  const reverseRow = makeReviewDispatchRow({
      taskId: "task-combo",
      execution: exec,
      dispatchId: "disp-reverse",
      runtimeSessionId: "sess-reverse",
      dispatchKey: combinedReverseKey,
      workspaceRevision: 31,
      occurredAt: "2026-11-21T10:06:00.000Z",
    }),
    reverseProjection: CutReviewDispatchProjection = {
      readRuntimeDispatchesByTaskExecution: () => [reverseRow],
      readRuntimeSessionEventsByType: () => [],
      readDispatchLifecycle: () => ({
        status: "ready",
        watermark: 32,
        sourceRevision: 32,
        rows: [
          makeSettledLifecycleView({
            dispatchId: "disp-reverse",
            runtimeSessionId: "sess-reverse",
            outcome: "failed",
            revision: 31,
            groupPhase: "active",
            controlLeafDispatchId: "disp-reverse",
          }),
        ],
        nextCursor: null,
      }),
    };
  assert.deepEqual(
    activeCutReviewDispatches(reverseProjection, "task-combo", exec).map(({ event }) => event.payload.dispatchId),
    ["disp-reverse"],
  );
});
