// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonBuildStamp, readDistBuildId } from "../../packages/daemon/src/daemon-host/build-identity.ts";
import { requestDaemonJsonRpcAt } from "../../packages/daemon/src/daemon-host/client/local-json-rpc-client.ts";
import { currentDaemonProtocolVersion } from "../../packages/daemon/src/daemon-host/protocol/daemon-protocol.contract.ts";
import { prepareE2EProbeGui, resolveE2EProbeElectronForTest } from "../e2e-probe.mjs";
import { startGuiResidentDaemonFixture } from "../../packages/gui/test-support/resident-daemon.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");

test(
  "GUI driver keeps the Electron profile out of the run directory and removes it on close",
  { timeout: 180_000 },
  async (t) => {
    const runtime = resolveE2EProbeElectronForTest(workspaceRoot);
    if (!runtime.available) {
      t.skip(runtime.reason);
      return;
    }
    t.after(runtime.close);
    prepareE2EProbeGui(workspaceRoot, runtime.env);
    // The isolated lane and smoke:gui:headless launch the bundled main entry, not the TS source.
    // prepareE2EProbeGui must therefore produce it on a clean checkout.
    const mainPath = path.join(workspaceRoot, "packages/gui/dist-electron/electron-main.js");
    assert.equal(existsSync(mainPath), true, `prepareE2EProbeGui must build ${mainPath}`);
    const guiCommit = readDistBuildId(path.join(workspaceRoot, "packages/gui"));
    assert.equal(guiCommit, daemonBuildStamp().commit ?? "source-archive");
    const { startGuiDriver } = await import("./driver.mjs");
    const fixture = await startGuiResidentDaemonFixture({
      prefix: "ha-gui-driver-profile-",
      daemonId: "gui-driver-profile",
      repoId: "gui-driver-profile",
      task: { taskId: "task-gui-driver-profile", title: "Keep the Electron profile out of artifacts" },
    });
    t.after(fixture.stop);
    const hello = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "protocol.hello",
      { protocolVersion: currentDaemonProtocolVersion },
      2_000,
    );
    assert.equal(hello.build.commit ?? "source-archive", guiCommit);
    // 模拟 worker 把运行目录指进任务包产物目录。目录必须放在 os.tmpdir() 之外:profile 若仍从
    // runRoot 派生(本测试锁定的回归),userData 会落在 outDir 下而不是系统临时目录。
    const outDir = path.join(workspaceRoot, ".harness", "gui-e2e-driver-profile-test");
    const runRoot = path.join(outDir, "run");
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    t.after(() => rmSync(outDir, { recursive: true, force: true }));
    const isolatedEnv = { ...runtime.env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint };
    delete isolatedEnv.HARNESS_EXECUTION_CREDENTIAL;
    const driver = await startGuiDriver({
      workspaceRoot,
      mainPath,
      rootDir: fixture.rootDir,
      env: isolatedEnv,
      runRoot,
    });
    // 断言失败也不能泄漏 Electron:不注册这个钩子,一次红会把 node --test 挂在子进程的管道上。
    // 显式 close 之后 playwright 连接已关,二次 close 会抛 TypeError,安全网只兜进程不判重入。
    t.after(() => driver.close().catch(() => undefined));
    const status = await driver.page.evaluate(() => globalThis.harness.getSystemStatus());
    assert.equal(status.guiBuild.commit, guiCommit);
    assert.equal(status.daemon.build.commitSha ?? "source-archive", guiCommit);
    // Electron 把 --user-data-dir 开关映射到 app.getPath("userData"),且返回 realpath
    // (macOS 上带 /private 前缀),所以对照 realpathSync 后的系统临时目录。
    const userData = await driver.app.evaluate(({ app }) => app.getPath("userData"));
    assert.equal(
      userData.startsWith(`${realpathSync(tmpdir())}${path.sep}`),
      true,
      `userData ${userData} must live under the os temp directory`,
    );
    // Playwright starts Electron through a shell wrapper on Windows. Closing by killing that
    // wrapper leaves the Electron main process and its renderer/GPU children alive; they keep
    // the profile open, so the is-removed assertion below turns red with EPERM. Assert the real
    // Electron process is gone as well, not just that the directory disappeared.
    const electronPid = await driver.app.evaluate(() => process.pid);
    assert.equal(
      await driver.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isOffscreen()),
      true,
    );
    const viewport = await driver.page.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
      scale: globalThis.devicePixelRatio,
    }));
    const png = readFileSync(await driver.shot("background"));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), Math.round(viewport.width * viewport.scale));
    assert.equal(png.readUInt32BE(20), Math.round(viewport.height * viewport.scale));
    await driver.assertBackground();
    await driver.close();
    assert.equal(existsSync(userData), false, `profile ${userData} must be removed when the driver closes`);
    assert.throws(
      () => process.kill(electronPid, 0),
      { code: "ESRCH" },
      `Electron process ${electronPid} must exit when the driver closes`,
    );
    assert.deepEqual(readdirSync(outDir), ["run"], "the output directory must receive only run deliverables");
    assert.deepEqual(readdirSync(runRoot), ["background.png", "window-state.json"]);
  },
);

test("GUI driver removes its profile directory when the launch fails", { timeout: 60_000 }, async (t) => {
  if (!existsSync(path.join(workspaceRoot, "node_modules", "electron", "path.txt"))) {
    t.skip("The Electron binary is not installed in this environment.");
    return;
  }
  const { startGuiDriver } = await import("./driver.mjs");
  // startGuiDriver 在 os.tmpdir() 下建 profile;把 TMPDIR 指到专用目录后,一次失败的启动
  // 不允许在里面留下任何 hg-profile-* 目录。
  const isolatedTmpdir = mkdtempSync(path.join(tmpdir(), "gui-driver-profile-tmp-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmpdir;
  try {
    const missingWorkspace = path.join(isolatedTmpdir, "missing-workspace");
    await assert.rejects(
      startGuiDriver({
        workspaceRoot: missingWorkspace,
        rootDir: isolatedTmpdir,
        env: process.env,
        runRoot: isolatedTmpdir,
      }),
    );
    assert.deepEqual(
      readdirSync(isolatedTmpdir).filter((entry) => entry.startsWith("hg-profile-")),
      [],
      "a failed launch must not leave a profile directory behind",
    );
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(isolatedTmpdir, { recursive: true, force: true });
  }
});

test(
  "shared pool isolates cross-scenario state, exports trace+IPC only on failure, and self-heals after real renderer crash and timeout",
  { timeout: 240_000 },
  async (t) => {
    const runtime = resolveE2EProbeElectronForTest(workspaceRoot);
    if (!runtime.available) {
      t.skip(runtime.reason);
      return;
    }
    t.after(runtime.close);
    prepareE2EProbeGui(workspaceRoot, runtime.env);
    const { runGuiE2E } = await import("../gui-e2e.mjs");
    const { openIsolatedFixture } = await import("./lanes.mjs");
    const { startGuiDriver } = await import("./driver.mjs");
    const { createLaneSessionPool } = await import("./session-pool.mjs");

    const outDir = mkdtempSync(path.join(tmpdir(), "gui-driver-trace-"));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));

    // Verify canonical lane also enforces hermetic isolation and built main entrypoint.
    const canonicalFixture = await openIsolatedFixture({
      workspaceRoot,
      scenarioId: "canonical-hermetic-check",
      env: { ...runtime.env, HARNESS_DAEMON_USER_ROOT: path.join(process.env.HOME ?? tmpdir(), ".harness") },
    });
    t.after(() => canonicalFixture.close().catch(() => undefined));
    assert.notEqual(
      canonicalFixture.fixture.userRoot,
      path.join(process.env.HOME ?? tmpdir(), ".harness"),
      "canonical fixture must never bind host default userRoot",
    );
    await canonicalFixture.close();

    // Run a single runGuiE2E batch over real Electron covering:
    // 1. Healthy scenario + IPC calls -> zero .zip / -ipc-trace.json written
    // 2. Dirty state mutation (localStorage/sessionStorage/window size/extra window) -> next scenario resets cleanly on same PID
    // 3. Real renderer crash (webContents.forcefullyCrashRenderer) -> fails with trace/PNG/IPC, rebuilds Electron, next passes
    // 4. Real scenario timeout -> fails with timeout error + artifacts, rebuilds Electron, next passes
    let pidAfterFirst = null;
    let pidAfterDirtyReset = null;
    let pidAfterCrash = null;
    let pidAfterTimeout = null;
    let primaryWindowId = null;
    const scenarios = [
      {
        id: "healthy-baseline",
        feature: "overview",
        lane: "isolated",
        readOnly: true,
        run: async (driver) => {
          await driver.page.getByTestId("app-sidebar").waitFor({ timeout: 20_000 });
          pidAfterFirst = await driver.app.evaluate(() => process.pid);
          primaryWindowId = await driver.app.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id ?? null,
          );
        },
      },
      {
        id: "dirty-state-mutator",
        feature: "overview",
        lane: "isolated",
        readOnly: true,
        run: async (driver) => {
          await driver.page.evaluate(() => {
            globalThis.localStorage.setItem("e2e.polluted", "yes");
            globalThis.sessionStorage.setItem("e2e.sessionPolluted", "yes");
          });
          const extraPagePromise = driver.app.waitForEvent("window");
          await driver.app.evaluate(({ BrowserWindow }, primaryId) => {
            const win =
              (primaryId !== null ? BrowserWindow.fromId(primaryId) : null) ?? BrowserWindow.getAllWindows()[0];
            win.setSize(1200, 800);
            const extra = new BrowserWindow({ show: false, focusable: false });
            void extra.loadURL("about:blank");
          }, primaryWindowId);
          const extraPage = await extraPagePromise;
          await extraPage.waitForLoadState("domcontentloaded");
          const pollutedBefore = await driver.page.evaluate(() => ({
            ls: globalThis.localStorage.getItem("e2e.polluted"),
            ss: globalThis.sessionStorage.getItem("e2e.sessionPolluted"),
          }));
          assert.equal(pollutedBefore.ls, "yes");
          assert.equal(pollutedBefore.ss, "yes");
        },
      },
      {
        id: "clean-after-reset",
        feature: "overview",
        lane: "isolated",
        readOnly: true,
        run: async (driver) => {
          pidAfterDirtyReset = await driver.app.evaluate(() => process.pid);
          assert.equal(pidAfterDirtyReset, pidAfterFirst, "reset must reuse the healthy Electron process");
          const clean = await driver.page.evaluate(() => ({
            ls: globalThis.localStorage.getItem("e2e.polluted"),
            ss: globalThis.sessionStorage.getItem("e2e.sessionPolluted"),
            firstRun: globalThis.localStorage.getItem("harness.desktop-first-run.done"),
          }));
          assert.equal(clean.ls, null, "resetForScenario must clear cross-scenario localStorage");
          assert.equal(clean.ss, null, "resetForScenario must clear cross-scenario sessionStorage");
          assert.equal(clean.firstRun, "1", "resetForScenario must preserve first-run suppression");
          const winState = await driver.app.evaluate(({ BrowserWindow }) => {
            const wins = BrowserWindow.getAllWindows();
            return {
              count: wins.length,
              size: wins[0].getSize(),
              visible: wins[0].isVisible(),
              focused: wins[0].isFocused(),
            };
          });
          assert.equal(winState.count, 1, "resetForScenario must close extra windows");
          assert.deepEqual(winState.size, [1440, 920], "resetForScenario must restore 1440x920 window size");
          assert.equal(winState.visible, false);
          assert.equal(winState.focused, false);
        },
      },
      {
        id: "real-renderer-crash",
        feature: "crash",
        lane: "isolated",
        readOnly: true,
        run: async (driver) => {
          const crashed = once(driver.page, "crash", { signal: AbortSignal.timeout(2_000) });
          // Register the event waiter before asking the main process to kill the renderer.
          await Promise.all([
            crashed,
            driver.app.evaluate(({ BrowserWindow }) => {
              BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
            }),
          ]);
        },
      },
      {
        id: "recovered-after-crash",
        feature: "overview",
        lane: "isolated",
        readOnly: true,
        run: async (driver) => {
          await driver.page.getByTestId("app-sidebar").waitFor({ timeout: 20_000 });
          pidAfterCrash = await driver.app.evaluate(() => process.pid);
          assert.notEqual(pidAfterCrash, pidAfterFirst, "pool must relaunch Electron after real renderer crash");
        },
      },
      {
        id: "real-scenario-timeout",
        feature: "timeout",
        lane: "isolated",
        readOnly: true,
        run: async (driver) => {
          await driver.page.evaluate(() =>
            globalThis.harness?.getTasks?.({ repoId: "gui-e2e-catalog" }).catch(() => null),
          );
          await new Promise(() => undefined);
        },
      },
      {
        id: "recovered-after-timeout",
        feature: "overview",
        lane: "isolated",
        readOnly: true,
        run: async (driver) => {
          await driver.page.getByTestId("app-sidebar").waitFor({ timeout: 20_000 });
          pidAfterTimeout = await driver.app.evaluate(() => process.pid);
          assert.notEqual(pidAfterTimeout, pidAfterCrash, "pool must relaunch Electron after scenario timeout");
        },
      },
    ];

    const { result, runRoot } = await runGuiE2E({
      lane: "isolated",
      noBuild: true,
      shots: outDir,
      selectedScenarios: scenarios,
      scenarioTimeoutMs: 6_000,
      createPool: (opts) => createLaneSessionPool({ ...opts, env: runtime.env, startDriver: startGuiDriver }),
    });

    assert.equal(result.outcome, "failed");
    assert.equal(result.scenarios.length, scenarios.length);
    const byId = Object.fromEntries(result.scenarios.map((entry) => [entry.id, entry]));

    assert.equal(byId["healthy-baseline"].outcome, "healthy", JSON.stringify(byId["healthy-baseline"]));
    const healthyDir = path.join(runRoot, "isolated", "healthy-baseline");
    assert.deepEqual(
      readdirSync(healthyDir).filter((name) => name.endsWith(".zip") || name.endsWith("-ipc-trace.json")),
      [],
      "healthy scenario must not write trace.zip or ipc-trace.json",
    );

    assert.equal(byId["clean-after-reset"].outcome, "healthy", JSON.stringify(byId["clean-after-reset"]));
    assert.equal(byId["real-renderer-crash"].outcome, "failed", JSON.stringify(byId["real-renderer-crash"]));
    assert.equal(byId["recovered-after-crash"].outcome, "healthy", JSON.stringify(byId["recovered-after-crash"]));

    const timeoutEntry = byId["real-scenario-timeout"];
    assert.equal(timeoutEntry.outcome, "failed");
    assert.match(timeoutEntry.message, /timed out/iu);
    assert.ok(timeoutEntry.screenshotPath && existsSync(timeoutEntry.screenshotPath), "timeout screenshot must exist");
    assert.ok(timeoutEntry.tracePath && existsSync(timeoutEntry.tracePath), "timeout trace.zip must exist");
    assert.ok(statSync(timeoutEntry.tracePath).size > 0);
    assert.equal(readFileSync(timeoutEntry.tracePath).subarray(0, 2).toString(), "PK");
    assert.ok(timeoutEntry.ipcTracePath && existsSync(timeoutEntry.ipcTracePath), "timeout ipc-trace.json must exist");
    const ipcDoc = JSON.parse(readFileSync(timeoutEntry.ipcTracePath, "utf8"));
    assert.equal(ipcDoc.schema, "gui-e2e-ipc-trace/v1");
    assert.ok(ipcDoc.count > 0 && Array.isArray(ipcDoc.entries));
    assert.ok(ipcDoc.entries.some((entry) => entry.channel === "harness:rpc" && entry.method === "repo.tasks.list"));

    assert.equal(byId["recovered-after-timeout"].outcome, "healthy");
  },
);

test(
  "driver attributes startup and shared-reset console errors to the responsible scenario without swallowing",
  { timeout: 180_000 },
  async (t) => {
    const runtime = resolveE2EProbeElectronForTest(workspaceRoot);
    if (!runtime.available) {
      t.skip(runtime.reason);
      return;
    }
    t.after(runtime.close);
    prepareE2EProbeGui(workspaceRoot, runtime.env);
    const mainPath = path.join(workspaceRoot, "packages/gui/dist-electron/electron-main.js");
    const { runGuiE2E } = await import("../gui-e2e.mjs");
    const { runScenario, startGuiDriver } = await import("./driver.mjs");
    const { createLaneSessionPool } = await import("./session-pool.mjs");

    let mode = "startup-error";
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (mode === "startup-error") {
        res.end(
          "<!doctype html><html><body><script>console.error('synthetic_startup_console_probe');</script></body></html>",
        );
        return;
      }
      if (mode === "reset-error" && _req.url === "/") {
        mode = "clean";
        res.end(
          "<!doctype html><html><body><script>throw new Error('synthetic_reset_pageerror_probe');</script></body></html>",
        );
      } else {
        res.end("<!doctype html><html><body><h1>ok</h1></body></html>");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const { port } = server.address();
    const rendererUrl = `http://127.0.0.1:${port}/`;

    const outDir = mkdtempSync(path.join(tmpdir(), "gui-startup-reset-err-"));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));

    // 1. Startup console.error must fail the first scenario instead of being skipped by consoleOffset.
    const d1 = await startGuiDriver({
      workspaceRoot,
      mainPath,
      rootDir: outDir,
      env: runtime.env,
      runRoot: path.join(outDir, "startup"),
      rendererUrl,
    });
    t.after(() => d1.close().catch(() => undefined));
    const startupResult = await runScenario(
      d1,
      { id: "startup-probe", feature: "startup", lane: "isolated", run: async () => undefined },
      { shots: null },
    );
    await d1.close();
    assert.equal(startupResult.outcome, "failed");
    assert.match(startupResult.message, /synthetic_startup_console_probe/u);

    // 2. Shared reset console.error must fail the acquiring scenario instead of being swallowed by pool retry.
    mode = "clean";
    let firstPid;
    const { result, runRoot } = await runGuiE2E({
      lane: "isolated",
      noBuild: true,
      shots: outDir,
      selectedScenarios: [
        [
          "before-reset",
          async (driver) => {
            firstPid = await driver.app.evaluate(() => process.pid);
            mode = "reset-error";
          },
        ],
        ["failed-reset", async () => assert.fail("the scenario must not run after a failed reset")],
        ["after-reset", async (driver) => assert.notEqual(await driver.app.evaluate(() => process.pid), firstPid)],
      ].map(([id, run]) => ({ id, feature: "reset", lane: "isolated", readOnly: true, run })),
      createPool: (opts) =>
        createLaneSessionPool({
          ...opts,
          openIsolatedFixtureImpl: async () => ({
            fixture: { rootDir: outDir },
            isHealthy: async () => true,
            launchDriver: ({ runRoot, startDriver }) =>
              startDriver({ workspaceRoot, mainPath, rootDir: outDir, env: runtime.env, runRoot, rendererUrl }),
            close: async () => undefined,
          }),
        }),
    });
    assert.deepEqual(
      result.scenarios.map(({ outcome }) => outcome),
      ["healthy", "failed", "healthy"],
    );
    const diskResult = JSON.parse(readFileSync(path.join(runRoot, "result.json"), "utf8"));
    assert.deepEqual(diskResult, result);
    const failure = diskResult.scenarios[1];
    assert.equal(failure.failedStep, "failed-reset");
    assert.match(failure.message, /synthetic_reset_pageerror_probe/u);
    const artifactRoot = path.join(runRoot, "isolated", "failed-reset");
    for (const artifact of [failure.screenshotPath, failure.tracePath, failure.windowStatePath, failure.ipcTracePath]) {
      assert.ok(artifact && path.dirname(artifact) === artifactRoot && statSync(artifact).size > 0, String(artifact));
    }
    assert.equal(readFileSync(failure.screenshotPath).subarray(1, 4).toString(), "PNG");
    assert.equal(readFileSync(failure.tracePath).subarray(0, 2).toString(), "PK");
    assert.deepEqual(JSON.parse(readFileSync(failure.windowStatePath, "utf8")), [{ visible: false, focused: false }]);
    const ipc = JSON.parse(readFileSync(failure.ipcTracePath, "utf8"));
    assert.equal(ipc.schema, "gui-e2e-ipc-trace/v1");
    assert.equal(ipc.scenarioId, "failed-reset");
    assert.equal(ipc.count, ipc.entries.length);
  },
);
