// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decisionPointBindingDigest,
  type AdvisoryDecision,
  type AgentRuntimeEventV1,
  type DecisionPointDeclaration,
  type DecisionQuestionDeclaration,
  type VerticalDefinition,
} from "@harness-anything/kernel";
import type { RepoCell } from "../src/repo-cell-types.ts";
import {
  decisionPointBindingDigestForVertical,
  openDecisionPointExecutor,
  projectDecisionInput,
} from "../src/decision-point-executor.ts";
import {
  decisionAdvisoryFromProvider,
  openDecisionAnnotationStore,
  readDecisionAnnotationsByDispatch,
} from "../src/decision-annotations.ts";

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
