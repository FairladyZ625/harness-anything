// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { IPty, IExitEvent } from "node-pty";
import { createPtyTerminalSessionService, resolveTerminalCwd, type PtySpawnOptions } from "../src/terminal/pty-host.ts";

test("pty host spawns at the project root and streams input output resize and exit", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-pty-host-"));
  const fake = fakePty();
  let spawnContext: { readonly shell: string; readonly options: PtySpawnOptions } | undefined;
  try {
    const service = createPtyTerminalSessionService({
      workspaceRoot,
      env: { PATH: process.env.PATH },
      createId: () => "term-real",
      spawnPty: (shell, _args, options) => {
        spawnContext = { shell, options };
        return fake.pty;
      }
    });

    const created = service.createSession({ name: "Project shell", shell: process.execPath });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.session.cwd, realpathSync(workspaceRoot));
    assert.equal(created.session.backend, "direct-pty");
    assert.equal(created.session.degraded, true);
    assert.equal(created.session.durability, "none");
    assert.equal(spawnContext?.shell, process.execPath);
    assert.equal(spawnContext?.options.cwd, realpathSync(workspaceRoot));

    fake.emitData("ready\r\n");
    const output = await service.readSession({ sessionId: created.session.sessionId, cursor: 0, timeoutMs: 0 });
    assert.equal(output.ok, true);
    if (!output.ok) return;
    assert.deepEqual(output.events, [{ kind: "data", sequence: 1, data: "ready\r\n" }]);

    assert.equal(service.writeSession({ sessionId: created.session.sessionId, data: "pwd\r" }).ok, true);
    assert.deepEqual(fake.writes, ["pwd\r"]);
    assert.equal(service.resizeSession({ sessionId: created.session.sessionId, columns: 132, rows: 42 }).ok, true);
    assert.deepEqual(fake.resizes, [{ columns: 132, rows: 42 }]);

    fake.emitExit({ exitCode: 7, signal: 0 });
    const exited = await service.readSession({ sessionId: created.session.sessionId, cursor: output.nextCursor, timeoutMs: 0 });
    assert.equal(exited.ok, true);
    if (!exited.ok) return;
    assert.deepEqual(exited.events, [{ kind: "exit", sequence: 2, exitCode: 7, signal: 0 }]);
    assert.equal(exited.session.status, "exited");
    assert.equal(exited.session.exitCode, 7);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("daemon registry restores a durable tmux session and reattaches without respawn-as-resume", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-tmux-host-"));
  const namespaceState = new Set<string>();
  const controller = {
    probe: () => ({ available: true, executable: "tmux", version: "tmux 3.4" }),
    hasSession: (_executable: string, namespace: string) => namespaceState.has(namespace),
    killSession: (_executable: string, namespace: string) => { namespaceState.delete(namespace); }
  };
  try {
    const firstPty = fakePty();
    let createdNamespace = "";
    const first = createPtyTerminalSessionService({
      workspaceRoot,
      tmux: controller,
      createId: () => "term-durable",
      spawnPty: (command, args) => {
        assert.equal(command, "tmux");
        createdNamespace = String(args[args.indexOf("-s") + 1]);
        namespaceState.add(createdNamespace);
        return firstPty.pty;
      }
    });
    const created = first.createSession({ name: "Durable" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.session.backend, "tmux");
    assert.equal(created.session.durability, "daemon-restart");
    assert.equal(created.session.degraded, false);

    const attachedPty = fakePty();
    const second = createPtyTerminalSessionService({
      workspaceRoot,
      tmux: controller,
      spawnPty: (command, args) => {
        assert.equal(command, "tmux");
        assert.deepEqual(args, ["attach-session", "-t", createdNamespace]);
        return attachedPty.pty;
      }
    });
    const restored = second.listSessions();
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.sessions[0]?.status, "idle");
    assert.equal(restored.sessions[0]?.attachable, true);
    assert.equal(second.attachSession({ sessionId: "term-durable" }).ok, true);
    assert.deepEqual(second.terminateSession({
      sessionId: "term-durable",
      confirmation: "terminate-terminal-session"
    }).ok, true);
    assert.equal(namespaceState.size, 0);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("daemon restart marks direct-pty metadata unknown instead of inventing a live channel", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-direct-restart-"));
  try {
    const first = createPtyTerminalSessionService({
      workspaceRoot,
      createId: () => "term-direct",
      spawnPty: () => fakePty().pty
    });
    assert.equal(first.createSession({ name: "Ephemeral", backend: "direct-pty" }).ok, true);
    const second = createPtyTerminalSessionService({ workspaceRoot, spawnPty: () => fakePty().pty });
    const restored = second.getSession({ sessionId: "term-direct" });
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.session.status, "unknown");
    assert.equal(restored.session.attachable, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("pty host allows project subdirectories and rejects cwd escapes", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-pty-cwd-"));
  try {
    mkdirSync(path.join(workspaceRoot, "packages"));
    assert.equal(resolveTerminalCwd(workspaceRoot, "packages"), realpathSync(path.join(workspaceRoot, "packages")));
    assert.throws(() => resolveTerminalCwd(workspaceRoot, ".."), /project root or a directory inside it/u);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function fakePty() {
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: ((event: IExitEvent) => void) | undefined;
  const writes: string[] = [];
  const resizes: Array<{ readonly columns: number; readonly rows: number }> = [];
  const pty = {
    pid: 123,
    process: "/bin/sh",
    cols: 80,
    rows: 24,
    write: (data: string) => writes.push(data),
    resize: (columns: number, rows: number) => resizes.push({ columns, rows }),
    clear: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    kill: () => exitListener?.({ exitCode: 0, signal: 0 }),
    onData: (listener: (data: string) => void) => {
      dataListener = listener;
      return { dispose: () => { dataListener = undefined; } };
    },
    onExit: (listener: (event: IExitEvent) => void) => {
      exitListener = listener;
      return { dispose: () => { exitListener = undefined; } };
    }
  } as unknown as IPty;
  return {
    pty,
    writes,
    resizes,
    emitData: (data: string) => dataListener?.(data),
    emitExit: (event: IExitEvent) => exitListener?.(event)
  };
}
