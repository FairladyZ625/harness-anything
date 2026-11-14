// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { runProcessTextAsync } from "../src/process-port.ts";

test("a timed out command releases pipes held by a spawned descendant", async () => {
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
});

test("output past the 1 MiB default buffer needs an explicit maxBuffer", async () => {
  const twoMiB = ["-e", "process.stdout.write('x'.repeat(2 << 20))"];
  await assert.rejects(runProcessTextAsync(process.execPath, twoMiB), /maxBuffer/u);
  const stdout = await runProcessTextAsync(process.execPath, twoMiB, undefined, undefined, undefined, undefined, {
    maxBuffer: 4 << 20,
  });
  assert.equal(stdout.length, 2 << 20);
});

test("interactive stdin is kept open for the protocol exchange and its failure terminates the child", async () => {
  const result = await runProcessTextAsync(
    process.execPath,
    ["-e", "process.stdin.on('data',x=>process.stdout.write(x))"],
    undefined,
    undefined,
    async (child) => {
      child.stdin!.write("request");
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    },
    undefined,
    { timeoutMs: 1000 },
  );
  assert.equal(result, "request");
  const failure = new Error("interaction failed");
  await assert.rejects(
    runProcessTextAsync(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      undefined,
      undefined,
      async () => {
        throw failure;
      },
      undefined,
      { timeoutMs: 1000 },
    ),
    (error) => error === failure,
  );
});
