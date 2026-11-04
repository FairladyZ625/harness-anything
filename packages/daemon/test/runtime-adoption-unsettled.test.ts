// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { RuntimeSessionReadQuery } from "@harness-anything/kernel";

const settledHistoryCount = 200;

test("startup recovery reads only unsettled sessions and never point-reads settled history", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-adoption-scan-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatchId = "dispatch_777777777777777777777777",
    runtimeSessionId = "runtime-unsettled",
    binding = { actor: { principal: { personId: "owner" } }, source: "local" as const };
  const stream = openDispatchStream(rootDir, {
    dispatchId,
    runtimeSessionId,
    taskId: null,
    executionId: null,
    instanceId: "deepseek-worker",
    startedAt: "2026-11-04T00:00:00.000Z",
    dispatchOpId: dispatchId,
    kindId: "deepseek-harness",
    permissionMode: "bypass",
    cwd: rootDir,
    binding,
    prompt: "recover the only unsettled runtime",
    model: "deepseek-v4.1-flash",
    reasoningEffort: null,
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
  appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
  stream.appendTerminalOutcome(
    {
      payload: {
        runtimeSessionId,
        outcome: "failed",
        exitCode: 0,
        result: null,
        resultRef: `artifact:runtime-result/sha256/${createHash("sha256").update("durable loss").digest("hex")}`,
        endedAt: "2026-11-04T00:00:30.000Z",
      },
      body: "durable loss",
      reason: "runtime process was no longer alive after daemon restart",
      processGroupPid: 2_147_483_647,
    },
    "2026-11-04T00:00:30.000Z",
  );

  const history = Array.from({ length: settledHistoryCount }, (_, index) => ({
    runtimeSessionId: `runtime-settled-${index}`,
    instanceId: "deepseek-worker",
    providerSessionId: null,
    liveness: "exited" as const,
    outcome: "succeeded" as const,
  }));
  const unsettled = [
    {
      runtimeSessionId,
      instanceId: "deepseek-worker",
      providerSessionId: null,
      liveness: "unknown" as const,
      outcome: null,
    },
  ];
  const reads: (RuntimeSessionReadQuery | undefined)[] = [],
    pointReads: string[] = [],
    events: unknown[] = [],
    published: string[] = [];
  const context = {
    input: {
      rootDir,
      now: () => "2026-11-04T00:01:00.000Z",
      stream: { publish: () => undefined },
      recordLifecycle: (event: unknown) => events.push(event),
    },
    processes: new Map(),
    exiting: new Set(),
    requiredRuntimeProjection: () => ({
      // Recovery relies on the read layer to drop settled sessions; this fake mirrors that
      // contract so the assertion measures adoption's request rather than the fake's memory.
      readRuntimeSessions: (query?: RuntimeSessionReadQuery) => {
        reads.push(query);
        return query?.unsettledOnly ? unsettled : [...history, ...unsettled];
      },
      readRuntimeDispatch: (id: string) => {
        pointReads.push(id);
        return id === runtimeSessionId ? { ...binding, payload: { dispatchId } } : null;
      },
    }),
    publishExit: (active: Parameters<typeof publishExit>[1], code: number | null) => publishExit(context, active, code),
    publishRuntimeEvent: async (type: string) => {
      published.push(type);
      return {};
    },
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;

  const results = await adoptRuntimes(context);
  assert.deepEqual(reads, [{ unsettledOnly: true }], "recovery must ask the read layer for unsettled sessions only");
  assert.deepEqual(
    pointReads,
    [runtimeSessionId],
    `settled history must not be point-read; saw ${String(pointReads.length)} point reads`,
  );
  assert.deepEqual(
    results.map(({ runtimeSessionId: id, outcome }) => [id, outcome]),
    [[runtimeSessionId, "ready"]],
  );
  assert.deepEqual(
    events.filter((event) => (event as { readonly event?: string }).event === "runtime_recovery_failed"),
    [],
  );
  assert.deepEqual(published, ["runtime_session_exited", "runtime_session_outcome_observed"]);
  assert.equal(context.processes.size, 0);
});
