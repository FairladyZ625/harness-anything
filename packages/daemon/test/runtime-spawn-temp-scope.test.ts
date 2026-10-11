// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import test from "node:test";
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
