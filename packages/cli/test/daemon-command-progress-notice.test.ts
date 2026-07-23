// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/main.ts";

const fixtureRunnerSymbol = Symbol.for("harness-anything.cli-test-fixture-runner");
const finalReceipt = {
  ok: true,
  schema: "command-receipt/v2",
  command: "doctor",
  action: "doctor",
  summary: "completed doctor",
  details: { data: { report: { readOnly: true } } },
  meta: {
    generatedAt: "2026-07-23T00:00:00.000Z",
    compatibility: { legacyReceipt: "CommandReceipt/v1" }
  }
} as const;

test("daemon-backed CLI progress says the command is still running before the final receipt", async () => {
  const originalError = console.error;
  const originalLog = console.log;
  const stderr: string[] = [];
  const stdout: string[] = [];
  let releaseCommand!: (receipt: typeof finalReceipt) => void;
  const commandResult = new Promise<typeof finalReceipt>((resolve) => {
    releaseCommand = resolve;
  });
  let progressSeen!: () => void;
  const progress = new Promise<void>((resolve) => {
    progressSeen = resolve;
  });

  (globalThis as Record<symbol, unknown>)[fixtureRunnerSymbol] = async () => commandResult;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
    progressSeen();
  };
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };

  const exit = main(["--json", "doctor"]);
  const progressTimeout = setTimeout(() => progressSeen(), 2_000);
  try {
    await progress;
    assert.ok(stderr.length > 0, "progress notice timeout");
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, [
      "[ha] Command is still running; this is progress, not the final receipt. Keep waiting for this process to finish. Agent tools must continue reading the same session."
    ]);

    releaseCommand(finalReceipt);
    assert.equal(await exit, 0);
    assert.equal(stdout.length, 1);
    assert.equal(JSON.parse(stdout[0] ?? "{}").schema, "command-receipt/v2");
  } finally {
    clearTimeout(progressTimeout);
    releaseCommand(finalReceipt);
    await exit;
    delete (globalThis as Record<symbol, unknown>)[fixtureRunnerSymbol];
    console.error = originalError;
    console.log = originalLog;
  }
});

test("HA_PROGRESS=0 suppresses daemon-backed progress without changing the final receipt", async () => {
  const originalError = console.error;
  const originalLog = console.log;
  const originalProgress = process.env.HA_PROGRESS;
  const stderr: string[] = [];
  const stdout: string[] = [];

  process.env.HA_PROGRESS = "0";
  (globalThis as Record<symbol, unknown>)[fixtureRunnerSymbol] = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    return finalReceipt;
  };
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));

  try {
    assert.equal(await main(["--json", "doctor"]), 0);
    assert.deepEqual(stderr, []);
    assert.equal(stdout.length, 1);
    assert.equal(JSON.parse(stdout[0] ?? "{}").schema, "command-receipt/v2");
  } finally {
    delete (globalThis as Record<symbol, unknown>)[fixtureRunnerSymbol];
    if (originalProgress === undefined) delete process.env.HA_PROGRESS;
    else process.env.HA_PROGRESS = originalProgress;
    console.error = originalError;
    console.log = originalLog;
  }
});
