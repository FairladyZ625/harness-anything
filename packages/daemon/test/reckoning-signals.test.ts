// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalEventV1, RuntimeSession } from "../../kernel/src/index.ts";
import { collectReckoningSignals } from "../src/reckoning-signals.ts";

const now = Date.parse("2026-09-19T23:30:00.000Z");

function session(
  input: Partial<RuntimeSession> & Pick<RuntimeSession, "runtimeSessionId" | "instanceId">,
): RuntimeSession {
  return {
    installationId: "installation_test",
    kindId: "codex",
    definitionSnapshotRef: "artifact:test",
    providerSessionId: null,
    transcriptRef: null,
    launchGeneration: 0,
    liveness: "exited",
    attachable: false,
    taskBindings: [],
    outcome: "failed",
    exitCode: 1,
    resultRef: null,
    lastObservedAt: new Date(now).toISOString(),
    ...input,
  };
}

test("reckoning groups abnormal sessions and excludes principal cancellations", () => {
  const result = collectReckoningSignals({
    events: [],
    sessions: [
      session({ runtimeSessionId: "runtime_1", instanceId: "instance_a" }),
      session({ runtimeSessionId: "runtime_2", instanceId: "instance_a" }),
      session({
        runtimeSessionId: "runtime_3",
        instanceId: "instance_a",
        outcome: "cancelled",
        cancelledBy: { principal: { personId: "person_owner" }, executor: null },
      }),
    ],
    since: now - 86_400_000,
    until: now,
  });
  assert.deepEqual(
    result.signals.map(({ kind, occurrences }) => [kind, occurrences]),
    [["abnormal-session", 2]],
  );
});

test("reckoning calls rework only for repeated failed attempts in one execution and instance", () => {
  const binding = {
    taskId: "task_a",
    executionId: "exe_a",
    providerSessionId: null,
    transcriptRef: null,
    boundAt: new Date(now).toISOString(),
  };
  const result = collectReckoningSignals({
    events: [],
    sessions: [
      session({ runtimeSessionId: "runtime_1", instanceId: "instance_a", taskBindings: [binding] }),
      session({ runtimeSessionId: "runtime_2", instanceId: "instance_a", taskBindings: [binding] }),
      session({
        runtimeSessionId: "runtime_3",
        instanceId: "instance_b",
        taskBindings: [binding],
        outcome: "succeeded",
      }),
    ],
    since: now - 86_400_000,
    until: now,
  });
  assert.equal(result.signals.filter(({ kind }) => kind === "rework").length, 1);
});

test("one superseding fact is one correction, never two recurrences", () => {
  const event = {
    type: "fact_recorded",
    occurredAt: new Date(now).toISOString(),
    workspaceRevision: 4,
    entity: { kind: "fact", id: "F-ABCDEFGH" },
    payload: { supersedes: { factRef: "fact/F-12345678", rationale: "new evidence" } },
  } as unknown as CanonicalEventV1;
  const result = collectReckoningSignals({ events: [event], sessions: [], since: now - 86_400_000, until: now });
  assert.deepEqual(
    result.signals.map(({ kind, occurrences }) => [kind, occurrences]),
    [["corrected-fact", 1]],
  );
});
