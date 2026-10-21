// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import { classifyRuntimeExit } from "../src/runtime-provider-fault.ts";
import { parseRulingRequest, readDispatchRuling, runtimeRulingPath } from "../src/runtime-ruling.ts";

const rulingBody = `---
ruling: awaiting
question: low 档含 GUI 改动时，是否仍必须通过 GUI 行为验收？
options:
  - 保留 GUI 验收（推荐）
  - low 档不要求 GUI 验收
---

这是 task_936005e1 上 worker 实际提出的问题。
`;

function active(overrides: Partial<ActiveRuntime> = {}): ActiveRuntime {
  return {
    runtimeSessionId: "runtime-1",
    instanceId: "codex-api",
    kindId: "codex",
    dispatchId: "dispatch_25716c64031a31cc45f5e1d1",
    model: "gpt-6.1-sol",
    task: { taskId: "task_1", executionId: "exe_1" },
    cancelRequested: false,
    lossReason: null,
    providerFault: null,
    providerOutcome: null,
    errorBuffer: "",
    errorOverflowed: false,
    finalText: null,
    failureText: null,
    toolCallObserved: true,
    nonEmptyAgentOutputObserved: true,
    providerUsageEmpty: false,
    protocolError: false,
    ...overrides,
  } as unknown as ActiveRuntime;
}

test("a ruling artifact parses its question and ordered options", () => {
  assert.deepEqual(parseRulingRequest(rulingBody, "tasks/t/artifacts/rulings/dispatch_x.md"), {
    question: "low 档含 GUI 改动时，是否仍必须通过 GUI 行为验收？",
    options: ["保留 GUI 验收（推荐）", "low 档不要求 GUI 验收"],
    path: "tasks/t/artifacts/rulings/dispatch_x.md",
  });
});

test("only the declared awaiting shape is a ruling; anything else is absent", () => {
  // A prose report is not a machine-readable ask: the mission's channel is this frontmatter.
  assert.equal(parseRulingRequest("## Checkpoint\n\nI need a ruling on the GUI acceptance question.", "x"), null);
  assert.equal(parseRulingRequest("---\nruling: done\nquestion: q\n---\n", "x"), null);
  assert.equal(
    parseRulingRequest("---\nruling: awaiting\n---\n", "x"),
    null,
    "a ruling without a question is not an ask",
  );
  assert.deepEqual(
    parseRulingRequest("---\nruling: awaiting\nquestion: q\n---\n", "x")?.options,
    [],
    "options are optional: a yes/no ruling writes none",
  );
});

test("the ruling path is keyed by dispatch id so two dispatches never overwrite each other", () => {
  assert.equal(runtimeRulingPath("dispatch_a"), "artifacts/rulings/dispatch_a.md");
  assert.notEqual(runtimeRulingPath("dispatch_a"), runtimeRulingPath("dispatch_b"));
  assert.equal(
    readDispatchRuling(() => null, "tasks/t", "dispatch_a"),
    null,
    "an absent artifact settles by the ordinary classification",
  );
  assert.deepEqual(
    readDispatchRuling(
      (relative) => (relative === "tasks/t/artifacts/rulings/dispatch_a.md" ? rulingBody : null),
      "tasks/t",
      "dispatch_a",
    )?.question,
    "low 档含 GUI 改动时，是否仍必须通过 GUI 行为验收？",
  );
});

test("a ruling settles stopped/awaiting_ruling instead of gate_red, and carries the question", () => {
  // The measured shape of task_936005e1: tool activity, provider exit 2, no delivered cut. Without
  // the ruling this is `gate_red`/failed; with it the run is a deliberate stop for the owner.
  const failed = classifyRuntimeExit(active(), 2);
  assert.equal(failed.classification, "gate_red");
  assert.equal(failed.outcome, "failed");

  const awaiting = classifyRuntimeExit(active(), 2, {
    question: "low 档含 GUI 改动时，是否仍必须通过 GUI 行为验收？",
  });
  assert.equal(awaiting.classification, "awaiting_ruling");
  assert.equal(awaiting.outcome, "stopped", "a ruling is not a failed run");
  assert.equal(awaiting.reason, "low 档含 GUI 改动时，是否仍必须通过 GUI 行为验收？");
  assert.equal(awaiting.provider.kind, "codex");
});

test("a cancellation still outranks a written ruling: the operator stopped the run", () => {
  const cancelled = classifyRuntimeExit(active({ cancelRequested: true }), 2, { question: "q" });
  assert.equal(cancelled.classification, "worker_stop");
  assert.equal(cancelled.outcome, "cancelled");
});
