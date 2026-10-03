// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseFleetFrame, serializeFleetFrame } from "@harness-anything/daemon/internal/fleet/contract";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("real fact CLI fields survive the fleet wire, including long text and retirement provenance", () => {
  for (const flag of ["--statement", "--text"]) {
    const statement = "观测正文。".repeat(200),
      parsed = parseThinCommand([
        "fact",
        "record",
        "--task",
        "task_one",
        flag,
        statement,
        "--source",
        "test:observation",
        "--type",
        "measurement",
        "--memory-tag",
        "pattern",
        "--observed-at",
        "2026-10-04T00:00:00Z",
        "--supersedes",
        "fact/F-12345678",
        "--rationale",
        "New measurement.",
      ]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const frame = {
      schema: "fleet.task.command/v1" as const,
      messageId: "fact",
      writerEpoch: 1,
      opId: "fact-op",
      repoId: "repo",
      taskId: "task_one",
      action: parsed.command.action,
      docChanges: null,
      mirrorBaseCut: null,
    };
    assert.deepEqual(parseFleetFrame(serializeFleetFrame(frame)), frame);
    assert.throws(() => parseFleetFrame({ ...frame, action: { ...frame.action, actor: "client" } }));
    assert.throws(() => parseFleetFrame({ ...frame, action: { ...frame.action, credential: "client" } }));
  }
});

test("progress prose crosses 512 characters while the existing body and frame limits remain enforced", () => {
  const frame = {
    schema: "fleet.task.command/v1" as const,
    messageId: "progress",
    writerEpoch: 1,
    opId: "progress-op",
    repoId: "repo",
    taskId: "task_one",
    action: { kind: "task-progress-append", taskId: "task_one", text: "x".repeat(513) },
    docChanges: null,
    mirrorBaseCut: null,
  };
  assert.deepEqual(parseFleetFrame(serializeFleetFrame(frame)), frame);
  assert.throws(() => parseFleetFrame({ ...frame, action: { ...frame.action, text: "x".repeat(32 * 1024 + 1) } }));
  assert.throws(() => parseFleetFrame({ ...frame, action: { ...frame.action, text: "字".repeat(32 * 1024) } }));
});
