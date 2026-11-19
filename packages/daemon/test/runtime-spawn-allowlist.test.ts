// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSpawnerInput } from "../src/daemon-host/runtime-spawn-types.ts";
import { resolveRuntimeDispatchResources } from "../src/daemon-host/runtime-spawn-allowlist.ts";

test("remote dispatch resources do not require a local task projection", async () => {
  const resources = await resolveRuntimeDispatchResources(
    {
      readSettings: () => ({ runtime: { allowedInstances: ["remote-instance"] } }) as never,
    },
    {
      readRuntimeSessions: async () => [],
      readDispatchLifecycle: () => {
        throw new Error("Repository lifecycle cannot be used as a node-local load census.");
      },
    } as NonNullable<RuntimeSpawnerInput["remote"]>,
    null,
  );
  assert.deepEqual(resources, [[], [], ["remote-instance"], []]);
});

test("shared runtime capabilities restrict admission by node kind and model", async () => {
  const instances = [
      { instanceId: "private-openai", kindId: "codex", models: ["model-a", "model-b"], enabled: true },
      { instanceId: "private-zcode", kindId: "zcode", models: ["model-b"], enabled: true },
    ] as never,
    [, admitted, allowedInstanceIds] = await resolveRuntimeDispatchResources(
      {
        readSettings: () => ({ runtime: { allowedKinds: ["codex"], allowedModels: ["model-b"] } }) as never,
        runtimeInstances: () => instances,
      },
      undefined,
      null,
    );
  assert.deepEqual(
    admitted.map(({ instanceId, models }) => ({ instanceId, models })),
    [
      { instanceId: "private-openai", models: ["model-b"] },
      { instanceId: "private-zcode", models: ["model-b"] },
    ],
  );
  assert.deepEqual(allowedInstanceIds, ["private-openai"]);
});

test("an explicitly empty model capability list admits no node instances", async () => {
  const [, instances, allowedInstanceIds] = await resolveRuntimeDispatchResources(
    {
      readSettings: () => ({ runtime: { allowedModels: [] } }) as never,
      runtimeInstances: () => [{ instanceId: "private-openai", kindId: "codex", models: ["model-a"] }] as never,
    },
    undefined,
    null,
  );
  assert.deepEqual(instances.map(({ models }) => models), [[]]);
  assert.deepEqual(allowedInstanceIds, []);
});
