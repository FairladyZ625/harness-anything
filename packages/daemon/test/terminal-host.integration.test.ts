// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openTerminalHost } from "../src/terminal-host.ts";
import type { TmuxController } from "../src/terminal-tmux.ts";

test("daemon terminal host spawns, echoes, attaches, resizes, detaches, and terminates", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-terminal-"));
    try {
    const host = openTerminalHost({ repoId: "repo-a", rootDir: root, daemonGeneration: 7 });
    const spawned = host.spawn({ idempotencyKey: "terminal-test", backend: "direct-pty", cwd: { scope: "repo-root" }, shellProfileId: "default", name: "Test" });
    assert.equal(spawned.ok, true);
    const attached = host.attach(spawned.sessionId!, 0);
    assert.match(String(attached.initial.status), /attached|gap/u);
    assert.equal(host.resize({ sessionId: spawned.sessionId!, cols: 100, rows: 31 }).state, "running");
    assert.equal(host.input({ sessionId: spawned.sessionId!, clientSeq: 1, utf8: "echo __HA_PTY_OK__\r" }).acceptedThrough, 1);
    let output = "";
    for (let attempts = 0; attempts < 20 && !output.includes("__HA_PTY_OK__"); attempts += 1) {
      const frame = await Promise.race([attached.next(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
      if (frame?.kind === "output") output += String(frame.utf8);
    }
    assert.match(output, /__HA_PTY_OK__/u);
    assert.equal(host.detach({ sessionId: spawned.sessionId!, attachmentId: attached.initial.attachmentId as string }).state, "detached");
    assert.equal(host.terminate({ sessionId: spawned.sessionId!, confirmed: true }).state, "exited");
    await host.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trusted runtime auth terminal executes an exact non-platform fixture without exposing its launch spec", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-terminal-"));
  try {
    let data: ((value: string) => void) | undefined, exit: ((value: { readonly exitCode: number }) => void) | undefined, launch: { readonly file: string; readonly args: readonly string[]; readonly options: Record<string, unknown> } | undefined;
    const fakePty = { onData: (listener: (value: string) => void) => { data = listener; return { dispose: () => undefined }; }, onExit: (listener: (value: { readonly exitCode: number }) => void) => { exit = listener; return { dispose: () => undefined }; }, write: () => undefined, resize: () => undefined, kill: () => { exit?.({ exitCode: 0 }); } };
    const host = openTerminalHost({ repoId: "repo-a", rootDir: root, daemonGeneration: 8, spawnPty: ((file: string, args: readonly string[], options: Record<string, unknown>) => { launch = { file, args, options }; return fakePty; }) as never });
    const spawned = host.spawnTrusted({ idempotencyKey: "runtime-auth", name: "Codex Review · Sign in", executablePath: process.execPath, args: ["-e", "process.stdout.write(process.env.RUNTIME_AUTH_MARKER ?? 'missing')"], env: { PATH: process.env.PATH ?? "", RUNTIME_AUTH_MARKER: "AUTH_STUB_OK" }, cwd: root, publicCwd: "runtime-instance:codex-review", profile: "runtime-auth" });
    assert.equal(spawned.ok, true); assert.deepEqual(launch, { file: process.execPath, args: ["-e", "process.stdout.write(process.env.RUNTIME_AUTH_MARKER ?? 'missing')"], options: { name: "xterm-256color", cols: 80, rows: 24, cwd: root, env: { PATH: process.env.PATH ?? "", RUNTIME_AUTH_MARKER: "AUTH_STUB_OK", TERM: "xterm-256color" } } }); const attached = host.attach(spawned.sessionId!, 0); data?.("AUTH_STUB_OK"); const frame = await attached.next(); assert.equal(frame?.utf8, "AUTH_STUB_OK");
    const listed = JSON.stringify(host.list()); assert.match(listed, /runtime-instance:codex-review/u); assert.doesNotMatch(listed, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")); assert.doesNotMatch(listed, /RUNTIME_AUTH_MARKER/u); await host.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("windows terminals preserve SystemRoot and pass command shims to node-pty as one command line", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-terminal-windows-")), previousSystemRoot = process.env.SystemRoot;
  try {
    process.env.SystemRoot = "C:\\Windows";
    const launches: Array<{ readonly file: string; readonly args: readonly string[] | string; readonly options: Record<string, unknown> }> = [];
    const host = openTerminalHost({ repoId: "repo-windows", rootDir: root, daemonGeneration: 9, platform: "win32", spawnPty: ((file: string, args: readonly string[] | string, options: Record<string, unknown>) => { let exit: ((value: { readonly exitCode: number }) => void) | undefined; launches.push({ file, args, options }); return { onData: () => ({ dispose: () => undefined }), onExit: (listener: (value: { readonly exitCode: number }) => void) => { exit = listener; return { dispose: () => undefined }; }, write: () => undefined, resize: () => undefined, kill: () => { exit?.({ exitCode: 0 }); } }; }) as never });
    host.spawn({ idempotencyKey: "windows-shell", backend: "direct-pty", cwd: { scope: "repo-root" }, shellProfileId: "default", name: "Windows shell" });
    host.spawnTrusted({ idempotencyKey: "windows-auth", name: "Codex · Sign in", executablePath: "C:\\Program Files\\Codex\\codex.cmd", args: ["login"], env: { PATH: "C:\\Program Files\\Codex", COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, cwd: root, publicCwd: "runtime-instance:codex", profile: "runtime-auth" });
    assert.equal(launches[0]?.file, "powershell.exe"); assert.equal((launches[0]?.options.env as Record<string, unknown>).SystemRoot, "C:\\Windows");
    assert.equal(launches[1]?.file, "C:\\Windows\\System32\\cmd.exe"); assert.equal(launches[1]?.args, '/d /s /c ""C:\\Program Files\\Codex\\codex.cmd" login"');
    await host.close();
  } finally { if (previousSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previousSystemRoot; rmSync(root, { recursive: true, force: true }); }
});

test("a terminal child that exits on its own still gets its pty released on windows", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-terminal-selfexit-"));
  try {
    const kills: number[] = []; let alive = true; let exit: ((value: { readonly exitCode: number }) => void) | undefined;
    // kill() models node-pty's WindowsTerminal: it ends a live child and drives the conout worker
    // dispose; once the child has exited on its own the native kill is a no-op, so kill() must not
    // report another exit.
    const fakePty = { onData: () => ({ dispose: () => undefined }), onExit: (listener: (value: { readonly exitCode: number }) => void) => { exit = listener; return { dispose: () => undefined }; }, write: () => undefined, resize: () => undefined, kill: () => { kills.push(kills.length); if (alive) { alive = false; exit?.({ exitCode: 0 }); } } };
    const host = openTerminalHost({ repoId: "repo-b", rootDir: root, daemonGeneration: 9, platform: "win32", spawnPty: (() => fakePty) as never });
    const spawned = host.spawn({ idempotencyKey: "self-exit", backend: "direct-pty", cwd: { scope: "repo-root" }, shellProfileId: "default", name: "Self exit" });
    assert.equal(spawned.ok, true);
    alive = false; exit?.({ exitCode: 3 });
    assert.deepEqual(kills, [0], "natural exit must release the pty exactly once");
    const listed = JSON.stringify(host.list()); assert.match(listed, /"status":"exited"/u); assert.match(listed, /"exitCode":3/u);
    const attached = host.attach(spawned.sessionId!, 0); const frame = await attached.next(); assert.equal(frame?.kind, "exit");
    assert.throws(() => host.input({ sessionId: spawned.sessionId!, clientSeq: 1, utf8: "x" }), /Terminal session has exited\./u);
    assert.equal(host.terminate({ sessionId: spawned.sessionId!, confirmed: true }).state, "exited");
    await host.close();
    assert.deepEqual(kills, [0], "terminate and close after a natural exit must not kill again");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a terminal child that exits on its own is not killed again on posix", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-terminal-selfexit-posix-"));
  try {
    const kills: number[] = []; let exit: ((value: { readonly exitCode: number }) => void) | undefined;
    const fakePty = { onData: () => ({ dispose: () => undefined }), onExit: (listener: (value: { readonly exitCode: number }) => void) => { exit = listener; return { dispose: () => undefined }; }, write: () => undefined, resize: () => undefined, kill: () => { kills.push(kills.length); } };
    const host = openTerminalHost({ repoId: "repo-c", rootDir: root, daemonGeneration: 10, platform: "darwin", spawnPty: (() => fakePty) as never });
    const spawned = host.spawn({ idempotencyKey: "self-exit", backend: "direct-pty", cwd: { scope: "repo-root" }, shellProfileId: "default", name: "Self exit" });
    assert.equal(spawned.ok, true);
    exit?.({ exitCode: 0 });
    assert.deepEqual(kills, [], "posix exits release the pty on their own; no post-exit signal");
    assert.equal(host.terminate({ sessionId: spawned.sessionId!, confirmed: true }).state, "exited");
    await host.close();
    assert.deepEqual(kills, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("closing a running windows terminal does not kill it twice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-terminal-close-running-"));
  try {
    const kills: number[] = []; let exit: ((value: { readonly exitCode: number }) => void) | undefined;
    const fakePty = { onData: () => ({ dispose: () => undefined }), onExit: (listener: (value: { readonly exitCode: number }) => void) => { exit = listener; return { dispose: () => undefined }; }, write: () => undefined, resize: () => undefined, kill: () => { kills.push(kills.length); exit?.({ exitCode: 137 }); } };
    const host = openTerminalHost({ repoId: "repo-d", rootDir: root, daemonGeneration: 11, platform: "win32", spawnPty: (() => fakePty) as never });
    const spawned = host.spawn({ idempotencyKey: "close-running", backend: "direct-pty", cwd: { scope: "repo-root" }, shellProfileId: "default", name: "Close running" });
    assert.equal(spawned.ok, true);
    await host.close();
    assert.deepEqual(kills, [0], "close must release the pty exactly once");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("selecting TMUX spawns its exact command and confirmed terminate kills the durable session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-terminal-tmux-command-")), live = new Set<string>(), launches: RecordedLaunch[] = [], killed: string[] = [];
  try {
    const controller = fakeTmuxController(live, killed), host = openTerminalHost({ repoId: "repo-tmux", rootDir: root, daemonGeneration: 12, tmux: controller, spawnPty: recordingPtySpawner(launches, live) });
    const spawned = host.spawn({ idempotencyKey: "tmux-exact", backend: "tmux", cwd: { scope: "repo-root" }, shellProfileId: "zsh", name: "Durable" });
    assert.equal(spawned.state, "running");
    const namespace = Array.isArray(launches[0]?.args) ? String(launches[0].args[4]) : "";
    assert.deepEqual(launches[0], { file: "/test/tmux", args: ["-u", "new-session", "-A", "-s", namespace, "-c", root, "/bin/zsh"], cwd: root });
    const row = terminalRows(host)[0];
    assert.deepEqual(row && { requestedBackend: row.requestedBackend, backend: row.backend, durability: row.durability, warning: row.warning, attachable: row.attachable }, { requestedBackend: "tmux", backend: "tmux", durability: "daemon-restart", warning: null, attachable: true });
    assert.equal(host.terminate({ sessionId: spawned.sessionId!, confirmed: true }).state, "exited");
    assert.deepEqual(killed, [namespace]); assert.equal(live.size, 0);
    await host.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unavailable TMUX request visibly falls back to direct PTY", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-terminal-tmux-fallback-")), launches: RecordedLaunch[] = [];
  try {
    const unavailable: TmuxController = { probe: () => ({ available: false, reason: "fixture unavailable" }), hasSession: () => false, killSession: () => { throw new Error("unexpected kill"); } };
    const host = openTerminalHost({ repoId: "repo-fallback", rootDir: root, daemonGeneration: 13, tmux: unavailable, spawnPty: recordingPtySpawner(launches) });
    host.spawn({ idempotencyKey: "tmux-fallback", backend: "tmux", cwd: { scope: "repo-root" }, shellProfileId: "bash", name: "Fallback" });
    assert.equal(launches[0]?.file, "/bin/bash"); assert.deepEqual(launches[0]?.args, []);
    const row = terminalRows(host)[0];
    assert.deepEqual(row && { requestedBackend: row.requestedBackend, backend: row.backend, durability: row.durability, warning: row.warning }, { requestedBackend: "tmux", backend: "direct-pty", durability: "daemon-process", warning: "tmux-unavailable" });
    assert.equal(existsSync(path.join(root, ".harness", "generated", "terminal-sessions.json")), false, "fallback direct PTY must not claim durable registry state");
    await host.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a TMUX registry restores a live session and attach uses the existing namespace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-terminal-tmux-restore-")), live = new Set<string>(), killed: string[] = [], firstLaunches: RecordedLaunch[] = [], restoredLaunches: RecordedLaunch[] = [], registry = path.join(root, ".harness", "generated", "terminal-sessions.json");
  try {
    const controller = fakeTmuxController(live, killed), first = openTerminalHost({ repoId: "repo-restore", rootDir: root, daemonGeneration: 14, tmux: controller, spawnPty: recordingPtySpawner(firstLaunches, live) });
    const spawned = first.spawn({ idempotencyKey: "tmux-restore", backend: "tmux", cwd: { scope: "repo-root" }, shellProfileId: "zsh", name: "Restore me" }), namespace = Array.isArray(firstLaunches[0]?.args) ? String(firstLaunches[0].args[4]) : "";
    assert.equal(live.has(namespace), true); await first.close(); assert.equal(live.has(namespace), true, "daemon close must leave the TMUX server alive");
    assert.equal(statSync(registry).mode & 0o777, 0o600); assert.doesNotMatch(readFileSync(registry, "utf8"), /"(?:env|PATH|HOME|TERM|output)"/iu);

    const restored = openTerminalHost({ repoId: "repo-restore", rootDir: root, daemonGeneration: 15, tmux: controller, spawnPty: recordingPtySpawner(restoredLaunches, live) }), row = terminalRows(restored)[0];
    assert.deepEqual(row && { sessionId: row.sessionId, status: row.status, backend: row.backend, attachable: row.attachable }, { sessionId: spawned.sessionId, status: "running", backend: "tmux", attachable: true });
    const attachment = restored.attach(spawned.sessionId!, 0); assert.deepEqual(restoredLaunches[0], { file: "/test/tmux", args: ["-u", "attach-session", "-t", namespace], cwd: root });
    assert.equal(restored.detach({ sessionId: spawned.sessionId!, attachmentId: attachment.initial.attachmentId as string }).state, "detached");
    restored.terminate({ sessionId: spawned.sessionId!, confirmed: true }); assert.equal(live.has(namespace), false); assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")).sessions, []);
    await restored.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

interface RecordedLaunch { readonly file: string; readonly args: readonly string[] | string; readonly cwd: unknown }
function recordingPtySpawner(launches: RecordedLaunch[], live?: Set<string>): never {
  return ((file: string, args: readonly string[] | string, options: Record<string, unknown>) => {
    const argv = typeof args === "string" ? args : [...args]; launches.push({ file, args: argv, cwd: options.cwd });
    if (Array.isArray(argv) && argv.includes("new-session")) live?.add(String(argv[4]));
    let exit: ((value: { readonly exitCode: number }) => void) | undefined;
    return { onData: () => ({ dispose: () => undefined }), onExit: (listener: (value: { readonly exitCode: number }) => void) => { exit = listener; return { dispose: () => undefined }; }, write: () => undefined, resize: () => undefined, kill: () => { exit?.({ exitCode: 0 }); } };
  }) as never;
}
function fakeTmuxController(live: Set<string>, killed: string[]): TmuxController { return { probe: () => ({ available: true, executable: "/test/tmux", version: "tmux test" }), hasSession: (_executable, namespace) => live.has(namespace), killSession: (_executable, namespace) => { if (!live.delete(namespace)) throw new Error("tmux session is unavailable"); killed.push(namespace); } }; }
function terminalRows(host: ReturnType<typeof openTerminalHost>): readonly Record<string, unknown>[] { return (host.list().sessions ?? []) as readonly Record<string, unknown>[]; }
