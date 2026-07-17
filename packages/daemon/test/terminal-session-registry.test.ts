// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryTerminalSessionService, directPtyCapability, tmuxCapability } from "../src/index.ts";
import { classifyShellOutput } from "../../gui/src/terminal/boundary.ts";

test("terminal session registry creates lists gets attaches resizes and closes runtime metadata", () => {
  const service = createInMemoryTerminalSessionService({
    createId: sequence("term"),
    now: sequenceTime("2026-06-14T00:00:00.000Z"),
    scrollback: {
      maxBytes: 4096,
      replayMaxBytes: 1024,
      eviction: "drop-oldest"
    }
  });

  const created = service.createSession({
    name: "Task shell",
    backend: "direct-pty",
    hostLabel: "local",
    projectId: "project-a",
    taskId: "task-1",
    cwd: "/workspace",
    shell: "/bin/zsh"
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.session.sessionId, "term-1");
  assert.equal(created.session.status, "active");

  assert.deepEqual(service.listSessions(), { ok: true, sessions: [created.session] });
  assert.deepEqual(service.getSession({ sessionId: "term-1" }), { ok: true, session: created.session });

  const attached = service.attachSession({ sessionId: "term-1" });
  assert.equal(attached.ok, true);
  if (!attached.ok) return;
  assert.equal(attached.policy.displayOnly, true);
  assert.equal(attached.policy.outputCreatesTaskState, false);
  assert.equal(attached.policy.replayMaxBytes, 1024);

  const resized = service.resizeSession({ sessionId: "term-1", columns: 120, rows: 40 });
  assert.equal(resized.ok, true);
  if (!resized.ok) return;
  assert.equal(resized.session.status, "active");

  const closed = service.closeSession({ sessionId: "term-1" });
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.equal(closed.session.status, "exited");
  assert.equal(closed.session.exitCode, 0);
  assert.equal(service.attachSession({ sessionId: "term-1" }).ok, false);
});

test("terminal session detach is distinct from confirmed termination", () => {
  const service = createInMemoryTerminalSessionService({
    createId: sequence("term"),
    now: sequenceTime("2026-06-14T01:00:00.000Z")
  });

  const created = service.createSession({ name: "Detach test" });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const detached = service.detachSession({ sessionId: created.session.sessionId });
  assert.equal(detached.ok, true);
  if (!detached.ok) return;
  assert.equal(detached.session.status, "idle");
  assert.equal(detached.session.exitCode, undefined);

  const attached = service.attachSession({ sessionId: created.session.sessionId });
  assert.equal(attached.ok, true);
  if (!attached.ok) return;
  assert.equal(attached.session.status, "active");

  const refused = service.terminateSession({
    sessionId: created.session.sessionId,
    confirmation: "wrong" as "terminate-terminal-session"
  });
  assert.equal(refused.ok, false);
  assert.equal(service.getSession({ sessionId: created.session.sessionId }).ok, true);

  const terminated = service.terminateSession({
    sessionId: created.session.sessionId,
    confirmation: "terminate-terminal-session"
  });
  assert.equal(terminated.ok, true);
  if (!terminated.ok) return;
  assert.equal(terminated.session.status, "exited");
  assert.equal(terminated.session.attachable, false);
});

test("terminal session reopen creates a new session with inherited metadata", () => {
  const service = createInMemoryTerminalSessionService({
    createId: sequence("term"),
    now: sequenceTime("2026-06-14T02:00:00.000Z")
  });
  const created = service.createSession({
    name: "Reusable shell",
    backend: "direct-pty",
    hostLabel: "local",
    projectId: "project-a",
    taskId: "task-1",
    cwd: "/workspace",
    shell: "/bin/zsh"
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  assert.equal(service.createSession({ reopenOfSessionId: created.session.sessionId }).ok, false);
  const closed = service.closeSession({ sessionId: created.session.sessionId });
  assert.equal(closed.ok, true);
  if (!closed.ok) return;

  const reopened = service.createSession({ reopenOfSessionId: created.session.sessionId });
  assert.equal(reopened.ok, true);
  if (!reopened.ok) return;
  assert.equal(reopened.session.sessionId, "term-2");
  assert.equal(reopened.session.name, "Reusable shell");
  assert.equal(reopened.session.cwd, "/workspace");
  assert.equal(reopened.session.taskId, "task-1");
  assert.equal(reopened.session.status, "active");
  assert.equal(reopened.session.exitCode, undefined);
});

test("terminal session registry selects backend through registered capabilities", () => {
  const service = createInMemoryTerminalSessionService({
    createId: sequence("term"),
    now: sequenceTime("2026-06-14T03:00:00.000Z"),
    defaultBackend: "tmux",
    backendCapabilities: [directPtyCapability(), tmuxCapability({ available: true, version: "tmux 3.4" })]
  });

  const created = service.createSession({ name: "Durable shell" });

  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.session.backend, "tmux");
});

test("terminal session registry fails closed when requested backend is unavailable and fallback is disabled", () => {
  const service = createInMemoryTerminalSessionService({
    createId: sequence("term"),
    now: sequenceTime("2026-06-14T04:00:00.000Z"),
    backendCapabilities: [directPtyCapability(), tmuxCapability({ available: false, reason: "tmux binary not found" })],
    allowDirectPtyFallback: false
  });

  const created = service.createSession({ name: "Strict durable shell", backend: "tmux" });

  assert.deepEqual(created, {
    ok: false,
    error: {
      code: "terminal_backend_unavailable",
      hint: "tmux binary not found"
    }
  });
});

test("terminal session registry reports non-durable fallback when requested tmux is unavailable", () => {
  const service = createInMemoryTerminalSessionService({
    createId: sequence("term"),
    now: sequenceTime("2026-06-14T05:00:00.000Z"),
    backendCapabilities: [directPtyCapability(), tmuxCapability({ available: false, reason: "tmux binary not found" })]
  });

  const created = service.createSession({ name: "Fallback shell", backend: "tmux" });

  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.session.backend, "direct-pty");
  assert.deepEqual(created.session.backendWarnings, [
    {
      code: "terminal_backend_downgraded_non_durable",
      requestedBackend: "tmux",
      selectedBackend: "direct-pty",
      hint: "tmux binary not found"
    }
  ]);
});

test("shell chunks remain display-only", () => {
  const chunk = classifyShellOutput("task status done");

  assert.deepEqual(chunk, {
    displayOnly: true,
    stateChange: false
  });
});

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function sequenceTime(start: string): () => string {
  let value = Date.parse(start);
  return () => {
    const current = new Date(value).toISOString();
    value += 1000;
    return current;
  };
}
