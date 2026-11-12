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
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { decisionReadSurfaces } from "@harness-anything/kernel";
import type { TaskDispatchRow } from "../src/protocol/daemon-protocol.contract.ts";

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
    // This direct server fixture performs hello only; opt in as the current CLI client does.
    await e.rpc.handle({ jsonrpc: "2.0", id: "lifecycle", method: "protocol.dispatchLifecycle.enable", params: {} });
    const read = async (payload: Record<string, unknown> = { taskId: "advice-task" }) => {
      const response = await e.rpc.handle({
        jsonrpc: "2.0",
        id: "advisory",
        method: "repo.task.dispatches",
        params: { repo: { repoId: "lease-repo" }, payload },
      });
      assert.ok(response && "result" in response, JSON.stringify(response));
      return response.result as { dispatches: readonly TaskDispatchRow[] };
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
    // Valid stored prose may exceed a frame; the transport still returns the
    // center's full advisory through the edge JSON-RPC path.
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
    const full = oversized.result as { readonly dispatches: readonly { readonly advisories?: readonly unknown[] }[] };
    assert.equal(JSON.stringify(full).length > 98_304, true);
    assert.equal(
      (full.dispatches[0]?.advisories?.[0] as typeof advisory | undefined)?.options[0]?.text,
      "长评审依据".repeat(30_000),
    );
    const unpaged = await e.rpc.handle({
      jsonrpc: "2.0",
      id: "oversized-single",
      method: "repo.task.dispatches",
      params: { repo: { repoId: "lease-repo" }, payload: { taskId: "advice-task", advisorySurface: "gui.dispatch" } },
    });
    assert.ok(unpaged && "result" in unpaged);
    const unpagedFull = unpaged.result as typeof full;
    assert.equal(
      (unpagedFull.dispatches[0]?.advisories?.[0] as typeof advisory | undefined)?.options[0]?.text,
      "长评审依据".repeat(30_000),
    );
    // The center owns the canonical row but not this node's dispatch stream. Join the stream
    // back in on the edge read, and keep the center read free of evidence it cannot observe.
    const runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
      transcriptRef = `file:.harness/runtime/dispatches/${dispatchId}.jsonl`,
      ingress = (type: string, payload: Record<string, unknown>) =>
        f.host.runtimeIngress(
          "lease-repo",
          { kind: "event", type, opId: `runtime-${type}-${hash.slice(0, 16)}`, payload },
          localAuthFixture(),
        );
    assert.equal(
      (
        await ingress("runtime_session_started", {
          runtimeSessionId,
          instanceId: "fixture-runtime",
          installationId: "fixture-installation",
          kindId: "codex",
          definitionSnapshotRef: "artifact:runtime-definition/advisory-edge",
          launchGeneration: 1,
          attachable: true,
        })
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await ingress("runtime_session_provider_bound", {
          runtimeSessionId,
          providerSessionId: "provider-session-edge",
          transcriptRef,
        })
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await ingress("runtime_session_task_bound", {
          runtimeSessionId,
          taskId: "advice-task",
          executionId: started.receipt!.executionId,
          providerSessionId: "provider-session-edge",
          transcriptRef,
        })
      ).outcome,
      "applied",
    );
    openDispatchStream(e.edgeRoot, {
      dispatchId,
      taskId: "advice-task",
      executionId: started.receipt!.executionId,
      runtimeSessionId,
      instanceId: "fixture-runtime",
      kindId: "codex",
      startedAt: new Date().toISOString(),
    });
    appendRuntimeWorkerRecord(e.edgeRoot, dispatchId, {
      kind: "process_started",
      occurredAt: new Date().toISOString(),
      pid: process.pid,
    });
    appendRuntimeWorkerRecord(e.edgeRoot, dispatchId, {
      kind: "provider_event",
      occurredAt: new Date().toISOString(),
      event: { type: "item.started", item: { type: "command_execution" } },
    });
    const centerRow = (
        await f.host.read("lease-repo", "repo.task.dispatches", { taskId: "advice-task" }, localAuthFixture())
      ).dispatches[0]!,
      edgeRow = (await read()).dispatches[0]!;
    // The accepted provider binding names the transcript at both nodes. Only the edge has the
    // local tool activity; that display evidence must not change the central lifecycle policy.
    assert.equal(centerRow.activityStatus, "thinking");
    assert.equal(centerRow.eventStreamRef, transcriptRef);
    assert.equal(edgeRow.eventStreamRef, transcriptRef);
    assert.equal(edgeRow.activityStatus, "tool");
    assert.deepEqual(edgeRow.lifecycle, centerRow.lifecycle);

    await store.remove(dispatchId);
    assert.equal((await read()).dispatches[0]!.advisories, undefined);
    assert.equal(existsSync(path.join(e.edgeRoot, ".harness/decision-annotations.json")), false);
  },
);
