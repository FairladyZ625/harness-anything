// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { runProcessTextAsync } from "../src/process-port.ts";

test("a timed out command releases pipes held by a spawned descendant", async () => {
  const started = performance.now();
  await assert.rejects(
    runProcessTextAsync(
      process.execPath,
      [
        "-e",
        [
          "const {spawn}=require('node:child_process');",
          "spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});",
          "setTimeout(()=>{},60000);",
        ].join(""),
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      { timeoutMs: 50 },
    ),
  );
  assert.ok(performance.now() - started < 2_000, "timeout must not wait for the descendant pipe");
});
