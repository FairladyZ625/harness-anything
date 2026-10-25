// Daemon arm: one throwaway fixture whose daemon is respawned from the source entry with the
// event-loop probe preloaded (NODE_OPTIONS --import; no product code touched). Measures cold boot
// (spawn -> repo attached), sequential RPC read p50/p95 (client wall + daemon-side serviceMs from
// the connection log), durable-write p50/p95 (repo.task.run fact records), resident memory from
// the OS and from inside the daemon, and event-loop delay percentiles while idle and under load.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { requestDaemonJsonRpcAt } from "../../packages/daemon/src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../../packages/daemon/src/client/local-daemon-target.ts";
import { bytesToMib, round3, stats, summarizeEventLoopLines } from "./baseline-stats.mjs";
import {
  PROBE_REPO_ID,
  PROBE_TASK_ID,
  bindFixtureRealm,
  fixtureEnv,
  initializeFixtureRepo,
  makeCliFixture,
  stopFixtureDaemon,
  withoutExecutionCredential,
} from "./baseline-fixture.mjs";

const daemonHostEntry = "packages/daemon/src/bin.ts";

export async function runDaemonArm({ rootDir, outDir, readRounds = 10, writeRounds = 8, idleMs = 10_000, log }) {
  const fixture = makeCliFixture(rootDir);
  const eventLoopLog = path.join(outDir, "daemon-eventloop.jsonl");
  if (existsSync(eventLoopLog)) rmSync(eventLoopLog);
  const windows = { idle: null, load: null };
  const realm = await bindFixtureRealm(fixture);
  try {
    const probeImport = `--import=${pathToFileURL(path.join(rootDir, "tools/perf/daemon-eventloop-probe.mjs")).href}`;
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      [path.join(rootDir, daemonHostEntry), "serve", "--user-root", fixture.userRoot, "--daemon-id", "default"],
      {
        env: fixtureEnv(fixture, { NODE_OPTIONS: probeImport, HA_PERF_EVENTLOOP_LOG: eventLoopLog }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let daemonOutput = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        daemonOutput += chunk;
      });
    const endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
    try {
      await waitForDaemonReady(endpoint, 60_000, () => daemonOutput);
      const socketReadyMs = round3(performance.now() - startedAt);
      // The suite pre-spawns the daemon (with the probe) instead of letting init autostart one,
      // so the probe observes every request; init then registers the repo on this daemon.
      await initializeFixtureRepo(fixture);
      await waitForAttached(endpoint, PROBE_REPO_ID, 120_000, () => daemonOutput);
      log(`[daemon] socket ready ${socketReadyMs}ms; repo attached at ${round3(performance.now() - startedAt)}ms`);

      windows.idle = { startMs: Date.now(), endMs: Date.now() + idleMs };
      const idleRss = sampleRssUntil(child.pid, windows.idle.endMs);
      await delayUntil(windows.idle.endMs);

      const loadStart = Date.now();
      const reads = {
        "repo.tasks.list": [],
        "repo.task.read": [],
        "repo.agenda.read": [],
        "repo.decisions.list": [],
        "daemon.runtimeInstance.list": [],
      };
      const writes = [];
      const loadRss = sampleRssInBackground(child.pid);
      for (let round = 0; round < readRounds; round += 1) {
        const listMs = await timedRpc(endpoint, "repo.tasks.list", {
          repo: { repoId: PROBE_REPO_ID },
          payload: { limit: 50 },
        });
        reads["repo.tasks.list"].push(listMs);
        const readMs = await timedRpc(endpoint, "repo.task.read", {
          repo: { repoId: PROBE_REPO_ID },
          payload: { action: { kind: "task-show", taskId: PROBE_TASK_ID } },
        });
        reads["repo.task.read"].push(readMs);
        for (const [method, params] of [
          ["repo.agenda.read", { repo: { repoId: PROBE_REPO_ID }, payload: {} }],
          ["repo.decisions.list", { repo: { repoId: PROBE_REPO_ID }, payload: { projection: "summary" } }],
          ["daemon.runtimeInstance.list", { payload: {} }],
        ]) {
          reads[method].push(await timedRpc(endpoint, method, params));
        }
      }
      for (let round = 0; round < writeRounds; round += 1) {
        const writeMs = await timedRpc(endpoint, "repo.task.run", {
          repo: { repoId: PROBE_REPO_ID },
          payload: {
            action: {
              kind: "fact-record",
              taskId: PROBE_TASK_ID,
              statement: `daemon arm write sample ${round} ${new Date().toISOString()}`,
              evidenceSource: "tools/perf/baseline-daemon-arm.mjs",
              // The CLI fills these defaults; the raw RPC action must carry them explicitly.
              confidence: "medium",
              memoryClass: "semantic",
            },
          },
        });
        writes.push(writeMs);
        log(`[daemon] write ${round + 1}/${writeRounds}: ${writeMs}ms`);
      }
      await delay(1_000); // conn-log appends are off the reply path; settle before reading them
      const loadEnd = Date.now();
      windows.load = { startMs: loadStart, endMs: loadEnd + 1_000 };
      loadRss.stop = true;

      const serverSide = serverSideLatencies(fixture.userRoot, child.pid, windows.load);
      const loop = existsSync(eventLoopLog)
        ? summarizeEventLoopLines(readFileSync(eventLoopLog, "utf8").split("\n").filter(Boolean), windows)
        : { summary: {}, parseErrors: 0, records: [] };

      return {
        schema: "perf-baseline-daemon-arm/v1",
        measuredAt: new Date().toISOString(),
        entry: daemonHostEntry,
        socketReadyMs,
        coldBootMs: round3(performance.now() - startedAt),
        coldBootShape:
          "spawn -> daemon.status ok (socketReadyMs); repo registered+attached through a real ha init afterwards",
        reads: {
          rounds: readRounds,
          clientWallMs: Object.fromEntries(Object.entries(reads).map(([method, values]) => [method, stats(values)])),
          serverServiceMs: serverSide,
        },
        writes: {
          rounds: writeRounds,
          shape: "repo.task.run fact-record, durable receipt awaited",
          clientWallMs: stats(writes),
          serverServiceMs: serverSide["repo.task.run"] ?? null,
        },
        memory: {
          idleRssMib: stats((await idleRss).map((row) => bytesToMib(row.rssBytes))),
          loadRssMib: stats((await loadRss.promise).map((row) => bytesToMib(row.rssBytes))),
          inDaemonIdleRssMib: loop.summary.idle?.rssMib ?? null,
          inDaemonLoadRssMib: loop.summary.load?.rssMib ?? null,
          rssSource: "ps -o rss= (external) and process.memoryUsage inside the daemon probe",
        },
        eventLoopDelay: loop.summary,
        eventLoopParseErrors: loop.parseErrors,
      };
    } finally {
      await stopDaemon(child, fixture);
    }
  } finally {
    await realm.close();
    await stopFixtureDaemon(fixture);
    rmSync(fixture.fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function waitForDaemonReady(endpoint, timeoutMs, describeDaemonOutput) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    const ok = await withoutExecutionCredential(async () => {
      try {
        const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 250, 2_000);
        return status.ok === true;
      } catch {
        return false;
      }
    });
    if (ok) return;
    await delay(150);
  }
  throw new Error(`fixture daemon did not answer within ${timeoutMs}ms: ${describeDaemonOutput().slice(-600)}`);
}

async function timedRpc(endpoint, method, params) {
  const started = performance.now();
  const receipt = await withoutExecutionCredential(() =>
    requestDaemonJsonRpcAt(endpoint, method, params, 1_000, 30_000),
  );
  if (receipt.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(receipt).slice(0, 600)}`);
  return round3(performance.now() - started);
}

async function waitForAttached(endpoint, repoId, timeoutMs, describeDaemonOutput) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    const repo = await withoutExecutionCredential(async () => {
      try {
        const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 250, 2_000);
        const found = status.repos?.find?.((candidate) => candidate.repoId === repoId);
        if (found?.state === "unavailable") throw new Error(`fixture repo unavailable: ${found.lastError}`);
        return found ?? null;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("fixture repo unavailable")) throw error;
        return null;
      }
    });
    if (repo?.state === "attached") return;
    await delay(150);
  }
  throw new Error(
    `fixture daemon did not attach ${repoId} within ${timeoutMs}ms: ${describeDaemonOutput().slice(-600)}`,
  );
}

// ps-sampled RSS series. `sampleRssUntil` runs to a wall-clock end; `sampleRssInBackground` keeps
// sampling until `.stop` flips and resolves through `.promise`.
function readRssKib(pid) {
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

async function sampleRssUntil(pid, endMs) {
  const samples = [];
  while (Date.now() < endMs) {
    samples.push({ atMs: Date.now(), rssBytes: readRssKib(pid) * 1024 });
    await delay(1_000);
  }
  return samples;
}

function sampleRssInBackground(pid) {
  const state = { stop: false, samples: [], promise: null };
  state.promise = (async () => {
    while (!state.stop) {
      state.samples.push({ atMs: Date.now(), rssBytes: readRssKib(pid) * 1024 });
      await delay(1_000);
    }
    return state.samples;
  })();
  return state;
}

function serverSideLatencies(userRoot, pid, window) {
  const logDir = path.join(userRoot, "logs");
  const byMethod = new Map();
  if (!existsSync(logDir)) return Object.fromEntries([...byMethod].map(([method, values]) => [method, stats(values)]));
  for (const name of readdirSync(logDir).sort()) {
    if (!name.startsWith("daemon-default-conn-") || !name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(path.join(logDir, name), "utf8").split("\n")) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.event !== "request" || row.pid !== pid || typeof row.method !== "string") continue;
      const at = Date.parse(row.atEnd ?? row.at);
      if (!Number.isFinite(at) || at < window.startMs - 2_000 || at > window.endMs + 2_000) continue;
      const serviceMs = Number(row.serviceMs ?? row.durationMs);
      if (!Number.isFinite(serviceMs)) continue;
      byMethod.set(row.method, [...(byMethod.get(row.method) ?? []), serviceMs]);
    }
  }
  return Object.fromEntries([...byMethod].map(([method, values]) => [method, stats(values)]));
}

async function stopDaemon(child, fixture) {
  await stopFixtureDaemon(fixture);
  for (const deadline = Date.now() + 15_000; Date.now() < deadline && child.exitCode === null; ) await delay(200);
  if (child.exitCode === null) child.kill("SIGTERM");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayUntil(endMs) {
  return delay(Math.max(0, endMs - Date.now()));
}
