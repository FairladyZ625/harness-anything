// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { readFleetReceiptClient, runFleetRuntimeEventClient } from "../src/fleet/peer.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

test("a runtime retry returning no_changes preserves the earlier committed receipt", { timeout: 60_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t),
    dispatchKey = "f3-runtime-retry",
    hash = createHash("sha256").update(`lease-repo\0${dispatchKey}`).digest("hex"),
    dispatchId = `dispatch_${hash.slice(0, 24)}`,
    runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
    instanceId = "runtime-instance-f3",
    installationId = "runtime-installation-f3",
    kindId = "codex",
    definitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId,
      installationId,
      kindId,
      providerId: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      baseUrl: null,
      authMode: "subscription",
    },
    dispatch = await runFleetRuntimeEventClient({
      ...f.peer("node-one"),
      opId: randomUUID(),
      eventType: "runtime_dispatch_requested",
      payload: {
        dispatchId,
        runtimeSessionId,
        instanceId,
        installationId,
        kindId,
        dispatchKey,
        definitionSnapshotRef: "artifact:runtime-definition/f3",
        definitionSnapshot,
      },
      dispatchContext: { role: null, taskId: null, executionId: null },
    });
  assert.equal(dispatch.receipt.outcome, "applied", JSON.stringify(dispatch));

  const frameOpId = randomUUID(),
    payload = {
      runtimeSessionId,
      instanceId,
      installationId,
      kindId,
      definitionSnapshotRef: "artifact:runtime-definition/f3",
      launchGeneration: 1,
      attachable: true,
    },
    options = {
      ...f.peer("node-one"),
      opId: frameOpId,
      eventType: "runtime_session_started",
    } as const;

  const first = await runFleetRuntimeEventClient({ ...options, payload });
  assert.equal(first.receipt.outcome, "applied", JSON.stringify(first));
  const committedOpId = String(first.event?.opId);
  assert.match(committedOpId, uuid);

  // The caller lost the first response and retries the same frame/payload. The reducer returns
  // no_changes with a fresh center id; that id was never appended. The listener must not
  // overwrite the recoverable committed target with it (review F3).
  const retry = await runFleetRuntimeEventClient({ ...options, payload });
  assert.equal(retry.receipt.outcome, "no_changes", JSON.stringify(retry));
  assert.equal(retry.event, null);

  const recovered = await readFleetReceiptClient({ ...f.peer("node-one"), opId: frameOpId });
  assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
  assert.equal(recovered.opId, committedOpId, "the request id still resolves to the committed event");
});

test(
  "runtime-event frame opId stays correlation; stored event identity is center-minted per request",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t),
      ingressOpIds: string[] = [];
    // Observe the listener -> runtime ingress boundary. A reused frame opId must not become the
    // stored event/command key, or the second event would hit storage dedup/op_conflict before the
    // RuntimeSession reducer can decide its transition.
    Object.defineProperty(f.host, "runtimeIngress", {
      configurable: true,
      value: async (
        _repoId: string,
        action: { readonly opId: string; readonly type: string; readonly payload: JsonObject },
      ) => {
        ingressOpIds.push(action.opId);
        return {
          outcome: "applied",
          opId: action.opId,
          event: { schema: "agent-runtime-event/v1", opId: action.opId, type: action.type, payload: action.payload },
          replicationSequence: null,
        } satisfies JsonObject;
      },
    });
    const frameOpId = randomUUID(),
      payload = { runtimeSessionId: "runtime_correlation", liveness: "live", occurredAt: "2026-11-05T00:00:00.000Z" },
      options = {
        ...f.peer("node-one"),
        opId: frameOpId,
        eventType: "runtime_session_liveness_changed",
      } as const;

    const first = await runFleetRuntimeEventClient({ ...options, payload }),
      second = await runFleetRuntimeEventClient({
        ...options,
        payload: { ...payload, liveness: "stale" },
      });

    assert.equal(ingressOpIds.length, 2);
    assert.deepEqual(ingressOpIds, [String(first.event?.opId), String(second.event?.opId)]);
    assert.notEqual(ingressOpIds[0], ingressOpIds[1], "each ingress request gets a new stored identity");
    for (const opId of ingressOpIds) {
      assert.match(opId, uuid, "the center-minted event identity is a random UUID");
      assert.notEqual(opId, frameOpId, "the caller's frame opId never becomes the stored event identity");
    }
  },
);
