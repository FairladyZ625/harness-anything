// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeEventV1, RuntimeSession } from "../../kernel/src/index.ts";
import { makeAgentRuntimeReadModel } from "../src/agent-runtime-read.ts";

test("runtime overview pages at the server before DTO and dispatch expansion", () => {
  const session = (runtimeSessionId: string): RuntimeSession => ({
      runtimeSessionId,
      instanceId: "instance-1",
      installationId: "installation-1",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/test",
      providerSessionId: null,
      transcriptRef: null,
      launchGeneration: 1,
      liveness: "live",
      attachable: false,
      taskBindings: [],
      outcome: null,
      exitCode: null,
      resultRef: null,
      lastObservedAt: "2026-09-12T00:00:00.000Z",
    }),
    rows = Array.from({ length: 12 }, (_, index) => session(`runtime-${String(index).padStart(2, "0")}`));
  let unboundedReads = 0,
    exactDispatchReads = 0,
    batchDispatchReads = 0,
    pageQuery: unknown;
  const dispatches = rows.map(
      ({ runtimeSessionId }) =>
        ({
          type: "runtime_dispatch_requested",
          payload: { runtimeSessionId, definitionSnapshotRef: "artifact:runtime-definition/test" },
        }) as AgentRuntimeEventV1,
    ),
    projection = {
      readCut: () => ({ status: "ready", watermark: 1 }),
      readRuntimeSessionPage: (query: unknown) => (
        (pageQuery = query),
        { rows, nextRuntimeSessionId: "runtime-11", remainingCount: 13 }
      ),
      readRuntimeSessions: () => ((unboundedReads += 1), rows),
      readRuntimeInstallations: () => [],
      readRuntimeDispatches: () => ((batchDispatchReads += 1), dispatches),
      readRuntimeDispatch: () => ((exactDispatchReads += 1), null),
      currentLease: () => null,
    };
  const overview = makeAgentRuntimeReadModel({
    store: {} as never,
    projection: projection as never,
    stream: { latestCursor: () => "stream:0" } as never,
  }).overview({ limit: 12 });
  assert.equal(overview.sessions.length, 12);
  assert.equal(unboundedReads, 0);
  assert.equal(exactDispatchReads, 0);
  assert.equal(batchDispatchReads, 1);
  assert.deepEqual(pageQuery, { limit: 12 });
  assert.deepEqual(overview.page, {
    limit: 12,
    cursor: null,
    nextCursor: "runtime-session:runtime-11",
    remainingCount: 13,
  });
});
