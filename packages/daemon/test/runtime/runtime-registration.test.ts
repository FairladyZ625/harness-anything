// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createMultiRepoDaemonRuntime } from "../../src/runtime/repo-runtime.ts";
import { withTempStoreAsync } from "./helpers/store.ts";

test("generation-owned runtime registration is stable until detach and changes across registrations", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const generationAxes = { machineId: "machine-installation-a", daemonGeneration: 7 };
    const runtime = createMultiRepoDaemonRuntime({
      materializerPollMs: false,
      generationAxes,
      repos: [{ repoId: "canonical", rootDir }]
    });
    let first: string | undefined;
    try {
      const started = await runtime.start();
      first = started.repos[0]?.runtimeRegistrationId;
      assert.match(first ?? "", /^[0-9a-f-]{36}$/u);
      assert.equal(started.repos[0]?.daemonGeneration, 7);
      assert.equal((await runtime.attachRepo({ repoId: "canonical", rootDir })).runtimeRegistrationId, first);

      const detached = await runtime.detachRepo("canonical");
      assert.equal(detached.runtimeRegistrationId, undefined);
      assert.equal(detached.daemonGeneration, undefined);
      const reattached = await runtime.attachRepo({ repoId: "canonical", rootDir });
      assert.notEqual(reattached.runtimeRegistrationId, first);
      assert.equal(reattached.daemonGeneration, 7);
    } finally {
      await runtime.stop();
    }

    const replacement = createMultiRepoDaemonRuntime({
      materializerPollMs: false,
      generationAxes: { ...generationAxes, daemonGeneration: 8 },
      repos: [{ repoId: "canonical", rootDir }]
    });
    try {
      const status = await replacement.start();
      assert.equal(status.repos[0]?.daemonGeneration, 8);
      assert.notEqual(status.repos[0]?.runtimeRegistrationId, first);
    } finally {
      await replacement.stop();
    }
  });
});
