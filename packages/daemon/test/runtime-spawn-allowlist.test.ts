// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";
import { resolveRuntimeDispatchResources } from "../src/runtime-spawn-allowlist.ts";
import { emptyDispatchLifecycleRead } from "./dispatch-lifecycle-read.fixtures.ts";

test("remote dispatch resources do not require a local task projection", async () => {
  const resources = await resolveRuntimeDispatchResources(
    {
      readSettings: () => ({ runtime: { allowedInstances: ["remote-instance"] } }) as never,
    },
    {
      readRuntimeSessions: async () => [],
      readDispatchLifecycle: emptyDispatchLifecycleRead,
    } as NonNullable<RuntimeSpawnerInput["remote"]>,
    null,
  );
  assert.deepEqual(resources, [[], [], ["remote-instance"], [], []]);
});
