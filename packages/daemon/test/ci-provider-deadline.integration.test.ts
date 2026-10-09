// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { runCiProviderCommand } from "../src/ci-observation-actions.ts";

test("the CI provider boundary terminates and waits for a stalled child", async () => {
  await assert.rejects(
    runCiProviderCommand(process.execPath, ["-e", "setTimeout(() => {}, 35000)"], { cwd: process.cwd() }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { killed: boolean }).killed, true);
      return true;
    },
  );
});
