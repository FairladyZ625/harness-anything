// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalEventV1, RuntimeSession } from "@harness-anything/kernel";
import { collectReckoningSignals, readReckoningSignals } from "../src/reckoning-signals.ts";

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

test("the signal read uses an indexed time range and keeps an acceptance before the signal window", () => {
  const DAY = 86_400_000,
    at = (revision: number, ageDays: number, type: string, id: string) =>
      ({
        type,
        workspaceRevision: revision,
        occurredAt: new Date(now - ageDays * DAY).toISOString(),
        entity: { kind: "decision", id },
        payload: {},
      }) as unknown as CanonicalEventV1,
    // 2,000 old events, then an accept six days ago and its supersede inside the 24 hour window.
    ledger = [
      ...Array.from({ length: 2_000 }, (_, index) => at(index + 1, 30, "decision_accepted", `dec_old_${index}`)),
      at(2_001, 6, "decision_accepted", "dec_short"),
      at(2_002, 0.5, "decision_superseded", "dec_short"),
    ],
    reads: unknown[] = [];
  const result = readReckoningSignals(
    {
      queryEvents: (query) => {
        reads.push(query);
        return ledger.filter(
          (event) =>
            event.type === query.type &&
            (query.after === undefined || event.occurredAt >= query.after) &&
            (query.before === undefined || event.occurredAt <= query.before),
        );
      },
    },
    { readRuntimeSessions: () => [] },
    new Date(now).toISOString(),
  );
  assert.deepEqual(
    result.signals.map((signal) => signal.key),
    ["decision:dec_short"],
  );
  // Only the types the signals read are queried, and only accepts reach back past the window.
  const before = new Date(now).toISOString(),
    windowStart = new Date(now - DAY).toISOString(),
    limit = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(reads, [
    { type: "fact_recorded", after: windowStart, before, limit },
    { type: "decision_superseded", after: windowStart, before, limit },
    { type: "decision_retired", after: windowStart, before, limit },
    { type: "decision_accepted", after: new Date(now - 8 * DAY).toISOString(), before, limit },
  ]);
});

test("out-of-order imported timestamps cannot hide a recent correction", () => {
  const DAY = 86_400_000,
    correction = {
      type: "fact_recorded",
      occurredAt: new Date(now - DAY / 2).toISOString(),
      workspaceRevision: 1,
      entity: { kind: "fact", id: "F-NEW" },
      payload: { supersedes: { factRef: "fact/F-OLD" } },
    } as unknown as CanonicalEventV1,
    imports = Array.from({ length: 500 }, (_, index) => ({
      type: "entity_upserted",
      occurredAt: new Date(now - 30 * DAY).toISOString(),
      workspaceRevision: index + 2,
      payload: {},
    })) as unknown as CanonicalEventV1[];
  const result = readReckoningSignals(
    {
      queryEvents: (query) =>
        [correction, ...imports].filter(
          (event) => event.type === query.type && event.occurredAt >= query.after! && event.occurredAt <= query.before!,
        ),
    },
    { readRuntimeSessions: () => [] },
    new Date(now).toISOString(),
  );
  assert.deepEqual(
    result.signals.map(({ key }) => key),
    ["fact/F-OLD"],
  );
});
