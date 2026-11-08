// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";
import { resolveRuntimeDispatchResources } from "../src/runtime-spawn-allowlist.ts";

test("remote dispatch resources do not require a local task projection", async () => {
  const resources = await resolveRuntimeDispatchResources(
    {
      readSettings: () => ({ runtime: { allowedInstances: ["remote-instance"] } }) as never,
    },
    { readRuntimeSessions: async () => [] } as NonNullable<RuntimeSpawnerInput["remote"]>,
    null,
  );
  const [sessions, instances, allowed, health, instanceLoad] = resources;
  assert.deepEqual([sessions, instances, allowed, health], [[], [], ["remote-instance"], []]);
  assert.equal(instanceLoad("remote-instance"), 0, "an edge has no local lifecycle reservation index");
});
