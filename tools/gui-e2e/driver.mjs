import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const DEFAULT_WINDOW_WIDTH = 1440;
const DEFAULT_WINDOW_HEIGHT = 920;
const DEFAULT_SCENARIO_TIMEOUT_MS = 60_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_RESET_TIMEOUT_MS = 15_000;

export async function withTimeout(promiseOrFactory, timeoutMs, message) {
  let timer;
  const target = typeof promiseOrFactory === "function" ? promiseOrFactory() : promiseOrFactory;
  try {
    return await Promise.race([
      Promise.resolve(target),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function resolveProfileBaseDir({ platform = process.platform, baseTmpDir = tmpdir() } = {}) {
  // Chromium creates SingletonSocket inside --user-data-dir; Linux sockaddr_un.sun_path rejects >107 bytes with SIGTRAP.
  if (platform === "linux" && Buffer.byteLength(path.join(baseTmpDir, "hg-profile-XXXXXX", "SingletonSocket")) > 100) {
    return "/tmp";
  }
  return baseTmpDir;
}

export async function startGuiDriver({
  workspaceRoot,
  rootDir,
  env,
  runRoot,
  headless = true,
  mainPath,
  userDataDir,
  rendererUrl,
}) {
  const ownsProfile = userDataDir === undefined,
    profile = userDataDir ?? mkdtempSync(path.join(resolveProfileBaseDir(), "hg-profile-"));
  const consoleFailures = [];
  const args = [
    mainPath ?? path.join(workspaceRoot, "packages/gui/src/main/electron-main.ts"),
    `--user-data-dir=${profile}`,
  ];
  if (headless) args.push("--no-sandbox", "--headless", "--disable-gpu", "--disable-dev-shm-usage");
  // A task worker exports ELECTRON_RUN_AS_NODE=1 for its own child processes; Electron then
  // starts as plain Node and rejects Chromium switches (bad option: --remote-debugging-port).
  // This driver always launches the GUI shell, so it must run Electron in its own mode.
  const launchEnv = {
    ...env,
    ELECTRON_DISABLE_SANDBOX: "1",
    HARNESS_GUI_ROOT: rootDir,
    HARNESS_GUI_IPC_TRACE: "1",
  };
  const safeChildTmp = resolveProfileBaseDir({ baseTmpDir: launchEnv.TMPDIR || tmpdir() });
  if (safeChildTmp !== (launchEnv.TMPDIR || tmpdir())) {
    // Chromium/Electron C++ temp sockets under $TMPDIR share Linux's 107-byte sun_path limit.
    launchEnv.TMPDIR = safeChildTmp;
  }
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  if (rendererUrl === undefined) delete launchEnv.ELECTRON_RENDERER_URL;
  else launchEnv.ELECTRON_RENDERER_URL = rendererUrl;
  let app;
  try {
    // Let Playwright launch the installed Electron with its loader. An explicit binary path
    // bypasses that loader, which holds app readiness until both CDP clients connect.
    app = await electron.launch({
      args,
      cwd: workspaceRoot,
      env: launchEnv,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    let crashed = false;
    page.on("crash", () => {
      crashed = true;
    });
    page.on("close", () => {
      crashed = true;
    });
    app.on("close", () => {
      crashed = true;
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleFailures.push(message.text());
    });
    page.on("pageerror", (error) => consoleFailures.push(error.message));
    if (rendererUrl === undefined) await page.waitForLoadState("domcontentloaded");
    else await page.waitForURL(new URL(rendererUrl).href, { waitUntil: "domcontentloaded" });
    // 每次运行都是全新 profile,首次启动引导浮层(task_aba0fddb 起)必然弹出并拦截所有
    // 点击;e2e 验收的是各页面流程而非引导本身,落它的已完成标记后重载一次关掉。
    await page.evaluate(() => globalThis.localStorage.setItem("harness.desktop-first-run.done", "1"));
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const initialUrl = page.url();
    const mainWindowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id ?? null);
    const driver = {
      app,
      page,
      profile,
      runRoot,
      consoleFailures,
      // Start at 0 so any console.error/pageerror emitted during initial launch or reload is
      // attributed to the first scenario instead of being skipped by an initial offset.
      consoleCursor: 0,
      isAlive() {
        const child = app.process();
        return !crashed && !page.isClosed() && child.exitCode === null && child.signalCode === null;
      },
      async assertBackground() {
        if (!headless) return;
        const windows = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
        );
        mkdirSync(driver.runRoot, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(driver.runRoot, "window-state.json"), `${JSON.stringify(windows)}\n`);
        assert.ok(windows.length > 0 && windows.every((window) => !window.visible && !window.focused));
      },
      async nav(label) {
        await page.getByRole("button", { name: label, exact: true }).click();
      },
      async shot(name) {
        mkdirSync(driver.runRoot, { recursive: true, mode: 0o700 });
        const target = path.join(driver.runRoot, `${name}.png`);
        await page.screenshot({ path: target, fullPage: true, animations: "disabled" });
        return target;
      },
      assertConsoleClean(from = driver.consoleCursor) {
        const failures = consoleFailures.slice(from);
        if (failures.length) throw new Error(`renderer console errors:\n${failures.join("\n")}`);
      },
      markConsoleClean() {
        driver.consoleCursor = consoleFailures.length;
      },
      async readIpcTrace({ clear = false } = {}) {
        try {
          if (!driver.isAlive()) {
            // Even when the renderer crashed, main process may still answer app.evaluate.
            const child = app.process();
            if (child.exitCode !== null || child.signalCode !== null) return [];
          }
          const entries = await withTimeout(
            app.evaluate((_, shouldClear) => {
              const tracer = globalThis.__harnessGuiIpcTrace;
              return tracer && typeof tracer.snapshot === "function" ? tracer.snapshot(shouldClear) : [];
            }, clear),
            2_000,
            "Timed out reading Electron IPC trace",
          );
          return Array.isArray(entries) ? entries : [];
        } catch {
          return [];
        }
      },
      async clearIpcTrace() {
        await driver.readIpcTrace({ clear: true });
      },
      async resetForScenario(nextRunRoot, { timeoutMs = DEFAULT_RESET_TIMEOUT_MS, scenarioId = "reset" } = {}) {
        if (!driver.isAlive()) throw new Error("Electron session is not alive");
        driver.runRoot = nextRunRoot;
        await withTimeout(
          async () => {
            await driver.clearIpcTrace();
            const contentSize = await app.evaluate(
              ({ BrowserWindow }, { size, primaryId }) => {
                const windows = BrowserWindow.getAllWindows();
                if (windows.length === 0) return null;
                const win = (primaryId !== null ? BrowserWindow.fromId(primaryId) : null) ?? windows[0];
                if (!win || win.isDestroyed()) return null;
                for (const extra of windows) {
                  if (extra.id !== win.id && !extra.isDestroyed()) extra.close();
                }
                const [w, h] = win.getSize();
                if (w !== size.width || h !== size.height) win.setSize(size.width, size.height);
                return win.getContentSize();
              },
              { size: { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }, primaryId: mainWindowId },
            );
            if (!contentSize) throw new Error("Electron main window is missing");
            const viewport = page.viewportSize();
            if (!viewport || viewport.width !== contentSize[0] || viewport.height !== contentSize[1]) {
              await page.setViewportSize({ width: contentSize[0], height: contentSize[1] });
            }
            await page.evaluate(() => {
              globalThis.localStorage.clear();
              globalThis.sessionStorage.clear();
              globalThis.localStorage.setItem("harness.desktop-first-run.done", "1");
            });
            if (page.url() !== initialUrl) {
              await page.goto(initialUrl, { waitUntil: "domcontentloaded" });
            } else {
              await page.reload({ waitUntil: "domcontentloaded" });
            }
            await driver.assertBackground();
            driver.assertConsoleClean(driver.consoleCursor);
            driver.markConsoleClean();
          },
          timeoutMs,
          `Electron reset timed out after ${timeoutMs}ms`,
        ).catch(async (error) => {
          try {
            await withTimeout(driver.shot(`${scenarioId}-failure`), 3_000, "Reset failure screenshot timed out");
          } catch {
            // Best-effort screenshot when reset itself fails.
          }
          throw error;
        });
      },
      async close(closeTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {
        await stopElectronApp(app, closeTimeoutMs);
        if (ownsProfile) rmSync(profile, { recursive: true, force: true });
      },
    };
    await driver.assertBackground();
    return driver;
  } catch (error) {
    // The profile is owned by this run: a launch that never returned a driver must
    // still not leave it behind (and must not leave a window-less Electron process).
    if (app) await stopElectronApp(app, DEFAULT_CLEANUP_TIMEOUT_MS).catch(() => undefined);
    if (ownsProfile) rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

async function waitForChildExit(child, waitMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, waitMs);
    if (typeof timer.unref === "function") timer.unref();
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

async function stopElectronApp(app, closeTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Close active windows before app.quit() so Playwright tears down page CDP sessions
  // cleanly and does not leave late WebSocket messages racing past teardown.
  if (typeof app.windows === "function") {
    await Promise.all(
      app.windows().map((win) => withTimeout(win.close(), 2_000, "Window close timed out").catch(() => undefined)),
    );
  }
  // Ask Electron itself to quit and wait for Playwright's process-close event, bounded by
  // closeTimeoutMs so a wedged process falls back to SIGKILL instead of hanging the batch.
  try {
    await withTimeout(app.close(), closeTimeoutMs, `Electron app.close() timed out after ${closeTimeoutMs}ms`);
  } catch {
    // Fall through to child exit verification / SIGKILL below.
  }
  if (!(await waitForChildExit(child, 2_000))) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process already exited.
    }
    await waitForChildExit(child, 2_000);
  }
  // Drain one macrotask turn so any buffered DevTools transport callbacks settle before return.
  await new Promise((resolve) => setImmediate(resolve));
}

export async function runScenario(
  driver,
  scenario,
  {
    shots,
    trace = true,
    injectFault,
    scenarioTimeoutMs = DEFAULT_SCENARIO_TIMEOUT_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  } = {},
) {
  const started = Date.now();
  const consoleOffset = typeof driver.consoleCursor === "number" ? driver.consoleCursor : 0;
  const context = typeof driver.page?.context === "function" ? driver.page.context() : null;
  let tracingStarted = false;
  try {
    if (trace && context?.tracing) {
      await withTimeout(
        context.tracing.start({ screenshots: true, snapshots: true, sources: false }),
        cleanupTimeoutMs,
        `Playwright tracing.start timed out for ${scenario.id}`,
      );
      tracingStarted = true;
    }
    await withTimeout(
      async () => {
        await scenario.run(driver);
        if (injectFault) await injectFault({ driver, scenario });
        if (typeof driver.isAlive === "function" && !driver.isAlive()) {
          throw new Error(`Electron renderer/session died during ${scenario.id}`);
        }
        await driver.assertBackground();
        driver.assertConsoleClean(consoleOffset);
        if (typeof driver.markConsoleClean === "function") driver.markConsoleClean();
        if (shots) await driver.shot(scenario.id);
      },
      scenarioTimeoutMs,
      `Scenario "${scenario.id}" timed out after ${scenarioTimeoutMs}ms`,
    );
    if (tracingStarted) {
      await withTimeout(
        context.tracing.stop(),
        cleanupTimeoutMs,
        `Playwright tracing.stop timed out for ${scenario.id}`,
      );
      tracingStarted = false;
    }
    return {
      id: scenario.id,
      feature: scenario.feature,
      lane: scenario.lane,
      outcome: "healthy",
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const targetRoot = driver.runRoot ?? shots ?? "";
    let screenshotPath = targetRoot ? path.join(targetRoot, `${scenario.id}-failure.png`) : null;
    const sessionAlive = typeof driver.isAlive !== "function" || driver.isAlive();
    try {
      if (sessionAlive && typeof driver.shot === "function") {
        screenshotPath = await withTimeout(
          driver.shot(`${scenario.id}-failure`),
          cleanupTimeoutMs,
          `Failure screenshot timed out for ${scenario.id}`,
        );
      } else {
        screenshotPath = screenshotPath && existsSync(screenshotPath) ? screenshotPath : null;
      }
    } catch {
      screenshotPath = screenshotPath && existsSync(screenshotPath) ? screenshotPath : null;
    }
    let tracePath = null;
    if (tracingStarted) {
      const candidateTracePath = targetRoot ? path.join(targetRoot, `${scenario.id}-trace.zip`) : null;
      try {
        if (candidateTracePath) {
          mkdirSync(path.dirname(candidateTracePath), { recursive: true, mode: 0o700 });
          await withTimeout(
            context.tracing.stop({ path: candidateTracePath }),
            cleanupTimeoutMs,
            `Failure tracing.stop timed out for ${scenario.id}`,
          );
          if (existsSync(candidateTracePath)) tracePath = candidateTracePath;
        } else {
          await withTimeout(context.tracing.stop(), cleanupTimeoutMs, "Failure tracing.stop timed out");
        }
      } catch {
        tracePath = candidateTracePath && existsSync(candidateTracePath) ? candidateTracePath : null;
      }
    }
    let ipcTracePath = null;
    if (targetRoot && typeof driver.readIpcTrace === "function") {
      try {
        const entries = await driver.readIpcTrace();
        const candidateIpcPath = path.join(targetRoot, `${scenario.id}-ipc-trace.json`);
        mkdirSync(path.dirname(candidateIpcPath), { recursive: true, mode: 0o700 });
        writeFileSync(
          candidateIpcPath,
          `${JSON.stringify(
            {
              schema: "gui-e2e-ipc-trace/v1",
              scenarioId: scenario.id,
              count: entries.length,
              entries,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
        ipcTracePath = candidateIpcPath;
      } catch {
        ipcTracePath = null;
      }
    }
    return {
      id: scenario.id,
      feature: scenario.feature,
      lane: scenario.lane,
      outcome: "failed",
      durationMs: Date.now() - started,
      failedStep: scenario.id,
      message: error instanceof Error ? error.message : String(error),
      screenshotPath,
      tracePath,
      ipcTracePath,
    };
  }
}
