// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { CredentialPort } from "../src/agent-runtime-credential-port.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { incidentDispositionQuestionVersion } from "../src/decision-incident-action.ts";
import { openDecisionProviderService } from "../src/decision-provider.ts";
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
import {
  appendIncidentActionReceipt,
  incidentContinuationUsed,
  readIncidentActionReceipt,
} from "../src/decision-incident-receipt.ts";

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A real worktree commit is the only way to exercise the measured HEAD path: the daemon runs
 * `git rev-parse HEAD` on the workspace binding, so the fixture must be a real repository. */
function commitWorktree(rootDir: string): { readonly path: string; readonly head: string } {
  const worktree = path.join(rootDir, "worktree");
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "-q");
  git(worktree, "config", "user.name", "Decision Point Test");
  git(worktree, "config", "user.email", "decision-point@example.invalid");
  writeFileSync(path.join(worktree, "progress.txt"), "progress\n");
  git(worktree, "add", "progress.txt");
  git(worktree, "commit", "-qm", "progress");
  return { path: worktree, head: git(worktree, "rev-parse", "HEAD") };
}

const testOperatorSession = {
  personId: "person_owner_1",
  accessToken: "test-operator-access-token",
  url: "https://keycloak.test",
  realm: "harness-test",
  clientId: "harness-center",
} as const;

/** Production always supplies the daemon's local session; tests opt in explicitly so a missing
 * wiring cannot silently reproduce the credential-less automatic resume. */
function openTestExecutor(
  input: Omit<Parameters<typeof openDecisionPointExecutor>[0], "keycloakSession">,
  keycloakSession: Parameters<typeof openDecisionPointExecutor>[0]["keycloakSession"] = async () => testOperatorSession,
) {
  return openDecisionPointExecutor({ ...input, keycloakSession });
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
  const executor = openTestExecutor({
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
  const executor = openTestExecutor({
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
  const executor = openTestExecutor({
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
  const executor = openTestExecutor({
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

test("incident projection keeps missing tool metrics distinct and carries the continuation allowance and fixed budget", () => {
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
      continuationBudget: { used: 1, limit: 3, source: "daemon" },
    },
  } as never);
  assert.ok(projected);
  assert.match(projected.state, /tool_call_count: unavailable/u);
  assert.match(projected.state, /head_status: changed/u);
  assert.match(projected.state, /rework_budget: used=1 limit=3 source=daemon/u);
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
    when: { outcome: ["stopped", "failed"], classification: ["worker_stop"] },
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

function incidentOutcomeEvent(
  outcome: "stopped" | "failed" | "succeeded" = "stopped",
  classification = "worker_stop",
): Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }> {
  const settledEvent = outcomeEvent(null, classification);
  return {
    ...settledEvent,
    payload: {
      ...settledEvent.payload,
      outcome,
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
    runtimeContextReads: Array<Readonly<Record<string, unknown>> | undefined> = [],
    cell = {
      read: async (method: string, payload?: Readonly<Record<string, unknown>>) => {
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
        if (method === "repo.tasks.runtimeContext.read") {
          runtimeContextReads.push(payload);
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
        }
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
  return { cell, spawns, relates, runtimeContextReads };
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

function seedAppliedIncidentAction(
  rootDir: string,
  target: string,
  budget: { readonly used: number; readonly limit: number; readonly source: "task" | "repository" | "daemon" },
  decidedAt: string,
): void {
  seedIncidentStream(rootDir, target);
  appendIncidentActionReceipt(rootDir, target, {
    pointId: incidentPointId,
    questionVersion: incidentDispositionQuestionVersion,
    status: "applied",
    selected: "rerun_same_identity",
    action: "rerun",
    reason: null,
    successorDispatchId: `${target}_successor`,
    budget,
    decidedAt,
  });
}

function openTestDecisionProvider(
  rootDir: string,
  invokeDecision: Parameters<typeof openDecisionProviderService>[0]["invokeDecision"],
) {
  const vault: CredentialPort = {
    issue: () => "credential:v1:decision-test",
    store: async () => undefined,
    resolve: async () => "decision-test-key",
    remove: async () => undefined,
  };
  return openDecisionProviderService({
    userRoot: rootDir,
    vault,
    sleep: async () => undefined,
    invokeDecision,
  });
}

async function configureTestDecisionProvider(service: ReturnType<typeof openDecisionProviderService>): Promise<void> {
  await service.command({
    kind: "provider-create",
    type: "decisions",
    providerId: provider.providerId,
    name: provider.name,
    model: provider.model,
    credentialRef: "credential:v1:decision-test",
  });
}

const providerChoiceResponse = (choice: string) => ({
  model: provider.model,
  usage: { inputTokens: 1, outputTokens: 1 },
  answers: {
    decision: {
      type: "choice" as const,
      choice,
      probabilities: {
        resume_original: choice === "resume_original" ? 1 : 0,
        rerun_same_identity: choice === "rerun_same_identity" ? 1 : 0,
        switch_declared_next: choice === "switch_declared_next" ? 1 : 0,
        needs_attention: choice === "needs_attention" ? 1 : 0,
        no_action: choice === "no_action" ? 1 : 0,
      },
    },
  },
});

test("an admissible resume choice launches one successor through the existing spawn port", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const requests: string[] = [],
    executor = openTestExecutor({
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
  const spawnedBinding = spawns[0]?.binding as {
    keycloakAuthorization?: { session?: { personId?: string; accessToken?: string } };
  };
  assert.equal(
    spawnedBinding.keycloakAuthorization?.session?.personId,
    "person_owner_1",
    "the automatic resume reuses the daemon's current operator session",
  );
  assert.equal(spawnedBinding.keycloakAuthorization?.session?.accessToken, "test-operator-access-token");
  assert.equal(
    "authorizationDecision" in (spawns[0]?.binding as object),
    false,
    "the publication turn still authorizes; the executor only attaches the session it reuses",
  );
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.status, "succeeded");
  assert.equal(stored[0]?.advisory?.selected, "resume_original");
  assert.equal(stored[0]?.action?.action, "resume");
  assert.equal(stored[0]?.action?.status, "applied");
  assert.equal(stored[0]?.action?.successorDispatchId, "dispatch_successor_000000000001");
  assert.deepEqual(stored[0]?.action?.budget, { used: 1, limit: 3, source: "daemon" });
  assert.match(requests[0]!, /tool_call_count: 7/u);
  assert.match(requests[0]!, /head_status: no-previous-run/u);
  assert.match(requests[0]!, /rework_budget: used=0 limit=3 source=daemon/u);
  assert.match(requests[0]!, /rounds_used: 1/u);
});

test("a provider fault uses the existing incident continuation and its shared budget", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openTestExecutor({
      rootDir,
      providers: {
        list: () => [provider],
        port: { decide: async () => Promise.reject(new Error("decision service unavailable")) },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns } = fakeIncidentCell({ rootDir, agentId: "terra" });

  await executor.settle(cell, incidentOutcomeEvent("failed", "gate_red"));
  assert.equal(spawns.length, 0, "gate_red does not receive the provider-fault incident trigger");

  await executor.settle(cell, incidentOutcomeEvent("failed", "provider_fault"));

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]?.payload.agentId, "terra");
  assert.equal(spawns[0]?.payload.taskId, "task-1");
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  assert.equal(receipt?.action, "rerun");
  assert.deepEqual(receipt?.budget, { used: 1, limit: 3, source: "daemon" });
});

test("an automatic resume refuses a local session owned by a different person", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openTestExecutor(
      {
        rootDir,
        providers: { list: () => [provider], port: { decide: async () => choiceAnswer("resume_original") } },
        now: () => "2026-10-19T00:00:01.000Z",
      },
      async () => ({ ...testOperatorSession, personId: "person_someone_else" }),
    ),
    { cell, spawns } = fakeIncidentCell({ resume: { dispatchId, agentId: "terra" } });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0, "a different person's session may not launch the original runtime");
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.action, "needs_attention");
  assert.equal(stored[0]?.action?.status, "applied");
  assert.match(String(stored[0]?.action?.reason), /original runtime owner must sign in/u);
});

test("an automatic resume without a local operator session escalates instead of launching", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openTestExecutor(
      {
        rootDir,
        providers: { list: () => [provider], port: { decide: async () => choiceAnswer("resume_original") } },
        now: () => "2026-10-19T00:00:01.000Z",
      },
      async () => {
        throw Object.assign(new Error("Sign in before continuing a runtime."), { code: "authentication_required" });
      },
    ),
    { cell, spawns } = fakeIncidentCell({ resume: { dispatchId, agentId: "terra" } });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0, "no local session must fail closed, never launch without authority");
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.action, "needs_attention");
  assert.equal(stored[0]?.action?.status, "applied");
  assert.match(String(stored[0]?.action?.reason), /launch failed: Sign in before continuing a runtime/u);
});

test("a transient Decisions rate limit retries in the provider and settles the real incident choice", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const decisionProvider = openTestDecisionProvider(rootDir, async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("rate limited"), { code: "decision_rate_limited" });
    return providerChoiceResponse("resume_original");
  });
  await configureTestDecisionProvider(decisionProvider);
  const executor = openTestExecutor({
      rootDir,
      providers: { list: decisionProvider.list, port: decisionProvider.port },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({ rootDir, resume: { dispatchId, agentId: "terra" } });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(calls, 2);
  assert.equal(spawns.length, 1);
  assert.equal(relates.length, 0);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.action, "resume");
  assert.notEqual(stored[0]?.action?.action, "needs_attention");
});

test("an exhausted Decisions rate limit applies the deterministic rerun instead of awaiting a ruling", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const decisionProvider = openTestDecisionProvider(rootDir, async () => {
    calls++;
    throw Object.assign(new Error("rate limited"), { code: "decision_rate_limited" });
  });
  await configureTestDecisionProvider(decisionProvider);
  const executor = openTestExecutor({
      rootDir,
      providers: { list: decisionProvider.list, port: decisionProvider.port },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({ rootDir, agentId: "terra" });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(calls, 4, "the bounded provider retry still runs before the default is applied");
  assert.equal(relates.length, 0, "an automatic disposition must not open an owner await");
  assert.equal(spawns.length, 1, "the default disposition reruns the same identity");
  assert.equal(spawns[0]?.payload.agentId, "terra");
  assert.equal(spawns[0]?.payload.dispatchKey, `incident-action:task-1:${dispatchId}`);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.status, "failed");
  assert.equal(stored[0]?.failureCode, "decision_rate_limited");
  assert.equal(stored[0]?.action?.selected, "rerun_same_identity");
  assert.equal(stored[0]?.action?.action, "rerun");
  assert.equal(stored[0]?.action?.status, "applied");
  assert.match(String(stored[0]?.action?.reason), /Decisions API unavailable/u);
  assert.match(String(stored[0]?.action?.reason), /decision_rate_limited/u);
  assert.match(String(stored[0]?.action?.reason), /重试 3 次后仍限流/u);
  assert.match(String(stored[0]?.action?.reason), /default disposition "rerun_same_identity"/u);
  // The durable receipt is what the dispatch read projects; it must carry the same explanation
  // so the row never reads as an owner ruling.
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  assert.equal(receipt?.status, "applied");
  assert.equal(receipt?.action, "rerun");
  assert.equal(receipt?.selected, "rerun_same_identity");
  assert.equal(receipt?.successorDispatchId, "dispatch_successor_000000000001");
  assert.match(String(receipt?.reason), /Decisions API unavailable/u);
});

test("an exhausted rate limit resumes a resumable dispatch before falling back to a rerun", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const decisionProvider = openTestDecisionProvider(rootDir, async () => {
    calls++;
    throw Object.assign(new Error("rate limited"), { code: "decision_rate_limited" });
  });
  await configureTestDecisionProvider(decisionProvider);
  const executor = openTestExecutor({
      rootDir,
      providers: { list: decisionProvider.list, port: decisionProvider.port },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({
      rootDir,
      resume: { dispatchId, agentId: "terra" },
      agentId: "terra",
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(calls, 4);
  assert.equal(relates.length, 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]?.payload.dispatchId, dispatchId, "resume reuses the source dispatch session");
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.selected, "resume_original");
  assert.equal(stored[0]?.action?.action, "resume");
});

test("a delivered cut retains a terminal provider cause while defaulting to no_action", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const decisionProvider = openTestDecisionProvider(rootDir, async () => {
    throw Object.assign(new Error("Invalid URL"), {
      name: "NotFoundResponseError",
      statusCode: 404,
      data$: { error: { code: 404, message: "Invalid URL" } },
    });
  });
  await configureTestDecisionProvider(decisionProvider);
  const executor = openTestExecutor({
      rootDir,
      providers: { list: decisionProvider.list, port: decisionProvider.port },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({
      rootDir,
      submission: { commitSha: "b".repeat(40) },
      resume: { dispatchId, agentId: "terra" },
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0, "a delivered cut must not be rerun by a fallback");
  assert.equal(relates.length, 0);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.selected, "no_action");
  assert.equal(stored[0]?.action?.action, "no_action");
  assert.match(
    String(stored[0]?.action?.reason),
    /decision_transport after 0 retries: The OpenRouter Decisions request could not be completed/u,
  );
  assert.match(String(stored[0]?.action?.reason), /HTTP 404 NotFoundResponseError: Invalid URL/u);
});

test("the deterministic default still escalates when a guard forbids every automatic action", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  // Budget already spent by an earlier automatic disposition: the fallback may not silently
  // borrow another slot just because the provider is down.
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
    budget: { used: 3, limit: 3, source: "daemon" },
    decidedAt: "2026-10-18T00:00:01.000Z",
  });
  const executor = openTestExecutor({
      rootDir,
      providers: {
        list: () => [provider],
        port: {
          decide: async () => {
            throw Object.assign(new Error("rate limited"), { code: "decision_rate_limited" });
          },
        },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({
      rootDir,
      agentId: "terra",
      reviewReturnBudget: 1,
      priorDispatches: [{ dispatchId: priorDispatchId, receipt: readIncidentActionReceipt(rootDir, priorDispatchId) }],
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0, "an exhausted budget stays a real owner boundary");
  assert.equal(relates.length, 0, "an escalation rides the durable receipt, not a second relation");
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.action, "needs_attention");
  assert.equal(stored[0]?.action?.attention, "guard");
  assert.match(String(stored[0]?.action?.reason), /^needs_attention:/u);
  assert.match(String(stored[0]?.action?.reason), /budget is exhausted/u);
  assert.match(String(stored[0]?.action?.reason), /Decisions API unavailable/u);
  assert.doesNotMatch(String(stored[0]?.action?.reason), /question:/u);
});
test("two concurrent outcome callbacks reserve once, ask once and launch once", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const executor = openTestExecutor({
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

test("an exhausted provider-fault incident budget escalates instead of launching", async (t) => {
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
    budget: { used: 3, limit: 3, source: "daemon" },
    decidedAt: "2026-10-18T00:00:01.000Z",
  });
  const executor = openTestExecutor({
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
  await executor.settle(cell, incidentOutcomeEvent("failed", "provider_fault"));
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 0);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.action?.action, "needs_attention");
  assert.equal(stored[0]?.action?.attention, "guard");
  assert.equal(stored[0]?.action?.status, "applied");
  assert.match(String(stored[0]?.action?.reason), /^needs_attention:/u);
  assert.doesNotMatch(String(stored[0]?.action?.reason), /question:/u);
  assert.deepEqual(stored[0]?.action?.budget, { used: 3, limit: 3, source: "daemon" });
});

test("consecutive HEAD-changing stops stop auto-continuing on the fourth stop", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  // Three applied redispatches that each followed a measured HEAD change. The reported defect
  // reset the allowance to zero on that measurement, so the sequence could repeat forever. The
  // allowance is task-level: the fourth stop must escalate instead of launching again.
  const priorIds = [
    "dispatch_00000000000000000000b001",
    "dispatch_00000000000000000000b002",
    "dispatch_00000000000000000000b003",
  ];
  for (const [index, priorId] of priorIds.entries())
    seedAppliedIncidentAction(
      rootDir,
      priorId,
      { used: index + 1, limit: 3, source: "daemon" },
      `2026-10-18T00:00:0${String(index)}.000Z`,
    );
  const worktree = commitWorktree(rootDir);
  let requestState = "";
  const executor = openTestExecutor({
      rootDir,
      providers: {
        list: () => [provider],
        port: {
          decide: async (request) => {
            requestState = request.state[0] ?? "";
            return choiceAnswer("rerun_same_identity");
          },
        },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates, runtimeContextReads } = fakeIncidentCell({
      rootDir,
      agentId: "terra",
      continuationContext: {
        dispatchId: priorIds[2]!,
        lastConclusion: "committed progress on the worktree",
        exitHead: "a".repeat(40),
      },
      workspace: { kind: "worktree", path: worktree.path, state: "materialized" },
      priorDispatches: priorIds.map((priorId) => ({
        dispatchId: priorId,
        receipt: readIncidentActionReceipt(rootDir, priorId),
      })),
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.deepEqual(
    runtimeContextReads[0],
    { taskId: "task-1", excludeDispatchId: dispatchId },
    "the settlement read must skip the dispatch being settled, or HEAD compares with itself",
  );
  assert.equal(spawns.length, 0, "a HEAD change must not buy another automatic redispatch past the cap");
  assert.equal(relates.length, 0, "the escalation rides the durable receipt, not an owner await");
  assert.match(requestState, /head_status: changed/u, "the HEAD change still explains the continuation context");
  assert.match(requestState, /rework_budget: used=3 limit=3 source=daemon/u);
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  if (receipt === null || receipt.status === "claimed") assert.fail("expected an applied receipt");
  assert.equal(receipt.action, "needs_attention");
  assert.match(String(receipt.reason), /budget is exhausted/u);
  assert.deepEqual(receipt.budget, { used: 3, limit: 3, source: "daemon" });
});

test("a measured HEAD change consumes the next continuation slot instead of resetting it", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const priorId = "dispatch_00000000000000000000d001";
  seedAppliedIncidentAction(rootDir, priorId, { used: 1, limit: 3, source: "daemon" }, "2026-10-18T00:00:01.000Z");
  const worktree = commitWorktree(rootDir);
  let requestState = "";
  const executor = openTestExecutor({
      rootDir,
      providers: {
        list: () => [provider],
        port: {
          decide: async (request) => {
            requestState = request.state[0] ?? "";
            return choiceAnswer("rerun_same_identity");
          },
        },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns } = fakeIncidentCell({
      rootDir,
      agentId: "terra",
      continuationContext: {
        dispatchId: priorId,
        lastConclusion: "committed progress on the worktree",
        exitHead: "a".repeat(40),
      },
      workspace: { kind: "worktree", path: worktree.path, state: "materialized" },
      priorDispatches: [{ dispatchId: priorId, receipt: readIncidentActionReceipt(rootDir, priorId) }],
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 1);
  assert.match(requestState, /head_status: changed/u);
  assert.match(requestState, /rework_budget: used=1 limit=3 source=daemon/u);
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  if (receipt === null || receipt.status === "claimed") assert.fail("expected an applied receipt");
  assert.equal(receipt.action, "rerun");
  assert.deepEqual(receipt.budget, { used: 2, limit: 3, source: "daemon" });
});

test("the repository review-return budget does not gate automatic continuation", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const priorId = "dispatch_00000000000000000000c001";
  seedAppliedIncidentAction(
    rootDir,
    priorId,
    // The old counter made this one applied action equal to reviewReturnBudget: 1. The
    // task-level allowance reads 1 of 3 and must keep going.
    { used: 1, limit: 3, source: "repository" },
    "2026-10-18T00:00:01.000Z",
  );
  let requestState = "";
  const executor = openTestExecutor({
      rootDir,
      providers: {
        list: () => [provider],
        port: {
          decide: async (request) => {
            requestState = request.state[0] ?? "";
            return choiceAnswer("rerun_same_identity");
          },
        },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, runtimeContextReads } = fakeIncidentCell({
      rootDir,
      agentId: "terra",
      reviewReturnBudget: 1,
      priorDispatches: [{ dispatchId: priorId, receipt: readIncidentActionReceipt(rootDir, priorId) }],
    });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.deepEqual(runtimeContextReads[0], { taskId: "task-1", excludeDispatchId: dispatchId });
  assert.equal(spawns.length, 1, "reviewReturnBudget changes must not open or close the continuation gate");
  assert.match(requestState, /rework_budget: used=1 limit=3 source=daemon/u);
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  if (receipt === null || receipt.status === "claimed") assert.fail("expected an applied receipt");
  assert.deepEqual(receipt.budget, { used: 2, limit: 3, source: "daemon" });
});

test("the continuation allowance reads the newest recorded disposition", () => {
  const applied = (used: number, decidedAt: string, action: "resume" | "rerun" | "needs_attention" | "no_action") =>
      ({
        pointId: incidentPointId,
        questionVersion: incidentDispositionQuestionVersion,
        status: "applied",
        selected: action === "resume" ? "resume_original" : action === "rerun" ? "rerun_same_identity" : action,
        action,
        attention: action === "needs_attention" ? "guard" : null,
        reason: action === "needs_attention" ? "needs_attention: a guard" : null,
        successorDispatchId: action === "resume" || action === "rerun" ? "dispatch_successor" : null,
        budget: { used, limit: 3, source: "daemon" },
        decidedAt,
      }) as const,
    rows = [
      { decisionAction: applied(2, "2026-10-18T00:00:02.000Z", "rerun") },
      { decisionAction: applied(1, "2026-10-18T00:00:01.000Z", "resume") },
      {
        decisionAction: {
          pointId: incidentPointId,
          questionVersion: incidentDispositionQuestionVersion,
          status: "claimed",
          decidedAt: "2026-10-18T00:00:03.000Z",
        } as const,
      },
    ];
  assert.equal(incidentContinuationUsed(rows), 2, "the newest recorded disposition carries the allowance");
  assert.equal(
    incidentContinuationUsed([...rows, { decisionAction: applied(3, "2026-10-18T00:00:04.000Z", "needs_attention") }]),
    3,
    "an owner escalation keeps the exhausted count as the newest durable state",
  );
  assert.equal(
    incidentContinuationUsed([
      {
        decisionAction: {
          pointId: incidentPointId,
          questionVersion: incidentDispositionQuestionVersion,
          status: "applied",
          selected: "no_action",
          action: "no_action",
          attention: null,
          reason: "owner dismissed the incident",
          successorDispatchId: null,
          budget: null,
          decidedAt: "2026-10-18T00:00:05.000Z",
        } as const,
      },
    ]),
    0,
    "an owner dismissal carries no allowance and starts the next count at zero",
  );
  assert.equal(incidentContinuationUsed([]), 0, "a task with no recorded disposition starts at zero");
});

test("a disabled provider takes the deterministic default instead of waiting for a ruling", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const executor = openTestExecutor({
      rootDir,
      providers: {
        list: () => [{ ...provider, enabled: false }],
        port: { decide: async () => (calls++, choiceAnswer("needs_attention")) },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({ rootDir, agentId: "terra" });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(calls, 0, "a disabled provider is never asked");
  assert.equal(relates.length, 0, "the default disposition must not open an owner await");
  assert.equal(spawns.length, 1, "the same identity is rerun without the provider");
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.status, "failed");
  assert.equal(stored[0]?.failureCode, "provider_disabled");
  assert.equal(stored[0]?.action?.action, "rerun");
  assert.equal(stored[0]?.action?.status, "applied");
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  assert.equal(receipt?.status, "applied");
  assert.equal(receipt?.action, "rerun");
  assert.match(String(receipt?.reason), /provider is disabled/u);
  assert.match(String(receipt?.reason), /Decisions API unavailable/u);
});

test("a disabled provider with nothing automatic to do still escalates", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openTestExecutor({
      rootDir,
      providers: {
        list: () => [{ ...provider, enabled: false }],
        port: { decide: async () => choiceAnswer("rerun_same_identity") },
      },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({ rootDir });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 0);
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  assert.equal(receipt?.action, "needs_attention");
  assert.match(String(receipt?.reason), /no worker identity to rerun/u);
  assert.match(String(receipt?.reason), /Decisions API unavailable/u);
});

test("a submitted cut turns no_action into the receipt and launches nothing", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openTestExecutor({
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

test("a succeeded worker-stop settlement stays out of the incident decision point", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const executor = openTestExecutor({
      rootDir,
      providers: { list: () => [provider], port: { decide: async () => (calls++, choiceAnswer("needs_attention")) } },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({});
  await executor.settle(cell, incidentOutcomeEvent("succeeded"));
  assert.equal(calls, 0);
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 0);
  assert.equal(readIncidentActionReceipt(rootDir, dispatchId), null);
});

test("a switch choice on a worker-stop incident is inadmissible and escalates", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openTestExecutor({
      rootDir,
      providers: { list: () => [provider], port: { decide: async () => choiceAnswer("switch_declared_next") } },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({});
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 0);
  const stored = await openDecisionAnnotationStore(rootDir).export();
  assert.equal(stored[0]?.action?.action, "needs_attention");
  assert.equal(stored[0]?.action?.selected, "switch_declared_next");
});

test("a failed launch escalates to the owner and records the launch failure", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  const executor = openTestExecutor({
      rootDir,
      providers: { list: () => [provider], port: { decide: async () => choiceAnswer("resume_original") } },
      now: () => "2026-10-19T00:00:01.000Z",
    }),
    { cell, spawns, relates } = fakeIncidentCell({ resume: { dispatchId, agentId: "terra" }, spawnFails: true });
  await executor.settle(cell, incidentOutcomeEvent());
  assert.equal(spawns.length, 0);
  assert.equal(relates.length, 0);
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
      continuationBudget: { used: 1, limit: 2, source: "daemon" },
    },
  });
  assert.ok(projected);
  assert.ok(!projected.state.includes("/Users/zeyu"), "report local paths must be redacted");
  assert.ok(!projected.state.includes("/home/worker"), "conclusion local paths must be redacted");
  assert.match(projected.state, /last_conclusion: .*LOCAL_PATH/u);
  assert.match(projected.state, /rework_budget: used=1 limit=2 source=daemon/u);
  assert.ok(projected.state.includes("a".repeat(40)) && projected.state.includes("b".repeat(40)));
});

// ── Review blockers: one claim per dispatch, HEAD fail-closed, durable canonical receipts ──────

test("a later settlement observation after the first action lands never acts twice", async (t) => {
  const rootDir = isolatedRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedIncidentStream(rootDir);
  let calls = 0;
  const executor = openTestExecutor({
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
  const executor = openTestExecutor({
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
  assert.equal(relates.length, 0, "owner escalation rides the durable dispatch receipt");
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
    budget: { used: 3, limit: 3, source: "daemon" },
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

  const executor = openTestExecutor({
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
  assert.equal(relates.length, 0);
});
