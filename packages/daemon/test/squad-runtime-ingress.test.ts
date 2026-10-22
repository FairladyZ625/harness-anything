// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentRuntimeEventV1, PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import { normalizeHistoricalSquadRunIdentity } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events";
import type { RepoCellActionContext } from "../src/repo-cell-action-context.ts";
import type { RepoCellBinding, RuntimeIngressAction } from "../src/repo-cell-types.ts";
import { requireSquadRuntimeOwner } from "../src/squad-runtime-ingress.ts";

const historicalEvents = JSON.parse(
  readFileSync(new URL("../../kernel/fixtures/squad-history/flat-task-identity.json", import.meta.url), "utf8"),
) as PersistedCanonicalEventV1[];

test("historical flat Squad dispatch accepts the first subject-shaped observation", () => {
  const dispatch = historicalEvents[0] as unknown as Extract<
      AgentRuntimeEventV1,
      { type: "runtime_dispatch_requested" }
    >,
    historicalObservation = historicalEvents[1] as unknown as Extract<
      AgentRuntimeEventV1,
      { type: "runtime_squad_run_observed" }
    >,
    observedPayload = normalizeHistoricalSquadRunIdentity(historicalObservation.payload) as Record<string, unknown>,
    binding: RepoCellBinding = { actor: dispatch.actor, source: dispatch.source },
    projection = {
      readRuntimeDispatchById: (dispatchId: string) =>
        dispatchId === dispatch.payload.squadRun?.squadRunId
          ? { event: dispatch }
          : dispatchId === dispatch.payload.dispatchId
            ? { event: dispatch }
            : null,
      readRuntimeSession: () => null,
      readLeaseIntervals: () => [],
    },
    cell = {
      projection,
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as unknown as RepoCellActionContext,
    action: RuntimeIngressAction = {
      kind: "event",
      type: "runtime_squad_run_observed",
      opId: `squad-observed-${String(observedPayload.squadRunId)}-${String(observedPayload.runRevision)}`,
      payload: observedPayload,
    };

  assert.equal((dispatch.payload.squadRun as Record<string, unknown>).subject, undefined);
  assert.deepEqual(observedPayload.subject, {
    kind: "task",
    taskId: "task_000000000000000000000001",
    executionId: "exe_000000000000000000000001",
  });
  assert.doesNotThrow(() =>
    requireSquadRuntimeOwner(cell, action as Extract<RuntimeIngressAction, { kind: "event" }>, binding),
  );
});
