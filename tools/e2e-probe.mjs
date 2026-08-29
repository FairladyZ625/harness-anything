#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

export function prepareE2EProbeGui(rootDir = repositoryRoot, env = process.env) {
  const guiRoot = path.join(rootDir, "packages", "gui"),
    vite = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) throw probeError("gui_dependencies_missing", `Missing ${vite}; run npm install first.`);
  for (const config of ["vite.config.ts", "vite.preload.config.ts"])
    try {
      execFileSync(process.execPath, [vite, "build", "--config", config], {
        cwd: guiRoot,
        env,
        encoding: "utf8",
        stdio: "pipe",
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const detail = typeof error?.stderr === "string" ? error.stderr.trim() : String(error);
      throw probeError("gui_build_failed", `${config}: ${detail}`);
    }
}

export function resolveE2EProbeElectronForTest(rootDir = repositoryRoot, env = process.env) {
  const packageRoot = path.join(rootDir, "node_modules", "electron"),
    marker = path.join(packageRoot, "path.txt");
  if (!existsSync(marker))
    return unavailableElectronTestRuntime("The Electron binary is not installed in this environment.", env);
  if (process.platform === "linux" && !env.DISPLAY)
    return unavailableElectronTestRuntime(
      "The canonical GUI journey requires an existing DISPLAY and is skipped in headless environments.",
      env,
    );
  return { available: true, reason: null, env, close: () => undefined };
}

function unavailableElectronTestRuntime(reason, env) {
  return { available: false, reason, env, close: () => undefined };
}

export async function recordE2EProbeFailure({
  rootDir = repositoryRoot,
  workspaceRoot = repositoryRoot,
  bundlePath,
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  const journey = readFailureBundle(bundlePath),
    updatedAfter = new Date(Date.parse(now()) - 24 * 60 * 60 * 1_000).toISOString(),
    title = `E2E probe failure [${journey.failureSignature}]`,
    existing = cliRows(
      await runCliJson(
        workspaceRoot,
        rootDir,
        ["task", "list", "--search", title, "--updated-after", updatedAfter],
        env,
      ),
    )[0];
  if (existing)
    return {
      schema: "e2e-probe-result/v1",
      outcome: "failed",
      runId: journey.runId,
      failureSignature: journey.failureSignature,
      taskId: String(existing.taskId),
      deduplicated: true,
    };
  const created = await runCliJson(
      workspaceRoot,
      rootDir,
      [
        "task",
        "create",
        "--title",
        title,
        "--idempotency-key",
        `e2e-probe:${journey.failureSignature}:${journey.startedAt}`,
        "--kind",
        "fix",
        "--risk-tier",
        "medium",
        "--urgency",
        "high",
        "--surface",
        "tools/e2e-probe.mjs",
        "--surface",
        "packages/gui",
      ],
      env,
    ),
    taskId = requiredText(created.taskId, "taskId"),
    destination = `artifacts/e2e-probe/${path.basename(bundlePath)}`;
  await runCliJson(
    workspaceRoot,
    rootDir,
    ["task", "artifact", "add", taskId, "--source", bundlePath, "--destination", destination],
    env,
  );
  return {
    schema: "e2e-probe-result/v1",
    outcome: "failed",
    runId: journey.runId,
    failureSignature: journey.failureSignature,
    taskId,
    deduplicated: false,
  };
}

export async function warmDaemonProjection({
  rootDir = repositoryRoot,
  workspaceRoot = repositoryRoot,
  env = process.env,
  attempts = 30,
  delayMs = 1_000,
  readProjection = () => runCliJson(workspaceRoot, rootDir, ["task", "list"], env),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastDetail = "the daemon answered no projection read";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = projectionStatus(await readProjection());
      if (status === "ready") return { attempts: attempt + 1, status };
      lastDetail = `projection status ${status ?? "unknown"} after ${attempt + 1} read(s)`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  throw probeError("daemon_projection_unready", `Daemon projection never reached ready: ${lastDetail}.`);
}

function projectionStatus(receipt) {
  try {
    return JSON.parse(receipt.evidence).status ?? null;
  } catch {
    return null;
  }
}

async function agentRun() {
  const journey = await runE2EProbeJourney();
  if (journey.outcome === "healthy")
    return {
      schema: "e2e-probe-result/v1",
      outcome: "healthy",
      runId: journey.runId,
      failureSignature: null,
      taskId: null,
      deduplicated: null,
    };
  return await recordE2EProbeFailure({ bundlePath: journey.bundlePath });
}

async function runCliJson(workspaceRoot, rootDir, args, env) {
  const child = spawn(
    process.execPath,
    [path.join(workspaceRoot, "packages", "cli", "src", "index.ts"), "--root", rootDir, "--json", ...args],
    {
      cwd: rootDir,
      env: { ...env, HARNESS_ACTOR: "agent:e2e-probe" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [status] = await once(child, "close");
  let receipt;
  try {
    receipt = JSON.parse(stdout.trim());
  } catch {
    throw probeError(
      "probe_closure_invalid_receipt",
      `CLI produced no JSON receipt. stderr=${stderr.trim() || "<empty>"}`,
    );
  }
  if (status !== 0 || receipt.ok !== true || receipt.outcome !== "applied")
    throw probeError(
      "probe_closure_rejected",
      String(receipt.nextAction ?? receipt.error?.hint ?? stderr.trim() ?? "Probe closure was rejected."),
    );
  return receipt;
}

function cliRows(receipt) {
  try {
    const evidence = JSON.parse(receipt.evidence);
    return Array.isArray(evidence.rows) ? evidence.rows : [];
  } catch {
    throw probeError("probe_closure_invalid_receipt", "Task list receipt omitted its structured rows.");
  }
}

function readFailureBundle(bundlePath) {
  if (typeof bundlePath !== "string" || !bundlePath)
    throw probeError("probe_bundle_missing", "Failure bundle path is required.");
  const parsed = JSON.parse(readFileSync(bundlePath, "utf8"));
  if (
    parsed.schema !== "e2e-probe-journey/v1" ||
    parsed.outcome !== "failed" ||
    typeof parsed.runId !== "string" ||
    typeof parsed.startedAt !== "string" ||
    typeof parsed.failureSignature !== "string"
  )
    throw probeError("probe_bundle_invalid", "Failure bundle must be a failed e2e-probe-journey/v1 object.");
  return parsed;
}

function signatureOf(step, code, message, rootDir) {
  const normalized = message.replaceAll(rootDir, "<repo>").replaceAll(/\s+/gu, " ").trim().slice(0, 512);
  return createHash("sha256").update(`${step}\0${code}\0${normalized}`).digest("hex").slice(0, 20);
}

function probeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function errorCode(error) {
  return typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : "probe_failed";
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value) throw probeError("probe_closure_invalid_receipt", `Missing ${field}.`);
  return value;
}

async function closeElectronApp(electronApp) {
  const child = electronApp.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--canonical-read-only") return runE2EProbeJourney();
  if (argv.length === 1 && argv[0] === "--agent-run") return agentRun();
  if (argv.length === 2 && argv[0] === "--record-failure")
    return recordE2EProbeFailure({ bundlePath: path.resolve(argv[1]) });
  throw probeError(
    "invalid_probe_command",
    "Use --canonical-read-only, --agent-run, or --record-failure <bundle-path>.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
