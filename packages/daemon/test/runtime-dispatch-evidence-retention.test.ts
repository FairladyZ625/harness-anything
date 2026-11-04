// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  appendRuntimeWorkerRecord,
  dispatchStreamPath,
  openDispatchStream,
  readDispatchStream,
  readDispatchStreamSummary,
} from "../src/dispatch-stream.ts";
import { purgeRepoCache } from "../src/repo-cache-purge.ts";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import {
  fixtureTaskId,
  workerGitFixture,
  workerSettlementContext,
  workerSettlementRuntime,
} from "./runtime-spawn-settlement.fixtures.ts";

test("an archive publication failure keeps the abnormal stream out of compaction and cache purge", async (context) => {
  const fixture = workerGitFixture(context, "forensics-pending", { reachableRemote: true }),
    runtime = workerSettlementRuntime(fixture, {
      providerOutcome: "failed",
      failureText: "provider disconnected",
      finalText: null,
      toolCallObserved: false,
    }),
    stream = openDispatchStream(fixture.canonical, {
      dispatchId: runtime.dispatchId,
      runtimeSessionId: runtime.runtimeSessionId,
      taskId: fixtureTaskId,
      executionId: "execution-owner",
      instanceId: runtime.instanceId,
      startedAt: runtime.startedAt,
      dispatchOpId: runtime.dispatchOpId,
      kindId: runtime.kindId,
      permissionMode: runtime.permissionMode,
      cwd: runtime.cwd,
      binding: runtime.binding,
      prompt: runtime.prompt,
      model: runtime.model,
      reasoningEffort: runtime.reasoningEffort,
    }),
    settleContext = workerSettlementContext(fixture, async () => ({}));
  Object.assign(runtime.stream, {
    appendEvidenceState: (
      value: { readonly state: "pending" | "stored"; readonly reason?: string },
      occurredAt: string,
    ) =>
      appendRuntimeWorkerRecord(fixture.canonical, runtime.dispatchId, {
        kind: "evidence_state",
        occurredAt,
        ...value,
      }),
  });
  stream.appendProviderEvent(
    { type: "thread.started", thread_id: "provider-pending", request_id: "request-pending" },
    "2026-11-05T00:00:01.000Z",
  );
  // The durable publish fails after capture: the marker must keep the raw stream live and make
  // the cache purge treat it as non-regenerable evidence rather than deleting it.
  settleContext.input.remote = {
    archive: async () => {
      throw new Error("injected archive publication failure");
    },
  } as never;
  context.mock.method(console, "error", () => undefined);
  await publishExit(settleContext, runtime, 1);
  const summary = readDispatchStreamSummary(fixture.canonical, runtime.dispatchId),
    streamPath = dispatchStreamPath(fixture.canonical, runtime.dispatchId);
  assert.equal(
    summary?.evidenceState,
    "pending",
    JSON.stringify({
      terminal: summary?.terminalOutcome,
      kinds: readDispatchStream(fixture.canonical, runtime.dispatchId)?.records.map((record) => record.kind),
    }),
  );
  assert.equal(path.basename(path.dirname(streamPath)), "dispatches", "the raw stream must remain un-compacted");
  assert.equal(existsSync(streamPath), true);
  const removed = purgeRepoCache(fixture.canonical);
  assert.equal(removed.includes(".harness/runtime/dispatches"), false, JSON.stringify(removed));
  assert.equal(existsSync(streamPath), true, "the pending evidence stream survives the cache purge");
  assert.match(readFileSync(streamPath, "utf8"), /"kind":"evidence_state"/u);
});
