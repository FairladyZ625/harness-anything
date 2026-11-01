// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import { classifyRuntimeExit } from "../src/runtime-provider-fault.ts";
import { recordedRuling, recordedStream } from "./fixtures/task-936005e1-ruling.ts";
import {
  parseRulingArtifact,
  parseRulingRequest,
  readDispatchRuling,
  readDispatchRulingFromWorker,
  rulingReceiptText,
  runtimeRulingPath,
} from "../src/runtime-ruling.ts";

const { question, options, body: rulingBody } = recordedRuling,
  dispatchRecord = recordedStream.find((record) => record.kind === "dispatch")!,
  exitRecord = recordedStream.find((record) => record.kind === "process_exit")!,
  attemptRecord = recordedStream.find((record) => record.kind === "attempt_outcome")!,
  terminalRecord = recordedStream.find((record) => record.kind === "terminal_outcome")!,
  a24RulingBody = [
    "# Blocking decision：G2 仍需共享关闭接线交接",
    "",
    "dispatch_fe494d7c69556ef6228888d7 按本轮允许的“提交交付或报告 blocking decision”选择后者。没有提交新的完整修复，F1 仍成立。",
    "",
    "## 当前证据与边界",
    "",
    "观察时间 2026-11-01T12:27:14.319737+00:00。已检查当前工作树、任务包 closeout/前序裁决、任务 projection、read-set 及真实关闭源码；沿用本会话已读的五张必选技能和根规范。",
    "",
    "- 本轮任务书仍明确排除 daemon-host-open.ts 等共享文件。owner task_96477eb1200576afd890105a29 仍 active。",
    "",
    "## 请求裁决与建议",
    "",
    "**A（推荐）：CEO 与原 owner 明确交接最小范围。** 将 daemon-host-open.ts 的 close、stream 启动、initial continuation 的收尾 ownership 交给本任务。",
  ].join("\n");

function active(overrides: Partial<ActiveRuntime> = {}): ActiveRuntime {
  return {
    runtimeSessionId: dispatchRecord.runtimeSessionId,
    instanceId: dispatchRecord.instanceId,
    kindId: dispatchRecord.kindId,
    dispatchId: dispatchRecord.dispatchId,
    model: "gpt-6.1-sol",
    task: { taskId: dispatchRecord.taskId, executionId: dispatchRecord.executionId },
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

test("the recorded task_936005e1 stream still reads as a failed gate_red run without a ruling artifact", () => {
  // The measured before-state: exit 2, tool activity, no delivered cut — nothing distinguishes this
  // from a broken provider unless the dispatch carries a ruling artifact.
  assert.equal(exitRecord.exitCode, 2);
  assert.equal(attemptRecord.classification, "gate_red");
  assert.equal((terminalRecord.payload as { readonly outcome: string }).outcome, "failed");
  const before = classifyRuntimeExit(active(), 2);
  assert.equal(before.classification, "gate_red");
  assert.equal(before.outcome, "failed");
});

test("a ruling artifact parses its question and ordered options", () => {
  assert.deepEqual(parseRulingRequest(rulingBody, "tasks/t/artifacts/rulings/dispatch_x.md"), {
    question: "low 档含 GUI 改动时，是否仍必须通过 GUI 行为验收？此决定会限定免评范围。",
    options: ["保留 GUI 验收（推荐）", "low 档不要求 GUI 验收"],
    path: "tasks/t/artifacts/rulings/dispatch_x.md",
  });
});

test("only the declared awaiting shape is a ruling; anything else is absent", () => {
  // A prose report is not a machine-readable ask; legacy frontmatter remains supported.
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

test("an a24-shaped ruling file is detected as malformed instead of disappearing as an absent ask", () => {
  assert.deepEqual(
    parseRulingArtifact(a24RulingBody, "tasks/a24/artifacts/rulings/dispatch_d2c417018144246db421e440.md"),
    {
      kind: "malformed",
      path: "tasks/a24/artifacts/rulings/dispatch_d2c417018144246db421e440.md",
      reason: "missing ruling frontmatter",
    },
  );
  assert.deepEqual(parseRulingArtifact(rulingBody, "tasks/t/artifacts/rulings/dispatch_x.md"), {
    kind: "valid",
    question,
    options,
    path: "tasks/t/artifacts/rulings/dispatch_x.md",
  });
  assert.deepEqual(parseRulingArtifact("", "x"), { kind: "malformed", path: "x", reason: "ruling artifact is empty" });
});

test("a present malformed ruling is an awaiting-owner stop with a visible file reason", () => {
  const parsed = parseRulingArtifact(a24RulingBody, "tasks/a24/artifacts/rulings/dispatch_d2c417018144246db421e440.md"),
    malformed =
      parsed?.kind === "malformed"
        ? {
            question: `Ruling artifact is not machine-readable: ${parsed.reason}`,
            options: [],
            path: parsed.path,
            malformedReason: parsed.reason,
          }
        : null,
    stopped = classifyRuntimeExit(active(), 2, malformed);
  assert.equal(stopped.classification, "awaiting_ruling");
  assert.equal(stopped.outcome, "stopped");
  assert.match(stopped.reason, /not machine-readable/u);
  assert.equal(malformed?.path, "tasks/a24/artifacts/rulings/dispatch_d2c417018144246db421e440.md");
  assert.match(rulingReceiptText(malformed!), /missing ruling frontmatter/u);
  assert.ok(rulingReceiptText(malformed!).includes("artifacts/rulings/dispatch_d2c417018144246db421e440.md"));
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
    question,
  );
});

test("the worker's own filesystem is the read path: a worktree-local artifact is found before any doc sync", () => {
  // The exact production failure (review F1): a dispatch writes into its worktree package mirror and
  // no doc sync publishes it, so the projection read is empty at settlement. This exercises the real
  // filesystem layout — `<cwd>/harness/<packagePath>/artifacts/rulings/<dispatchId>.md` — and asserts
  // the disk read wins while the projection fallback stays empty.
  const root = mkdtempSync(path.join(tmpdir(), "ha-ruling-worker-"));
  try {
    const packagePath = "tasks/task_ruling_fixture-package",
      cwd = path.join(root, ".worktrees", "task_ruling_fixture"),
      artifact = path.join(
        cwd,
        "harness",
        ...packagePath.split("/"),
        "artifacts",
        "rulings",
        `${dispatchRecord.dispatchId}.md`,
      );
    mkdirSync(path.dirname(artifact), { recursive: true });
    writeFileSync(artifact, rulingBody);
    assert.equal(
      readDispatchRuling(() => null, packagePath, String(dispatchRecord.dispatchId)),
      null,
      "projection-only read is empty: this is the before-state the fix replaces",
    );
    const found = readDispatchRulingFromWorker({
      cwd,
      rootDir: root,
      packagePath,
      dispatchId: String(dispatchRecord.dispatchId),
    });
    assert.equal(found?.question, question);
    assert.deepEqual(found?.options, options);
    assert.equal(found?.path, `${packagePath}/artifacts/rulings/${dispatchRecord.dispatchId}.md`);
    assert.equal(found?.body, rulingBody, "the parsed body travels with the request so settlement can publish it");
    // A package-bound dispatch whose cwd is the package itself reads the same artifact.
    assert.equal(
      readDispatchRulingFromWorker({
        cwd: path.join(cwd, "harness", ...packagePath.split("/")),
        rootDir: root,
        packagePath,
        dispatchId: String(dispatchRecord.dispatchId),
      })?.question,
      question,
    );
    // No artifact anywhere: the ordinary classification survives.
    assert.equal(
      readDispatchRulingFromWorker({ cwd, rootDir: root, packagePath, dispatchId: "dispatch_absent" }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a ruling settles stopped/awaiting_ruling instead of gate_red, and carries the question", () => {
  // The measured shape of task_936005e1: tool activity, provider exit 2, no delivered cut. Without
  // the ruling this is `gate_red`/failed; with it the run is a deliberate stop for the owner.
  const failed = classifyRuntimeExit(active(), 2);
  assert.equal(failed.classification, "gate_red");
  assert.equal(failed.outcome, "failed");

  const awaiting = classifyRuntimeExit(active(), 2, { question, options });
  assert.equal(awaiting.classification, "awaiting_ruling");
  assert.equal(awaiting.outcome, "stopped", "a ruling is not a failed run");
  assert.equal(awaiting.reason, question);
  assert.equal(awaiting.provider.kind, "codex");
});

test("the receipt text carries the question, every option in order, and the resolution command", () => {
  const text = rulingReceiptText({
    question,
    options,
    path: `tasks/t/artifacts/rulings/${dispatchRecord.dispatchId}.md`,
  });
  assert.match(text, new RegExp(`^Awaiting owner ruling: ${question}$`, "mu"));
  assert.match(text, /^Options:$/mu);
  assert.match(text, /^ {2}1\. 保留 GUI 验收（推荐）$/mu);
  assert.match(text, /^ {2}2\. low 档不要求 GUI 验收$/mu);
  assert.match(text, /Ruling artifact: tasks\/t\/artifacts\/rulings\/dispatch_25716c64031a31cc45f5e1d1\.md/u);
  assert.match(text, /ha task escalation resolve <task-id> --dispatch-id <dispatch-id>/u);
  // A yes/no ask writes no options block at all rather than an empty heading.
  assert.doesNotMatch(
    rulingReceiptText({ question: "Ship it?", options: [], path: "tasks/t/artifacts/rulings/d.md" }),
    /Options:/u,
  );
});

test("a cancellation still outranks a written ruling: the operator stopped the run", () => {
  const cancelled = classifyRuntimeExit(active({ cancelRequested: true }), 2, { question, options });
  assert.equal(cancelled.classification, "worker_stop");
  assert.equal(cancelled.outcome, "cancelled");
});
