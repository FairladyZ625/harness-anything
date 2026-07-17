// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryTerminalBackendController,
  createTerminalBackendNamespace,
  directPtyCapability,
  remoteCapability,
  selectTerminalBackend,
  tmuxCapability
} from "../src/index.ts";
import type { TerminalSessionInfo } from "../src/index.ts";

test("terminal backend selection uses tmux only with capability evidence", () => {
  const selected = selectTerminalBackend({
    requestedBackend: "tmux",
    capabilities: [directPtyCapability(), tmuxCapability({ available: true, version: "tmux 3.4" })]
  });

  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.equal(selected.backend, "tmux");
  assert.equal(selected.capability.version, "tmux 3.4");
  assert.equal(selected.durableAcrossDaemonRestart, true);
  assert.deepEqual(selected.warnings, []);
});

test("terminal backend selection downgrades unavailable tmux with explicit non-durable warning", () => {
  const selected = selectTerminalBackend({
    requestedBackend: "tmux",
    capabilities: [directPtyCapability(), tmuxCapability({ available: false, reason: "tmux binary not found" })]
  });

  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.equal(selected.backend, "direct-pty");
  assert.equal(selected.durableAcrossDaemonRestart, false);
  assert.deepEqual(selected.warnings, [
    {
      code: "terminal_backend_downgraded_non_durable",
      requestedBackend: "tmux",
      selectedBackend: "direct-pty",
      hint: "tmux binary not found"
    }
  ]);
});

test("terminal backend selection does not silently fallback remote ownership", () => {
  const selected = selectTerminalBackend({
    requestedBackend: "remote",
    capabilities: [directPtyCapability(), remoteCapability({ available: false, reason: "remote daemon is not connected" })]
  });

  assert.deepEqual(selected, {
    ok: false,
    error: {
      code: "terminal_backend_unavailable",
      hint: "remote daemon is not connected"
    }
  });
});

test("terminal backend namespace is deterministic and separates project task contexts", () => {
  const left = createTerminalBackendNamespace({
    sessionId: "Term 01",
    hostProfileId: "local",
    projectId: "project-a",
    taskId: "task-1",
    cwd: "/workspace"
  });
  const same = createTerminalBackendNamespace({
    sessionId: "Term 01",
    hostProfileId: "local",
    projectId: "project-a",
    taskId: "task-1",
    cwd: "/workspace"
  });
  const right = createTerminalBackendNamespace({
    sessionId: "Term 01",
    hostProfileId: "local",
    projectId: "project-a",
    taskId: "task-2",
    cwd: "/workspace"
  });

  assert.deepEqual(left, same);
  assert.notEqual(left.namespace, right.namespace);
  assert.match(left.namespace, /^ha-[a-z0-9]+-term-01$/);
});

test("tmux backend resources detach and resume across daemon restart", () => {
  const controller = createInMemoryTerminalBackendController();
  const selection = selectTerminalBackend({
    requestedBackend: "tmux",
    capabilities: [directPtyCapability(), tmuxCapability({ available: true })]
  });
  assert.equal(selection.ok, true);
  if (!selection.ok) return;

  const created = controller.createResource({
    session: session({ sessionId: "term-1", backend: "tmux" }),
    selection,
    namespace: createTerminalBackendNamespace({ sessionId: "term-1", projectId: "project-a", taskId: "task-1" })
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const detached = controller.detachResourceView("term-1");
  assert.equal(detached.ok, true);
  if (!detached.ok) return;
  assert.equal(detached.resource.status, "detached");

  controller.simulateDaemonRestart();

  const resumed = controller.resumeResource("term-1");
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.resource.resourceId, created.resource.resourceId);
  assert.equal(resumed.resource.status, "attached");
  assert.equal(resumed.resource.durability, "daemon-restart");
});

test("backend resources reject session and selection backend drift", () => {
  const controller = createInMemoryTerminalBackendController();
  const selection = selectTerminalBackend({
    requestedBackend: "tmux",
    capabilities: [directPtyCapability(), tmuxCapability({ available: true })]
  });
  assert.equal(selection.ok, true);
  if (!selection.ok) return;

  assert.deepEqual(
    controller.createResource({
      session: session({ sessionId: "term-mismatch", backend: "direct-pty" }),
      selection,
      namespace: createTerminalBackendNamespace({ sessionId: "term-mismatch", projectId: "project-a" })
    }),
    {
      ok: false,
      error: {
        code: "terminal_backend_mismatch",
        hint: "Terminal session backend direct-pty does not match selected backend tmux."
      }
    }
  );
});

test("direct-pty backend resources are explicitly non-durable across daemon restart", () => {
  const controller = createInMemoryTerminalBackendController();
  const selection = selectTerminalBackend({
    requestedBackend: "direct-pty",
    capabilities: [directPtyCapability()]
  });
  assert.equal(selection.ok, true);
  if (!selection.ok) return;

  const created = controller.createResource({
    session: session({ sessionId: "term-2", backend: "direct-pty" }),
    selection,
    namespace: createTerminalBackendNamespace({ sessionId: "term-2", projectId: "project-a" })
  });
  assert.equal(created.ok, true);

  controller.simulateDaemonRestart();

  assert.deepEqual(controller.resumeResource("term-2"), {
    ok: false,
    error: {
      code: "terminal_backend_resource_closed",
      hint: "daemon-restart-non-durable-backend"
    }
  });
});

test("explicit close releases durable backend resource while pane detach does not", () => {
  const controller = createInMemoryTerminalBackendController();
  const selection = selectTerminalBackend({
    requestedBackend: "tmux",
    capabilities: [directPtyCapability(), tmuxCapability({ available: true })]
  });
  assert.equal(selection.ok, true);
  if (!selection.ok) return;

  controller.createResource({
    session: session({ sessionId: "term-3", backend: "tmux" }),
    selection,
    namespace: createTerminalBackendNamespace({ sessionId: "term-3", projectId: "project-a" })
  });
  assert.equal(controller.detachResourceView("term-3").ok, true);
  assert.equal(controller.resumeResource("term-3").ok, true);

  const closed = controller.closeResource("term-3");
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.equal(closed.resource.status, "closed");
  assert.equal(controller.resumeResource("term-3").ok, false);
});

function session(overrides: Pick<TerminalSessionInfo, "sessionId" | "backend">): TerminalSessionInfo {
  return {
    sessionId: overrides.sessionId,
    name: "Task shell",
    backend: overrides.backend,
    durability: overrides.backend === "tmux" ? "daemon-restart" : "none",
    degraded: false,
    status: "active",
    attachable: true,
    hostLabel: "local",
    projectId: "project-a",
    taskId: "task-1",
    cwd: "/workspace",
    shell: "/bin/zsh",
    createdAt: "2026-06-14T00:00:00.000Z",
    lastActivityAt: "2026-06-14T00:00:00.000Z"
  };
}
