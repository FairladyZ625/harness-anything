import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

export async function startGuiDriver({ workspaceRoot, rootDir, env, runRoot, headless = true }) {
  const profile = path.join(runRoot, "profile");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const consoleFailures = [];
  const args = [path.join(workspaceRoot, "packages/gui/src/main/electron-main.ts"), `--user-data-dir=${profile}`];
  if (headless) args.push("--no-sandbox", "--headless", "--disable-gpu", "--disable-dev-shm-usage");
  const app = await electron.launch({
    executablePath: electronPath,
    args,
    cwd: workspaceRoot,
    env: { ...env, ELECTRON_DISABLE_SANDBOX: "1", HARNESS_GUI_ROOT: rootDir },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("console", (message) => {
    if (message.type() === "error") consoleFailures.push(message.text());
  });
  page.on("pageerror", (error) => consoleFailures.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  return {
    app,
    page,
    consoleFailures,
    async nav(label) {
      await page.getByRole("button", { name: label, exact: true }).click();
    },
    async shot(name) {
      const target = path.join(runRoot, `${name}.png`);
      await page.screenshot({ path: target, fullPage: true });
      return target;
    },
    assertConsoleClean(from = 0) {
      const failures = consoleFailures.slice(from);
      if (failures.length) throw new Error(`renderer console errors:\n${failures.join("\n")}`);
    },
    async close() {
      const child = app.process();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    },
  };
}

export async function runScenario(driver, scenario, { shots }) {
  const started = Date.now();
  const consoleOffset = driver.consoleFailures.length;
  try {
    await scenario.run(driver);
    driver.assertConsoleClean(consoleOffset);
    if (shots) await driver.shot(scenario.id);
    return {
      id: scenario.id,
      feature: scenario.feature,
      lane: scenario.lane,
      outcome: "healthy",
      durationMs: Date.now() - started,
    };
  } catch (error) {
    let screenshotPath = path.join(driver.runRoot ?? shots ?? "", `${scenario.id}-failure.png`);
    try {
      screenshotPath = await driver.shot(`${scenario.id}-failure`);
    } catch {
      screenshotPath = existsSync(screenshotPath) ? screenshotPath : null;
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
    };
  }
}
