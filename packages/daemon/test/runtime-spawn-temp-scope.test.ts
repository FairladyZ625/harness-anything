// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes, sweepSettledRuntimeTempDirectories } from "../src/runtime-spawn-adoption.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";

const binding: RepoCellBinding = {
  actor: { principal: { personId: "person-owner" }, executor: null },
  source: "local",
};

test("a dispatch hands its runtime session id to the launch preparation", async () => {
  const repoId = "repository",
    idempotencyKey = "temp-scope-wiring",
    hash = createHash("sha256").update(`${repoId}\0${idempotencyKey}`).digest("hex"),
    expectedSessionId = `runtime_${hash.slice(24, 48)}`,
    launches: { instanceId: string; runtimeSessionId: string | undefined }[] = [];
  const spawner = makeRuntimeSpawner({
    repoId,
    rootDir: tmpdir(),
    store: () => ({ readEvent: () => null }),
    projection: () =>
      ({
        readRuntimeSessions: () => [],
        currentLease: () => null,
        read: () => assert.fail("a taskless dispatch reads no task projection"),
      }) as never,
    runtimeInstances: () => [
      {
        instanceId: "worker",
        name: "Worker",
        kindId: "codex",
        models: ["gpt-5.6-sol"],
        defaultModel: "gpt-5.6-sol",
        enabled: true,
        authMode: "subscription",
        authReadiness: { status: "ready", code: null, hint: null },
        permissionMode: "bypass",
      },
    ],
    prepareLaunch: async (instanceId, request) => {
      launches.push({ instanceId, runtimeSessionId: request.runtimeSessionId });
      throw new Error("stop at the launch boundary");
    },
    now: () => "2026-10-11T00:00:00.000Z",
  } as unknown as RuntimeSpawnerInput);
  await assert.rejects(
    spawner.spawn(
      {
        runtimeInstanceId: "worker",
        cwd: { scope: "repo-root" },
        prompt: "Scoped temp run",
        taskId: null,
        idempotencyKey,
      },
      binding,
    ),
    /stop at the launch boundary/u,
  );
  assert.deepEqual(launches, [{ instanceId: "worker", runtimeSessionId: expectedSessionId }]);
});

test("the startup sweep treats only settled sessions as reclaimable and reports failures", async () => {
  const settled = "runtime_0123456789abcdef01234567",
    live = "runtime_89abcdef0123456789abcdef",
    adopted = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    neverRegistered = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb";
  let predicate: ((runtimeSessionId: string) => boolean) | null = null;
  const logged: string[] = [],
    originalError = console.error;
  console.error = ((line: string) => {
    logged.push(line);
  }) as typeof console.error;
  try {
    const context = {
      exiting: new Set<string>(),
      processes: new Map([[adopted, { runtimeSessionId: adopted }]]),
      input: {
        reclaimSettledRuntimeTempDirectories: (isSettled: (runtimeSessionId: string) => boolean) => {
          predicate = isSettled;
          return [{ instanceId: "provider-a", runtimeSessionId: settled, error: new Error("EBUSY: locked") }];
        },
      },
      requiredRuntimeProjection: () => ({
        readRuntimeSessions: () => [
          { runtimeSessionId: settled, outcome: "succeeded" },
          { runtimeSessionId: live, outcome: null },
          { runtimeSessionId: adopted, outcome: null },
        ],
      }),
    };
    await sweepSettledRuntimeTempDirectories(context as never);
    assert.equal(typeof predicate, "function");
    assert.equal(predicate!(settled), true, "a settled session's directory is reclaimed");
    assert.equal(predicate!(live), false, "a live-at-center session keeps its directory");
    assert.equal(predicate!(adopted), false, "a locally re-adopted session keeps its directory");
    assert.equal(predicate!(neverRegistered), true, "a session the center never registered is an orphan");
    assert.equal(
      logged.some((line) => line.includes("EBUSY: locked")),
      true,
      "the sweep's reclaim failure is logged, not swallowed",
    );
  } finally {
    console.error = originalError;
  }
});

test("the startup sweep leaves every directory alone when the center read fails", async () => {
  let reclaimCalled = false;
  const context = {
    exiting: new Set<string>(),
    processes: new Map(),
    input: {
      reclaimSettledRuntimeTempDirectories: () => {
        reclaimCalled = true;
        return [];
      },
    },
    requiredRuntimeProjection: () => {
      throw new Error("center disconnected");
    },
  };
  await sweepSettledRuntimeTempDirectories(context as never);
  assert.equal(reclaimCalled, false, "settled-ness is unverifiable without the session read");
});

test("startup adoption sweeps; cancel's mid-operation adoption call does not", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-adoption-sweep-flag-"));
  try {
    const sweeps: number[] = [],
      context = {
        exiting: new Set<string>(),
        processes: new Map(),
        input: {
          repoId: "repository",
          rootDir,
          reclaimSettledRuntimeTempDirectories: () => {
            sweeps.push(sweeps.length);
            return [];
          },
        },
        requiredRuntimeProjection: () => ({ readRuntimeSessions: () => [] }),
      };
    await adoptRuntimes(context as never, undefined, { sweepTempDirectories: true });
    assert.deepEqual(sweeps, [0], "startup adoption reclaims settled temp directories");
    await adoptRuntimes(context as never);
    assert.deepEqual(sweeps, [0], "cancel's mid-operation adoption must not sweep");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
