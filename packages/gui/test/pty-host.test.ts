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
      env: { SHELL: "/bin/sh", PATH: process.env.PATH },
      createId: () => "term-real",
      spawnPty: (shell, _args, options) => {
        spawnContext = { shell, options };
        return fake.pty;
      }
    });

    const created = service.createSession({ name: "Project shell" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.session.cwd, realpathSync(workspaceRoot));
    assert.equal(spawnContext?.shell, "/bin/sh");
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
