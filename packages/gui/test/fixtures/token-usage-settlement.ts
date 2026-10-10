import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishExit } from "../../../daemon/src/runtime-spawn-settlement.ts";
import { openDispatchStream, readDispatchStream } from "../../../daemon/src/dispatch-stream.ts";
import { readAgentRuntimeTokenUsage } from "../../../daemon/src/agent-runtime-token-usage.ts";
import type { ActiveRuntime } from "../../../daemon/src/runtime-spawn-types.ts";
import type { RuntimeSpawnerContext } from "../../../daemon/src/runtime-spawn-context.ts";

import type { TaskProjection } from "@harness-anything/kernel";

const rows: ReturnType<TaskProjection["readRuntimeDispatchPage"]>["rows"] = [];
const rootDir = mkdtempSync(path.join(tmpdir(), "token-usage-settlement-"));
try {
  for (const [index, rawUsage] of [
    { used: 909, input: 900, output: 9, total: 909 },
    { input_tokens: 900, output_tokens: 9, cache_write_input_tokens: 0 },
  ].entries()) {
    const dispatchId = `dispatch_00000000000000000000cc0${index}`,
      runtimeSessionId = `runtime-cache-write-${index}`,
      now = "2026-10-10T00:01:00.000Z",
      runtime = {
        cancelRequested: false,
        publicationOwner: "runtime",
        fallbackAttempt: null,
        permissionMode: "bypass",
        providerFault: null,
        errorOverflowed: false,
        errorBuffer: "",
        toolCallObserved: false,
        failureText: null,
        lossReason: null,
        planIncomplete: false,
        planObserved: true,
        protocolError: false,
        writeItemObserved: true,
        dispatchId,
        runtimeSessionId,
        dispatchOpId: dispatchId,
        instanceId: "provider-test",
        kindId: index === 0 ? "devin" : "codex",
        model: index === 0 ? "devin-neutral" : "codex-real-zero",
        task: null,
        schedule: null,
        squadId: null,
        delegatedBy: null,
        cwd: rootDir,
        startedAt: now,
        providerSessionId: "provider-session",
        providerOutcome: "succeeded",
        finalText: "completed result",
        prompt: "usage test",
        binding: {
          actor: { principal: { kind: "human", id: "operator" }, executor: { kind: "agent", id: runtimeSessionId } },
          source: "local",
        },
        process: { pid: process.pid },
        inputTokens: 900,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 9,
        toolCallCount: 0,
        usageReported: true,
        compacted: false,
        rawUsage,
        stream: openDispatchStream(rootDir, {
          dispatchId,
          runtimeSessionId,
          instanceId: "provider-test",
          taskId: null,
          executionId: null,
          startedAt: now,
          model: index === 0 ? "devin-neutral" : "codex-real-zero",
        }),
      } as unknown as ActiveRuntime,
      context = {
        exiting: new Set(),
        processes: new Map([[runtimeSessionId, runtime]]),
        input: {
          rootDir,
          repoId: "canonical",
          now: () => now,
          stream: { publish: () => ({}) },
          remote: { archive: async () => ({ outcome: "applied" }) },
        },
        resultMediaType: "text/markdown",
        runtimeResultText: () => "completed result",
        markProtocolError: () => undefined,
        publishRuntimeEvent: async () => ({}),
        settleFallback: async () => undefined,
      } as unknown as RuntimeSpawnerContext;
    rows.push({
      event: {
        occurredAt: now,
        payload: {
          dispatchId,
          runtimeSessionId,
          instanceId: runtime.instanceId,
          kindId: runtime.kindId,
          startedAt: now,
          definitionSnapshot: { model: runtime.model },
        },
      },
    } as unknown as (typeof rows)[number]);
    await publishExit(context, runtime, 0);
    const metrics = readDispatchStream(rootDir, dispatchId)?.runtimeMetrics;
    assert.equal(metrics?.cacheWriteTokens, index === 0 ? undefined : 0);
  }
  const result = readAgentRuntimeTokenUsage({
    rootDir,
    now: "2026-10-10T00:02:00.000Z",
    range: "today",
    cut: { status: "ready", watermark: 0, sourceRevision: 0 },
    projection: { readRuntimeDispatchPage: () => ({ rows, nextCursor: null, done: true }) },
    entityLabel: () => null,
    taskOf: () => undefined,
  });
  assert.equal(result.totals.cacheWriteUnreportedDispatches, 1);
  process.stdout.write(JSON.stringify(result));
} finally {
  rmSync(rootDir, { recursive: true, force: true });
}
