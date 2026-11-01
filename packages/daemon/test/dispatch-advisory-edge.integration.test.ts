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
import { decisionReadSurfaces } from "@harness-anything/kernel";

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
    for (const surface of decisionReadSurfaces) {
      await store.reserve({
        key: `edge-advisory-${surface}`,
        pointId: advisory.pointId,
        questionVersion: advisory.questionVersion,
        bindingDigest: "b".repeat(64),
        event: "dispatch.settled",
        show: [surface],
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
      await store.succeed(`edge-advisory-${surface}`, { ...advisory, pointId: surface }, "2026-10-19T00:00:01.000Z");
    }
    for (const advisorySurface of [undefined, ...decisionReadSurfaces]) {
      const payload = { taskId: "advice-task", ...(advisorySurface ? { advisorySurface } : {}) };
      const center = await f.host.read("lease-repo", "repo.task.dispatches", payload, localAuthFixture());
      assert.deepEqual(center.dispatches[0]!.advisories, [
        { ...advisory, pointId: advisorySurface ?? "task.dispatches", evaluatedAt: "2026-10-19T00:00:01.000Z" },
      ]);
      assert.deepEqual((await read(payload)).dispatches, center.dispatches);
      assert.deepEqual(
        (await read({ taskIds: ["advice-task"], limit: 500, ...(advisorySurface ? { advisorySurface } : {}) }))
          .dispatches,
        center.dispatches,
      );
    }
    // Valid stored prose can make even one dispatch too large. Verify the real
    // center → TLS → edge → JSON-RPC path preserves the actionable error code.
    await store.succeed(
      "edge-advisory-gui.dispatch",
      {
        ...advisory,
        options: advisory.options.map((option) => ({ ...option, text: "长评审依据".repeat(30_000) })),
      },
      "2026-10-19T00:00:02.000Z",
    );
    const oversized = await e.rpc.handle({
      jsonrpc: "2.0",
      id: "oversized",
      method: "repo.task.dispatches",
      params: {
        repo: { repoId: "lease-repo" },
        payload: { taskIds: ["advice-task"], limit: 500, advisorySurface: "gui.dispatch" },
      },
    });
    assert.ok(oversized && "result" in oversized, JSON.stringify(oversized));
    const failure = JSON.stringify(oversized.result);
    assert.match(failure, /fleet_read_too_large/u);
    assert.match(failure, /98304 bytes/u);
    assert.match(failure, /limit:16.*cursor:page.nextCursor/u);
    assert.doesNotMatch(failure, /invalid_frame/u);
    console.log(`oversized edge dispatch: ${failure}`);
    const unpaged = await e.rpc.handle({
      jsonrpc: "2.0",
      id: "oversized-single",
      method: "repo.task.dispatches",
      params: { repo: { repoId: "lease-repo" }, payload: { taskId: "advice-task", advisorySurface: "gui.dispatch" } },
    });
    assert.ok(unpaged && "result" in unpaged);
    const guarded = JSON.stringify(unpaged.result);
    assert.match(guarded, /fleet_read_too_large/u);
    assert.match(guarded, /98304 bytes/u);
    assert.doesNotMatch(guarded, /invalid_frame/u);
    console.log(`oversized unpaged edge dispatch: ${guarded}`);
    await store.remove(dispatchId);
    assert.equal((await read()).dispatches[0]!.advisories, undefined);
    assert.equal(existsSync(path.join(e.edgeRoot, ".harness/decision-annotations.json")), false);
  },
);
