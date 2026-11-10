// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  adoptRuntimes,
  reclaimFailedLaunchTempDirectory,
  sweepSettledRuntimeTempDirectories,
} from "../src/runtime-spawn-adoption.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";
import { emptyDispatchLifecycleRead, lifecycleReadFor } from "./dispatch-lifecycle-read.fixtures.ts";

const binding: RepoCellBinding = {
  actor: { principal: { personId: "person-owner" }, executor: null },
  source: "local",
};

test("a dispatch hands its runtime session id to the launch preparation", async () => {
  const repoId = "repository",
    dispatchKey = "temp-scope-wiring",
    hash = createHash("sha256").update(`${repoId}\0${dispatchKey}`).digest("hex"),
    expectedSessionId = `runtime_${hash.slice(24, 48)}`,
    launches: { instanceId: string; runtimeSessionId: string | undefined }[] = [];
  const spawner = makeRuntimeSpawner({
    repoId,
    rootDir: tmpdir(),
    store: () => ({ readEvent: () => null }),
    projection: () =>
      ({
        readDispatchLifecycle: emptyDispatchLifecycleRead,
        readRuntimeSessions: () => [],
        currentLease: () => null,
        getEntity: () => ({ value: { runtime: { allowedInstances: ["worker"] } } }),
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
        dispatchKey,
      },
      binding,
    ),
    /stop at the launch boundary/u,
  );
  assert.deepEqual(launches, [{ instanceId: "worker", runtimeSessionId: expectedSessionId }]);
});

test("a launch refused after preparation returns the temp scope prepareLaunch minted", async () => {
  const repoId = "repository",
    dispatchKey = "prepared-refusal",
    hash = createHash("sha256").update(`${repoId}\0${dispatchKey}`).digest("hex"),
    runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
    tempRoot = mkdtempSync(path.join(tmpdir(), "runtime-prepared-refusal-")),
    reclaimed: string[] = [];
  try {
    const spawner = makeRuntimeSpawner({
      repoId,
      rootDir: tempRoot,
      store: () => ({ readEvent: () => null }),
      projection: () =>
        ({
          readDispatchLifecycle: emptyDispatchLifecycleRead,
          readRuntimeSessions: () => [],
          currentLease: () => null,
          getEntity: () => ({ value: { runtime: { allowedInstances: ["worker"] } } }),
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
        mkdirSync(path.join(tempRoot, request.runtimeSessionId!), { recursive: true });
        return {
          // The prepared snapshot names a different instance than the selected one, so the
          // closed-request assertion refuses before any stream or process exists.
          definition: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId: "other-instance",
            installationId: "installation-codex",
            kindId: "codex",
            providerId: "openai",
            model: "gpt-5.6-sol",
            reasoningEffort: null,
            fast: false,
            baseUrl: null,
            authMode: "subscription",
          },
          installation: {
            installationId: "installation-codex",
            kindId: "codex",
            executablePath: "/usr/bin/false",
            version: "0.147.0",
          },
          executablePath: "/usr/bin/false",
          args: [],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      reclaimRuntimeTempDirectory: (_instanceId, runtimeSessionId) => {
        reclaimed.push(runtimeSessionId);
        rmSync(path.join(tempRoot, runtimeSessionId), { recursive: true, force: true });
        return null;
      },
      now: () => "2026-10-25T00:00:00.000Z",
    } as unknown as RuntimeSpawnerInput);
    await assert.rejects(
      spawner.spawn(
        {
          runtimeInstanceId: "worker",
          cwd: { scope: "repo-root" },
          prompt: "Refused after preparation",
          taskId: null,
          dispatchKey,
        },
        binding,
      ),
      { code: "invalid_runtime_launch" },
    );
    assert.deepEqual(reclaimed, [runtimeSessionId], "the refusal still hands the minted scope back");
    assert.equal(existsSync(path.join(tempRoot, runtimeSessionId)), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a failed launch's temp reclaim surfaces its refusal instead of swallowing it", async () => {
  const logged: string[] = [],
    originalError = console.error,
    reclaimCalls: { instanceId: string; runtimeSessionId: string }[] = [];
  console.error = ((line: string) => {
    logged.push(line);
  }) as typeof console.error;
  try {
    const input = {
      reclaimRuntimeTempDirectory: (instanceId: string, runtimeSessionId: string) => {
        reclaimCalls.push({ instanceId, runtimeSessionId });
        return new Error("EBUSY: locked");
      },
    };
    reclaimFailedLaunchTempDirectory(input, "worker", "runtime_0123456789abcdef01234567");
    assert.deepEqual(reclaimCalls, [{ instanceId: "worker", runtimeSessionId: "runtime_0123456789abcdef01234567" }]);
    assert.equal(
      logged.some((line) =>
        line.includes(
          "[runtime-temp] worker/runtime_0123456789abcdef01234567 could not be reclaimed after a failed launch: EBUSY: locked",
        ),
      ),
      true,
      "the refusal is logged with its original error",
    );
    reclaimFailedLaunchTempDirectory(
      { reclaimRuntimeTempDirectory: () => null },
      "worker",
      "runtime_0123456789abcdef01234567",
    );
    assert.equal(logged.length, 1, "a successful reclaim logs nothing");
  } finally {
    console.error = originalError;
  }
});

test("the startup sweep treats only settled sessions as reclaimable and reports failures", async () => {
  const settled = "runtime_0123456789abcdef01234567",
    live = "runtime_89abcdef0123456789abcdef",
    adopted = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
    neverRegistered = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb",
    exiting = "runtime_cccccccccccccccccccccccc";
  let selected: readonly string[] = [];
  const logged: string[] = [],
    pointReads: string[] = [],
    originalError = console.error;
  console.error = ((line: string) => {
    logged.push(line);
  }) as typeof console.error;
  try {
    const context = {
      exiting: new Set<string>([exiting]),
      processes: new Map([[adopted, { runtimeSessionId: adopted }]]),
      input: {
        listRuntimeTempSessionIds: () => [settled, live, adopted, neverRegistered, exiting],
        reclaimSettledRuntimeTempDirectories: (ids: readonly string[]) => {
          selected = ids;
          return [{ instanceId: "provider-a", runtimeSessionId: settled, error: new Error("EBUSY: locked") }];
        },
      },
      requiredRuntimeProjection: () => ({
        readDispatchLifecycle: async (query) => {
          if (query.by === "session") pointReads.push(query.runtimeSessionId);
          return lifecycleReadFor([
            {
              runtimeSessionId: settled,
              dispatchId: "dispatch-settled",
              instanceId: "provider-a",
              attemptSettled: true,
            },
            { runtimeSessionId: live, dispatchId: "dispatch-live", instanceId: "provider-a", process: "alive" },
            { runtimeSessionId: adopted, dispatchId: "dispatch-adopted", instanceId: "provider-a", process: "alive" },
            { runtimeSessionId: exiting, dispatchId: "dispatch-exiting", instanceId: "provider-a", process: "unknown" },
          ])(query);
        },
        readRuntimeSessions: () => assert.fail("the sweep must not read the whole session table"),
        readRuntimeSession: (id: string) => {
          pointReads.push(id);
          const sessions: Record<string, { runtimeSessionId: string; outcome: string | null }> = {
            [settled]: { runtimeSessionId: settled, outcome: "succeeded" },
            [live]: { runtimeSessionId: live, outcome: null },
            [adopted]: { runtimeSessionId: adopted, outcome: null },
            [exiting]: { runtimeSessionId: exiting, outcome: null },
          };
          return sessions[id] ?? null;
        },
      }),
    };
    await sweepSettledRuntimeTempDirectories(context as never);
    assert.deepEqual(pointReads, [settled, live, adopted, neverRegistered, exiting]);
    assert.deepEqual(selected, [settled]);
    assert.equal(selected.includes(live), false, "live-at-center session stays");
    assert.equal(selected.includes(adopted), false, "locally re-adopted session stays");
    assert.equal(selected.includes(exiting), false, "locally settling session stays");
    assert.equal(selected.includes(neverRegistered), false, "unknown ownership is retained");
    assert.equal(
      logged.some((line) => line.includes("EBUSY: locked")),
      true,
      "the sweep's reclaim failure is logged, not swallowed",
    );
  } finally {
    console.error = originalError;
  }
});

test("the startup sweep point-reads only local temp directories regardless of session history", async () => {
  const local = ["runtime_0123456789abcdef01234567", "runtime_89abcdef0123456789abcdef"],
    pointReads: string[] = [];
  let reclaimed: readonly string[] = [];
  const context = {
    exiting: new Set<string>(),
    processes: new Map(),
    input: {
      listRuntimeTempSessionIds: () => local,
      reclaimSettledRuntimeTempDirectories: (ids: readonly string[]) => {
        reclaimed = ids;
        return [];
      },
    },
    requiredRuntimeProjection: () => ({
      readDispatchLifecycle: async (query) => {
        if (query.by === "session") pointReads.push(query.runtimeSessionId);
        return lifecycleReadFor(
          local.map((runtimeSessionId, index) => ({
            runtimeSessionId,
            dispatchId: `dispatch-${index}`,
            instanceId: "provider-a",
            attemptSettled: true,
          })),
        )(query);
      },
      readRuntimeSessions: () => assert.fail("the sweep must not read historical runtime sessions"),
    }),
  };
  await sweepSettledRuntimeTempDirectories(context as never);
  assert.deepEqual(pointReads, local, "the sweep point-reads lifecycle only for local temp directory names");
  assert.deepEqual(reclaimed, local);
});

test("the startup sweep leaves every directory alone when the center read fails", async () => {
  let reclaimCalled = false;
  const runtimeSessionId = "runtime_0123456789abcdef01234567",
    context = {
      exiting: new Set<string>(),
      processes: new Map(),
      input: {
        listRuntimeTempSessionIds: () => [runtimeSessionId],
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

test("settled temp maintenance is independent of runtime adoption", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-adoption-sweep-flag-"));
  try {
    const settled = "runtime_0123456789abcdef01234567",
      sweeps: number[] = [],
      context = {
        exiting: new Set<string>(),
        processes: new Map(),
        input: {
          repoId: "repository",
          rootDir,
          listRuntimeTempSessionIds: () => [settled],
          reclaimSettledRuntimeTempDirectories: () => {
            sweeps.push(sweeps.length);
            return [];
          },
        },
        requiredRuntimeProjection: () => ({
          readDispatchLifecycle: lifecycleReadFor([
            {
              runtimeSessionId: settled,
              dispatchId: "dispatch-settled",
              instanceId: "provider-a",
              attemptSettled: true,
            },
          ]),
          readRuntimeSessions: () => [],
          readRuntimeSession: () => ({ runtimeSessionId: settled, outcome: "succeeded" }),
        }),
      };
    await sweepSettledRuntimeTempDirectories(context as never);
    assert.deepEqual(sweeps, [0], "maintenance reclaims settled temp directories");
    await adoptRuntimes(context as never);
    assert.deepEqual(sweeps, [0], "cancel's mid-operation adoption must not sweep");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
