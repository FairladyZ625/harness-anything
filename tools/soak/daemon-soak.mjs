#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { REPLAY_TASK_GRAPH, eventObjectTarget, registerDaemonRepo, serializeCanonicalEvent, serializeEventHead, sha256Text } from "../../packages/kernel/src/index.ts";
import { JsonRpcLineClient, connectSocket, requestDaemonJsonRpcAt } from "../../packages/daemon/src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../../packages/daemon/src/client/local-daemon-target.ts";
import { streamAgentRuntimeAt } from "../../packages/daemon/src/client/local-json-rpc-stream.ts";
import { openDaemonConnLog } from "../../packages/daemon/src/conn-log.ts";
import { currentDaemonProtocolVersion } from "../../packages/daemon/src/protocol/version.ts";
import { assessHermeticConfig } from "../test-hermetic-preflight.mjs";
import { buildTimeline, discoverConnLogFiles, loadConnLogRecords, renderTimeline } from "../logs/log-timeline.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const cliEntry = path.join(repoRoot, "packages/cli/src/index.ts");
const MIB = 1024 * 1024;

const soakActor = Object.freeze({ principal: { personId: "person-soak" }, executor: null });
const runtimeDefinition = Object.freeze({ schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "instance-soak", installationId: "installation-soak", kindId: "codex", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: null, authMode: "subscription" });

export function createSoakEvents({ taskCount, eventCount }) {
  if (!Number.isInteger(taskCount) || taskCount < 1) throw new Error("taskCount must be a positive integer");
  if (!Number.isInteger(eventCount) || eventCount < taskCount + 3) throw new Error("eventCount must leave room for every task and the runtime stream fixture");
  const events = [], tasks = [];
  const append = (schema, type, payload, taskId) => {
    const revision = events.length + 1, suffix = String(revision).padStart(8, "0");
    events.push({ schema, eventId: `event-soak-${suffix}`, workspaceRevision: revision, opId: `op-soak-${suffix}`, ...(taskId ? { taskId } : {}), type, actor: soakActor, source: "local", occurredAt: new Date(Date.UTC(2026, 0, 1) + revision * 1_000).toISOString(), payload });
  };
  for (let index = 0; index < taskCount; index += 1) {
    const taskId = `task_soak_${String(index).padStart(6, "0")}`;
    const task = { schema: "task/v1", taskId, title: `Nightly soak task ${String(index).padStart(6, "0")}`, taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: soakActor, completionGateIds: [], presetSnapshotDigest: null,
      metadata: { idempotencyKey: null, parentTaskId: index === 0 ? null : `task_soak_${String(index - 1).padStart(6, "0")}`, workKind: "test", riskTier: "medium", urgency: "medium", verticalId: "software/coding", presetId: "baseline", profileId: "baseline", moduleKey: "daemon", slug: `nightly-soak-${String(index).padStart(6, "0")}`, surfaces: ["packages/daemon"], fromLegacyId: null } };
    tasks.push(task);
    append("task-event/v1", "task_created", { task }, taskId);
  }
  append("agent-runtime-event/v1", "runtime_installation_observed", { installationId: "installation-soak", kindId: "codex", protocolFamily: "codex", hostRef: "host:soak", version: "1.0.0", discoverySource: "wrapper", capabilities: ["structured_witness", "attach"] });
  append("agent-runtime-event/v1", "runtime_dispatch_requested", { dispatchId: "dispatch-soak", runtimeSessionId: "runtime-session-soak", instanceId: runtimeDefinition.instanceId, installationId: runtimeDefinition.installationId, kindId: runtimeDefinition.kindId, idempotencyKey: "nightly-soak", definitionSnapshotRef: "artifact:runtime-definition/nightly-soak", definitionSnapshot: runtimeDefinition });
  append("agent-runtime-event/v1", "runtime_session_started", { runtimeSessionId: "runtime-session-soak", instanceId: runtimeDefinition.instanceId, installationId: runtimeDefinition.installationId, kindId: runtimeDefinition.kindId, definitionSnapshotRef: "artifact:runtime-definition/nightly-soak", launchGeneration: 1, attachable: true });
  for (let index = 0; events.length < eventCount; index += 1) {
    const task = tasks[index % tasks.length];
    append("task-event/v1", "task_transitioned", { task, mutation: { command: "transition", reason: "nightly soak scale filler", fields: [] }, documentClaims: [] }, task.taskId);
  }
  return events;
}

export function assessConnections({ normal, fault, maxFaultConnections }) {
  const failures = [];
  if (normal.connections.stillOpen !== 0) failures.push(`${normal.connections.stillOpen} normal-load connection(s) remained open`);
  if (normal.growth.startedMinute !== null) failures.push(`active connections entered a sustained climb at ${normal.growth.startedMinute}`);
  if (fault.connections.stillOpen !== 0) failures.push(`${fault.connections.stillOpen} fault-window connection(s) remained open`);
  if (fault.connections.opened > maxFaultConnections) failures.push(`fault window opened ${fault.connections.opened} > ${maxFaultConnections}`);
  const prefix = failures.length === 0 ? "PASS" : "FAIL";
  return {
    ok: failures.length === 0,
    message: `${prefix} bounded connections: ${failures.join("; ") || `${normal.connections.opened} normal opens drained; ${fault.connections.opened}/${maxFaultConnections} fault opens`}`
  };
}

export function assessHelloLatency({ clientSamplesMs, daemon, maxP99Ms }) {
  const clientP99Ms = percentile(clientSamplesMs, 0.99);
  const daemonP99Ms = daemon.methods.find(({ method }) => method === "protocol.hello")?.p99Ms ?? Number.POSITIVE_INFINITY;
  const failures = [];
  if (clientP99Ms > maxP99Ms) failures.push(`client P99 ${formatMs(clientP99Ms)} > ${formatMs(maxP99Ms)}`);
  if (daemonP99Ms > maxP99Ms) failures.push(`daemon dispatch P99 ${formatMs(daemonP99Ms)} > ${formatMs(maxP99Ms)}`);
  const prefix = failures.length === 0 ? "PASS" : "FAIL";
  return {
    ok: failures.length === 0,
    clientP99Ms,
    daemonP99Ms,
    message: `${prefix} protocol.hello latency: ${failures.join("; ") || `client P99 ${formatMs(clientP99Ms)}, daemon dispatch P99 ${formatMs(daemonP99Ms)} <= ${formatMs(maxP99Ms)}`}`
  };
}

export function assessRssTrend({ samples, maxGrowthBytes, maxSlopeBytesPerMinute }) {
  if (samples.length < 4) return { ok: false, message: `FAIL RSS trend: only ${samples.length} samples; need at least 4` };
  const windowSize = Math.max(1, Math.floor(samples.length / 4));
  const firstMedianBytes = median(samples.slice(0, windowSize).map(({ rssBytes }) => rssBytes));
  const lastMedianBytes = median(samples.slice(-windowSize).map(({ rssBytes }) => rssBytes));
  const growthBytes = lastMedianBytes - firstMedianBytes;
  const slopeBytesPerMinute = linearSlope(samples.map(({ atMs, rssBytes }) => ({ x: atMs / 60_000, y: rssBytes })));
  const failures = [];
  if (growthBytes > maxGrowthBytes) failures.push(`last-window median grew ${formatBytes(growthBytes)} > ${formatBytes(maxGrowthBytes)}`);
  if (slopeBytesPerMinute > maxSlopeBytesPerMinute) failures.push(`slope ${formatBytes(slopeBytesPerMinute)}/min > ${formatBytes(maxSlopeBytesPerMinute)}/min`);
  const prefix = failures.length === 0 ? "PASS" : "FAIL";
  return {
    ok: failures.length === 0,
    firstMedianBytes,
    lastMedianBytes,
    growthBytes,
    slopeBytesPerMinute,
    message: `${prefix} RSS trend: ${failures.join("; ") || `window growth ${formatBytes(growthBytes)}, slope ${formatBytes(slopeBytesPerMinute)}/min within bounds`}`
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function linearSlope(points) {
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0, denominator = 0;
  for (const point of points) { const dx = point.x - meanX; numerator += dx * (point.y - meanY); denominator += dx * dx; }
  return denominator === 0 ? 0 : numerator / denominator;
}

function formatMs(value) { return `${Math.round(value)}ms`; }
function formatBytes(value) { return `${(value / 1024 / 1024).toFixed(1)}MiB`; }

async function runSoak(config = readConfig()) {
  const resultsDir = path.resolve(config.resultsDir), parent = mkdtempSync(path.join(tmpdir(), "harness-nightly-soak-"));
  const rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"), home = path.join(parent, "home"), daemonId = `nightly-soak-${process.pid}`, repoId = "nightly-soak", endpoint = localUserDaemonEndpoint(userRoot, daemonId);
  const hermetic = assessHermeticConfig({ userRoot, daemonId, userRootSource: "flag" });
  if (!hermetic.ok) throw new Error(`soak fixture is not hermetic: ${hermetic.failures.join("; ")}`);
  mkdirSync(resultsDir, { recursive: true });
  let child, detach, rejectServer;
  const daemonOutput = [];
  try {
    console.log(`[soak] hermetic user-root=${userRoot} daemon-id=${daemonId}`);
    const fixtureStarted = performance.now(), events = createSoakEvents(config);
    initializeFixture({ rootDir, userRoot, repoId, events });
    console.log(`[soak] fixture tasks=${config.taskCount} events=${events.length} generated=${Math.round(performance.now() - fixtureStarted)}ms (deterministic canonical event snapshot)`);

    child = spawn(process.execPath, [cliEntry, "daemon", "serve", "--user-root", userRoot, "--daemon-id", daemonId, "--json"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: "/dev/null", HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: daemonId },
      stdio: ["ignore", "pipe", "pipe"]
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => daemonOutput.push(chunk.toString("utf8")));
    const readyStarted = performance.now();
    await waitForAttachedRepo({ child, endpoint, repoId, timeoutMs: config.startupTimeoutMs });
    console.log(`[soak] daemon pid=${child.pid} attached scale ledger in ${Math.round(performance.now() - readyStarted)}ms`);

    const taskIds = Array.from({ length: config.taskCount }, (_, index) => `task_soak_${String(index).padStart(6, "0")}`);
    const warmup = await runLoadPhase({ endpoint, repoId, taskIds, durationMs: config.warmupMs, concurrency: config.concurrency, requestIntervalMs: config.requestIntervalMs, helloProbeIntervalMs: config.helloProbeIntervalMs, sampleRssPid: null });
    console.log(`[soak] warmup ${config.warmupMs}ms requests=${warmup.requests} failures=${warmup.failures}`);
    const load = await runLoadPhase({ endpoint, repoId, taskIds, durationMs: config.durationMs, concurrency: config.concurrency, requestIntervalMs: config.requestIntervalMs, helloProbeIntervalMs: config.helloProbeIntervalMs, sampleRssPid: child.pid });
    console.log(`[soak] load ${config.durationMs}ms requests=${load.requests} failures=${load.failures} hello-probes=${load.helloSamplesMs.length} rss-samples=${load.rssSamples.length}`);

    let streamAttached = false, streamLost = null;
    detach = await streamAgentRuntimeAt({ socketPath: endpoint, repoId, payload: { runtimeSessionId: "runtime-session-soak", afterCursor: "stream:0" }, onValue: (value) => { if (value && typeof value === "object" && "ok" in value && value.ok === true) streamAttached = true; }, onClosed: (failure) => { streamLost = failure; } });
    if (!streamAttached) throw new Error("fault-control stream did not complete its initial real daemon attach");
    await requestDaemonJsonRpcAt(endpoint, "daemon.stop", {}, 1_000, 5_000);
    await waitForChildExit(child, 30_000);
    await waitForMissing(endpoint, 5_000);

    const faultLog = openDaemonConnLog({ userRoot, daemonId: `${daemonId}-fault` });
    rejectServer = net.createServer((socket) => {
      const connectionId = randomUUID();
      faultLog.connectionOpened(connectionId, "fault-injection");
      socket.once("close", () => faultLog.connectionClosed(connectionId));
      socket.destroy();
    });
    await listen(rejectServer, endpoint);
    await delay(config.faultDurationMs);
    detach(); detach = undefined;
    await closeServer(rejectServer); rejectServer = undefined;
    await faultLog.settle();
    console.log(`[soak] fault window ${config.faultDurationMs}ms complete; terminal report=${streamLost ? JSON.stringify(streamLost) : "none"}`);

    const normal = timelineFor({ userRoot, daemonId }), fault = timelineFor({ userRoot, daemonId: `${daemonId}-fault` });
    const connections = assessConnections({ normal, fault, maxFaultConnections: config.maxFaultConnections });
    const hello = assessHelloLatency({ clientSamplesMs: load.helloSamplesMs, daemon: normal, maxP99Ms: config.maxHelloP99Ms });
    const rss = assessRssTrend({ samples: load.rssSamples, maxGrowthBytes: config.maxRssGrowthBytes, maxSlopeBytesPerMinute: config.maxRssSlopeBytesPerMinute });
    const workload = { ...load, helloSamplesMs: undefined, rssSamples: undefined, warmupRequests: warmup.requests, warmupFailures: warmup.failures };
    const assertions = [connections, hello, rss, { ok: load.failures === 0, message: `${load.failures === 0 ? "PASS" : "FAIL"} workload requests: ${load.requests} completed, ${load.failures} failed` }];
    const report = { schema: "daemon-nightly-soak/v1", generatedAt: new Date().toISOString(), config, fixture: { tasks: config.taskCount, events: config.eventCount, method: "deterministic canonical event generator committed as the fixture's initial Git snapshot" }, workload, assertions, rssSamples: load.rssSamples, helloSamplesMs: load.helloSamplesMs, normalTimeline: normal, faultTimeline: fault, streamLost };
    writeFileSync(path.join(resultsDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(path.join(resultsDir, "normal-timeline.txt"), `${renderTimeline(normal)}\n`, "utf8");
    writeFileSync(path.join(resultsDir, "fault-timeline.txt"), `${renderTimeline(fault)}\n`, "utf8");
    writeFileSync(path.join(resultsDir, "daemon-output.log"), daemonOutput.join(""), "utf8");
    for (const assertion of assertions) console.log(assertion.message);
    console.log(`[soak] artifacts=${resultsDir}`);
    if (assertions.some(({ ok }) => !ok)) throw new Error("nightly soak invariants failed");
    return report;
  } finally {
    detach?.();
    if (rejectServer) await closeServer(rejectServer).catch(() => undefined);
    await stopChild(child);
    if (daemonOutput.length > 0 && !existsSync(path.join(resultsDir, "daemon-output.log"))) writeFileSync(path.join(resultsDir, "daemon-output.log"), daemonOutput.join(""), "utf8");
    rmSync(parent, { recursive: true, force: true });
  }
}

function initializeFixture({ rootDir, userRoot, repoId, events }) {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "README.md"), "# Nightly daemon soak fixture\n", "utf8");
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`, "utf8");
  writeFileSync(path.join(rootDir, "harness/people.yaml"), `schema: harness-people/v1\npeople:\n  - personId: person-soak\n    displayName: Nightly Soak\n    primaryEmail: soak@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`, "utf8");
  for (const event of events) { const target = path.join(rootDir, eventObjectTarget(event.opId)); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, serializeCanonicalEvent(event), "utf8"); }
  const last = events.at(-1), eventBody = serializeCanonicalEvent(last);
  writeFileSync(path.join(rootDir, "harness/events/head.json"), serializeEventHead({ revision: last.workspaceRevision, opId: last.opId, eventDigest: `sha256:${sha256Text(eventBody)}` }), "utf8");
  git(rootDir, "init", "--quiet"); git(rootDir, "config", "user.name", "Nightly Soak"); git(rootDir, "config", "user.email", "soak@example.test"); git(rootDir, "add", "README.md", "harness"); git(rootDir, "commit", "--quiet", "-m", "nightly soak fixture");
  registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
}

async function runLoadPhase({ endpoint, repoId, taskIds, durationMs, concurrency, requestIntervalMs, helloProbeIntervalMs, sampleRssPid }) {
  const stopAt = Date.now() + durationMs, counts = { requests: 0, failures: 0 }, methods = new Map(), helloSamplesMs = [], rssSamples = [];
  const workers = Array.from({ length: concurrency }, (_, worker) => workloadClient({ endpoint, repoId, taskIds, stopAt, worker, counts, methods, requestIntervalMs }));
  const probes = helloProbeLoop({ endpoint, stopAt, samples: helloSamplesMs, counts, helloProbeIntervalMs });
  const rss = sampleRssPid ? rssLoop({ pid: sampleRssPid, stopAt, samples: rssSamples }) : Promise.resolve();
  await Promise.all([...workers, probes, rss]);
  await delay(250);
  return { ...counts, methods: Object.fromEntries([...methods.entries()].sort()), helloSamplesMs, rssSamples };
}

async function workloadClient({ endpoint, repoId, taskIds, stopAt, worker, counts, methods, requestIntervalMs }) {
  let iteration = 0;
  while (Date.now() < stopAt) {
    const batchStart = (worker * 53 + iteration * 17) % taskIds.length;
    const taskBatch = Array.from({ length: Math.min(50, taskIds.length) }, (_, offset) => taskIds[(batchStart + offset) % taskIds.length]);
    const options = [
      ["repo.task.dispatches", { repo: { repoId }, payload: { taskIds: taskBatch, limit: taskBatch.length } }],
      ["repo.task.dispatches", { repo: { repoId }, payload: { taskIds: taskBatch, limit: taskBatch.length } }],
      ["repo.task.dispatches", { repo: { repoId }, payload: { taskIds: taskBatch, limit: taskBatch.length } }],
      ["repo.task.dispatches", { repo: { repoId }, payload: { taskIds: taskBatch, limit: taskBatch.length } }],
      ["repo.task.dispatches", { repo: { repoId }, payload: { taskIds: taskBatch, limit: taskBatch.length } }],
      ["repo.tasks.list", { repo: { repoId }, payload: { limit: 50 } }],
      ["repo.tasks.list", { repo: { repoId }, payload: { limit: 50 } }],
      ["daemon.status", {}]
    ];
    const [method, params] = options[(worker + iteration) % options.length];
    try {
      const result = await requestDaemonJsonRpcAt(endpoint, method, params, 1_000, 5_000);
      if (result.ok !== true) counts.failures += 1;
    } catch { counts.failures += 1; }
    counts.requests += 1; methods.set(method, (methods.get(method) ?? 0) + 1); iteration += 1;
    await delay(requestIntervalMs);
  }
}

async function helloProbeLoop({ endpoint, stopAt, samples, counts, helloProbeIntervalMs }) {
  while (Date.now() < stopAt) {
    let socket;
    try {
      socket = await connectSocket(endpoint, 1_000);
      const client = new JsonRpcLineClient(socket, socket), started = performance.now();
      const result = await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 5_000);
      samples.push(performance.now() - started);
      if (result.ok !== true) counts.failures += 1;
      client.close();
    } catch { counts.failures += 1; socket?.destroy(); }
    await delay(helloProbeIntervalMs);
  }
}

async function rssLoop({ pid, stopAt, samples }) {
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

function timelineFor({ userRoot, daemonId }) {
  const files = discoverConnLogFiles({ userRoot, daemonId });
  if (files.length === 0) throw new Error(`no connection log was written for daemon ${daemonId}`);
  return buildTimeline(loadConnLogRecords(files));
}

async function waitForAttachedRepo({ child, endpoint, repoId, timeoutMs }) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
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

function readConfig(env = process.env) {
  return {
    taskCount: positive(env.HARNESS_SOAK_TASKS, 1_377), eventCount: positive(env.HARNESS_SOAK_EVENTS, 26_650),
    durationMs: positive(env.HARNESS_SOAK_DURATION_MS, 120_000), warmupMs: positive(env.HARNESS_SOAK_WARMUP_MS, 30_000), faultDurationMs: positive(env.HARNESS_SOAK_FAULT_MS, 10_000), startupTimeoutMs: positive(env.HARNESS_SOAK_STARTUP_TIMEOUT_MS, 300_000), concurrency: positive(env.HARNESS_SOAK_CONCURRENCY, 8), requestIntervalMs: positive(env.HARNESS_SOAK_REQUEST_INTERVAL_MS, 500), helloProbeIntervalMs: positive(env.HARNESS_SOAK_HELLO_INTERVAL_MS, 500),
    maxFaultConnections: positive(env.HARNESS_SOAK_MAX_FAULT_CONNECTIONS, 6), maxHelloP99Ms: positive(env.HARNESS_SOAK_MAX_HELLO_P99_MS, 500), maxRssGrowthBytes: positive(env.HARNESS_SOAK_MAX_RSS_GROWTH_MIB, 32) * MIB, maxRssSlopeBytesPerMinute: positive(env.HARNESS_SOAK_MAX_RSS_SLOPE_MIB_PER_MIN, 12) * MIB,
    resultsDir: env.HARNESS_SOAK_RESULTS_DIR || "tmp/soak-results"
  };
}

function positive(value, fallback) { const parsed = value === undefined ? fallback : Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`soak configuration must be positive integers; received ${value}`); return parsed; }
function git(rootDir, ...args) { execFileSync("git", ["-C", rootDir, ...args], { stdio: "ignore" }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function listen(server, endpoint) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => { server.off("error", reject); resolve(); }); }); }
function closeServer(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function waitForChildExit(child, timeoutMs) { return Promise.race([new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("close", resolve)), delay(timeoutMs).then(() => { throw new Error(`daemon did not exit within ${timeoutMs}ms`); })]); }
async function waitForMissing(target, timeoutMs) { for (const deadline = Date.now() + timeoutMs; existsSync(target) && Date.now() < deadline;) await delay(25); if (existsSync(target)) throw new Error(`daemon endpoint remained after stop: ${target}`); }
async function stopChild(child) { if (!child || child.exitCode !== null) return; child.kill("SIGTERM"); try { await waitForChildExit(child, 5_000); } catch { child.kill("SIGKILL"); await waitForChildExit(child, 2_000).catch(() => undefined); } }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  try { await runSoak(config); } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error), resultsDir = path.resolve(config.resultsDir);
    mkdirSync(resultsDir, { recursive: true }); writeFileSync(path.join(resultsDir, "failure.txt"), `${message}\n`, "utf8");
    console.error(`[soak] FAIL ${message}`); process.exitCode = 1;
  }
}
