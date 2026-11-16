// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DISPATCH_LIFECYCLE_PAGE_LIMIT, type DispatchLifecycleQuery } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { createRuntimeInstanceDispatchState } from "../src/runtime-instance-selection.ts";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import {
  importedRuntimeSessionProjection,
  sameImportedRuntimeSessionProjection,
} from "../src/runtime-imported-settlement.ts";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";

test("a recovered imported session still reconciles with its replayed source at a later observation stamp", () => {
  const source = {
      runtimeSessionId: "runtime_imported_reconcile",
      instanceId: "codex",
      installationId: "installation",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/reconcile",
      providerSessionId: null,
      transcriptRef: null,
      launchGeneration: 1,
      liveness: "live" as const,
      attachable: true,
      taskBindings: [],
      outcome: null,
      exitCode: null,
      resultRef: null,
      lastObservedAt: "2026-08-24T03:06:09.253Z",
    },
    recovered = {
      ...importedRuntimeSessionProjection(source),
      lastObservedAt: "2026-11-05T00:00:00.000Z",
    };
  assert.equal(
    sameImportedRuntimeSessionProjection(recovered, source),
    true,
    "the settlement observation stamp is not entity identity",
  );
  assert.equal(
    sameImportedRuntimeSessionProjection({ ...recovered, outcome: "succeeded" }, source),
    false,
    "a different terminal outcome is not the replayed terminal",
  );
});

test("adoptRuntimes pages terminal stream headers within DISPATCH_LIFECYCLE_PAGE_LIMIT and fails closed on pending pages", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "adopt-runtimes-lifecycle-page-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const totalHeaders = DISPATCH_LIFECYCLE_PAGE_LIMIT + 5;
  const binding = { actor: { principal: { personId: "owner" }, executor: null }, source: "local" as const };
  const entries = Array.from({ length: totalHeaders }, (_, index) => {
    const suffix = String(index).padStart(4, "0"),
      dispatchId = `dispatch_00000000000000000000${suffix}`,
      runtimeSessionId = `runtime-${suffix}`,
      unprovenStop = index === 1 || index === totalHeaders - 1;
    const stream = openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId,
      taskId: `task-${suffix}`,
      executionId: `exe-${suffix}`,
      instanceId: "instance",
      startedAt: "2026-11-15T00:00:00.000Z",
      dispatchOpId: dispatchId,
      kindId: "codex",
      permissionMode: "read-only",
      cwd: rootDir,
      binding,
      prompt: "recover",
      model: "test",
      reasoningEffort: null,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    stream.appendFallbackState(
      { state: "scheduled", delayMs: 1, notBeforeAt: "2026-11-15T00:01:00.000Z", nextProvider: { instance: "next" } },
      "2026-11-15T00:00:01.000Z",
    );
    return {
      runtimeSessionId,
      dispatchId,
      instanceId: "instance",
      owner: "local",
      process: "unknown" as const,
      stopProof: unprovenStop ? ("unproven" as const) : ("proven_stopped" as const),
      attemptSettled: true,
      groupSettled: true,
    };
  });

  const baseRead = lifecycleReadForSync(entries);
  // Negative control: the point-read contract itself still rejects >100 dispatchIds.
  assert.throws(
    () => baseRead({ by: "dispatch", dispatchIds: entries.map(({ dispatchId }) => dispatchId) }),
    /dispatch lifecycle point reads accept at most 100 ids/,
  );

  const pointBatchSizes: number[] = [];
  let failSecondBatchPending = false;
  const makeContext = () => {
    const dispatchState = createRuntimeInstanceDispatchState();
    const context = {
      input: { rootDir, now: () => "2026-11-15T00:01:00.000Z" },
      processes: new Map(),
      exiting: new Set(),
      dispatchState,
      requiredRuntimeProjection: () => ({
        readRuntimeSession(id: string) {
          return entries.some(({ runtimeSessionId }) => runtimeSessionId === id)
            ? { runtimeSessionId: id, instanceId: "instance", outcome: "succeeded", liveness: "exited" }
            : null;
        },
        readRuntimeSessions: () =>
          entries.map(({ runtimeSessionId }) => ({
            runtimeSessionId,
            instanceId: "instance",
            outcome: "succeeded",
            liveness: "exited",
          })),
        readRuntimeDispatch: (id: string) => {
          const found = entries.find(({ runtimeSessionId }) => runtimeSessionId === id);
          return found ? { ...binding, source: "local", payload: { dispatchId: found.dispatchId } } : null;
        },
        readDispatchLifecycle: (query: DispatchLifecycleQuery) => {
          if (query.by === "active")
            return { status: "ready" as const, watermark: 1, sourceRevision: 1, rows: [], nextCursor: null };
          if (query.by === "dispatch") {
            pointBatchSizes.push(query.dispatchIds.length);
            if (failSecondBatchPending && pointBatchSizes.length >= 2) {
              return { status: "pending" as const, watermark: 4, sourceRevision: 5 };
            }
          }
          return baseRead(query);
        },
      }),
      publishExit: () => {
        throw new Error("settled terminal attempts must not publish exit again");
      },
      runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as unknown as RuntimeSpawnerContext;
    return { context, dispatchState };
  };

  const targetSessionId = entries.at(-1)!.runtimeSessionId;
  const { context: targetedContext, dispatchState } = makeContext();
  const targeted = await adoptRuntimes(targetedContext, undefined, { runtimeSessionId: targetSessionId });
  assert.equal(targeted.length, 1);
  assert.equal(targeted[0]?.runtimeSessionId, targetSessionId);
  assert.equal(targeted[0]?.outcome, "settled");
  assert.deepEqual(pointBatchSizes.slice(0, 2), [DISPATCH_LIFECYCLE_PAGE_LIMIT, 5]);
  // beb7a500d70 invariant: unproven-stopped terminal headers outside options.runtimeSessionId still activate load tracking.
  assert.equal(dispatchState.readActiveLoads().get("instance"), 2);

  pointBatchSizes.length = 0;
  failSecondBatchPending = true;
  const { context: pendingContext } = makeContext();
  await assert.rejects(() => adoptRuntimes(pendingContext), { code: "dispatch_lifecycle_pending" });

  pointBatchSizes.length = 0;
  failSecondBatchPending = false;
  const { context: fullContext } = makeContext();
  const full = await adoptRuntimes(fullContext);
  assert.equal(full.length, totalHeaders - 1);
  assert.equal(
    full.every((result) => result.outcome === "settled"),
    true,
  );
  assert.deepEqual(pointBatchSizes.slice(0, 2), [DISPATCH_LIFECYCLE_PAGE_LIMIT, 4]);
});
