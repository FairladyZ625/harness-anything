// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detachedProcessOptions } from "../../daemon/src/process-port.ts";
import { runGuiLaunch, type GuiLaunchDependencies } from "../src/daemon/control.ts";
import { emit } from "../src/index.ts";

test("daemon process port hides detached startup windows", () => {
  assert.deepEqual(detachedProcessOptions, { detached: true, stdio: "ignore", windowsHide: true });
});

test("daemon-missing write rejects without autostart or local fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-no-daemon-"));
  try { const started = performance.now(), result = spawnSync(process.execPath,
    [path.resolve("packages/cli/src/index.ts"), "--root", root, "--json", "task", "create", "--title", "No daemon"],
    { encoding: "utf8", env: { ...process.env, HOME: path.join(root, ".home"), HARNESS_DAEMON_USER_ROOT: path.join(root, "user") } });
    const elapsedMs = performance.now() - started, receipt = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    assert.notEqual(result.status, 0); assert.equal(receipt.ok, false); assert.equal(receipt.error.code, "daemon_unavailable");
    assert.equal(existsSync(path.join(root, "harness")), false); assert.equal(existsSync(path.join(root, ".harness")), false);
    assert.equal(existsSync(path.join(root, "user", "daemon-default.pid")), false, "an unregistered workspace must not launch a daemon");
    assert.equal(elapsedMs < 250, true, `source-mode diagnostic ${elapsedMs.toFixed(3)}ms`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daemon-missing doc submit is explicitly rejected without a local Git or scan fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-no-doc-daemon-"));
  try { const result = spawnSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "--root", root, "--json", "doc", "sync", "--submit",
    "--execution-id", "exec-1", "--path", "tasks/task-1-one/notes.md"],
  { encoding: "utf8", env: { ...process.env, HOME: path.join(root, ".home"), HARNESS_DAEMON_USER_ROOT: path.join(root, "user") } });
    const receipt = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } }; assert.notEqual(result.status, 0);
    assert.equal(receipt.ok, false); assert.equal(receipt.error.code, "daemon_unavailable");
    assert.equal(existsSync(path.join(root, "harness")), false); assert.equal(existsSync(path.join(root, ".harness")), false);
    assert.equal(existsSync(path.join(root, "user", "daemon-default.pid")), false, "an unregistered workspace must not launch a daemon");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daemon-missing preset run rejects promptly without child or direct fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-no-preset-daemon-"));
  try { const started = performance.now(), result = spawnSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "--root", root, "--json", "script", "run", "preset:user-canary/check", "--idempotency-key", "once", "--inputs", "{}"], { encoding: "utf8", env: { ...process.env, HOME: path.join(root, ".home"), HARNESS_DAEMON_USER_ROOT: path.join(root, "user") } }), receipt = JSON.parse(result.stdout) as { error: { code: string } }; assert.notEqual(result.status, 0); assert.equal(receipt.error.code, "daemon_unavailable"); assert.equal(performance.now() - started < 1_000, true); assert.equal(existsSync(path.join(root, ".harness")), false); assert.equal(existsSync(path.join(root, "user", "daemon-default.pid")), false, "an unregistered workspace must not launch a daemon"); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("GUI launch reports a missing Electron binary with a next action", () => {
  const fixture = makeGuiFixture(false);
  try {
    const output = captureGuiOutput(() => runGuiLaunch(["gui", "--json"], { workspaceRoot: fixture.root, resolveElectronBinary: () => undefined }, emit));
    const receipt = JSON.parse(output.stdout) as { ok: boolean; code: string; error: { code: string; hint: string } };
    assert.equal(output.status, 1); assert.equal(receipt.ok, false); assert.equal(receipt.code, "electron_unavailable");
    assert.equal(receipt.error.code, "electron_unavailable"); assert.match(receipt.error.hint, /electron\/install\.js/u);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("GUI launch reports a missing renderer dist with the build command", () => {
  const fixture = makeGuiFixture(true);
  try {
    const output = captureGuiOutput(() => runGuiLaunch(["gui", "--json"], { workspaceRoot: fixture.root, resolveElectronBinary: () => "/electron" }, emit));
    const receipt = JSON.parse(output.stdout) as { ok: boolean; code: string; error: { code: string; hint: string } };
    assert.equal(output.status, 1); assert.equal(receipt.ok, false); assert.equal(receipt.code, "gui_dist_missing");
    assert.equal(receipt.error.code, "gui_dist_missing"); assert.match(receipt.error.hint, /npm run build -w @harness-anything\/gui/u);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("GUI launch refuses a built renderer whose preload bundle is missing", () => {
  const fixture = makeGuiFixture(true);
  try {
    writeFileSync(path.join(fixture.root, "packages/gui/dist/index.html"), "<!doctype html>\n");
    const output = captureGuiOutput(() => runGuiLaunch(["gui", "--json"], { workspaceRoot: fixture.root, resolveElectronBinary: () => "/electron", spawnProcess: () => { throw new Error("a GUI without its preload bridge must never be launched"); } }, emit));
    const receipt = JSON.parse(output.stdout) as { ok: boolean; code: string; error: { code: string; hint: string } };
    assert.equal(output.status, 1); assert.equal(receipt.ok, false); assert.equal(receipt.code, "gui_preload_missing");
    assert.match(receipt.error.hint, /npm run build:preload -w @harness-anything\/gui/u);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("GUI launch starts the packaged Electron entry detached and without a dev renderer", () => {
  const fixture = makeGuiFixture(true), calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
  try {
    writeFileSync(path.join(fixture.root, "packages/gui/dist/index.html"), "<!doctype html>\n"); writeFileSync(path.join(fixture.root, "packages/gui/dist-electron/electron-preload.cjs"), "\n");
    process.env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5173"; process.env.ELECTRON_RUN_AS_NODE = "1";
    let unrefs = 0;
    const output = captureGuiOutput(() => runGuiLaunch(["gui", "--json"], {
      workspaceRoot: fixture.root,
      resolveElectronBinary: () => "/electron",
      spawnProcess: (command, args, options) => {
        void command; calls.push({ args, options: options as Record<string, unknown> });
        return { pid: 42, on() {}, unref() { unrefs += 1; } } as unknown as ReturnType<NonNullable<GuiLaunchDependencies["spawnProcess"]>>;
      }
    }, emit));
    const receipt = JSON.parse(output.stdout) as { ok: boolean; pid: number };
    assert.equal(output.status, 0); assert.equal(receipt.ok, true); assert.equal(receipt.pid, 42);
    assert.deepEqual(calls[0]?.args, [path.join(fixture.root, "packages/gui/src/main/electron-main.ts")]);
    assert.equal(calls[0]?.options.detached, true); assert.equal(calls[0]?.options.stdio, "ignore"); assert.equal(calls[0]?.options.windowsHide, true);
    assert.equal(calls[0]?.options.cwd, fixture.root, "the shell must run from the workspace it was resolved against");
    assert.equal(unrefs, 1, "a detached launch must be unreferenced or the CLI never exits");
    const spawnedEnv = calls[0]?.options.env as NodeJS.ProcessEnv;
    assert.equal(spawnedEnv.ELECTRON_RENDERER_URL, undefined, "the dev renderer origin must not survive into a packaged launch");
    assert.equal(spawnedEnv.ELECTRON_RUN_AS_NODE, undefined, "node mode would start the main process without a window");
    assert.equal(spawnedEnv.HARNESS_GUI_ROOT, process.cwd(), "the shell must be told which workspace to open");
  } finally { delete process.env.ELECTRON_RENDERER_URL; delete process.env.ELECTRON_RUN_AS_NODE; rmSync(fixture.root, { recursive: true, force: true }); }
});

test("GUI launch rejects when the spawned Electron never yields a pid", () => {
  const fixture = makeGuiFixture(true);
  try {
    writeFileSync(path.join(fixture.root, "packages/gui/dist/index.html"), "<!doctype html>\n"); writeFileSync(path.join(fixture.root, "packages/gui/dist-electron/electron-preload.cjs"), "\n");
    // spawn surfaces a missing or unusable binary asynchronously, so it never throws here; an
    // absent pid is the only synchronous witness, and reporting ok would hand back a dead GUI.
    const output = captureGuiOutput(() => runGuiLaunch(["gui", "--json"], { workspaceRoot: fixture.root, resolveElectronBinary: () => "/nonexistent-electron",
      spawnProcess: () => ({ pid: undefined, on() {}, unref() {} }) as unknown as ReturnType<NonNullable<GuiLaunchDependencies["spawnProcess"]>> }, emit));
    const receipt = JSON.parse(output.stdout) as { ok: boolean; code: string };
    assert.equal(output.status, 1); assert.equal(receipt.ok, false); assert.equal(receipt.code, "gui_launch_failed");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("the gui command reaches the launcher through the CLI entry", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-route-"));
  try { const result = spawnSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "gui", "--json"], { encoding: "utf8", cwd: root, env: { ...process.env, HOME: path.join(root, ".home") } });
    const receipt = JSON.parse(result.stdout) as { command: string };
    assert.equal(receipt.command, "gui", "argv routing must reach the launcher, not the daemon command parser");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function makeGuiFixture(withDist: boolean): { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-launch-"));
  mkdirSync(path.join(root, "packages/gui/src/main"), { recursive: true });
  if (withDist) { mkdirSync(path.join(root, "packages/gui/dist"), { recursive: true }); mkdirSync(path.join(root, "packages/gui/dist-electron"), { recursive: true }); }
  return { root };
}

function captureGuiOutput(run: () => number): { status: number; stdout: string; stderr: string } {
  const stdout: string[] = [], stderr: string[] = [], log = console.log, error = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.join(" ")); console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try { return { status: run(), stdout: stdout.join("\n"), stderr: stderr.join("\n") }; }
  finally { console.log = log; console.error = error; }
}
