#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const BRIDGE_READ_METHODS = Object.freeze({
  getSystemStatus: "daemon.gui.system.read",
  getTasks: "repo.tasks.list",
  getWorkspaceSummary: "repo.workspace.summary.read",
  getAgenda: "repo.agenda.read",
  getRelationGraph: "repo.triadic.relationGraph",
  getDecisions: "repo.decisions.list",
  getTaskDocument: "repo.tasks.document.read",
  getTaskDocuments: "repo.tasks.documents.list",
  getAgentRuntimeOverview: "repo.agentRuntime.overview",
  getAgentRuntimeSessionGroups: "repo.agentRuntime.sessionGroups",
  getAgentRuntimeSession: "repo.agentRuntime.sessions.read",
  getAgentRuntimeEvents: "repo.agentRuntime.events.read",
  getTaskDispatches: "repo.task.dispatches",
  listAgents: "repo.agent.entities.list",
  showAgent: "repo.agent.entity.read",
  listAgentSkills: "repo.agent.skills.list",
  listSquads: "repo.squad.entities.list",
  showSquad: "repo.squad.entity.read",
  listSquadRuns: "repo.squad.runs.list",
  readSquadRun: "repo.squad.run.read",
  listSchedules: "repo.schedules.list",
  listArtifacts: "repo.artifacts.list",
});

const VIEWS = Object.freeze([
  { id: "overview", label: "总览" },
  { id: "board", label: "看板" },
  { id: "graph", label: "关系图" },
  { id: "sessions", label: "会话" },
  { id: "schedules", label: "定时计划" },
  { id: "agentSquad", label: "Agent · 含 Squad" },
  { id: "artifacts", label: "产物" },
]);

class InspectorClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
  }

  static async connect(url) {
    const socket = new globalThis.WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    return new InspectorClient(socket);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const options = parseArgs(process.argv.slice(2));
const sourceRoot = path.resolve(options.sourceRoot ?? path.resolve(import.meta.dirname, ".."));
const ledgerRoot = path.resolve(options.ledgerRoot ?? process.env.HARNESS_CANONICAL_ROOT ?? sourceRoot);
const userRoot = path.resolve(
  options.userRoot ?? process.env.HARNESS_DAEMON_USER_ROOT ?? path.join(os.homedir(), ".harness"),
);
const outputPath = path.resolve(
  options.output ?? path.join(sourceRoot, "tmp", `gui-read-baseline-${new Date().toISOString().slice(0, 10)}.json`),
);

const processes = processSnapshot();
const daemon = findDaemon(processes, userRoot);
const gui = findGui(processes, sourceRoot);
const basisRevision = git(sourceRoot, ["rev-parse", "HEAD"]).trim();
const sourceStatus = git(sourceRoot, ["status", "--short"]).split("\n").filter(Boolean);
const projection = projectionStatus(path.join(ledgerRoot, ".harness", "cache", "task.sqlite"));
if (!projection.ready) throw new Error(`projection is not ready: ${JSON.stringify(projection)}`);

const inspector = await openElectronInspector(gui.pid);
let probeInstalled = false;
try {
  await focusGui(inspector.client);
  await installProbe(inspector.client);
  probeInstalled = true;
  await selectRepository(inspector.client);
  await waitForQuiet(inspector.client, 800, 120_000);

  const runs = [];
  for (const view of VIEWS) {
    await selectView(inspector.client, view.label);
    await waitForQuiet(inspector.client, 800, 120_000);
    await resetProbe(inspector.client);
    const startedAtMs = Date.now();
    await reloadRenderer(inspector.client);
    await waitForView(inspector.client, view.label, 120_000);
    await waitForQuiet(inspector.client, 800, 120_000);
    const endedAtMs = Date.now();
    const records = await readProbe(inspector.client);
    const wrongRepo = records.find((record) => record.payload?.repoId && record.payload.repoId !== "canonical");
    if (wrongRepo) throw new Error(`view ${view.id} read unexpected repository ${wrongRepo.payload.repoId}`);
    runs.push({ view, startedAtMs, endedAtMs, records });
    process.stdout.write(`[measure] ${view.id} requests=${records.length} elapsedMs=${endedAtMs - startedAtMs}\n`);
  }

  await sleep(1_000);
  const start = Math.min(...runs.map((run) => run.startedAtMs));
  const end = Math.max(...runs.map((run) => run.endedAtMs));
  const daemonRequests = await readDaemonRequests(userRoot, daemon.pid, start, end);
  const views = Object.fromEntries(
    runs.map((run) => {
      const requests = pairDaemonRequests(run.records, daemonRequests);
      return [run.view.id, summarizeView(run, requests)];
    }),
  );
  const baseline = {
    schema: "gui-read-baseline/v1",
    measuredAt: new Date().toISOString(),
    basisRevision,
    sourceState: { dirty: sourceStatus.length > 0, status: sourceStatus },
    repository: { id: "canonical", ledgerRoot, sourceRoot },
    daemon: { pid: daemon.pid, elapsed: daemon.elapsed },
    projection,
    measurement: {
      shape:
        "cold renderer reload with canonical ordered first and the target view persisted; includes common chrome reads",
      payloadBytes: "Buffer.byteLength(JSON.stringify(bridgeResult))",
      e2eDurationMs: "Electron IPC handler elapsed time",
      handlerDurationMs: "paired daemon-default connection-log request durationMs",
      viewOrder: VIEWS.map((view) => view.id),
    },
    views,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  const markdownPath = outputPath.replace(/\.json$/u, ".md");
  await writeFile(markdownPath, renderMarkdown(baseline), "utf8");
  process.stdout.write(`baseline=${outputPath}\nreport=${markdownPath}\n`);
} finally {
  if (probeInstalled) await uninstallProbe(inspector.client).catch(() => undefined);
  inspector.client.close();
  if (inspector.openedByScript) await closeElectronInspector();
}

function summarizeView(run, requests) {
  const successful = requests.filter((request) => request.handlerOk && request.responseBytes !== null);
  const methodGroups = groupBy(successful, (request) => request.daemonMethod);
  const methods = Object.fromEntries(
    [...methodGroups.entries()].map(([method, rows]) => [
      method,
      {
        requestCount: rows.length,
        payloadBytes: rows.reduce((sum, row) => sum + row.responseBytes, 0),
        e2eDurationMs: rows.map((row) => round(row.e2eMs)),
        handlerDurationMs: rows.map((row) => row.daemonDurationMs),
      },
    ]),
  );
  const repeatedProjection = [...methodGroups.entries()].flatMap(([method, rows]) => {
    const payloads = groupBy(rows, (row) => JSON.stringify(row.payload));
    return [...payloads.values()].some((samePayload) => samePayload.length > 1) ? [method] : [];
  });
  const nPlusOne = [...methodGroups.entries()].flatMap(([method, rows]) => {
    if (rows.length < 2) return [];
    const entityKeys = new Set(rows.map((row) => entitySelector(row.payload)).filter(Boolean));
    return entityKeys.size > 1 ? [method] : [];
  });
  const fullProjection = successful
    .filter(
      (row) =>
        (row.daemonMethod === "repo.triadic.relationGraph" && !row.payload?.facet) ||
        (row.daemonMethod === "repo.decisions.list" && !row.payload?.projection),
    )
    .map((row) => row.daemonMethod);
  return {
    label: run.view.label,
    coldLoadDurationMs: run.endedAtMs - run.startedAtMs,
    requestCount: successful.length,
    payloadBytes: successful.reduce((sum, row) => sum + row.responseBytes, 0),
    maxE2eDurationMs: round(Math.max(0, ...successful.map((row) => row.e2eMs))),
    maxHandlerDurationMs: Math.max(0, ...successful.map((row) => row.daemonDurationMs ?? 0)),
    amplification: {
      nPlusOneMethods: [...new Set(nPlusOne)],
      fullProjectionMethods: [...new Set(fullProjection)],
      repeatedProjectionMethods: [...new Set(repeatedProjection)],
    },
    methods,
    requests,
  };
}

function renderMarkdown(baseline) {
  const rows = Object.entries(baseline.views)
    .map(([id, view]) => {
      const flags = [
        view.amplification.nPlusOneMethods.length ? `N+1: ${view.amplification.nPlusOneMethods.join(", ")}` : null,
        view.amplification.fullProjectionMethods.length
          ? `full: ${view.amplification.fullProjectionMethods.join(", ")}`
          : null,
        view.amplification.repeatedProjectionMethods.length
          ? `repeat: ${view.amplification.repeatedProjectionMethods.join(", ")}`
          : null,
      ].filter(Boolean);
      return `| ${view.label} (\`${id}\`) | ${view.requestCount} | ${view.payloadBytes} | ${view.maxE2eDurationMs} | ${view.maxHandlerDurationMs} | ${flags.join("; ") || "none"} |`;
    })
    .join("\n");
  const detail = Object.entries(baseline.views)
    .map(([id, view]) => {
      const methodRows = Object.entries(view.methods)
        .map(
          ([method, metrics]) =>
            `| \`${method}\` | ${metrics.requestCount} | ${metrics.payloadBytes} | ${metrics.e2eDurationMs.join(", ")} | ${metrics.handlerDurationMs.map((value) => value ?? "unmatched").join(", ")} |`,
        )
        .join("\n");
      return `## ${view.label} (\`${id}\`)\n\n| method | count | payload bytes | e2e duration ms | daemon duration ms |\n|---|---:|---:|---|---|\n${methodRows}\n`;
    })
    .join("\n");
  return `# GUI read baseline\n\n- Measured: ${baseline.measuredAt}\n- Basis revision: \`${baseline.basisRevision}\`\n- Source state: ${baseline.sourceState.dirty ? `dirty (${baseline.sourceState.status.join(", ")})` : "clean"}\n- Projection: schema ${baseline.projection.schemaVersion}, watermark ${baseline.projection.watermark}, source revision ${baseline.projection.scannedRevision}\n- Basis: ${baseline.measurement.shape}. Payload and latency definitions are embedded in the JSON sibling.\n\n| view | requests | payload bytes | max e2e ms | max daemon ms | amplification |\n|---|---:|---:|---:|---:|---|\n${rows}\n\n${detail}`;
}

function pairDaemonRequests(guiRecords, daemonRequests) {
  const available = new Set(daemonRequests.map((_, index) => index));
  return guiRecords.map((record) => {
    let best = null;
    for (const index of available) {
      const candidate = daemonRequests[index];
      if (candidate.method !== record.daemonMethod) continue;
      const distance = Math.abs(Date.parse(candidate.atEnd) - record.endedAtMs);
      if (distance > 5_000 || (best && best.distance <= distance)) continue;
      best = { index, distance, candidate };
    }
    if (best) available.delete(best.index);
    return {
      ...record,
      e2eMs: round(record.e2eMs),
      daemonDurationMs: best?.candidate.durationMs ?? null,
      daemonAtEnd: best?.candidate.atEnd ?? null,
    };
  });
}

async function readDaemonRequests(root, pid, startMs, endMs) {
  const logDir = path.join(root, "logs");
  const names = (await readdir(logDir)).filter(
    (name) => name.startsWith("daemon-default-conn-") && name.includes(".jsonl"),
  );
  const rows = [];
  for (const name of names) {
    const body = await readFile(path.join(logDir, name), "utf8");
    for (const line of body.split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      const at = Date.parse(row.atEnd ?? row.at);
      if (row.event === "request" && row.pid === pid && at >= startMs - 5_000 && at <= endMs + 5_000) rows.push(row);
    }
  }
  return rows;
}

async function installProbe(client) {
  return evaluateMain(
    client,
    `(() => {
      const { ipcMain } = process.mainModule.require("electron");
      const mapping = ${JSON.stringify(BRIDGE_READ_METHODS)};
      if (globalThis.__guiReadBaselineProbe?.uninstall) globalThis.__guiReadBaselineProbe.uninstall();
      const probe = { records: [], inflight: 0, originals: new Map() };
      for (const [bridgeMethod, daemonMethod] of Object.entries(mapping)) {
        const channel = "harness:" + bridgeMethod;
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) continue;
        probe.originals.set(channel, original);
        ipcMain._invokeHandlers.set(channel, async function (...args) {
          const startedAtMs = Date.now(), started = performance.now();
          probe.inflight += 1;
          try {
            const rawResult = await original.apply(this, args);
            const result = bridgeMethod === "getSystemStatus" && Array.isArray(rawResult?.repos)
              ? { ...rawResult, repos: [...rawResult.repos].sort((left, right) =>
                  left?.repoId === "canonical" ? -1 : right?.repoId === "canonical" ? 1 : 0) }
              : rawResult;
            probe.records.push({ bridgeMethod, daemonMethod, payload: args[1] ?? null, startedAtMs,
              endedAtMs: Date.now(), e2eMs: performance.now() - started,
              responseBytes: Buffer.byteLength(JSON.stringify(result) ?? "null"), handlerOk: true });
            return result;
          } catch (error) {
            probe.records.push({ bridgeMethod, daemonMethod, payload: args[1] ?? null, startedAtMs,
              endedAtMs: Date.now(), e2eMs: performance.now() - started, responseBytes: null,
              handlerOk: false, error: error instanceof Error ? error.message : String(error) });
            throw error;
          } finally { probe.inflight -= 1; }
        });
      }
      probe.uninstall = () => { for (const [channel, original] of probe.originals) ipcMain._invokeHandlers.set(channel, original); };
      globalThis.__guiReadBaselineProbe = probe;
      return { handlers: probe.originals.size };
    })()`,
  );
}

function readProbe(client) {
  return evaluateMain(client, "globalThis.__guiReadBaselineProbe?.records ?? []");
}
function resetProbe(client) {
  return evaluateMain(client, "globalThis.__guiReadBaselineProbe.records = []; true");
}
function uninstallProbe(client) {
  return evaluateMain(
    client,
    "globalThis.__guiReadBaselineProbe?.uninstall(); delete globalThis.__guiReadBaselineProbe; true",
  );
}

async function waitForQuiet(client, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluateMain(
      client,
      `(() => { const p = globalThis.__guiReadBaselineProbe; const last = p?.records.at(-1)?.endedAtMs ?? Date.now();
        return { inflight: p?.inflight ?? 0, quietFor: Date.now() - last }; })()`,
    );
    if (state.inflight === 0 && state.quietFor >= quietMs) return;
    await sleep(100);
  }
  throw new Error(`GUI reads did not become quiet within ${timeoutMs}ms`);
}

async function selectView(client, label) {
  const result = await executeRenderer(
    client,
    `(() => { const button = [...document.querySelectorAll("button")].find((row) => row.title === ${JSON.stringify(label)});
      if (!button) return false; button.click(); return true; })()`,
  );
  if (!result) throw new Error(`navigation button ${label} is missing`);
  await waitForView(client, label, 30_000);
}

async function waitForView(client, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await executeRenderer(
      client,
      `(() => { const button = [...document.querySelectorAll("button")].find((row) => row.title === ${JSON.stringify(label)});
        return Boolean(button && button.className.includes("font-medium") && document.querySelector('[data-testid="real-task-summary"]')); })()`,
    ).catch(() => false);
    if (ready) return;
    await sleep(150);
  }
  throw new Error(`view ${label} did not become active within ${timeoutMs}ms`);
}

async function selectRepository(client) {
  const current = await executeRenderer(
    client,
    `(() => [...document.querySelectorAll("button")].find((element) =>
      element.title === "快速切换项目")?.innerText ?? "")()`,
  );
  if (current.startsWith("harness-anything\n")) return;
  let selected = await executeRenderer(
    client,
    `(() => { const repository = [...document.querySelectorAll("button")].find((element) =>
      element.innerText.startsWith("harness-anything\\n") && element.innerText.includes("canonical · enabled / attached"));
      if (!repository) return false; repository.click(); return true; })()`,
  );
  const opened =
    selected ||
    (await executeRenderer(
      client,
      `(() => { const switcher = [...document.querySelectorAll("button")].find((element) =>
      element.title === "快速切换项目"); if (!switcher) return false; switcher.click(); return true; })()`,
    ));
  if (!opened) throw new Error("repository switcher is missing");
  if (!selected) {
    await sleep(350);
    selected = await executeRenderer(
      client,
      `(() => { const repository = [...document.querySelectorAll("button")].find((element) =>
        element.innerText.startsWith("harness-anything\\n") && element.innerText.includes("canonical · enabled / attached"));
        if (!repository) return false; repository.click(); return true; })()`,
    );
  }
  if (!selected) throw new Error("attached canonical repository entry is missing");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await executeRenderer(
      client,
      `(() => {
        const current = [...document.querySelectorAll("button")].find((element) =>
          element.title === "快速切换项目")?.innerText ?? "";
        const summary = document.querySelector('[data-testid="real-task-summary"]')?.innerText ?? "";
        return { ready: current.startsWith("harness-anything\\n") && /\\d+/u.test(summary), summary };
      })()`,
    ).catch(() => ({ ready: false }));
    if (ready.ready) return;
    await sleep(250);
  }
  throw new Error("canonical repository did not become ready in the GUI");
}

async function reloadRenderer(client) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await evaluateMain(
        client,
        `(() => { const { BrowserWindow } = process.mainModule.require("electron");
        BrowserWindow.getAllWindows()[0].webContents.reloadIgnoringCache(); return true; })()`,
      );
      await sleep(100);
      return;
    } catch (error) {
      if (!String(error).includes("Promise was collected") || attempt === 19) throw error;
      await sleep(100);
    }
  }
}

async function focusGui(client) {
  await evaluateMain(
    client,
    `(() => { const { BrowserWindow, app } = process.mainModule.require("electron");
    const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); app.focus({ steal: true }); return true; })()`,
  );
}

async function openElectronInspector(pid) {
  let target = await inspectorTarget(),
    openedByScript = false;
  if (!target) {
    process.kill(pid, "SIGUSR1");
    openedByScript = true;
    for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
      await sleep(100);
      target = await inspectorTarget();
    }
  }
  if (!target) throw new Error("Electron inspector did not open on 127.0.0.1:9229");
  const client = await InspectorClient.connect(target.webSocketDebuggerUrl);
  const inspectedPid = await evaluateMain(client, "process.pid");
  if (inspectedPid !== pid) throw new Error(`inspector pid ${inspectedPid} does not match GUI pid ${pid}`);
  return { client, openedByScript };
}

async function inspectorTarget() {
  try {
    const response = await fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(400) });
    const targets = response.ok ? await response.json() : [];
    return targets.find((entry) => entry.type === "node" && entry.webSocketDebuggerUrl) ?? null;
  } catch {
    return null;
  }
}

async function closeElectronInspector() {
  const target = await inspectorTarget();
  if (!target) return;
  const client = await InspectorClient.connect(target.webSocketDebuggerUrl);
  await evaluateMain(client, 'setTimeout(() => process.mainModule.require("node:inspector").close(), 50); true');
  client.close();
}

async function evaluateMain(client, expression) {
  const response = await client.request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails)
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}

async function executeRenderer(client, expression) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await evaluateMain(
        client,
        `(async () => { const { BrowserWindow } = process.mainModule.require("electron");
        return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(expression)}, true); })()`,
      );
    } catch (error) {
      if (!String(error).includes("Promise was collected") || attempt === 19) throw error;
      await sleep(100);
    }
  }
  throw new Error("renderer evaluation retry budget exhausted");
}

function processSnapshot() {
  return execFileSync("ps", ["-axo", "pid=,etime=,rss=,%cpu=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(.*)$/u.exec(line);
      return match ? [{ pid: Number(match[1]), elapsed: match[2], command: match[5] }] : [];
    });
}

function findDaemon(processes, root) {
  const suffix = `daemon serve --user-root ${root} --daemon-id default`;
  const matches = processes.filter((entry) => entry.command.includes(suffix));
  if (matches.length !== 1) throw new Error(`expected one default daemon for ${root}; found ${matches.length}`);
  return matches[0];
}

function findGui(processes, root) {
  const entrypoint = path.join(root, "packages", "gui", "src", "main", "electron-main.ts");
  const matches = processes.filter((entry) => entry.command.includes(entrypoint) && !entry.command.includes("--type="));
  if (matches.length !== 1) throw new Error(`expected one Electron GUI for ${root}; found ${matches.length}`);
  return matches[0];
}

function projectionStatus(databasePath) {
  const query =
    "SELECT schema_version, watermark, scanned_revision, squad_run_ready, coalesce(scan_cursor, '') FROM projection_meta";
  const [schemaVersion, watermark, scannedRevision, squadRunReady, scanCursor] = execFileSync(
    "/usr/bin/sqlite3",
    ["-readonly", "-separator", "\t", databasePath, query],
    { encoding: "utf8" },
  )
    .trim()
    .split("\t");
  return {
    schemaVersion: Number(schemaVersion),
    watermark: Number(watermark),
    scannedRevision: Number(scannedRevision),
    squadRunReady: Number(squadRunReady),
    scanCursor: scanCursor || null,
    ready: Number(watermark) === Number(scannedRevision) && Number(squadRunReady) === 1 && !scanCursor,
  };
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    const key = {
      "--source-root": "sourceRoot",
      "--ledger-root": "ledgerRoot",
      "--user-root": "userRoot",
      "--output": "output",
    }[flag];
    if (!key) throw new Error(`unknown option ${flag}`);
    result[key] = value;
  }
  return result;
}

function entitySelector(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["taskId", "runtimeSessionId", "agentId", "squadId", "scheduleId"]) {
    if (payload[key]) return `${key}:${payload[key]}`;
  }
  return null;
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return groups;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
function round(value) {
  return Math.round(value * 1000) / 1000;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
