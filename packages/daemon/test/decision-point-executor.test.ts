// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decisionPointBindingDigest,
  resolveHarnessLayout,
  type AdvisoryDecision,
  type AgentRuntimeEventV1,
  type DecisionPointDeclaration,
  type DecisionQuestionDeclaration,
  type VerticalDefinition,
} from "@harness-anything/kernel";
import type { RepoCell } from "../src/repo-cell-types.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { incidentDispositionQuestionVersion } from "../src/decision-incident-action.ts";
import {
  decisionPointBindingDigestForVertical,
  openDecisionPointExecutor,
  projectDecisionInput,
} from "../src/decision-point-executor.ts";
import {
  decisionAdvisoryFromProvider,
  decisionAnnotationRetention,
  openDecisionAnnotationStore,
  readDecisionAnnotationsByDispatch,
} from "../src/decision-annotations.ts";
import { appendIncidentActionReceipt, readIncidentActionReceipt } from "../src/decision-incident-receipt.ts";

const dispatchId = "dispatch_a1b2c3d4e5f60718293a4b5c",
  pointId = "dispatch-stop-reason",
  question: DecisionQuestionDeclaration = {
    version: "pilot2-choice-v2",
    type: "choice",
    prompt: "Classify the settlement.",
    options: [
      { id: "environment_unavailable", text: "Environment unavailable" },
      { id: "insufficient_information", text: "Insufficient information" },
    ],
    criteria: {
      environment_unavailable: "An attempted action was rejected by an external environment.",
      insufficient_information: "The report does not support a category.",
    },
    abstainOptionId: "insufficient_information",
  },
  point: DecisionPointDeclaration = {
    revision: "1",
    on: "dispatch.settled",
    when: { outcome: ["failed", "cancelled", "succeeded"], classification: ["worker_stop", "gate_red"] },
    input: ["report.body", "dispatch.reason", "dispatch.classification"],
    question: "stop-reason",
    show: ["task.dispatches"],
  },
  vertical = {
    id: "software/coding",
    title: "Software Coding",
    version: "1.4.0",
    decisions: {
      questions: { "stop-reason": question },
      points: { [pointId]: point },
    },
  } as VerticalDefinition,
  outcomeEvent = (fallbackState: "scheduled" | "exhausted" | null = null, classification = "worker_stop") =>
    ({
      schema: "agent-runtime-event/v1",
      type: "runtime_session_outcome_observed",
      occurredAt: "2026-10-19T00:00:00.000Z",
      payload: {
        runtimeSessionId: "runtime-1",
        outcome: "failed",
        exitCode: 1,
        resultRef: "artifact:runtime-result/sha256/" + "a".repeat(64),
        result: { sha256: "a".repeat(64), size: 7, mediaType: "text/plain" },
        dispatchId,
        endedAt: "2026-10-19T00:00:00.000Z",
        attempt: { classification, reason: "worker stopped", ...(fallbackState ? { fallbackState } : {}) },
      },
    }) as AgentRuntimeEventV1;

function isolatedRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ha-decision-point-"));
}

function fakeCell(input: {
  readonly report?: string;
  readonly fallbackState?: "scheduled" | "dispatched" | "exhausted" | null;
  readonly decisions?: { readonly provider?: string; readonly enabledPoints?: readonly string[] };
  readonly vertical?: VerticalDefinition;
}) {
  const reads: string[] = [],
    cell = {
      read: async (method: string) => {
        reads.push(method);
        if (method === "repo.agentRuntime.sessions.read")
          return {
            status: "ready",
            session: { associations: [{ taskId: "task-1" }] },
            result: { text: input.report ?? "worker stopped after a rejected tool call" },
          };
        if (method === "repo.task.dispatches")
          return {
            dispatches: [{ dispatchId, fallbackState: input.fallbackState ?? null, nextDispatchId: null }],
          };
        if (method === "repo.vertical.declaration.read") return { declaration: input.vertical ?? vertical };
        if (method === "repo.settings.read") return { settings: { decisions: input.decisions } };
        throw new Error(`Unexpected fake read ${method}`);
      },
    } as unknown as RepoCell;
  return { cell, reads };
}

const provider = {
    schema: "decision-provider/v1",
    providerId: "dp-openrouter-mercury",
    name: "Decision provider",
    providerType: "decisions",
    vendor: "openrouter",
    model: "model-a",
    baseUrl: null,
    auth: { mode: "api-key", credentialRef: "credential-ref" },
    enabled: true,
    configurationRevision: 1,
    probe: { state: "unknown" },
  } as const,
  answer = {
    disposition: "advisory",
    authoritative: false,
    subjectRef: `dispatch/${dispatchId}`,
    questionSetVersion: question.version,
    questionType: "choice",
    result: { type: "choice", selected: "environment_unavailable" },
    distribution: { environment_unavailable: 0.9, insufficient_information: 0.1 },
    provider: {
      providerId: provider.providerId,
      vendor: "openrouter",
      requestedModel: provider.model,
      resolvedModel: provider.model,
      modelVersion: null,
      providerRoute: null,
    },
    usage: { inputTokens: 12, outputTokens: 3, reportedCost: null },
    latencyMs: 24,
    __advisoryDecisionBrand: Symbol("advisory"),
  } as AdvisoryDecision;

test("an unset or stale binding leaves settlement dormant without a provider call", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let calls = 0;
  const executor = openDecisionPointExecutor({
    rootDir,
    providers: { list: () => [provider], port: { decide: async () => (calls++, answer) } },
    now: () => "2026-10-19T00:00:01.000Z",
  });
  const unset = fakeCell({});
  await executor.settle(
    unset.cell,
    outcomeEvent() as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>,
  );
  assert.equal(calls, 0);

  const stale = fakeCell({ decisions: { provider: provider.providerId, enabledPoints: [`${pointId}@000000000000`] } });
  await executor.settle(
    stale.cell,
    outcomeEvent() as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>,
  );
  assert.equal(calls, 0);
});

test("a configured but unavailable provider records a typed failure without changing settlement", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const binding = `${pointId}@${decisionPointBindingDigest(pointId, point, question).slice(0, 12)}`;
  const unavailable = { ...provider, enabled: false };
  const executor = openDecisionPointExecutor({
    rootDir,
    providers: { list: () => [unavailable], port: { decide: async () => answer } },
    now: () => "2026-10-19T00:00:01.000Z",
  });
  const { cell } = fakeCell({ decisions: { provider: provider.providerId, enabledPoints: [binding] } });
  await executor.settle(
    cell,
    outcomeEvent() as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>,
  );
  const entries = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(entries[0]?.status, "failed");
  assert.equal(entries[0]?.failureCode, "provider_disabled");
});

test("empty, explicitly truncated and fallback-scheduled reports do not call the provider", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const binding = `${pointId}@${decisionPointBindingDigest(pointId, point, question).slice(0, 12)}`;
  let calls = 0;
  const executor = openDecisionPointExecutor({
    rootDir,
    providers: { list: () => [provider], port: { decide: async () => (calls++, answer) } },
    now: () => "2026-10-19T00:00:01.000Z",
  });
  for (const report of ["  ", "body…[truncated]…tail"]) {
    const { cell } = fakeCell({ report, decisions: { provider: provider.providerId, enabledPoints: [binding] } });
    await executor.settle(
      cell,
      outcomeEvent() as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>,
    );
  }
  const scheduled = fakeCell({ decisions: { provider: provider.providerId, enabledPoints: [binding] } });
  await executor.settle(
    scheduled.cell,
    outcomeEvent("scheduled") as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>,
  );
  assert.equal(calls, 0);
});

test("two concurrent callbacks for one settlement reserve once and record the exact external projection", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const binding = `${pointId}@${decisionPointBindingDigest(pointId, point, question).slice(0, 12)}`;
  let calls = 0;
  const requests: Array<{ providerId: string; state: readonly [string] }> = [];
  const executor = openDecisionPointExecutor({
    rootDir,
    providers: {
      list: () => [provider],
      port: {
        decide: async (request) => {
          calls++;
          requests.push(request);
          return answer;
        },
      },
    },
    now: () => "2026-10-19T00:00:01.000Z",
  });
  const { cell } = fakeCell({ decisions: { provider: provider.providerId, enabledPoints: [binding] } });
  const event = outcomeEvent() as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>;
  await Promise.all([executor.settle(cell, event), executor.settle(cell, event)]);
  assert.equal(calls, 1);
  assert.equal(requests[0]?.providerId, provider.providerId);
  assert.match(
    requests[0]?.state[0] ?? "",
    /^reason: worker stopped\nclassification: worker_stop\nreport: worker stopped after a rejected tool call$/u,
  );

  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]?.egress.fields, ["dispatch.reason", "dispatch.classification", "report.body"]);
  assert.equal(stored[0]?.egress.inputDigest.length, 64);
  assert.equal(stored[0]?.advisory?.selected, "environment_unavailable");
  assert.equal(readDecisionAnnotationsByDispatch(rootDir, [dispatchId], "task.dispatches").get(dispatchId)?.length, 1);
  assert.equal(readDecisionAnnotationsByDispatch(rootDir, [dispatchId], "agenda").size, 0);
});

test("binding digest changes with question, field selection or deterministic filters", () => {
  const original = decisionPointBindingDigestForVertical(vertical, pointId);
  assert.ok(original);
  assert.notEqual(decisionPointBindingDigest(pointId, point, { ...question, version: "pilot2-choice-v3" }), original);
  assert.notEqual(decisionPointBindingDigest(pointId, { ...point, input: ["report.body"] }, question), original);
  assert.notEqual(decisionPointBindingDigest(pointId, { ...point, when: { outcome: ["failed"] } }, question), original);
});

test("report projection follows the catalog summary cap and rejects empty or truncated text", () => {
  const event = outcomeEvent() as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>;
  const projected = projectDecisionInput({ point, event, report: ` ${"head ".repeat(500)} ${"tail ".repeat(500)} ` });
  assert.ok(projected);
  assert.equal(projected.fields.length, 3);
  assert.ok(projected.state.includes("……[中略]……"));
  assert.ok(projected.state.length < 3_100);
  assert.equal(projectDecisionInput({ point, event, report: "  " }), null);
  assert.equal(projectDecisionInput({ point, event, report: "[report truncated]" }), null);
});

test("incident projection keeps missing tool metrics distinct and carries the continuation and effective budget", () => {
  const event = outcomeEvent() as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>;
  const incidentPoint = {
    ...point,
    input: [
      "dispatch.classification",
      "runtime.toolCallCount",
      "runtime.headStatus",
      "runtime.lastConclusion",
      "runtime.exitHead",
      "runtime.currentHead",
      "task.roundsUsed",
      "task.reworkBudget",
      "report.body",
    ],
  } as unknown as DecisionPointDeclaration;
  const projected = projectDecisionInput({
    point: incidentPoint,
    event: {
      ...event,
      payload: { ...event.payload, runtimeMetrics: undefined },
    },
    report: "Worker stopped before delivery.",
    incident: {
      headStatus: "changed",
      lastConclusion: "Tests passed; delivery not submitted.",
      exitHead: "a".repeat(40),
      currentHead: "b".repeat(40),
      roundsUsed: 2,
      reworkBudget: { used: 1, limit: 3, source: "repository" },
    },
  } as never);
  assert.ok(projected);
  assert.match(projected.state, /tool_call_count: unavailable/u);
  assert.match(projected.state, /head_status: changed/u);
  assert.match(projected.state, /rework_budget: used=1 limit=3 source=repository/u);
  assert.match(projected.state, /last_conclusion: Tests passed; delivery not submitted\./u);
  assert.deepEqual(projected.fields, [
    "dispatch.classification",
    "runtime.toolCallCount",
    "runtime.headStatus",
    "runtime.lastConclusion",
    "runtime.exitHead",
    "runtime.currentHead",
    "task.roundsUsed",
    "task.reworkBudget",
    "report.body",
  ]);
});

test("annotation de-duplication retains remaining dispatch links when one is removed", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const store = openDecisionAnnotationStore(rootDir),
    advisory = decisionAdvisoryFromProvider(answer, {
      pointId,
      questionVersion: question.version,
      options: question.type === "choice" ? question.options : [],
    });
  const base = {
    key: "same-input",
    pointId,
    questionVersion: question.version,
    bindingDigest: decisionPointBindingDigest(pointId, point, question),
    event: "dispatch.settled" as const,
    show: ["task.dispatches"] as const,
    subjectRef: `dispatch/${dispatchId}`,
    now: "2026-10-19T00:00:00.000Z",
    egress: {
      subjectRef: `dispatch/${dispatchId}`,
      dispatchId,
      pointId,
      fields: point.input,
      providerId: provider.providerId,
      model: provider.model,
      sentAt: "2026-10-19T00:00:00.000Z",
      inputDigest: "a".repeat(64),
    },
  };
  const first = await store.reserve({ ...base, dispatchId });
  assert.equal(first.created, true);
  await store.succeed(base.key, advisory, "2026-10-19T00:00:01.000Z");
  await store.reserve({
    ...base,
    dispatchId: "dispatch_fedcba987654321001234567",
    subjectRef: "dispatch/dispatch_fedcba987654321001234567",
    egress: { ...base.egress, dispatchId: "dispatch_fedcba987654321001234567" },
  });
  await store.remove(dispatchId);
  const entries = await store.export();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.dispatchIds, ["dispatch_fedcba987654321001234567"]);
});

// ── Executable incident disposition (runtime-incident-disposition/v1) ────────────────────────

const incidentQuestion: DecisionQuestionDeclaration = {
    version: incidentDispositionQuestionVersion,
    type: "choice",
    prompt: "Pick the incident disposition.",
    options: [
      { id: "resume_original", text: "续跑原会话" },
      { id: "rerun_same_identity", text: "同身份新会话重跑" },
      { id: "switch_declared_next", text: "换声明的下一个身份或 runtime" },
      { id: "needs_attention", text: "升级 CEO" },
      { id: "no_action", text: "不处理" },
    ],
    criteria: {
      resume_original: "resume",
      rerun_same_identity: "rerun",
      switch_declared_next: "switch",
      needs_attention: "escalate",
      no_action: "nothing to do",
    },
    abstainOptionId: "needs_attention",
  },
  incidentPointId = "runtime-incident-worker-stop",
  incidentPoint: DecisionPointDeclaration = {
    revision: "1",
    on: "dispatch.settled",
    when: { outcome: ["stopped", "succeeded"], classification: ["worker_stop"] },
    input: [
      "dispatch.classification",
      "dispatch.reason",
      "runtime.toolCallCount",
      "runtime.headStatus",
      "runtime.lastConclusion",
      "runtime.exitHead",
      "runtime.currentHead",
      "task.roundsUsed",
      "task.reworkBudget",
      "report.body",
    ],
    question: "runtime-incident-disposition",
    show: ["task.dispatches"],
  },
  incidentBindingKey = `${incidentPointId}@${decisionPointBindingDigest(incidentPointId, incidentPoint, incidentQuestion).slice(0, 12)}`;

const choiceAnswer = (selected: string): AdvisoryDecision =>
  ({
    ...answer,
    result: { type: "choice", selected },
    distribution: { [selected]: 1 },
  }) as AdvisoryDecision;

function incidentOutcomeEvent(): Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }> {
  return {
    ...outcomeEvent(),
    payload: {
      ...outcomeEvent().payload,
      outcome: "stopped",
      runtimeMetrics: {
        inputTokens: 10,
        cacheReadTokens: 0,
        outputTokens: 5,
        totalTokens: 15,
        toolCallCount: 7,
      },
    },
  } as AgentRuntimeEventV1 as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>;
}

function fakeIncidentCell(input: {
  /** When set, the canonical dispatch read carries the durable receipt this task's stream holds,
   * exactly like the real read surface, so budget and fence behaviour are observable. */
  readonly rootDir?: string;
  /** Older dispatches of the same task that already carry an applied receipt. */
  readonly priorDispatches?: readonly {
    readonly dispatchId: string;
    readonly receipt: ReturnType<typeof readIncidentActionReceipt>;
  }[];
  readonly submission?: object | null;
  readonly lease?: object | null;
  readonly resume?: { readonly dispatchId: string; readonly agentId: string | null };
  readonly agentId?: string;
  readonly running?: boolean;
  readonly spawnFails?: boolean;
  readonly providerEnabled?: boolean;
  readonly reviewReturnBudget?: number;
  readonly continuationContext?: {
    readonly dispatchId: string;
    readonly lastConclusion: string | null;
    readonly exitHead: string | null;
  };
  readonly workspace?: {
    readonly kind: "worktree";
    readonly path: string;
    readonly state: "materialized" | "retained";
  };
}) {
  const spawns: Array<{ readonly payload: Record<string, unknown>; readonly binding: unknown }> = [],
    relates: Array<{ readonly action: Record<string, unknown>; readonly binding: unknown }> = [],
    cell = {
      read: async (method: string) => {
        if (method === "repo.agentRuntime.sessions.read")
          return {
            status: "ready",
            session: { associations: [{ taskId: "task-1" }] },
            result: { text: "worker stopped after partial progress; nothing submitted" },
          };
        if (method === "repo.task.dispatches") {
          const receipt = input.rootDir ? readIncidentActionReceipt(input.rootDir, dispatchId) : null;
          return {
            dispatches: [
              ...(input.priorDispatches ?? []).flatMap((prior) =>
                prior.receipt
                  ? [
                      {
                        dispatchId: prior.dispatchId,
                        fallbackState: null,
                        nextDispatchId: null,
                        status: "stopped",
                        decisionAction: prior.receipt,
                      },
                    ]
                  : [],
              ),
              {
                dispatchId,
                fallbackState: null,
                nextDispatchId: null,
                status: "stopped",
                ...(input.resume ? { resume: input.resume } : {}),
                ...(input.agentId ? { agentId: input.agentId } : {}),
                ...(receipt ? { decisionAction: receipt } : {}),
              },
              ...(input.running || spawns.length > 0
                ? [{ dispatchId: "dispatch_running", fallbackState: null, nextDispatchId: null, status: "running" }]
                : []),
            ],
          };
        }
        if (method === "repo.vertical.declaration.read")
          return {
            declaration: {
              decisions: {
                questions: { "runtime-incident-disposition": incidentQuestion },
                points: { [incidentPointId]: incidentPoint },
              },
            },
          };
        if (method === "repo.settings.read")
          return {
            settings: {
              decisions: { provider: provider.providerId, enabledPoints: [incidentBindingKey] },
              reviewReturnBudget: input.reviewReturnBudget ?? 3,
            },
          };
        if (method === "repo.tasks.runtimeContext.read")
          return {
            schema: "task-runtime-context-read/v1",
            ok: true as const,
            taskId: "task-1",
            causalContext: null,
            profileId: null,
            worktree: null,
            continuationContext: input.continuationContext ?? null,
            snapshot: {
              task: { createdBy: { principal: { personId: "person_owner_1" } }, iteration: 1 },
              executions: [{ executionId: "execution-1", iteration: 1, submission: input.submission ?? null }],
              lease: input.lease ?? null,
              workspace: input.workspace ?? null,
            },
          };
        throw new Error(`Unexpected fake read ${method}`);
      },
      spawnRuntime: async (payload: Record<string, unknown>, binding: unknown) => {
        if (input.spawnFails) throw new Error("spawn admission rejected");
        spawns.push({ payload, binding });
        return { dispatchId: "dispatch_successor_000000000001" };
      },
      run: async (action: Record<string, unknown>, binding: unknown) => {
        relates.push({ action, binding });
        return { outcome: "applied" };
      },
    } as unknown as RepoCell;
  return { cell, spawns, relates };
}

/** The action actor comes from the source dispatch's persisted stream binding (fallback-continuation precedent). */
function seedIncidentStream(rootDir: string, target = dispatchId): void {
  openDispatchStream(rootDir, {
    dispatchId: target,
    taskId: "task-1",
    executionId: "execution-1",
    runtimeSessionId: target === dispatchId ? "runtime-1" : `runtime-${target.slice(-6)}`,
    instanceId: "instance-codex",
    startedAt: "2026-10-19T00:00:00.000Z",
    agentId: "terra",
    binding: {
      actor: {
        principal: { personId: "person_owner_1" },
        executor: { kind: "agent", id: "runtime-session:runtime-1" },
      },
      source: "local",
    },
  });
}

test("an admissible resume choice launches one successor through the existing spawn port", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const requests: string[] = [],
    executor = openDecisionPointExecutor({
      rootDir,
      providers: {
        list: () => [provider],
        port: {
          decide: async (request) => {
            calls++;
            requests.push(request.state[0]!);
            return choiceAnswer("resume_original");
          },
        },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({
      resume: { dispatchId, agentId: "terra" },
      agentId: "terra",
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(calls, 1);
  assert.equal(spawns.length, 1);
  assert.equal(relates.length, 0);
  assert.equal(spawns[0]?.payload.dispatchId, dispatchId);
  assert.equal(spawns[0]?.payload.taskId, "task-1");
  assert.equal(spawns[0]?.payload.dispatchKey, `incident-action:task-1:${dispatchId}`);
  assert.match(String(spawns[0]?.payload.prompt), /stopped without a submitted delivery/u);
  assert.equal(
    (spawns[0]?.binding as { actor: { executor: { id: string } } }).actor.executor.id,
    "runtime-session:runtime-1",
  );
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.status, "succeeded");
  assert.equal(stored[0]?.advisory?.selected, "resume_original");
  assert.equal(stored[0]?.action?.action, "resume");
  assert.equal(stored[0]?.action?.status, "applied");
  assert.equal(stored[0]?.action?.successorDispatchId, "dispatch_successor_000000000001");
  assert.deepEqual(stored[0]?.action?.budget, { used: 0, limit: 3, source: "repository" });
  assert.match(requests[0]!, /tool_call_count: 7/u);
  assert.match(requests[0]!, /head_status: no-previous-run/u);
  assert.match(requests[0]!, /rework_budget: used=0 limit=3 source=repository/u);
  assert.match(requests[0]!, /rounds_used: 1/u);
});

test("two concurrent outcome callbacks reserve once, ask once and launch once", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const executor = openDecisionPointExecutor({
      rootDir,
      providers: {
        list: () => [provider],
        port: { decide: async () => (calls++, choiceAnswer("rerun_same_identity")) },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({ agentId: "terra" });
  await Promise.all([executor.settle(cell, incidentOutcomeEvent()), executor.settle(cell, incidentOutcomeEvent())]);
  assert.equal(calls, 1);
  assert.equal(spawns.length, 1);
  assert.equal(relates.length, 0);
  assert.equal(spawns[0]?.payload.agentId, "terra");
  assert.equal(spawns[0]?.payload.dispatchId, undefined);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored.length, 1);
});

test("an exhausted automatic-disposition budget escalates instead of launching", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  // The prior automatic disposition is evidence on the dispatch's own stream, the surface the
  // budget fence counts; the local annotation copy is deliberately absent here.
  const priorDispatchId = "dispatch_00000000000000000000aaaa";
  seedIncidentStream(rootDir, priorDispatchId);
  appendIncidentActionReceipt(rootDir, priorDispatchId, {
    pointId: incidentPointId,
    questionVersion: incidentDispositionQuestionVersion,
    status: "applied",
    selected: "rerun_same_identity",
    action: "rerun",
    reason: null,
    successorDispatchId: "dispatch_prior_successor",
    budget: { used: 0, limit: 3, source: "repository" },
    decidedAt: "2026-10-18T00:00:01.000Z",
  });
  const executor = openDecisionPointExecutor({
      rootDir,
      providers: { list: () => [provider], port: { decide: async () => choiceAnswer("rerun_same_identity") } },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({
      rootDir,
      agentId: "terra",
      reviewReturnBudget: 1,
      priorDispatches: [{ dispatchId: priorDispatchId, receipt: readIncidentActionReceipt(rootDir, priorDispatchId) }],
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 1);
  assert.equal(relates[0]?.action.kind, "relation-relate");
  assert.equal(relates[0]?.action.sourceRef, "task/task-1");
  assert.equal(relates[0]?.action.targetRef, "person/person_owner_1");
  assert.equal(relates[0]?.action.relationType, "awaits");
  assert.match(String(relates[0]?.action.rationale), /^question: /u);
  assert.match(String(relates[0]?.action.rationale), /budget is exhausted/u);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.action?.action, "needs_attention");
  assert.equal(stored[0]?.action?.status, "applied");
  assert.deepEqual(stored[0]?.action?.budget, { used: 1, limit: 1, source: "repository" });
});

test("an unavailable provider escalates without asking or launching", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const executor = openDecisionPointExecutor({
      rootDir,
      providers: {
        list: () => [{ ...provider, enabled: false }],
        port: { decide: async () => (calls++, choiceAnswer("needs_attention")) },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({});
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(calls, 0);
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 1);
  assert.match(String(relates[0]?.action.rationale), /provider is disabled/u);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.status, "failed");
  assert.equal(stored[0]?.failureCode, "provider_disabled");
  assert.equal(stored[0]?.action?.action, "needs_attention");
  assert.equal(stored[0]?.action?.status, "applied");
});

test("a submitted cut turns no_action into the receipt and launches nothing", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openDecisionPointExecutor({
      rootDir,
      providers: { list: () => [provider], port: { decide: async () => choiceAnswer("no_action") } },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({
      submission: { commitSha: "b".repeat(40) },
      resume: { dispatchId, agentId: "terra" },
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 0);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.action, "no_action");
  assert.equal(stored[0]?.action?.status, "applied");
});

test("a switch choice on a worker-stop incident is inadmissible and escalates", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openDecisionPointExecutor({
      rootDir,
      providers: { list: () => [provider], port: { decide: async () => choiceAnswer("switch_declared_next") } },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({});
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 1);
  assert.match(String(relates[0]?.action.rationale), /fallback ladder stays closed/u);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.action, "needs_attention");
  assert.equal(stored[0]?.action?.selected, "switch_declared_next");
});

test("a failed launch escalates to the owner and records the launch failure", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openDecisionPointExecutor({
      rootDir,
      providers: { list: () => [provider], port: { decide: async () => choiceAnswer("resume_original") } },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({ resume: { dispatchId, agentId: "terra" }, spawnFails: true });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 1);
  assert.match(String(relates[0]?.action.rationale), /could not launch/u);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.action, "needs_attention");
  assert.equal(stored[0]?.action?.status, "applied");
  assert.match(String(stored[0]?.action?.reason), /launch failed/u);
});

test("incident projection scrubs worker prose before it leaves the daemon", () => {
  const event = incidentOutcomeEvent();
  const projected = projectDecisionInput({
    point: incidentPoint,
    event,
    report: "report body with /Users/zeyu/secret/path and sk-live-abcdef",
    incident: {
      toolCallCount: 3,
      headStatus: "changed",
      lastConclusion: "Final conclusion mentioning /home/worker/creds and credentialRef vault://prod/key.",
      exitHead: "a".repeat(40),
      currentHead: "b".repeat(40),
      roundsUsed: 2,
      reworkBudget: { used: 1, limit: 2, source: "task" },
    },
  });
  assert.ok(projected);
  assert.ok(!projected.state.includes("/Users/zeyu"), "report local paths must be redacted");
  assert.ok(!projected.state.includes("/home/worker"), "conclusion local paths must be redacted");
  assert.match(projected.state, /last_conclusion: .*LOCAL_PATH/u);
  assert.match(projected.state, /rework_budget: used=1 limit=2 source=task/u);
  assert.ok(projected.state.includes("a".repeat(40)) && projected.state.includes("b".repeat(40)));
});

// ── Review blockers: one claim per dispatch, HEAD fail-closed, durable canonical receipts ──────

test("a later settlement observation after the first action lands never acts twice", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const executor = openDecisionPointExecutor({
      rootDir,
      providers: {
        list: () => [provider],
        port: { decide: async () => (calls++, choiceAnswer("rerun_same_identity")) },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({ rootDir, agentId: "terra" });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(calls, 1);
  assert.equal(spawns.length, 1);

  // The second observation measures a different state: the successor is now running, the launch
  // consumed a budget slot and the receipt is on the row. A key built from those measurements
  // would mint a fresh claim; the dispatch-scoped key must not.
  await executor.settle(cell, incidentOutcomeEvent());
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(calls, 1, "a duplicate settlement must not ask the provider again");
  assert.equal(spawns.length, 1, "a duplicate settlement must not launch a second successor");
  assert.equal(relates.length, 0, "a duplicate settlement must not add an owner await either");
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  assert.equal(receipt?.status, "applied");
  assert.equal(receipt?.action, "rerun");
});

test("an unknown worktree HEAD makes an automatic restart inadmissible and escalates", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openDecisionPointExecutor({
      rootDir,
      providers: { list: () => [provider], port: { decide: async () => choiceAnswer("rerun_same_identity") } },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    // A continuation seed exists but no worktree resolves, so the measured HEAD is unavailable.
    { cell, spawns, relates } = fakeIncidentCell({
      rootDir,
      agentId: "terra",
      continuationContext: { dispatchId, lastConclusion: "stopped before delivery", exitHead: "a".repeat(40) },
      workspace: undefined,
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0, "unknown HEAD must never launch a successor");
  assert.equal(relates.length, 1, "unknown HEAD belongs to the owner");
  assert.equal(relates[0]?.action.relationType, "awaits");
  assert.match(String(relates[0]?.action.rationale), /HEAD is unknown/u);
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  assert.equal(receipt?.status, "applied");
  assert.equal(receipt?.action, "needs_attention");
});

test("the automatic budget counts durable dispatch receipts after the annotation store evicts them", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  // A retired dispatch whose applied receipt survives on its stream while the annotation store has
  // already rotated past it. The file below is exactly the shape retention leaves behind: the
  // newest N entries, none of them the retired action.
  const retiredDispatchId = "dispatch_00000000000000000000ffff",
    retiredAt = "2026-10-18T00:00:00.000Z";
  seedIncidentStream(rootDir, retiredDispatchId);
  appendIncidentActionReceipt(rootDir, retiredDispatchId, {
    pointId: incidentPointId,
    questionVersion: incidentDispositionQuestionVersion,
    status: "applied",
    selected: "rerun_same_identity",
    action: "rerun",
    reason: null,
    successorDispatchId: "dispatch_retired_successor_01",
    budget: { used: 0, limit: 1, source: "repository" },
    decidedAt: retiredAt,
  });
  const filler = Array.from({ length: decisionAnnotationRetention }, (_, index) => {
    const id = `dispatch_${index.toString(16).padStart(24, "0")}`;
    return {
      key: `evicting-${String(index)}`,
      pointId: incidentPointId,
      questionVersion: incidentDispositionQuestionVersion,
      bindingDigest: "0".repeat(64),
      event: "dispatch.settled",
      show: ["task.dispatches"],
      dispatchIds: [id],
      subjectRef: `dispatch/${id}`,
      status: "pending",
      createdAt: retiredAt,
      updatedAt: retiredAt,
      egress: {
        subjectRef: `dispatch/${id}`,
        dispatchId: id,
        pointId: incidentPointId,
        fields: [],
        providerId: provider.providerId,
        model: provider.model,
        sentAt: retiredAt,
        inputDigest: "0".repeat(64),
      },
    };
  });
  writeFileSync(
    path.join(resolveHarnessLayout(rootDir).localRoot, "decision-annotations.json"),
    `${JSON.stringify({ schema: "decision-annotation-store/v1", entries: filler })}\n`,
  );
  const store = openDecisionAnnotationStore(rootDir);
  assert.equal((await store.export()).length, decisionAnnotationRetention);
  assert.equal(
    (await store.export()).some((entry) => entry.dispatchIds.includes(retiredDispatchId)),
    false,
    "the fixture must model the retention window having rotated past the retired action",
  );

  const executor = openDecisionPointExecutor({
      rootDir,
      providers: { list: () => [provider], port: { decide: async () => choiceAnswer("rerun_same_identity") } },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({
      rootDir,
      agentId: "terra",
      reviewReturnBudget: 1,
      // The canonical read the executor consumes still carries the retired receipt.
      priorDispatches: [
        { dispatchId: retiredDispatchId, receipt: readIncidentActionReceipt(rootDir, retiredDispatchId) },
      ],
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0, "an evicted receipt must still enforce the cap");
  assert.equal(relates.length, 1);
  assert.match(String(relates[0]?.action.rationale), /budget is exhausted/u);
});
