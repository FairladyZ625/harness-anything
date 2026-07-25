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
        assert.deepEqual(args, ["-u", "attach-session", "-t", createdNamespace]);
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

test("close reports a PTY kill failure without inventing exit zero", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-pty-close-"));
  const fake = fakePty({ killError: new Error("PTY kill unavailable") });
  try {
    const service = createPtyTerminalSessionService({
      workspaceRoot,
      createId: () => "term-close-failure",
      spawnPty: () => fake.pty
    });
    assert.equal(service.createSession({ name: "Close failure", backend: "direct-pty" }).ok, true);

    assert.deepEqual(service.closeSession({ sessionId: "term-close-failure" }), {
      ok: false,
      error: {
        code: "terminal_termination_failed",
        hint: "PTY kill unavailable"
      }
    });
    const retained = service.getSession({ sessionId: "term-close-failure" });
    assert.equal(retained.ok, true);
    if (!retained.ok) return;
    assert.equal(retained.session.status, "active");
    assert.equal(retained.session.exitCode, undefined);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("close persists exit zero after the PTY kill succeeds", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-pty-close-"));
  try {
    const service = createPtyTerminalSessionService({
      workspaceRoot,
      createId: () => "term-close-success",
      spawnPty: () => fakePty().pty
    });
    assert.equal(service.createSession({ name: "Close success", backend: "direct-pty" }).ok, true);

    const closed = service.closeSession({ sessionId: "term-close-success" });
    assert.equal(closed.ok, true);
    if (!closed.ok) return;
    assert.equal(closed.session.status, "exited");
    assert.equal(closed.session.exitCode, 0);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("explicit termination reports a PTY kill failure without inventing exit zero", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-pty-terminate-"));
  const fake = fakePty({ killError: new Error("PTY kill unavailable") });
  try {
    const service = createPtyTerminalSessionService({
      workspaceRoot,
      createId: () => "term-terminate-failure",
      spawnPty: () => fake.pty
    });
    assert.equal(service.createSession({ name: "Terminate failure", backend: "direct-pty" }).ok, true);

    assert.deepEqual(service.terminateSession({
      sessionId: "term-terminate-failure",
      confirmation: "terminate-terminal-session"
    }), {
      ok: false,
      error: {
        code: "terminal_termination_failed",
        hint: "PTY kill unavailable"
      }
    });
    const retained = service.getSession({ sessionId: "term-terminate-failure" });
    assert.equal(retained.ok, true);
    if (!retained.ok) return;
    assert.equal(retained.session.status, "active");
    assert.equal(retained.session.exitCode, undefined);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("tmux termination failure keeps the namespace available for a retry", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-tmux-close-"));
  const fake = fakePty();
  let failKill = true;
  let killAttempts = 0;
  const controller = {
    probe: () => ({ available: true, executable: "tmux", version: "tmux 3.4" }),
    hasSession: () => true,
    killSession: () => {
      killAttempts += 1;
      if (failKill) throw new Error("tmux kill unavailable");
    }
  };
  try {
    const service = createPtyTerminalSessionService({
      workspaceRoot,
      tmux: controller,
      createId: () => "term-tmux-close-failure",
      spawnPty: () => fake.pty
    });
    assert.equal(service.createSession({ name: "Tmux close failure" }).ok, true);

    assert.deepEqual(service.terminateSession({
      sessionId: "term-tmux-close-failure",
      confirmation: "terminate-terminal-session"
    }), {
      ok: false,
      error: {
        code: "terminal_termination_failed",
        hint: "tmux kill unavailable"
      }
    });
    assert.equal(killAttempts, 1);
    const retained = service.getSession({ sessionId: "term-tmux-close-failure" });
    assert.equal(retained.ok, true);
    if (!retained.ok) return;
    assert.notEqual(retained.session.status, "exited");
    assert.equal(retained.session.exitCode, undefined);

    failKill = false;
    const retried = service.terminateSession({
      sessionId: "term-tmux-close-failure",
      confirmation: "terminate-terminal-session"
    });
    assert.equal(retried.ok, true);
    assert.equal(killAttempts, 2);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("terminal children get a UTF-8 ctype and tmux runs in UTF-8 mode", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-pty-utf8-"));
  const controller = {
    probe: () => ({ available: true, executable: "tmux", version: "tmux 3.4" }),
    hasSession: () => true,
    killSession: () => undefined
  };
  try {
    const spawns: Array<{ readonly args: ReadonlyArray<string>; readonly env: Record<string, string> }> = [];
    const service = createPtyTerminalSessionService({
      workspaceRoot,
      tmux: controller,
      env: { PATH: process.env.PATH ?? "", LANG: "", LC_CTYPE: "C" },
      createId: () => "term-utf8",
      spawnPty: (_command, args, options) => {
        spawns.push({ args, env: options.env });
        return fakePty().pty;
      }
    });
    assert.equal(service.createSession({ name: "Locale" }).ok, true);
    // `tmux -u` renders wide characters even when the daemon inherited no locale at all.
    assert.equal(spawns[0]?.args[0], "-u");
    assert.equal(spawns[0]?.env.LC_CTYPE, "C.UTF-8");

    const utf8Inherited = createPtyTerminalSessionService({
      workspaceRoot,
      tmux: controller,
      env: { PATH: process.env.PATH ?? "", LANG: "zh_CN.UTF-8" },
      createId: () => "term-utf8-inherited",
      spawnPty: (_command, args, options) => {
        spawns.push({ args, env: options.env });
        return fakePty().pty;
      }
    });
    assert.equal(utf8Inherited.createSession({ name: "Locale inherited" }).ok, true);
    assert.equal(spawns[1]?.env.LC_CTYPE, undefined);
    assert.equal(spawns[1]?.env.LANG, "zh_CN.UTF-8");
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

function fakePty(options: { readonly killError?: Error } = {}) {
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
    kill: () => {
      if (options.killError) throw options.killError;
      exitListener?.({ exitCode: 0, signal: 0 });
    },
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
