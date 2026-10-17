// GUI arm: the hidden-window lane gui-e2e already proved out (Playwright-driven Electron,
// --headless --disable-gpu, window asserted invisible). This arm reuses that driver and the
// disposable resident-daemon fixture to measure what the task brief asks: startup wall time
// (launch -> first window DOMContentLoaded -> first usable overview), idle CPU/RSS of the
// Electron process tree, and per-view switch latency. GPU usage is not measurable in this lane
// (GPU is disabled headless); the committed gui-read ratchet keeps covering read amplification.
import { execFileSync } from "node:child_process";
import { startGuiDriver } from "../gui-e2e/driver.mjs";
import { prepareE2EProbeGui } from "../e2e-probe.mjs";
import { startGuiResidentDaemonFixture } from "../../packages/gui/test-support/resident-daemon.mjs";
import { writeTriadicLedger } from "../../packages/gui/test-support/triadic-ledger.mjs";
import { stats } from "./baseline-stats.mjs";

const NAV_VIEWS = ["总览", "看板", "关系图"];

export async function runGuiArm({ rootDir, runRoot, idleMs = 30_000, navSamples = 8, noBuild = false, log }) {
  if (!noBuild) {
    log("[gui] building renderer/preload (vite)");
    prepareE2EProbeGui(rootDir, process.env);
  }
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  let fixture;
  try {
    fixture = await startGuiResidentDaemonFixture({
      prefix: "hg-perf-",
      daemonId: "g",
      repoId: "gui-perf",
      // task-gui-smoke is the id tools/gui-e2e's triadic ledger seeds on disk; keeping it means
      // writeTriadicLedger below lands on a task the projection actually holds.
      task: { taskId: "task-gui-smoke", title: "GUI performance baseline probe task" },
    });
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  }
  try {
    writeTriadicLedger(fixture.rootDir);
    const isolatedEnv = { ...process.env, ...fixture.env, HARNESS_DAEMON_ENDPOINT: fixture.endpoint };
    const launchStarted = Date.now();
    let driver;
    try {
      driver = await startGuiDriver({
        workspaceRoot: rootDir,
        rootDir: fixture.rootDir,
        env: isolatedEnv,
        runRoot,
      });
    } catch (error) {
      await fixture.stop();
      throw error;
    }
    driver.runRoot = runRoot;
    try {
      const windowReadyMs = Date.now() - launchStarted;
      const usableStarted = Date.now();
      await driver.page.getByTestId("real-task-summary").waitFor({ timeout: 60_000 });
      const firstUsableMs = Date.now() - launchStarted;
      log(
        `[gui] window ready ${windowReadyMs}ms, first usable ${firstUsableMs}ms (usable wait ${Date.now() - usableStarted}ms)`,
      );

      // The first-run guide modal intercepts pointer events on a fresh profile. Startup timing
      // above intentionally includes it; everything below runs with it dismissed the way a
      // user's second launch looks (localStorage flag + one reload).
      await driver.page.evaluate(() => globalThis.localStorage.setItem("harness.desktop-first-run.done", "1"));
      await driver.page.reload();
      await driver.page.getByTestId("real-task-summary").waitFor({ timeout: 60_000 });

      const electronPid = driver.app.process().pid;
      const idle = await sampleProcessTree(electronPid, idleMs, 2_000);

      const nav = {};
      for (const label of NAV_VIEWS) {
        const samples = [];
        for (let round = 0; round < navSamples; round += 1) {
          const started = Date.now();
          await driver.page.getByRole("button", { name: label, exact: true }).click();
          await driver.page.getByTestId("real-task-summary").waitFor({ timeout: 30_000 });
          samples.push(Date.now() - started);
        }
        nav[label] = stats(samples);
        log(`[gui] nav ${label}: p50=${nav[label].p50Ms}ms p95=${nav[label].p95Ms}ms (${navSamples} samples)`);
      }

      return {
        schema: "perf-baseline-gui-arm/v1",
        measuredAt: new Date().toISOString(),
        lane: "hidden window (--headless --disable-gpu, visibility asserted false by the driver)",
        startup: {
          windowReadyMs,
          firstUsableMs,
          shape: "electron.launch -> firstWindow domcontentloaded -> overview real-task-summary visible",
        },
        idle: {
          windowMs: idleMs,
          electronPid,
          mainRssMib: stats(idle.main.map((row) => row.rssMib)),
          treeRssMib: stats(idle.tree.map((row) => row.rssMib)),
          treeCpuPercent: stats(idle.tree.map((row) => row.cpuPercent)),
          trailingTreeCpuPercent: trailingStats(idle.tree.map((row) => row.cpuPercent)),
          cpuNote:
            "ps %cpu on macOS is a lifetime-decayed average, so the early samples still carry launch burn; trailingTreeCpuPercent is the last quarter of the window, the closest this lane gets to steady-state idle",
          processCount: idle.processCount,
        },
        viewSwitchMs: nav,
        gpu: {
          measured: false,
          reason: "GPU is disabled in the hidden-window lane; desktop GPU usage needs an owner-run visible measurement",
        },
      };
    } finally {
      await driver.close();
    }
  } finally {
    await fixture.stop();
  }
}

// ps-based process tree sampling: the Electron main pid plus its direct children (renderer,
// gpu-process is disabled headless). %cpu on macOS reports recent usage; it is an observation,
// not an accounting claim.
async function sampleProcessTree(pid, durationMs, intervalMs) {
  const main = [];
  const tree = [];
  let processCount = 0;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,%cpu="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s*$/u.exec(line);
        return match
          ? [
              {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                rssMib: round1(Number(match[3]) / 1024),
                cpuPercent: Number(match[4]),
              },
            ]
          : [];
      });
    const children = rows.filter((row) => row.ppid === pid);
    const all = [rows.find((row) => row.pid === pid), ...children].filter(Boolean);
    processCount = Math.max(processCount, all.length);
    const atMs = Date.now();
    const own = rows.find((row) => row.pid === pid);
    if (own) main.push({ atMs, rssMib: own.rssMib });
    if (all.length)
      tree.push({
        atMs,
        rssMib: round1(all.reduce((sum, row) => sum + row.rssMib, 0)),
        cpuPercent: round1(all.reduce((sum, row) => sum + row.cpuPercent, 0)),
      });
    await delay(intervalMs);
  }
  return { main, tree, processCount };
}

// Stats over the trailing quarter of a sample window: ps %cpu is a lifetime-decayed average on
// macOS, so the tail of a long quiet window is the honest steady-state estimate.
function trailingStats(values) {
  if (values.length === 0) return stats(values);
  return stats(values.slice(Math.floor(values.length * 0.75)));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
