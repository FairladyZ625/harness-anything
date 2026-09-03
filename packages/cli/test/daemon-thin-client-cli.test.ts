// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detachedProcessOptions } from "../../daemon/src/process-port.ts";
import { runGuiLaunch, type GuiLaunchDependencies } from "../src/cli/gui-launch.ts";
import { emit } from "../src/index.ts";

test("daemon process port hides detached startup windows", () => {
  assert.deepEqual(detachedProcessOptions, { detached: true, stdio: "ignore", windowsHide: true });
});

test("daemon-missing write rejects without autostart or local fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-no-daemon-"));
  try {
    // The pid/dir assertions prove that rejection does not autostart. Timing is observed by
    // the nightly daemon soak lane because scheduler load makes a PR wall-clock verdict flaky.
    const result = spawnSync(
      process.execPath,
      [path.resolve("packages/cli/src/index.ts"), "--root", root, "--json", "task", "create", "--title", "No daemon"],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: path.join(root, ".home"), HARNESS_DAEMON_USER_ROOT: path.join(root, "user") },
      },
    );
    const receipt = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    assert.notEqual(result.status, 0);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, "daemon_unavailable");
    assert.equal(existsSync(path.join(root, "harness")), false);
    assert.equal(existsSync(path.join(root, ".harness")), false);
    assert.equal(
      existsSync(path.join(root, "user", "daemon-default.pid")),
      false,
      "an unregistered workspace must not launch a daemon",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon-missing doc submit is explicitly rejected without a local Git or scan fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-no-doc-daemon-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("packages/cli/src/index.ts"),
        "--root",
        root,
        "--json",
        "doc",
        "sync",
        "--submit",
        "--task",
        "task-1",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: path.join(root, ".home"), HARNESS_DAEMON_USER_ROOT: path.join(root, "user") },
      },
    );
    const receipt = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    assert.notEqual(result.status, 0);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, "daemon_unavailable");
    assert.equal(existsSync(path.join(root, "harness")), false);
    assert.equal(existsSync(path.join(root, ".harness")), false);
    assert.equal(
      existsSync(path.join(root, "user", "daemon-default.pid")),
      false,
      "an unregistered workspace must not launch a daemon",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon-missing preset run rejects promptly without child or direct fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-no-preset-daemon-"));
  try {
    const result = spawnSync(
        process.execPath,
        [
          path.resolve("packages/cli/src/index.ts"),
          "--root",
          root,
          "--json",
          "script",
          "run",
          "preset:user-canary/check",
          "--idempotency-key",
          "once",
          "--inputs",
          "{}",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: path.join(root, ".home"), HARNESS_DAEMON_USER_ROOT: path.join(root, "user") },
        },
      ),
      receipt = JSON.parse(result.stdout) as { error: { code: string } };
    assert.notEqual(result.status, 0);
    assert.equal(receipt.error.code, "daemon_unavailable");
    assert.equal(existsSync(path.join(root, ".harness")), false);
    assert.equal(
      existsSync(path.join(root, "user", "daemon-default.pid")),
      false,
      "an unregistered workspace must not launch a daemon",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GUI launch reports a missing Electron binary with a structured diagnostic", async () => {
  const fixture = makeGuiFixture(false);
  try {
    const output = await captureGuiOutput(() =>
      runGuiLaunch(["gui", "--json"], { workspaceRoot: fixture.root, resolveElectronBinary: () => undefined }, emit),
    );
    const receipt = JSON.parse(output.stdout) as {
      ok: boolean;
      code: string;
      error: { code: string };
      diagnostic: { kind: string; expectation: string };
    };
    assert.equal(output.status, 1);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "electron_unavailable");
    assert.equal(receipt.error.code, "electron_unavailable");
    assert.equal(receipt.diagnostic.kind, "validation");
    assert.match(receipt.diagnostic.expectation, /electron\/install\.js/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GUI launch reports a renderer build failure before daemon acquisition", async () => {
  const fixture = makeGuiFixture(false);
  try {
    let daemonAcquisitions = 0;
    const output = await captureGuiOutput(() =>
      runGuiLaunch(
        ["gui", "--json"],
        {
          workspaceRoot: fixture.root,
          resolveElectronBinary: () => "/electron",
          prepareBundles: async () => ({ ok: false, hint: "fixture renderer build failed" }),
          ensureDaemon: async () => {
            daemonAcquisitions += 1;
            return { ok: true, hint: "reachable", attempts: 0 };
          },
        },
        emit,
      ),
    );
    const receipt = JSON.parse(output.stdout) as {
      ok: boolean;
      code: string;
      error: { code: string };
      diagnostic: { kind: string; expectation: string };
    };
    assert.equal(output.status, 1);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "gui_build_failed");
    assert.equal(receipt.error.code, "gui_build_failed");
    assert.equal(receipt.diagnostic.kind, "validation");
    assert.match(receipt.diagnostic.expectation, /fixture renderer build failed/u);
    assert.equal(daemonAcquisitions, 0, "a broken GUI build must not start the daemon");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GUI launch rejects unknown modes and a missing root before side effects", async () => {
  const fixture = makeGuiFixture(false);
  try {
    let sideEffects = 0;
    const dependencies: GuiLaunchDependencies = {
      workspaceRoot: fixture.root,
      resolveElectronBinary: () => {
        sideEffects += 1;
        return "/electron";
      },
      prepareBundles: async () => {
        sideEffects += 1;
        return { ok: true };
      },
      ensureDaemon: async () => {
        sideEffects += 1;
        return { ok: true, hint: "reachable", attempts: 0 };
      },
    };
    for (const argv of [
      ["gui", "--mode", "dev", "--json"],
      ["gui", "--root", "--json"],
    ]) {
      const output = await captureGuiOutput(() => runGuiLaunch(argv, dependencies, emit)),
        receipt = JSON.parse(output.stdout) as { code: string };
      assert.equal(output.status, 2);
      assert.ok(["unsupported_command", "missing_field"].includes(receipt.code));
    }
    assert.equal(sideEffects, 0, "invalid GUI arguments must be rejected before probing Electron, build, or daemon");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GUI launch refuses prepared output whose preload bundle is missing", async () => {
  const fixture = makeGuiFixture(true);
  try {
    writeFileSync(path.join(fixture.root, "packages/gui/dist/index.html"), "<!doctype html>\n");
    const output = await captureGuiOutput(() =>
      runGuiLaunch(
        ["gui", "--json"],
        {
          workspaceRoot: fixture.root,
          resolveElectronBinary: () => "/electron",
          prepareBundles: async () => ({ ok: true }),
          spawnProcess: () => {
            throw new Error("a GUI without its preload bridge must never be launched");
          },
        },
        emit,
      ),
    );
    const receipt = JSON.parse(output.stdout) as {
      ok: boolean;
      code: string;
      error: { code: string };
      diagnostic: { kind: string; expectation: string };
    };
    assert.equal(output.status, 1);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "gui_build_failed");
    assert.equal(receipt.diagnostic.kind, "validation");
    assert.match(receipt.diagnostic.expectation, /dist-electron\/electron-preload\.cjs/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GUI launch acquires the daemon then starts Electron detached without a dev renderer", async () => {
  const fixture = makeGuiFixture(true),
    calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
  try {
    writeFileSync(path.join(fixture.root, "packages/gui/dist/index.html"), "<!doctype html>\n");
    writeFileSync(path.join(fixture.root, "packages/gui/dist-electron/electron-preload.cjs"), "\n");
    process.env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5173";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    let unrefs = 0;
    const output = await captureGuiOutput(() =>
      runGuiLaunch(
        ["gui", "--json"],
        {
          workspaceRoot: fixture.root,
          resolveElectronBinary: () => "/electron",
          prepareBundles: async () => ({ ok: true }),
          ensureDaemon: async (invokingRoot) => {
            assert.equal(invokingRoot, fixture.root, "daemon autostart must be rooted at the GUI installation");
            return { ok: true, hint: "daemon is reachable", attempts: 0 };
          },
          spawnProcess: (command, args, options) => {
            void command;
            calls.push({ args, options: options as Record<string, unknown> });
            return {
              pid: 42,
              on() {},
              unref() {
                unrefs += 1;
              },
            } as unknown as ReturnType<NonNullable<GuiLaunchDependencies["spawnProcess"]>>;
          },
        },
        emit,
      ),
    );
    const receipt = JSON.parse(output.stdout) as {
      schema: string;
      command: string;
      outcome: string;
      ok: boolean;
      pid: number;
    };
    assert.equal(output.status, 0);
    assert.equal(receipt.schema, "command-receipt/v2");
    assert.equal(receipt.command, "gui");
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.pid, 42);
    assert.deepEqual(calls[0]?.args, [path.join(fixture.root, "packages/gui/src/main/electron-main.ts")]);
    assert.equal(calls[0]?.options.detached, true);
    assert.equal(calls[0]?.options.stdio, "ignore");
    assert.equal(calls[0]?.options.windowsHide, true);
    assert.equal(calls[0]?.options.cwd, fixture.root, "the shell must run from the workspace it was resolved against");
    assert.equal(unrefs, 1, "a detached launch must be unreferenced or the CLI never exits");
    const spawnedEnv = calls[0]?.options.env as NodeJS.ProcessEnv;
    assert.equal(
      spawnedEnv.ELECTRON_RENDERER_URL,
      undefined,
      "the dev renderer origin must not survive into a packaged launch",
    );
    assert.equal(spawnedEnv.ELECTRON_RUN_AS_NODE, undefined, "node mode would start the main process without a window");
    assert.equal(spawnedEnv.HARNESS_GUI_ROOT, process.cwd(), "the shell must be told which workspace to open");
  } finally {
    delete process.env.ELECTRON_RENDERER_URL;
    delete process.env.ELECTRON_RUN_AS_NODE;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GUI launch rejects when the spawned Electron never yields a pid", async () => {
  const fixture = makeGuiFixture(true);
  try {
    writeFileSync(path.join(fixture.root, "packages/gui/dist/index.html"), "<!doctype html>\n");
    writeFileSync(path.join(fixture.root, "packages/gui/dist-electron/electron-preload.cjs"), "\n");
    // spawn surfaces a missing or unusable binary asynchronously, so it never throws here; an
    // absent pid is the only synchronous witness, and reporting ok would hand back a dead GUI.
    const output = await captureGuiOutput(() =>
      runGuiLaunch(
        ["gui", "--json"],
        {
          workspaceRoot: fixture.root,
          resolveElectronBinary: () => "/nonexistent-electron",
          prepareBundles: async () => ({ ok: true }),
          ensureDaemon: async () => ({ ok: true, hint: "daemon is reachable", attempts: 0 }),
          spawnProcess: () =>
            ({ pid: undefined, on() {}, unref() {} }) as unknown as ReturnType<
              NonNullable<GuiLaunchDependencies["spawnProcess"]>
            >,
        },
        emit,
      ),
    );
    const receipt = JSON.parse(output.stdout) as { ok: boolean; code: string };
    assert.equal(output.status, 1);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, "gui_launch_failed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GUI launch does not spawn Electron when CLI daemon acquisition is refused", async () => {
  const fixture = makeGuiFixture(true);
  try {
    writeFileSync(path.join(fixture.root, "packages/gui/dist/index.html"), "<!doctype html>\n");
    writeFileSync(path.join(fixture.root, "packages/gui/dist-electron/electron-preload.cjs"), "\n");
    let electronSpawns = 0;
    const output = await captureGuiOutput(() =>
      runGuiLaunch(
        ["gui", "--json"],
        {
          workspaceRoot: fixture.root,
          resolveElectronBinary: () => "/electron",
          prepareBundles: async () => ({ ok: true }),
          ensureDaemon: async () => ({
            ok: false,
            code: "daemon_start_noncanonical_checkout",
            hint: "fixture canonical-only refusal",
            attempts: 0,
          }),
          spawnProcess: () => {
            electronSpawns += 1;
            throw new Error("daemon refusal must prevent Electron launch");
          },
        },
        emit,
      ),
    );
    const receipt = JSON.parse(output.stdout) as {
      code: string;
      error: { code: string };
      diagnostic: { kind: string; expectation: string };
    };
    assert.equal(output.status, 1);
    assert.equal(receipt.code, "daemon_start_noncanonical_checkout");
    assert.equal(receipt.error.code, "daemon_start_noncanonical_checkout");
    assert.equal(receipt.diagnostic.kind, "validation");
    assert.match(receipt.diagnostic.expectation, /fixture canonical-only refusal/u);
    assert.equal(electronSpawns, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the gui command reaches the launcher through the CLI entry", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-route-"));
  try {
    const result = spawnSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "gui", "--json"], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        HOME: path.join(root, ".home"),
        HARNESS_ACTOR: "agent:runtime-session:gui-route-test",
      },
    });
    const receipt = JSON.parse(result.stdout) as { command: string };
    assert.equal(receipt.command, "gui", "argv routing must reach the launcher, not the daemon command parser");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ha gui --help documents repository context and attach-only daemon ownership", () => {
  const result = spawnSync(process.execPath, [path.resolve("packages/cli/src/index.ts"), "gui", "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ha gui \[--root <path>\]/u);
  assert.match(result.stdout, /canonical CLI installation/u);
  assert.match(result.stdout, /never stops the daemon/u);
});

function makeGuiFixture(withDist: boolean): { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-launch-"));
  mkdirSync(path.join(root, "packages/gui/src/main"), { recursive: true });
  if (withDist) {
    mkdirSync(path.join(root, "packages/gui/dist"), { recursive: true });
    mkdirSync(path.join(root, "packages/gui/dist-electron"), { recursive: true });
  }
  return { root };
}

async function captureGuiOutput(
  run: () => Promise<number>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const stdout: string[] = [],
    stderr: string[] = [],
    log = console.log,
    error = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    return { status: await run(), stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}
