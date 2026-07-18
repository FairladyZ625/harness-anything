/**
 * P3 wall-clock Electron measure helpers and single-case runner.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { writePerfFixture } from "./p3-wall-clock-fixture.mjs";
import { COLD_TARGET_MS, WARM_TARGET_MS, DOM_CEILING } from "./p3-wall-clock-report.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const guiRoot = resolve(scriptDir, "..");
export const repoRoot = resolve(guiRoot, "../..");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function closeElectronApp(electronApp) {
  const child = electronApp.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(5_000)]);
}

export async function installLongTaskObserver(page) {
  await page.evaluate(() => {
    const host = globalThis;
    host.__harnessLongTasks = [];
    try {
      const Observer = globalThis.PerformanceObserver;
      if (typeof Observer !== "function") return;
      const obs = new Observer((list) => {
        for (const entry of list.getEntries()) {
          host.__harnessLongTasks.push({
            name: entry.name,
            duration: entry.duration,
            startTime: entry.startTime,
            entryType: entry.entryType,
          });
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
      host.__harnessLongTaskObserver = obs;
    } catch {
      // longtask may be unavailable in some Chromium builds
    }
  });
}

export async function collectMetrics(page, electronApp, view) {
  const domCount = await page.evaluate(() => globalThis.document.querySelectorAll("*").length);
  const longTasks = await page.evaluate(() => globalThis.__harnessLongTasks ?? []);
  const longestLongTaskMs = longTasks.reduce((m, t) => Math.max(m, t.duration ?? 0), 0);
  const heap = await page.evaluate(() => {
    const m = performance.memory;
    return m
      ? {
          usedJSHeapBytes: m.usedJSHeapSize,
          totalJSHeapBytes: m.totalJSHeapSize,
          jsHeapSizeLimit: m.jsHeapSizeLimit,
        }
      : null;
  });
  const appMetrics = await electronApp.evaluate(async ({ app: electronAppRef }) => {
    const metrics = electronAppRef.getAppMetrics?.() ?? [];
    const byType = {};
    let totalWorkingSetKb = 0;
    for (const row of metrics) {
      const kb = row.memory?.workingSetSize ?? 0;
      totalWorkingSetKb += kb;
      byType[row.type] = (byType[row.type] ?? 0) + kb;
    }
    return {
      processCount: metrics.length,
      totalWorkingSetKb,
      byType,
      mainProcess: process.memoryUsage(),
    };
  });
  const child = electronApp.process();
  let rssKb = null;
  try {
    const ps = execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], {
      encoding: "utf8",
    }).trim();
    rssKb = Number(ps) || null;
  } catch {
    // keep null
  }
  const trace = await page.evaluate((v) => globalThis.__harnessPerfTrace?.[v] ?? null, view);
  const markerElapsed = (name) => {
    if (!trace) return null;
    const start = trace.startedAt;
    const marker = (trace.markers ?? []).find((m) => m.name === name);
    if (marker == null) return null;
    return Math.round((marker.at - start) * 100) / 100;
  };
  return {
    domCount,
    longestLongTaskMs: Math.round(longestLongTaskMs * 100) / 100,
    longTaskCount: longTasks.length,
    heap,
    appMetrics,
    rssKb,
    inView: {
      navigationStartToDataReadyMs: markerElapsed("data-ready"),
      navigationStartToFirstMeaningfulMs: markerElapsed("first-meaningful-rows"),
      navigationStartToFirstUsableMs: markerElapsed("first-usable"),
      markers: (trace?.markers ?? []).map((m) => m.name),
    },
  };
}

export async function waitFirstUsable(page, view, timeoutMs) {
  const usable = page.locator(
    `[data-first-usable="true"][data-first-usable-view="${view}"]`,
  );
  await usable.waitFor({ timeout: timeoutMs });
  // Sanity: must not be empty shell — require interactive content markers.
  // Use the same budget as first-usable: large fixtures can paint usable
  // before the sidebar summary query settles.
  if (view === "overview") {
    const surface = page
      .getByTestId("real-task-summary")
      .or(page.getByTestId("task-empty-state"))
      .or(page.locator('[data-first-usable-view="overview"]'));
    await surface.first().waitFor({ timeout: Math.min(timeoutMs, 30_000) });
    // Prefer real summary when present, but do not fail the whole case if the
    // sidebar summary is still loading while the Overview body is interactive.
    const hasSummary = await page.getByTestId("real-task-summary").count();
    const hasEmpty = await page.getByTestId("task-empty-state").count();
    const hasOverviewBody = await page.locator('[data-first-usable-view="overview"]').count();
    if (hasSummary + hasEmpty + hasOverviewBody === 0) {
      throw new Error("overview first-usable present but no interactive body/summary");
    }
  } else if (view === "executions") {
    const body = page.locator('[data-first-usable-view="executions"], h1');
    await body.first().waitFor({ timeout: Math.min(timeoutMs, 30_000) });
  }
}


export async function measureCase(size, outputsPerExecution) {
  const label = `${size}x${outputsPerExecution}`;
  console.error(`[p3-wall] === case ${label} ===`);
  const ledgerRoot = mkdtempSync(path.join(tmpdir(), `ha-p3-wc-${label}-`));
  const fixtureWriteMs = writePerfFixture(ledgerRoot, size, outputsPerExecution);
  console.error(`[p3-wall] fixture wrote ${size} tasks in ${fixtureWriteMs}ms @ ${ledgerRoot}`);

  let electronApp;
  const result = {
    size,
    outputsPerExecution,
    label,
    fixtureWriteMs,
    ledgerRoot: "<temporary>",
    cold: {},
    warm: {},
    error: null,
  };

  try {
    const launchStarted = performance.now();
    electronApp = await electron.launch({
      executablePath: electronPath,
      args: [resolve(guiRoot, "src/main/electron-main.ts")],
      cwd: repoRoot,
      env: {
        ...process.env,
        HARNESS_GUI_ROOT: ledgerRoot,
        HARNESS_DAEMON_USER_ROOT: path.join(ledgerRoot, "daemon-user"),
        HARNESS_DAEMON_IDLE_MS: "15000",
        // Keep daemon quiet-ish
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(Math.max(30_000, size * 20));
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.waitForLoadState("domcontentloaded");
    const domContentLoadedMs = Math.round(performance.now() - launchStarted);
    await page.evaluate(() => globalThis.localStorage.setItem("harness-locale", "zh-CN"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await installLongTaskObserver(page);

    // --- COLD: Overview first-usable (default view) ---
    const overviewColdStart = performance.now();
    await waitFirstUsable(page, "overview", Math.max(120_000, size * 40));
    // Reject empty-shell first-usable: require data-ready marker with real taskCount when size>0.
    await page.waitForFunction(
      (expectedMinTasks) => {
        const trace = globalThis.__harnessPerfTrace?.overview;
        if (!trace) return false;
        const names = (trace.markers ?? []).map((m) => m.name);
        if (!names.includes("first-usable") || !names.includes("data-ready")) return false;
        const dataReady = (trace.markers ?? []).find((m) => m.name === "data-ready");
        const taskCount = dataReady?.detail?.taskCount;
        if (expectedMinTasks > 0 && (typeof taskCount !== "number" || taskCount < 1)) return false;
        return true;
      },
      size,
      { timeout: Math.max(120_000, size * 40) },
    );
    const overviewColdWallMs = Math.round(performance.now() - overviewColdStart);
    const overviewLaunchToUsableMs = Math.round(performance.now() - launchStarted);
    const overviewMetrics = await collectMetrics(page, electronApp, "overview");
    console.error(
      `[p3-wall] overview cold first-usable wall=${overviewColdWallMs}ms launch-to-usable=${overviewLaunchToUsableMs}ms dom=${overviewMetrics.domCount}`,
    );

    // --- COLD: navigate to Execution Evidence ---
    // Clear long tasks before EE nav for per-view long-task attribution.
    await page.evaluate(() => {
      globalThis.__harnessLongTasks = [];
    });
    const eeNavStart = performance.now();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /执行证据|Evidence|evidence/iu })
      .click();
    await waitFirstUsable(page, "executions", Math.max(120_000, size * 40));
    const eeColdFirstNavMs = Math.round(performance.now() - eeNavStart);
    const eeLaunchToUsableMs = Math.round(performance.now() - launchStarted);
    const eeMetrics = await collectMetrics(page, electronApp, "executions");
    console.error(
      `[p3-wall] executions cold first-nav=${eeColdFirstNavMs}ms launch-to-usable=${eeLaunchToUsableMs}ms dom=${eeMetrics.domCount}`,
    );

    // --- WARM: leave executions and re-enter ---
    await page.evaluate(() => {
      globalThis.__harnessLongTasks = [];
    });
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /总览|Overview|overview/iu })
      .click();
    await waitFirstUsable(page, "overview", 30_000);
    const warmStart = performance.now();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /执行证据|Evidence|evidence/iu })
      .click();
    await waitFirstUsable(page, "executions", 30_000);
    const eeWarmReentryMs = Math.round(performance.now() - warmStart);
    const eeWarmMetrics = await collectMetrics(page, electronApp, "executions");
    console.error(`[p3-wall] executions warm re-entry=${eeWarmReentryMs}ms dom=${eeWarmMetrics.domCount}`);

    // Overview warm re-entry
    await page.evaluate(() => {
      globalThis.__harnessLongTasks = [];
    });
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /执行证据|Evidence|evidence/iu })
      .click();
    await waitFirstUsable(page, "executions", 15_000);
    const ovWarmStart = performance.now();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /总览|Overview|overview/iu })
      .click();
    await waitFirstUsable(page, "overview", 30_000);
    const overviewWarmMs = Math.round(performance.now() - ovWarmStart);
    const overviewWarmMetrics = await collectMetrics(page, electronApp, "overview");

    result.cold = {
      launchToOverviewFirstUsableMs: overviewLaunchToUsableMs,
      overviewFirstUsableFromReloadMs: overviewColdWallMs,
      domContentLoadedMs,
      launchToExecutionsFirstUsableMs: eeLaunchToUsableMs,
      executionsFirstNavMs: eeColdFirstNavMs,
      overview: overviewMetrics,
      executions: eeMetrics,
    };
    result.warm = {
      executionsReentryMs: eeWarmReentryMs,
      overviewReentryMs: overviewWarmMs,
      executions: eeWarmMetrics,
      overview: overviewWarmMetrics,
    };
    result.consoleErrors = consoleErrors.slice(0, 20);
    // Primary targets from task_plan Verification (Execution Evidence oriented).
    // 1k: cold first-usable < 10s, warm re-entry < 3s.
    // 5k: operable first screen within 10s (Overview launch or EE first-nav).
    const fiveKFirstScreenMet =
      size < 5_000
        ? null
        : overviewLaunchToUsableMs < COLD_TARGET_MS || eeColdFirstNavMs < COLD_TARGET_MS;
    result.goals = {
      coldTargetMs: COLD_TARGET_MS,
      warmTargetMs: WARM_TARGET_MS,
      domCeiling: DOM_CEILING,
      executionsColdFirstNavMet: eeColdFirstNavMs < COLD_TARGET_MS,
      executionsWarmReentryMet: eeWarmReentryMs < WARM_TARGET_MS,
      launchToOverviewUsableMet: overviewLaunchToUsableMs < COLD_TARGET_MS,
      launchToExecutionsUsableMet: eeLaunchToUsableMs < COLD_TARGET_MS,
      fiveKFirstScreenMet,
      overviewDomMet: overviewMetrics.domCount <= DOM_CEILING,
      executionsDomMet: eeMetrics.domCount <= DOM_CEILING,
    };
  } catch (error) {
    result.error = {
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    };
    console.error(`[p3-wall] ERROR ${label}:`, error?.message ?? error);
  } finally {
    if (electronApp) await closeElectronApp(electronApp);
    await sleep(6_000);
    rmSync(ledgerRoot, { recursive: true, force: true });
  }
  return result;
}


export function runProjectionLayer(size, outputs) {
  console.error(`[p3-wall] projection/transport layer via perf:gui size=${size} outputs=${outputs}`);
  const started = performance.now();
  const proc = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "tools/perf/gui-projection-benchmark.mjs"),
      "--size",
      String(size),
      "--outputs",
      String(outputs),
      "--attribution-events",
      "1",
      "--update-samples",
      "1",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
      timeout: 600_000,
    },
  );
  const elapsedMs = Math.round(performance.now() - started);
  if (proc.error) {
    return {
      ok: false,
      elapsedMs,
      error: proc.error.message,
      stderr: proc.stderr?.slice?.(0, 2000) ?? String(proc.stderr),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch (error) {
    return {
      ok: false,
      elapsedMs,
      exitCode: proc.status,
      error: `JSON parse failed: ${error.message}`,
      stdoutTail: proc.stdout?.slice?.(-2000),
      stderrTail: proc.stderr?.slice?.(-2000),
    };
  }
  return {
    ok: proc.status === 0,
    elapsedMs,
    exitCode: proc.status,
    fixture: parsed.fixture,
    milliseconds: {
      evidenceFacetBuild: parsed.milliseconds?.evidenceFacetBuild,
      rebuild: parsed.milliseconds?.rebuild,
      queryExecutionEvidencePageFromReadyGeneration:
        parsed.milliseconds?.queryExecutionEvidencePageFromReadyGeneration,
      queryExecutionEvidencePageFromDaemonGeneration:
        parsed.milliseconds?.queryExecutionEvidencePageFromDaemonGeneration,
      daemonGenerationReady: parsed.milliseconds?.daemonGenerationReady,
      readTriadicProjectionSnapshot: parsed.milliseconds?.readTriadicProjectionSnapshot,
      aggregateExecutions: parsed.milliseconds?.aggregateExecutions,
    },
    assertions: {
      evidencePagePayloadBytes: parsed.assertions?.evidencePagePayloadBytes,
      legacyExecutionsPayloadBytes: parsed.assertions?.legacyExecutionsPayloadBytes,
      readyEvidencePageWithinBudget: parsed.assertions?.readyEvidencePageWithinBudget,
      daemonEvidencePageWithinBudget: parsed.assertions?.daemonEvidencePageWithinBudget,
      coldProjectionBuildWithinBudget: parsed.assertions?.coldProjectionBuildWithinBudget,
      evidenceFacetBuildWithinBudget: parsed.assertions?.evidenceFacetBuildWithinBudget,
      coldFirstUsableWithinBudget: parsed.assertions?.coldFirstUsableWithinBudget,
      coldFirstUsableMs: parsed.assertions?.coldFirstUsableMs,
    },
  };
}


