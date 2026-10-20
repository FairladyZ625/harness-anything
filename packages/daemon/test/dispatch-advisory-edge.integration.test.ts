// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { openDecisionAnnotationStore } from "../src/decision-annotations.ts";

// Real center projection + local-only annotations + authenticated edge JSON-RPC read.
test(
  "edge GUI and CLI dispatch reads return center advisory values and absence without a local annotation store",
  { timeout: 120_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    const created = await f.command("center-node", {
      kind: "task-create",
      taskId: "advice-task",
      title: "Advisory read",
    });
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const started = await f.command("center-node", { kind: "task-start", taskId: "advice-task" });
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const hash = createHash("sha256").update("lease-repo\0advisory-edge").digest("hex"),
      dispatchId = `dispatch_${hash.slice(0, 24)}`;
    const dispatched = await f.host.runtimeIngress(
      "lease-repo",
      {
        kind: "event",
        type: "runtime_dispatch_requested",
        opId: `runtime-spawn-${hash.slice(0, 32)}`,
        payload: {
          dispatchId,
          runtimeSessionId: `runtime_${hash.slice(24, 48)}`,
          instanceId: "fixture-runtime",
          installationId: "fixture-installation",
          kindId: "codex",
          dispatchKey: "advisory-edge",
          definitionSnapshotRef: "artifact:runtime-definition/advisory-edge",
          definitionSnapshot: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId: "fixture-runtime",
            installationId: "fixture-installation",
            kindId: "codex",
            providerId: "openai",
            model: "fixture-model",
            reasoningEffort: null,
            baseUrl: null,
            authMode: "subscription",
          },
          taskId: "advice-task",
          executionId: started.receipt!.executionId,
        },
      },
      localAuthFixture(),
    );
    assert.equal(dispatched.outcome, "applied", JSON.stringify(dispatched));
    const e = await fleetEdgeHostFixture(t, f);
    const read = async (payload: Record<string, unknown> = { taskId: "advice-task" }) => {
      const response = await e.rpc.handle({
        jsonrpc: "2.0",
        id: "advisory",
        method: "repo.task.dispatches",
        params: { repo: { repoId: "lease-repo" }, payload },
      });
      assert.ok(response && "result" in response, JSON.stringify(response));
      return response.result as { dispatches: readonly { dispatchId: string; advisories?: unknown }[] };
    };
    const empty = await read();
    assert.equal(empty.dispatches[0]!.dispatchId, dispatchId);
    assert.equal(empty.dispatches[0]!.advisories, undefined);
    const store = openDecisionAnnotationStore(f.repo),
      advisory = {
        pointId: "dispatch-stop-reason",
        questionVersion: "pilot2-choice-v2",
        selected: "environment_unavailable",
        distribution: { environment_unavailable: 0.9, insufficient_information: 0.1 },
        options: [
          { id: "environment_unavailable", text: "Environment unavailable" },
          { id: "insufficient_information", text: "Insufficient information" },
        ],
        provider: {
          providerId: "test-provider",
          vendor: "openrouter" as const,
          requestedModel: "model-a",
          resolvedModel: "model-b",
          modelVersion: null,
          providerRoute: null,
        },
        usage: { inputTokens: 12, outputTokens: 3, reportedCost: null },
        latencyMs: 24,
      };
    await store.reserve({
      key: "edge-advisory",
      pointId: advisory.pointId,
      questionVersion: advisory.questionVersion,
      bindingDigest: "b".repeat(64),
      event: "dispatch.settled",
      show: ["task.dispatches", "gui.dispatch", "agenda"],
      dispatchId,
      subjectRef: `dispatch/${dispatchId}`,
      now: "2026-10-19T00:00:00.000Z",
      egress: {
        subjectRef: `dispatch/${dispatchId}`,
        dispatchId,
        pointId: advisory.pointId,
        fields: ["report.body"],
        providerId: "test-provider",
        model: "model-a",
        sentAt: "2026-10-19T00:00:00.000Z",
        inputDigest: "c".repeat(64),
      },
    });
    await store.succeed("edge-advisory", advisory, "2026-10-19T00:00:01.000Z");
    const center = await f.host.read(
      "lease-repo",
      "repo.task.dispatches",
      { taskId: "advice-task" },
      localAuthFixture(),
    );
    assert.deepEqual(center.dispatches[0]!.advisories, [{ ...advisory, evaluatedAt: "2026-10-19T00:00:01.000Z" }]);
    assert.deepEqual((await read()).dispatches, center.dispatches);
    assert.deepEqual((await read({ taskIds: ["advice-task"], limit: 500 })).dispatches, center.dispatches);
    await store.remove(dispatchId);
    assert.equal((await read()).dispatches[0]!.advisories, undefined);
    assert.equal(existsSync(path.join(e.edgeRoot, ".harness/decision-annotations.json")), false);
  },
);
