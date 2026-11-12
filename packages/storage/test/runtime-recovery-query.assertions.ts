import assert from "node:assert/strict";
import type { AgentRuntimeEventV1, TaskProjectionQueries } from "@harness-anything/kernel";
import { canonicalEventWritePlan, type CanonicalWriteBundle } from "../src/store/task-event-store.ts";

// Keep these independent owner cases before the existing dispatch page contract's time window.
export async function appendRecoveryQueryFixtures(
  append: (bundle: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
): Promise<void> {
  for (const [suffix, nodeId] of [
    ["a", "node-query-a"],
    ["b", "node-query-b"],
    ["c", "node-query-a"],
  ] as const) {
    const id = `recovery-query-${suffix}`;
    const put = async (type: AgentRuntimeEventV1["type"], payload: unknown) => {
      const event = {
        schema: "agent-runtime-event/v1",
        type,
        payload,
        eventId: `${id}-${type}`,
        opId: `${id}-${type}`,
        workspaceRevision: revision(),
        occurredAt: "2025-11-05T00:00:00.000Z",
        actor: { principal: { personId: "query-fixture" }, executor: null },
        source: { kind: "node", nodeId },
      } as AgentRuntimeEventV1;
      await append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
    };
    await put("runtime_dispatch_requested", {
      dispatchId: id,
      dispatchKey: id,
      runtimeSessionId: id,
      instanceId: "query-worker",
      installationId: "query-installation",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definitions/query/v1",
      definitionSnapshot: {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "query-worker",
        installationId: "query-installation",
        kindId: "codex",
        providerId: "openai",
        model: "codex-fixture",
        reasoningEffort: null,
        baseUrl: null,
        authMode: "subscription",
      },
      startedAt: "2025-11-05T00:00:00.000Z",
    });
    await put("runtime_session_started", {
      runtimeSessionId: id,
      instanceId: "query-worker",
      installationId: "query-installation",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definitions/query/v1",
      launchGeneration: 1,
      attachable: false,
    });
    // a (unsettled) and c (settled) resumed one native session; b has its own.
    await put("runtime_session_provider_bound", {
      runtimeSessionId: id,
      providerSessionId: suffix === "b" ? "provider-query-b" : "provider-query-shared",
      transcriptRef: `artifact:runtime-transcript/${id}`,
    });
    if (suffix === "b") await put("runtime_session_exited", { runtimeSessionId: id });
    if (suffix === "c")
      await put("runtime_session_outcome_observed", {
        runtimeSessionId: id,
        dispatchId: id,
        outcome: "succeeded",
        exitCode: 0,
        endedAt: "2025-11-05T00:00:00.000Z",
        resultRef: "artifact:runtime-result/sha256/" + "1".repeat(64),
        result: null,
      });
  }
}

export function assertRecoveryQueryContract(queries: TaskProjectionQueries): void {
  const ids = (query: Parameters<TaskProjectionQueries["readRuntimeSessions"]>[0]) =>
    queries
      .readRuntimeSessions(query)
      .map(({ runtimeSessionId }) => runtimeSessionId)
      .sort();
  assert.deepEqual(ids({ executionOwnerNodeId: "node-query-a" }), ["recovery-query-a", "recovery-query-c"]);
  assert.deepEqual(ids({ executionOwnerNodeId: "node-query-a", unsettledOnly: true }), ["recovery-query-a"]);
  assert.deepEqual(ids({ executionOwnerNodeId: "node-query-b", unsettledOnly: true }), ["recovery-query-b"]);
  assert.deepEqual(ids({ runtimeSessionId: "recovery-query-c", executionOwnerNodeId: "node-query-a" }), [
    "recovery-query-c",
  ]);
  assert.deepEqual(ids({ runtimeSessionId: "recovery-query-c", executionOwnerNodeId: "node-query-b" }), []);
  assert.deepEqual(ids({ runtimeSessionId: "recovery-query-c", unsettledOnly: true }), []);
  // The deprecated nonExitedOnly query now means the center lifecycle active set:
  // accepted exit without outcome remains pending; an accepted terminal outcome closes the group.
  assert.deepEqual(ids({ runtimeSessionId: "recovery-query-b", nonExitedOnly: true }), ["recovery-query-b"]);
  assert.deepEqual(ids({ runtimeSessionId: "recovery-query-c", nonExitedOnly: true }), []);
  assert.deepEqual(ids({ executionOwnerNodeId: "node-query-a", nonExitedOnly: true }), ["recovery-query-a"]);
  assert.deepEqual(ids({ executionOwnerNodeId: "node-query-b", nonExitedOnly: true }), ["recovery-query-b"]);
  assert.deepEqual(ids({ runtimeSessionId: "recovery-query-a", observedAfter: "2025-11-05T00:00:00.001Z" }), []);
  assert.deepEqual(ids({ runtimeSessionId: "recovery-query-c", observedBefore: "2025-11-04T23:59:59.999Z" }), []);
  assert.deepEqual(
    ids({
      executionOwnerNodeId: "node-query-a",
      observedAfter: "2025-11-05T00:00:00.000Z",
      observedBefore: "2025-11-05T00:00:00Z",
    }),
    ["recovery-query-a", "recovery-query-c"],
  );
  // Live sessions stay in the activity window even after an outcome was observed; exited ones
  // enter only through their observation time. Bounds with a different precision compare as instants.
  assert.deepEqual(ids({ executionOwnerNodeId: "node-query-a", activitySince: "2026-01-01T00:00:00Z" }), [
    "recovery-query-a",
    "recovery-query-c",
  ]);
  assert.deepEqual(ids({ executionOwnerNodeId: "node-query-b", activitySince: "2026-01-01T00:00:00Z" }), []);
  assert.deepEqual(ids({ runtimeSessionId: "recovery-query-b", activitySince: "2025-11-05T00:00:00.000Z" }), [
    "recovery-query-b",
  ]);
  assert.deepEqual(ids({ runtimeSessionId: "recovery-query-a", unsettledOnly: true }), ["recovery-query-a"]);
  assert.deepEqual(ids({ providerSessionId: "provider-query-shared" }), ["recovery-query-a", "recovery-query-c"]);
  assert.deepEqual(ids({ providerSessionId: "provider-query-shared", unsettledOnly: true }), ["recovery-query-a"]);
  assert.deepEqual(ids({ providerSessionId: "provider-query-missing" }), []);
  assert.deepEqual(
    queries.readRuntimeSessions({ runtimeSessionId: "recovery-query-a" })[0],
    queries.readRuntimeSession("recovery-query-a"),
  );
}
