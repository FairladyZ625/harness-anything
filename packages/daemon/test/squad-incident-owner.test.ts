// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { readDecisionAnnotationsByDispatch } from "../src/decision-annotations.ts";
import { incidentDispositionQuestionVersion } from "../src/decision-incident-action.ts";
import { readIncidentActionReceipt } from "../src/decision-incident-receipt.ts";
import { openDecisionPointExecutor } from "../src/decision-point-executor.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { validTaskDispatchRow } from "../src/protocol/daemon-protocol-validate-relation-query.ts";
import type { TaskDispatchRow } from "../src/protocol/task-dispatch-contract.ts";
import { lifecycleReadFor } from "./dispatch-lifecycle-read.fixtures.ts";
import type { RepoCell } from "../src/repo-cell-types.ts";

const dispatchId = "dispatch_0123456789abcdef01234567",
  squadRunId = "squad_0123456789abcdef01234567",
  baseRow: TaskDispatchRow = {
    dispatchId,
    taskId: "task-child",
    executionId: "execution-child",
    runtimeSessionId: "runtime-child",
    instanceId: "instance-fixture",
    attemptGroupId: "attempt-fixture",
    attemptIndex: 1,
    provider: { instance: "instance-fixture", model: null },
    classification: "worker_stop",
    reason: "No submitted delivery.",
    fallbackState: null,
    nextDispatchId: null,
    squadId: "fixture-squad",
    providerSessionId: null,
    eventStreamRef: null,
    startedAt: "2026-11-05T07:01:00.115Z",
    endedAt: "2026-11-05T07:02:23.758Z",
    outcome: "stopped",
    status: "stopped",
  };

test("dispatch transport accepts optional squad run ownership and rejects a malformed marker", () => {
  assert.equal(validTaskDispatchRow(baseRow), true);
  assert.equal(validTaskDispatchRow({ ...baseRow, squadRunId }), true);
  for (const invalid of ["", null, 12, {}])
    assert.equal(validTaskDispatchRow({ ...baseRow, squadRunId: invalid }), false);
});

for (const scenario of [
  { name: "stopped squad child", owned: true, outcome: "stopped", executable: true },
  { name: "failed squad child", owned: true, outcome: "failed", executable: true },
  { name: "squad advisory", owned: true, outcome: "stopped", executable: false },
  { name: "direct dispatch by the same squad", owned: false, outcome: "stopped", executable: true },
] as const) {
  test(`settlement preserves the lifecycle owner for ${scenario.name}`, async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-incident-owner-"));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const pointId = "worker-stop",
      question: DecisionQuestionDeclaration = {
        version: scenario.executable ? incidentDispositionQuestionVersion : "squad-advisory/v1",
        type: "choice",
        prompt: "Classify the stopped worker.",
        options: [{ id: "needs_attention", text: "Needs attention" }],
        criteria: { needs_attention: "The worker stopped." },
        abstainOptionId: "needs_attention",
      },
      point: DecisionPointDeclaration = {
        revision: "1",
        on: "dispatch.settled",
        when: { outcome: ["stopped", "failed"], classification: ["worker_stop"] },
        input: ["report.body"],
        question: "stop",
        show: ["task.dispatches"],
      },
      vertical = { decisions: { questions: { stop: question }, points: { [pointId]: point } } } as VerticalDefinition,
      reads: string[] = [],
      row = { ...baseRow, ...(scenario.owned ? { squadRunId } : {}) },
      cell = {
        readDispatchLifecycle: lifecycleReadFor([
          { dispatchId, runtimeSessionId: row.runtimeSessionId, attemptSettled: true },
        ]),
        read: async (method: string) => {
          reads.push(method);
          if (method === "repo.agentRuntime.sessions.read")
            return {
              status: "ready",
              session: { associations: [{ taskId: row.taskId }] },
              result: { text: "Worker stopped; the squad leader receives this outcome." },
            };
          if (method === "repo.task.dispatches") return { dispatches: [row] };
          if (method === "repo.vertical.declaration.read") return { declaration: vertical };
          if (method === "repo.settings.read")
            return {
              settings: {
                decisions: {
                  provider: "provider",
                  enabledPoints: [`${pointId}@${decisionPointBindingDigest(pointId, point, question).slice(0, 12)}`],
                },
              },
            };
          if (method === "repo.tasks.runtimeContext.read")
            return {
              continuationContext: null,
              snapshot: { task: { iteration: 1 }, executions: [], lease: null, workspace: null },
            };
          throw new Error(`Unexpected incident read: ${method}`);
        },
        spawnRuntime: async () => {
          throw new Error("This settlement must not launch another runtime.");
        },
      } as unknown as RepoCell;
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: row.taskId,
      executionId: row.executionId,
      runtimeSessionId: row.runtimeSessionId,
      instanceId: row.instanceId,
      startedAt: row.startedAt,
    });
    let providerCalls = 0;
    const executor = openDecisionPointExecutor({
      rootDir,
      keycloakSession: async () => {
        throw new Error("This settlement must not acquire another lifecycle actor.");
      },
      now: () => "2026-11-05T07:02:32.232Z",
      providers: {
        list: () => [
          {
            schema: "decision-provider/v1",
            providerId: "provider",
            name: "Fixture",
            providerType: "decisions",
            vendor: "openrouter",
            model: "fixture",
            baseUrl: null,
            auth: { mode: "api-key", credentialRef: "fixture" },
            enabled: true,
            configurationRevision: 1,
            configurationId: "fixture",
            probe: { state: "unknown" },
          },
        ],
        port: {
          decide: async () => {
            providerCalls += 1;
            return {
              disposition: "advisory",
              authoritative: false,
              subjectRef: `dispatch/${dispatchId}`,
              questionSetVersion: question.version,
              questionType: "choice",
              result: { type: "choice", selected: "needs_attention" },
              distribution: { needs_attention: 1 },
              provider: {
                providerId: "provider",
                vendor: "openrouter",
                requestedModel: "fixture",
                resolvedModel: "fixture",
                modelVersion: null,
                providerRoute: null,
              },
              usage: { inputTokens: 1, outputTokens: 1, reportedCost: null },
              latencyMs: 1,
            } as AdvisoryDecision;
          },
        },
      },
    });
    await executor.settle(cell, {
      schema: "agent-runtime-event/v1",
      type: "runtime_session_outcome_observed",
      occurredAt: "2026-11-05T07:02:23.758Z",
      payload: {
        dispatchId,
        runtimeSessionId: row.runtimeSessionId,
        outcome: scenario.outcome,
        exitCode: 0,
        attempt: { classification: "worker_stop", reason: "No submitted delivery." },
      },
    } as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>);
    const skipped = scenario.owned && scenario.executable,
      advisory = readDecisionAnnotationsByDispatch(rootDir, [dispatchId], "task.dispatches").get(dispatchId) ?? [],
      receipt = readIncidentActionReceipt(rootDir, dispatchId);
    assert.equal(providerCalls, skipped ? 0 : 1);
    assert.equal(advisory.length, skipped ? 0 : 1);
    assert.equal(receipt?.action ?? null, !scenario.owned && scenario.executable ? "needs_attention" : null);
    assert.deepEqual(reads, [
      "repo.agentRuntime.sessions.read",
      "repo.task.dispatches",
      "repo.vertical.declaration.read",
      "repo.settings.read",
      ...(!scenario.owned && scenario.executable ? ["repo.tasks.runtimeContext.read"] : []),
    ]);
  });
}
