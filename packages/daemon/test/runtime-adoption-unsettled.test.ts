// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DISPATCH_LIFECYCLE_PAGE_LIMIT, type DispatchLifecycleQuery } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { createRuntimeInstanceDispatchState } from "../src/daemon-host/runtime-instance-selection.ts";
import { adoptRuntimes } from "../src/daemon-host/runtime-spawn-adoption.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import {
  importedRuntimeSessionProjection,
  sameImportedRuntimeSessionProjection,
} from "../src/runtime-engine/runtime-imported-settlement.ts";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
  t.after(() => removeTempRepository(rootDir));
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

test("adoptRuntimes overrides stale expired metadata executionPrincipal with fresh authorizationBinding while preserving metadata source", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "adopt-runtimes-expired-cred-"));
  t.after(() => removeTempRepository(rootDir));
  const dispatchId = "dispatch_eeeeeeeeeeeeeeeeeeeeeeee",
    runtimeSessionId = "runtime_eeeeeeeeeeeeeeeeeeeeeeee",
    metadataSource = { kind: "node" as const, nodeId: "edge-adopt-1" },
    expiredPrincipal = {
      personId: "owner",
      repoId: "repo-adopt",
      runtimeSessionId,
      dispatchId,
      taskId: "task-adopt",
      executionId: "exe-adopt",
      role: "implementation" as const,
      source: metadataSource,
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
    freshPrincipal = {
      ...expiredPrincipal,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    staleMetadataBinding = {
      actor: { principal: { personId: "owner" }, executor: null },
      source: metadataSource,
      executionPrincipal: expiredPrincipal,
      authorizationDecision: {
        outcome: "denied" as const,
        policyRef: "stale",
        reasonCodes: ["stale_decision"],
        nextActions: [],
      },
      staleMarker: "old",
    },
    freshAuthorizationBinding = {
      actor: { principal: { personId: "owner" }, executor: null },
      source: "local" as const,
      executionPrincipal: freshPrincipal,
      authorizationDecision: {
        outcome: "allowed" as const,
        policyRef: "fresh",
        reasonCodes: [],
        nextActions: [],
      },
      sessionEnvironment: { FRESH: "1" },
    };
  openDispatchStream(rootDir, {
    dispatchId,
    runtimeSessionId,
    taskId: "task-adopt",
    executionId: "exe-adopt",
    instanceId: "instance",
    startedAt: "2026-11-15T00:00:00.000Z",
    dispatchOpId: dispatchId,
    kindId: "codex",
    permissionMode: "read-only",
    cwd: rootDir,
    binding: staleMetadataBinding as never,
    prompt: "recover",
    model: "test",
    reasoningEffort: null,
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "process_exit",
    occurredAt: "2026-11-15T00:00:10.000Z",
    exitCode: 0,
    signal: null,
  });

  const publishedBindings: Record<string, unknown>[] = [];
  const exitedBindings: Record<string, unknown>[] = [];
  const baseRead = lifecycleReadForSync([
    {
      runtimeSessionId,
      dispatchId,
      instanceId: "instance",
      owner: "node:edge-adopt-1",
      process: "unknown",
      stopProof: "unproven",
      attemptSettled: false,
      groupSettled: false,
    },
  ]);
  const makeContext = () =>
    ({
      input: { rootDir, runtimeNode: { nodeId: "edge-adopt-1" }, now: () => "2026-11-15T00:01:00.000Z" },
      processes: new Map(),
      exiting: new Set(),
      dispatchState: createRuntimeInstanceDispatchState(),
      requiredRuntimeProjection: () => ({
        readRuntimeSession: () => ({
          runtimeSessionId,
          instanceId: "instance",
          outcome: null,
          liveness: "live",
        }),
        readRuntimeSessions: () => [
          {
            runtimeSessionId,
            instanceId: "instance",
            outcome: null,
            liveness: "live",
          },
        ],
        readRuntimeDispatch: () => ({
          ...staleMetadataBinding,
          payload: { dispatchId },
        }),
        readDispatchLifecycle: (query: DispatchLifecycleQuery) => baseRead(query),
      }),
      publishRuntimeEvent: async (
        _type: string,
        _payload: unknown,
        _opId: string,
        bindingArg: Record<string, unknown>,
      ) => {
        publishedBindings.push(bindingArg);
        return {};
      },
      publishExit: async (active: { readonly binding: Record<string, unknown> }) => {
        exitedBindings.push(active.binding);
      },
      runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    }) as unknown as RuntimeSpawnerContext;

  const results = await adoptRuntimes(makeContext(), undefined, {
    runtimeSessionId,
    authorizationBinding: freshAuthorizationBinding as never,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.outcome, "settled");
  assert.equal(publishedBindings.length, 1);
  assert.equal(exitedBindings.length, 1);
  for (const seen of [publishedBindings[0]!, exitedBindings[0]!]) {
    assert.deepEqual(seen.source, metadataSource, "metadata.binding.source must remain authoritative for edge streams");
    assert.equal("executionPrincipal" in seen && seen.executionPrincipal !== undefined, false);
    assert.equal(seen.authorizationDecision, undefined);
    assert.deepEqual(seen.sessionEnvironment, { FRESH: "1" }, "fresh authorizationBinding overrides stale metadata");
  }

  publishedBindings.length = 0;
  exitedBindings.length = 0;
  const fallbackResults = await adoptRuntimes(makeContext());
  assert.equal(fallbackResults[0]?.outcome, "settled");
  assert.equal(
    "executionPrincipal" in exitedBindings[0]! && exitedBindings[0]!.executionPrincipal !== undefined,
    false,
    "metadata-only adoption must also strip stale executionPrincipal",
  );
});
