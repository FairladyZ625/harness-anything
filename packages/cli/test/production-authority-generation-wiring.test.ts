// harness-test-tier: integration
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import {
  createProductionAuthorityLifecycleFixture as createFixture,
  productionWriterRuntime as writerRuntime
} from "./helpers/production-authority-lifecycle-fixture.ts";
import {
  createCliProductionAuthorityLifecycle as createProductionAuthorityLifecycle
} from "../src/composition/production-authority-lifecycle.ts";

test("production lifecycle startup requires POSIX generation context and permits only explicit Windows legacy", async () => {
  const fixture = createFixture();
  try {
    const repo = { repoId: "canonical", canonicalRoot: fixture.repoRoot };
    const baseRuntime = writerRuntime(fixture.authoredRoot);
    const lifecycle = createProductionAuthorityLifecycle({ manifestPath: fixture.manifestPath });
    const missing = await lifecycle.startRepo(repo, {
      ...baseRuntime,
      daemonGenerationCapability: () => ({ mode: "generation" as const }),
      daemonGenerationContext: () => undefined
    });
    assert.deepEqual(missing, {
      ok: false,
      error: "DAEMON_GENERATION_CONTEXT_REQUIRED_FOR_PRODUCTION_AUTHORITY"
    });
    assert.equal(lifecycle.component(repo.repoId), undefined, "failed startup exposed a serving component");

    const legacy = await lifecycle.startRepo(repo, {
      ...baseRuntime,
      daemonGenerationCapability: () => ({
        mode: "legacy" as const,
        platform: "win32" as const,
        diagnostic: "DAEMON_GENERATION_DURABILITY_UNSUPPORTED" as const
      }),
      daemonGenerationContext: () => undefined
    });
    assert.equal(legacy.ok, true, legacy.ok ? "" : legacy.error);
    await lifecycle.stopAll("daemon-shutdown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
