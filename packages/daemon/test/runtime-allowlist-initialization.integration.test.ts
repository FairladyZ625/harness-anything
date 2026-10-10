// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeInstanceCandidates } from "../src/runtime-spawn-mission.ts";

test("runtime dispatch does not initialize a missing repository allowlist", () => {
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "codex-api",
        agent: null,
        instances: [
          {
            instanceId: "codex-api",
            kindId: "codex",
            providerId: "openai",
            models: ["test-model"],
            enabled: true,
            authReadiness: { status: "ready", code: null, hint: null },
          } as never,
        ],
        sessions: [],
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "runtime_instance_allowlist_uninitialized" &&
      /ha init|repository settings/u.test(error.message),
  );
});
