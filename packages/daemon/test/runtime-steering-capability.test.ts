// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { renderEvidencePayload } from "@harness-anything/application/queries";
import { dispatchLifecycleSummary, type AgentRuntimeEventV1 } from "@harness-anything/kernel";
import { runtimeKinds } from "../src/runtime-engine/runtime-inventory.ts";
import { runtimeSpawnReceipt } from "../src/runtime-engine/runtime-spawn-receipt.ts";
import { validateRuntimeSpawnReceipt } from "../src/daemon-host/gui-s3-control.ts";
import { validateDaemonGuiCommandReceipt } from "../src/daemon-host/protocol/daemon-protocol-validate-results.ts";
import { makeAgentActionRuntime } from "../src/daemon-host/squad-action-runtime.ts";
import { validDispatchLifecycleSummary } from "../src/daemon-host/protocol/daemon-protocol-validate-relation-query.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

for (const [kindId, supported] of [
  ["agy", false],
  ["zcode", false],
  ["codex", true],
  ["agy-acp", true],
] as const) {
  test(`${kindId} declares steer support consistent with its actual adapter`, () => {
    const kind = runtimeKinds.find((entry) => entry.kindId === kindId)!;
    assert.equal(kind.steerSupported, supported);
    assert.equal(kind.capabilities.steer, supported ? "supported" : "unsupported");
    assert.equal(kind.steer !== undefined, supported);
  });
  test(`${kindId} lifecycle exposes steer availability without changing process liveness`, () => {
    const options = { instanceId: "worker", dispatchId: "dispatch", source: "local" as const },
      raw = lifecycleEvent("R", "session", options),
      admission = { ...raw, payload: { ...raw.payload, kindId } } as AgentRuntimeEventV1,
      events = [admission, lifecycleEvent("S", "session", options)],
      read = dispatchLifecycleReadOf(() => events)({ by: "session", runtimeSessionId: "session" });
    assert.equal(read.status, "ready");
    if (read.status !== "ready") throw new Error("fixture lifecycle pending");
    assert.equal(read.rows[0]!.policy.canSteer, supported);
    assert.equal(read.rows[0]!.policy.processAlive, true);
    assert.equal(dispatchLifecycleSummary(read).displayStatus, "running");
    const summary = dispatchLifecycleSummary(read);
    assert.equal(validDispatchLifecycleSummary(summary), true);
    assert.equal(
      validDispatchLifecycleSummary({ ...summary, policy: { ...summary.policy, processAlive: "true" } }),
      false,
    );
    const { processAlive: _newField, ...previousPolicy } = summary.policy!;
    assert.equal(validDispatchLifecycleSummary({ ...summary, policy: previousPolicy }), true);
    assert.equal(read.rows[0]!.policy.capacity, "held");
  });
  test(`${kindId} dispatch receipts explicitly report steer support, including replay`, () => {
    const raw = lifecycleEvent("R", "session", { source: "local", dispatchId: "dispatch" }),
      event = {
        ...raw,
        payload: {
          ...raw.payload,
          kindId,
          definitionSnapshot: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId: "worker",
            installationId: "installation",
            kindId,
            providerId: "test-provider",
            model: "model",
            reasoningEffort: null,
            endpointKind: "official",
            baseUrlHash: null,
            authMode: "subscription",
          },
        },
      } as AgentRuntimeEventV1;
    for (const revision of [event.workspaceRevision, 0]) {
      const receipt = runtimeSpawnReceipt(
        event,
        { cut: { opId: event.opId, revision } } as never,
        "session",
        "dispatch",
      );
      assert.equal(receipt.steerSupported, supported);
      assert.deepEqual(validateDaemonGuiCommandReceipt(receipt), []);
      assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...receipt, steerSupported: "false" }), []);
      assert.notDeepEqual(validateDaemonGuiCommandReceipt({ ...receipt, command: "task-start" }), []);
      if (receipt.outcome === "applied") {
        const cut = { repoId: "repo", generation: 1, revision, headDigest: `sha256:${"a".repeat(64)}` },
          pending = { state: "pending", cut: null },
          wire = {
            ...receipt,
            cut,
            commitSha: null,
            authorizationDecision: null,
            status: "accepted_durable",
            acceptance: {
              storage: "sqlite",
              durability: "local_fsync",
              recordedAt: "2026-11-18T00:00:00Z",
              revisionFrom: revision,
              revisionTo: revision,
              memberOpIds: [event.opId],
              cut,
            },
            projection: { state: "verified", cut },
            git: { ...pending, commitSha: null },
            worktree: pending,
            replica: pending,
          };
        assert.deepEqual(validateRuntimeSpawnReceipt(wire), []);
        const { steerSupported: _newField, ...previousReceipt } = wire;
        assert.deepEqual(validateRuntimeSpawnReceipt(previousReceipt), []);
        assert.deepEqual(validateRuntimeSpawnReceipt({ ...wire, steerSupported: "false" }), [
          "runtime spawn receipt.steerSupported must be optional-boolean",
        ]);
      }
    }
  });
}

test("agent inspect reports each declared runtime capability in structured and CLI output", () => {
  const agent = {
      schema: "agent-declaration/v1",
      id: "mixed",
      name: "Mixed worker",
      instructions: "Implement the assigned task.",
      runtimes: [
        { type: "agy", model: "model" },
        { type: "codex", model: "model" },
      ],
    },
    run = makeAgentActionRuntime({
      projection: { readCut: () => ({ sourceRevision: 1 }), getEntity: () => ({ value: agent, currentVersion: 1 }) },
      readResult: (_op: string, payload: object) => payload,
    } as never),
    inspected = run({ id: "inspect" } as never, { agentId: "mixed" } as never, {} as never, "inspect") as unknown as {
      runtimeCapabilities: readonly { kindId: string; steerSupported: boolean }[];
    };
  assert.deepEqual(inspected.runtimeCapabilities, [
    { kindId: "agy", steerSupported: false },
    { kindId: "codex", steerSupported: true },
  ]);
  assert.match(renderEvidencePayload(inspected), /kindId=agy\s+steerSupported=false/u);
});

test("all provider steer capabilities match their strategy, including unknown kinds failing closed", () => {
  for (const kind of runtimeKinds) assert.equal(kind.steerSupported, kind.steer !== undefined, kind.kindId);
  const raw = lifecycleEvent("R", "unknown", { source: "local", dispatchId: "unknown" }),
    admission = { ...raw, payload: { ...raw.payload, kindId: "future-provider" } } as AgentRuntimeEventV1,
    read = dispatchLifecycleReadOf(() => [
      admission,
      lifecycleEvent("S", "unknown", { source: "local", dispatchId: "unknown" }),
    ])({ by: "session", runtimeSessionId: "unknown" });
  assert.equal(read.status === "ready" && read.rows[0]!.policy.canSteer, false);
});
