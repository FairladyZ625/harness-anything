import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { requestDaemonJsonRpcAt } from "../../packages/daemon/src/client/local-json-rpc-client.ts";
import { buildTimeline, discoverConnLogFiles, loadConnLogRecords } from "../logs/log-timeline.mjs";

const MIB = 1024 * 1024;

export async function rssLoop({ pid, stopAt, samples }) {
  const started = performance.now();
  while (Date.now() < stopAt) {
    samples.push({ atMs: performance.now() - started, rssBytes: readRssBytes(pid) });
    await delay(2_000);
  }
  samples.push({ atMs: performance.now() - started, rssBytes: readRssBytes(pid) });
}

function readRssBytes(pid) {
  if (process.platform === "linux") {
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (!match) throw new Error(`VmRSS is missing for daemon pid ${pid}`);
    return Number(match[1]) * 1024;
  }
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024;
}

export function timelineFor({ userRoot, daemonId }) {
  const files = discoverConnLogFiles({ userRoot, daemonId });
  if (files.length === 0) throw new Error(`no connection log was written for daemon ${daemonId}`);
  return buildTimeline(loadConnLogRecords(files));
}

export async function waitForAttachedRepo({ child, endpoint, repoId, timeoutMs }) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (child.exitCode !== null) throw new Error(`daemon exited during startup with code ${child.exitCode}`);
    try {
      const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 500, 2_000);
      const repo = status.repos?.find?.((candidate) => candidate.repoId === repoId);
      if (repo?.state === "attached") return;
      if (repo?.state === "unavailable") throw new Error(`scale repo unavailable: ${repo.lastError}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("scale repo unavailable")) throw error;
    }
    await delay(100);
  }
  throw new Error(`daemon did not attach ${repoId} within ${timeoutMs}ms`);
}

export function readConfig(env = process.env) {
  return {
    taskCount: positive(env.HARNESS_SOAK_TASKS, 1_377),
    eventCount: positive(env.HARNESS_SOAK_EVENTS, 26_650),
    durationMs: positive(env.HARNESS_SOAK_DURATION_MS, 120_000),
    warmupMs: positive(env.HARNESS_SOAK_WARMUP_MS, 30_000),
    faultDurationMs: positive(env.HARNESS_SOAK_FAULT_MS, 10_000),
    startupTimeoutMs: positive(env.HARNESS_SOAK_STARTUP_TIMEOUT_MS, 300_000),
    concurrency: positive(env.HARNESS_SOAK_CONCURRENCY, 8),
    requestIntervalMs: positive(env.HARNESS_SOAK_REQUEST_INTERVAL_MS, 500),
    helloProbeIntervalMs: positive(env.HARNESS_SOAK_HELLO_INTERVAL_MS, 500),
    maxFaultConnections: positive(env.HARNESS_SOAK_MAX_FAULT_CONNECTIONS, 6),
    maxHelloP99Ms: positive(env.HARNESS_SOAK_MAX_HELLO_P99_MS, 500),
    maxRssGrowthBytes: positive(env.HARNESS_SOAK_MAX_RSS_GROWTH_MIB, 32) * MIB,
    maxRssSlopeBytesPerMinute: positive(env.HARNESS_SOAK_MAX_RSS_SLOPE_MIB_PER_MIN, 12) * MIB,
    workloadMethodOverride: optionalText(env.HARNESS_SOAK_WORKLOAD_METHOD_OVERRIDE),
    resultsDir: env.HARNESS_SOAK_RESULTS_DIR || "tmp/soak-results",
  };
}

function positive(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`soak configuration must be positive integers; received ${value}`);
  return parsed;
}
function optionalText(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0)
    throw new Error("HARNESS_SOAK_WORKLOAD_METHOD_OVERRIDE must be a non-empty method name");
  return value;
}
export function git(rootDir, ...args) {
  execFileSync("git", ["-C", rootDir, ...args], { stdio: "ignore" });
}
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
export function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
export function waitForChildExit(child, timeoutMs) {
  return Promise.race([
    new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("close", resolve))),
    delay(timeoutMs).then(() => {
      throw new Error(`daemon did not exit within ${timeoutMs}ms`);
    }),
  ]);
}
export async function waitForMissing(target, timeoutMs) {
  for (const deadline = Date.now() + timeoutMs; existsSync(target) && Date.now() < deadline; ) await delay(25);
  if (existsSync(target)) throw new Error(`daemon endpoint remained after stop: ${target}`);
}
export async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForChildExit(child, 5_000);
  } catch {
    child.kill("SIGKILL");
    await waitForChildExit(child, 2_000).catch(() => undefined);
  }
}
