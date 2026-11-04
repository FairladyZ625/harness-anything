// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  dispatchStreamPath,
  openDispatchStream,
} from "../src/dispatch-stream.ts";
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

for (const mode of ["local", "remote"] as const) {
  for (const state of ["dead", "alive", "foreign", "fallback"] as const) {
    test(`${mode} recovery repairs only a live settled stream and preserves ${state} ownership`, async (t) => {
      const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-adoption-live-"));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const dispatchId = "dispatch_888888888888888888888888",
        runtimeSessionId = "runtime-settled-live",
        binding = {
          actor: { principal: { personId: "owner" }, executor: null },
          source: { kind: "node", nodeId: "node-a" } as const,
        },
        header = {
          dispatchId,
          runtimeSessionId,
          taskId: null,
          executionId: null,
          instanceId: "deepseek-worker",
          startedAt: "2026-11-04T00:00:00.000Z",
          dispatchOpId: dispatchId,
          kindId: "deepseek-harness",
          permissionMode: "read-only" as const,
          cwd: rootDir,
          binding,
          prompt: "repair only the live stream",
          model: "test",
          reasoningEffort: null,
        };
      // Archived history is deliberately present on disk as well as in the canonical store.
      for (let index = 0; index < 20; index++) {
        const archivedId = `dispatch_${String(index).padStart(24, "0")}`;
        openDispatchStream(rootDir, { ...header, dispatchId: archivedId, runtimeSessionId: `history-${index}` });
        archiveDispatchStream(rootDir, archivedId);
      }
      const stream = openDispatchStream(rootDir, header);
      appendRuntimeWorkerRecord(rootDir, dispatchId, {
        kind: "process_started",
        pid: state === "alive" ? process.pid : 2_147_483_647,
      });
      if (state === "fallback")
        stream.appendFallbackState(
          {
            state: "scheduled",
            delayMs: 1,
            notBeforeAt: "2026-11-04T00:01:00.000Z",
            nextProvider: { instance: "next" },
          },
          "2026-11-04T00:00:01.000Z",
        );
      const session = { runtimeSessionId, instanceId: header.instanceId, outcome: "succeeded", liveness: "exited" },
        queries: (RuntimeSessionReadQuery | undefined)[] = [],
        sessionReads: string[] = [],
        dispatchReads: string[] = [],
        projection = {
          readRuntimeSessions: (query?: RuntimeSessionReadQuery) => {
            queries.push(query);
            if (query?.runtimeSessionId !== undefined) return [projection.readRuntimeSession(query.runtimeSessionId)];
            assert.equal(query?.unsettledOnly, true, "recovery cannot read all sessions");
            return [];
          },
          readRuntimeSession: (id: string) => {
            sessionReads.push(id);
            assert.equal(id, runtimeSessionId, "archived history cannot be point-read");
            return session;
          },
          readRuntimeDispatch: (id: string) => {
            dispatchReads.push(id);
            return {
              ...binding,
              source: state === "foreign" ? { kind: "node", nodeId: "node-b" } : binding.source,
              payload: { dispatchId },
            };
          },
        },
        context = {
          input: {
            rootDir,
            runtimeNode: { nodeId: "node-a" },
            ...(mode === "remote" ? { remote: projection } : {}),
          },
          requiredRuntimeProjection: () => projection,
          processes: new Map(),
          exiting: new Set(),
          publishExit: () => assert.fail("archive repair cannot settle the runtime again"),
          publishRuntimeEvent: () => assert.fail("archive repair cannot publish canonical events"),
        } as unknown as RuntimeSpawnerContext;
      const results = await adoptRuntimes(context);
      assert.deepEqual(sessionReads, [runtimeSessionId]);
      assert.deepEqual(dispatchReads, [runtimeSessionId]);
      assert.deepEqual(queries, [
        { unsettledOnly: true, executionOwnerNodeId: "node-a" },
        ...(mode === "remote" ? [{ runtimeSessionId }] : []),
      ]);
      assert.equal(results[0]?.outcome, state === "foreign" ? "foreign" : "settled");
      assert.equal(
        path.basename(path.dirname(dispatchStreamPath(rootDir, dispatchId))),
        state === "dead" ? "archive" : "dispatches",
      );
      sessionReads.length = 0;
      dispatchReads.length = 0;
      await adoptRuntimes(context);
      assert.deepEqual(sessionReads, state === "dead" ? [] : [runtimeSessionId]);
      assert.deepEqual(dispatchReads, state === "dead" ? [] : [runtimeSessionId]);
      assert.equal(context.processes.size, 0);
    });
  }
}

test("edge recovery scopes the session read to this node and never point-reads a foreign dispatch", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-adoption-edge-scope-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const localId = "runtime-local-node-a",
    foreignId = "runtime-foreign-node-b",
    binding = {
      actor: { principal: { personId: "owner" }, executor: null },
      source: { kind: "node", nodeId: "node-a" } as const,
    },
    queries: (RuntimeSessionReadQuery | undefined)[] = [],
    dispatchReads: string[] = [],
    context = {
      input: {
        rootDir,
        runtimeNode: { nodeId: "node-a" },
        remote: {
          // The production read layer returns only this node's unsettled sessions for the query.
          readRuntimeSessions: async (query?: RuntimeSessionReadQuery) => {
            queries.push(query);
            return [
              {
                runtimeSessionId: localId,
                instanceId: "worker",
                providerSessionId: null,
                liveness: "exited",
                outcome: "succeeded" as const,
              },
            ];
          },
          readRuntimeDispatch: async (id: string) => {
            dispatchReads.push(id);
            return id === localId ? { ...binding, payload: { dispatchId: "dispatch_000000000000000000000001" } } : null;
          },
        },
      },
      processes: new Map(),
      exiting: new Set(),
      publishRuntimeEvent: () => assert.fail("a settled local session needs no canonical publication"),
      publishExit: () => assert.fail("a settled local session cannot be settled twice"),
    } as unknown as RuntimeSpawnerContext;
  const results = await adoptRuntimes(context);
  assert.deepEqual(queries, [{ unsettledOnly: true, executionOwnerNodeId: "node-a" }]);
  assert.deepEqual(dispatchReads, [localId], `foreign ${foreignId} must not reach a dispatch point read`);
  assert.deepEqual(
    results.map(({ runtimeSessionId, outcome }) => [runtimeSessionId, outcome]),
    [[localId, "settled"]],
  );
});
