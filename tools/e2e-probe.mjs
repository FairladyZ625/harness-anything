#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withStdoutReservedForJson } from "./gui-e2e/emit-json.mjs";
import {
  buildProbeFailureBundle,
  errorCode,
  prepareE2EProbeGui,
  probeError,
  recordE2EProbeFailure,
  signatureOf,
  warmDaemonProjection,
} from "./e2e-probe-support.mjs";

export {
  buildProbeFailureBundle,
  prepareE2EProbeGui,
  recordE2EProbeFailure,
  resolveE2EProbeElectronForTest,
  runCliJsonForTest,
  warmDaemonProjection,
} from "./e2e-probe-support.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

export async function runE2EProbeJourney({
  rootDir = repositoryRoot,
  workspaceRoot = repositoryRoot,
  env = process.env,
  outputRoot = path.join(rootDir, ".harness", "e2e-probe"),
  now = () => new Date().toISOString(),
  injectFault,
  prepareGui = true,
  warmDaemon = true,
} = {}) {
  const runId = `probe-${now().replaceAll(/[^0-9A-Za-z]/gu, "-")}-${randomUUID().slice(0, 8)}`,
    runRoot = path.join(outputRoot, runId),
    startedAt = now(),
    completedSteps = [],
    consoleFailures = [];
  let currentStep = "prepare_gui",
    electronApp,
    page;
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  try {
    if (prepareGui) prepareE2EProbeGui(workspaceRoot, env);
    // The GUI answers projection reads with a 200 ms transport deadline. A scheduled run launches
    // the app while its own daemon is still cold or catching up, so that first read overruns the
    // deadline and the task sidebar stalls in its loading state until the probe's 20 s wait expires.
    // Manual runs pass only because an earlier command already warmed the daemon. Pay that cost here,
    // outside the GUI's budget, so both paths reach a ready projection before the window opens.
    if (warmDaemon) {
      currentStep = "warm_daemon";
      await warmDaemonProjection({ rootDir, workspaceRoot, env });
    }
    currentStep = "launch_gui";
    const [{ default: electronPath }, { _electron: electron }] = await Promise.all([
      import("electron"),
      import("playwright-core"),
    ]);
    electronApp = await electron.launch({
      executablePath: electronPath,
      args: [
        path.join(workspaceRoot, "packages", "gui", "src", "main", "electron-main.ts"),
        "--no-sandbox",
        "--headless",
        "--disable-gpu",
        "--disable-dev-shm-usage",
      ],
      cwd: workspaceRoot,
      env: {
        ...env,
        ELECTRON_DISABLE_SANDBOX: "1",
        HARNESS_GUI_ROOT: rootDir,
      },
    });
    page = await electronApp.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on("console", (message) => {
      if (message.type() === "error") consoleFailures.push(message.text());
    });
    page.on("pageerror", (error) => consoleFailures.push(error.message));

    const step = async (name, action) => {
      currentStep = name;
      await action();
      await injectFault?.({ step: name, page });
      completedSteps.push(name);
    };
    await step("bridge_ready", async () => {
      await page.waitForLoadState("domcontentloaded");
      if ((await page.evaluate(() => typeof globalThis.harness)) !== "object")
        throw probeError("bridge_unavailable", "The sandboxed preload bridge is unavailable.");
    });
    await step("task_projection", async () => {
      const taskSurface = page.getByTestId("real-task-summary").or(page.getByTestId("task-empty-state")),
        taskError = page.getByTestId("task-error-state");
      await taskSurface.or(taskError).first().waitFor();
      if (await taskError.isVisible()) throw probeError("task_projection_failed", await taskError.innerText());
    });
    await step("board", async () => {
      await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
      await page.getByTestId("board-task-card").first().waitFor();
    });
    await step("task_detail", async () => {
      await page.getByTestId("board-task-card").first().click();
      await page.getByRole("button", { name: /^(?:打开完整详情|Open full details)$/u }).click();
      await page.getByTestId("task-detail-view").waitFor();
    });
    await step("task_dispatch", async () => {
      await page.getByRole("tab", { name: /^(?:派工|Dispatch)$/u }).click();
      await page.getByTestId("task-dispatch-tab").waitFor();
    });
    await step("sessions", async () => {
      await page.getByRole("button", { name: /^(?:会话|Sessions)$/u }).click();
      await page.getByTestId("sessions-view").waitFor();
    });
    await step("agent_squad", async () => {
      await page.getByRole("button", { name: /^(?:Agent · 含 Squad|Agents · Squads)$/u }).click();
      await page.getByTestId("agent-squad-view").waitFor();
    });
    await step("navigation_history", async () => {
      const history = page.getByTestId("nav-history-bar");
      await history.getByRole("button", { name: /(?:后退|Back)/u }).click();
      await page.getByTestId("sessions-view").waitFor();
      await history.getByRole("button", { name: /(?:前进|Forward)/u }).click();
      await page.getByTestId("agent-squad-view").waitFor();
    });
    if (consoleFailures.length) throw probeError("renderer_console_error", consoleFailures.join("\n"));
    return {
      schema: "e2e-probe-journey/v1",
      outcome: "healthy",
      runId,
      startedAt,
      endedAt: now(),
      completedSteps,
      failureSignature: null,
      screenshotPath: null,
      bundlePath: null,
    };
  } catch (error) {
    const endedAt = now(),
      code = errorCode(error),
      message = error instanceof Error ? error.message : String(error),
      failureSignature = signatureOf(currentStep, code, message, rootDir),
      screenshotPath = page ? path.join(runRoot, "failure.png") : null,
      bundlePath = path.join(runRoot, "failure.json");
    if (page)
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch (screenshotError) {
        consoleFailures.push(`screenshot: ${String(screenshotError)}`);
      }
    const result = {
      schema: "e2e-probe-journey/v1",
      outcome: "failed",
      runId,
      startedAt,
      endedAt,
      completedSteps,
      failedStep: currentStep,
      code,
      message,
      failureSignature,
      screenshotPath: screenshotPath && existsSync(screenshotPath) ? screenshotPath : null,
      bundlePath,
      consoleFailures,
    };
    writeFileSync(bundlePath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return result;
  } finally {
    if (electronApp) await closeElectronApp(electronApp);
  }
}

async function closeElectronApp(electronApp) {
  const child = electronApp.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--canonical-read-only") {
    const { runGuiE2E } = await import("./gui-e2e.mjs");
    return (await runGuiE2E({ lane: "canonical", scenarios: [], noBuild: false })).result;
  }
  if (argv.length === 1 && argv[0] === "--agent-run") {
    const { runGuiE2E } = await import("./gui-e2e.mjs");
    const { result, runRoot } = await runGuiE2E({ lane: "all", scenarios: [], noBuild: false });
    if (result.outcome === "healthy") return result;
    const first = result.scenarios.find((scenario) => scenario.outcome === "failed"),
      bundlePath = path.join(runRoot, "probe-failure.json");
    writeFileSync(bundlePath, `${JSON.stringify(buildProbeFailureBundle(result, first), null, 2)}\n`);
    const closure = await recordE2EProbeFailure({ bundlePath });
    return { ...result, taskId: closure.taskId, deduplicated: closure.deduplicated };
  }
  if (argv.length === 2 && argv[0] === "--record-failure")
    return recordE2EProbeFailure({ bundlePath: path.resolve(argv[1]) });
  throw probeError(
    "invalid_probe_command",
    "Use --canonical-read-only, --agent-run, or --record-failure <bundle-path>.",
  );
}

// 入口不用顶层 await:gui-e2e.mjs 静态导入本模块,而本模块的 --agent-run 又动态导入 gui-e2e.mjs;
// 顶层 await 会让模块停在「求值中」,对方的导入永远等不到(Node 退出码 13 unsettled top-level await)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void withStdoutReservedForJson(
    () => main(process.argv.slice(2)),
    (error) => ({
      schema: "e2e-probe-result/v1",
      outcome: "failed",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
