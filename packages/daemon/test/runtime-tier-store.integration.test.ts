// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instance-store.ts";
import { openDaemonRuntimePorts } from "../src/daemon-runtime-ports.ts";

test("instance tier defaults, persists, updates and rejects invalid input without changing stored configuration", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-tier-"));
  const open = () =>
    openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { HOME: path.join(userRoot, "operator") },
      discover: () => [
        {
          installationId: "agy-test",
          kindId: "agy",
          executablePath: "/test/agy",
          version: "1.1.15",
          observedAt: "2026-11-14T00:00:00.000Z",
        },
      ],
    });
  try {
    const store = open();
    const created = store.command({
      kind: "runtime-instance-create",
      instanceId: "pro",
      name: "Pro",
      kindId: "agy",
      providerId: "google",
      models: ["Hydrogen"],
      authMode: "subscription",
      credentialSource: "instance",
    }).instance as Record<string, unknown>;
    assert.equal(created.tier, 1);
    store.command({ kind: "runtime-instance-update", instanceId: "pro", tier: 2 });
    assert.equal(open().read("pro").tier, 2);
    for (const tier of [0, 10, 1.5, "2", null]) {
      assert.throws(() => store.command({ kind: "runtime-instance-update", instanceId: "pro", tier }), {
        code: "invalid_runtime_tier",
      });
      assert.throws(
        () =>
          store.command({
            kind: "runtime-instance-create",
            instanceId: "invalid",
            name: "Invalid",
            kindId: "agy",
            providerId: "google",
            models: ["Hydrogen"],
            authMode: "subscription",
            credentialSource: "instance",
            tier,
          }),
        { code: "invalid_runtime_tier" },
      );
      assert.equal(store.read("pro").tier, 2);
    }
    const repoA = openDaemonRuntimePorts({ instances: store }),
      repoB = openDaemonRuntimePorts({ instances: store });
    repoA.runtimeInstanceDispatchState!.recordDispatch("pro");
    assert.equal(repoB.runtimeInstanceDispatchState!.lastDispatchedAt.get("pro"), 1);
    assert.equal(
      open().runtimeInstanceDispatchState.lastDispatchedAt.size,
      0,
      "daemon restart resets transient recency rather than reading history",
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
