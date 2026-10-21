// harness-test-tier: fast
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { tailRuntimeSteerCommands } from "../src/runtime-worker-control.ts";

const record = (value: Readonly<Record<string, unknown>>): string =>
  `${JSON.stringify({ schema: "runtime-dispatch-stream/v1", ...value })}\n`;

test("the steer tail skips the records already in the stream and dispatches only later steer requests", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-worker-control-"));
  try {
    const target = path.join(rootDir, "dispatch_0123456789abcdef0123456a.jsonl"),
      prompts: string[] = [];
    // History the host did not receive as commands: replaying it would re-steer every round.
    writeFileSync(
      target,
      record({ kind: "dispatch" }) +
        record({ kind: "steer_requested", prompt: "history" }) +
        record({ kind: "process_started", pid: 42 }),
    );
    const tail = tailRuntimeSteerCommands(target, (prompt) => prompts.push(prompt));
    await eventually(() => readSize(target) > 0);
    assert.deepEqual(prompts, [], "records present when the tail starts are not commands");
    appendFileSync(
      target,
      record({ kind: "provider_event", event: { type: "acp.session" } }) +
        record({ kind: "steer_requested", prompt: "first" }),
    );
    await eventually(() => prompts.length === 1);
    assert.deepEqual(prompts, ["first"]);
    // A re-read must not redispatch the same record; only new lines count.
    appendFileSync(target, record({ kind: "steer_requested", prompt: "second" }));
    await eventually(() => prompts.length === 2);
    assert.deepEqual(prompts, ["first", "second"]);
    tail.stop();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the steer tail holds back a partial trailing line until its newline arrives", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-worker-control-partial-"));
  try {
    const target = path.join(rootDir, "dispatch_0123456789abcdef0123456b.jsonl"),
      prompts: string[] = [],
      line = record({ kind: "steer_requested", prompt: "split" }),
      split = Math.floor(line.length / 2);
    writeFileSync(target, "");
    const tail = tailRuntimeSteerCommands(target, (prompt) => prompts.push(prompt));
    appendFileSync(target, line.slice(0, split));
    await eventually(() => readSize(target) > 0);
    assert.deepEqual(prompts, [], "a partial line must not dispatch");
    appendFileSync(target, line.slice(split));
    await eventually(() => prompts.length === 1);
    assert.deepEqual(prompts, ["split"]);
    tail.stop();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a steer record whose prompt is not a string is skipped, and records after stop are ignored", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-worker-control-shape-"));
  try {
    const target = path.join(rootDir, "dispatch_0123456789abcdef0123456c.jsonl"),
      prompts: string[] = [];
    writeFileSync(target, "");
    const tail = tailRuntimeSteerCommands(target, (prompt) => prompts.push(prompt));
    appendFileSync(target, record({ kind: "steer_requested", prompt: 7 }));
    await eventually(() => readSize(target) > 0);
    assert.deepEqual(prompts, [], "a malformed steer record must not dispatch");
    tail.stop();
    appendFileSync(target, record({ kind: "steer_requested", prompt: "after stop" }));
    await eventually(() => readSize(target) > 0);
    assert.deepEqual(prompts, [], "a stopped tail dispatches nothing");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the steer tail starts at zero for a stream that does not exist yet", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-worker-control-late-"));
  try {
    const target = path.join(rootDir, "dispatch_0123456789abcdef0123456d.jsonl"),
      prompts: string[] = [];
    const tail = tailRuntimeSteerCommands(target, (prompt) => prompts.push(prompt));
    appendFileSync(target, record({ kind: "steer_requested", prompt: "created later" }));
    await eventually(() => prompts.length === 1);
    assert.deepEqual(prompts, ["created later"]);
    tail.stop();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function readSize(target: string): number {
  return statSync(target).size;
}

async function eventually(check: () => boolean): Promise<void> {
  while (!check()) await new Promise<void>((resolve) => setImmediate(resolve));
}
