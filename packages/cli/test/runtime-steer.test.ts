// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serializeFleetAction, materializeCommandFileInputs } from "../src/daemon/fleet-payload-serializer.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("runtime steer accepts --prompt-file and materializes it into the steer prompt", () => {
  const root = mkdtempSync(path.join(tmpdir(), "steer-prompt-file-"));
  try {
    writeFileSync(path.join(root, "steer.md"), "continue the plan");
    const parsed = parseThinCommand(["runtime", "steer", "runtime_session1", "--prompt-file", "steer.md"], root);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error(parsed.nextAction);
    assert.equal(parsed.command.method, "repo.agentRuntime.steer");
    assert.equal(parsed.command.action.runtimeSessionId, "runtime_session1");
    assert.equal(parsed.command.action.promptFile, "steer.md");
    const materialized = materializeCommandFileInputs(parsed.command);
    assert.equal(materialized.action.prompt, "continue the plan");
    assert.equal(materialized.action.promptFile, undefined);
  } finally {
    removeTempRepository(root);
  }
});

test("runtime steer --prompt-file steers a dispatch target and stays inside the repository", () => {
  const root = mkdtempSync(path.join(tmpdir(), "steer-prompt-file-"));
  try {
    writeFileSync(path.join(root, "steer.md"), "change direction");
    const parsed = parseThinCommand(["runtime", "steer", "dispatch_123", "--prompt-file", "steer.md"], root);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error(parsed.nextAction);
    assert.equal(parsed.command.action.dispatchId, "dispatch_123");
    assert.equal(materializeCommandFileInputs(parsed.command).action.prompt, "change direction");
    const outside = parseThinCommand(["runtime", "steer", "runtime_session1", "--prompt-file", "../outside.md"], root);
    assert.equal(outside.ok, true, JSON.stringify(outside));
    if (!outside.ok) throw new Error(outside.nextAction);
    assert.throws(
      () => materializeCommandFileInputs(outside.command),
      (error: unknown) =>
        (error as { readonly code?: unknown }).code === "invalid_field" &&
        /must stay within the selected repository/u.test(String((error as Error).message)),
    );
  } finally {
    removeTempRepository(root);
  }
});

test("runtime steer --prompt-file rejects file and parent symlinks that leave the repository", (t) => {
  if (process.platform === "win32") {
    t.skip("requires POSIX file-symbolic-link semantics");
    return;
  }
  const parent = mkdtempSync(path.join(tmpdir(), "steer-prompt-symlink-")),
    root = path.join(parent, "repo"),
    outside = path.join(parent, "outside");
  mkdirSync(path.join(root, "linked"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "prompt.md"), "outside prompt");
  symlinkSync(path.join(outside, "prompt.md"), path.join(root, "file-link.md"));
  symlinkSync(outside, path.join(root, "directory-link"), "dir");
  writeFileSync(path.join(root, "inside.md"), "inside prompt");
  symlinkSync(path.join(root, "inside.md"), path.join(outside, "back-inside.md"));
  t.after(() => removeTempRepository(parent));

  for (const requested of ["file-link.md", "directory-link/prompt.md", "directory-link/back-inside.md"]) {
    const parsed = parseThinCommand(["runtime", "steer", "runtime_session1", "--prompt-file", requested], root);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) continue;
    assert.throws(
      () => serializeFleetAction(parsed.command),
      (error: unknown) =>
        (error as { readonly code?: unknown }).code === "invalid_field" &&
        /must stay within the selected repository/u.test(String((error as Error).message)),
    );
    assert.throws(
      () => materializeCommandFileInputs(parsed.command),
      (error: unknown) =>
        (error as { readonly code?: unknown }).code === "invalid_field" &&
        /must stay within the selected repository/u.test(String((error as Error).message)),
      requested,
    );
  }
});

test("runtime steer still takes --prompt directly and rejects ambiguous prompt sources", () => {
  const parsed = parseThinCommand(["runtime", "steer", "runtime_session1", "--prompt", "inline steer"]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error(parsed.nextAction);
  assert.equal(materializeCommandFileInputs(parsed.command).action.prompt, "inline steer");
  const neither = parseThinCommand(["runtime", "steer", "runtime_session1"]);
  assert.equal(neither.ok, false);
  if (neither.ok) throw new Error("expected rejection");
  assert.equal(neither.code, "missing_field");
  assert.match(neither.nextAction, /--prompt or --prompt-file/u);
  const both = parseThinCommand([
    "runtime",
    "steer",
    "runtime_session1",
    "--prompt",
    "inline",
    "--prompt-file",
    "steer.md",
  ]);
  assert.equal(both.ok, false);
  if (both.ok) throw new Error("expected rejection");
  assert.equal(both.code, "invalid_field");
  assert.match(both.nextAction, /mutually exclusive/u);
});

test("runtime steer carries compare-and-steer expectations to the daemon (#4372)", () => {
  const parsed = parseThinCommand([
    "runtime",
    "steer",
    "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
    "--prompt",
    "only if unchanged",
    "--expect-task",
    "task_x",
    "--expect-execution",
    "execution_x",
    "--expect-dispatch",
    "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
    "--expect-version",
    "2",
  ]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error(parsed.nextAction);
  assert.deepEqual(parsed.command.action.expected, {
    taskId: "task_x",
    executionId: "execution_x",
    dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
    version: 2,
  });
  const taskless = parseThinCommand(["runtime", "steer", "runtime_s", "--prompt", "x", "--expect-taskless"]);
  assert.equal(taskless.ok, true, JSON.stringify(taskless));
  if (!taskless.ok) throw new Error(taskless.nextAction);
  assert.deepEqual(taskless.command.action.expected, { taskless: true });
  const legacy = parseThinCommand(["runtime", "steer", "runtime_s", "--prompt", "x"]);
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  if (!legacy.ok) throw new Error(legacy.nextAction);
  assert.equal("expected" in legacy.command.action, false, "no expectation keeps the previous call shape");
  const badVersion = parseThinCommand(["runtime", "steer", "runtime_s", "--prompt", "x", "--expect-version", "-1"]);
  assert.equal(badVersion.ok, false);
  const contradiction = parseThinCommand([
    "runtime",
    "steer",
    "runtime_s",
    "--prompt",
    "x",
    "--expect-taskless",
    "--expect-task",
    "task_x",
  ]);
  assert.equal(contradiction.ok, false);
});

test("file codecs resolve a selected repository root symlink before checking an absolute in-repo input", (t) => {
  if (process.platform === "win32") {
    t.skip("requires POSIX file-symbolic-link semantics");
    return;
  }
  const parent = mkdtempSync(path.join(tmpdir(), "steer-root-symlink-")),
    root = path.join(parent, "repo"),
    alias = path.join(parent, "alias");
  mkdirSync(root);
  symlinkSync(root, alias, "dir");
  writeFileSync(path.join(root, "prompt.md"), "inside prompt");
  t.after(() => removeTempRepository(parent));
  const parsed = parseThinCommand(
    ["runtime", "steer", "runtime_session1", "--prompt-file", path.join(alias, "prompt.md")],
    alias,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(materializeCommandFileInputs(parsed.command).action.prompt, "inside prompt");
  assert.equal(serializeFleetAction(parsed.command).prompt, "inside prompt");
});

test("runtime steer accepts task targets, --mode auto|queue|interrupt, and --message alias", () => {
  const byTask = parseThinCommand([
    "runtime",
    "steer",
    "task_abcdef0123456789abcdef01",
    "--mode",
    "queue",
    "--message",
    "仅做子包 A，跳过 B",
  ]);
  assert.equal(byTask.ok, true, JSON.stringify(byTask));
  if (!byTask.ok) throw new Error(byTask.nextAction);
  assert.equal(byTask.command.method, "repo.agentRuntime.steer");
  assert.equal(byTask.command.action.taskId, "task_abcdef0123456789abcdef01");
  assert.equal(byTask.command.action.mode, "queue");
  assert.equal(byTask.command.action.prompt, "仅做子包 A，跳过 B");

  const badMode = parseThinCommand(["runtime", "steer", "runtime_s", "--prompt", "x", "--mode", "bogus"]);
  assert.equal(badMode.ok, false);
  if (badMode.ok) throw new Error("expected invalid mode rejection");
  assert.equal(badMode.code, "invalid_field");

  const conflict = parseThinCommand(["runtime", "steer", "runtime_s", "--prompt", "a", "--message", "b"]);
  assert.equal(conflict.ok, false);
});

test("runtime report, runtime collect, and runtime status --cursor parse cleanly", () => {
  const report = parseThinCommand([
    "runtime",
    "report",
    "--task",
    "task_abcdef0123456789abcdef01",
    "--kind",
    "milestone",
    "--summary",
    "子包 A 已提交",
  ]);
  assert.equal(report.ok, true, JSON.stringify(report));
  if (!report.ok) throw new Error(report.nextAction);
  assert.equal(report.command.method, "repo.task.run");
  assert.equal(report.command.action.kind, "runtime-report");
  assert.equal(report.command.action.taskId, "task_abcdef0123456789abcdef01");
  assert.equal(report.command.action.reportKind, "milestone");
  assert.equal(report.command.action.summary, "子包 A 已提交");

  const badKind = parseThinCommand([
    "runtime",
    "report",
    "--task",
    "task_abcdef0123456789abcdef01",
    "--kind",
    "unknown",
    "--summary",
    "x",
  ]);
  assert.equal(badKind.ok, false);

  const collect = parseThinCommand([
    "runtime",
    "collect",
    "task_abcdef0123456789abcdef01",
    "--since",
    "42",
    "--wait-event",
    "--timeout-ms",
    "5000",
  ]);
  assert.equal(collect.ok, true, JSON.stringify(collect));
  if (!collect.ok) throw new Error(collect.nextAction);
  assert.equal(collect.command.method, "repo.task.read");
  assert.equal(collect.command.action.kind, "runtime-collect");
  assert.equal(collect.command.action.taskId, "task_abcdef0123456789abcdef01");
  assert.equal(collect.command.action.since, 42);
  assert.equal(collect.command.action.waitEvent, true);
  assert.equal(collect.command.action.timeoutMs, 5000);

  const collectBySession = parseThinCommand(["runtime", "collect", "runtime_session1"]);
  assert.equal(collectBySession.ok, true, JSON.stringify(collectBySession));
  if (!collectBySession.ok) throw new Error(collectBySession.nextAction);
  assert.equal(collectBySession.command.action.runtimeSessionId, "runtime_session1");

  const statusCursor = parseThinCommand([
    "runtime",
    "status",
    "--limit",
    "64",
    "--cursor",
    "runtime-session:runtime_abc",
  ]);
  assert.equal(statusCursor.ok, true, JSON.stringify(statusCursor));
  if (!statusCursor.ok) throw new Error(statusCursor.nextAction);
  assert.equal(statusCursor.command.method, "repo.agentRuntime.overview");
  assert.equal(statusCursor.command.action.limit, 64);
  assert.equal(statusCursor.command.action.cursor, "runtime-session:runtime_abc");
});
