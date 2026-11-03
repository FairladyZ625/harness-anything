import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHistogram } from "node:perf_hooks";
import {
  allDaemonProtocolMethods,
  daemonProtocolCommands,
  commandClassForAction,
} from "../../packages/daemon/src/protocol/daemon-protocol-commands.ts";

// Reuse the production declarations: repo.task.run alone cannot distinguish a read from a write.
function requestClass(method, command) {
  const descriptor =
    allDaemonProtocolMethods.find((row) => row.method === method && row.commandClass) ??
    allDaemonProtocolMethods.find((row) => row.method === method);
  if (!descriptor) throw new Error(`unclassified daemon method: ${method}`);
  const declared = daemonProtocolCommands.find((row) => row.id === command && row.method === method);
  const kind =
    declared?.commandClass ??
    descriptor.commandClass ??
    (method === "repo.task.run" && command !== method ? commandClassForAction(command) : null);
  return kind === "repo-read" ? "read" : kind === "repo-write" || kind === "arbiter" ? "write" : "control";
}

export function extractTrafficModel(records) {
  const requests = [],
    connectionIds = new Map(),
    methods = {},
    commands = {},
    classes = { read: 0, write: 0, control: 0 };
  let droppedLines = 0;
  for (const row of records) {
    if (row.schema !== "daemon-conn-log/v1") throw new Error("expected daemon-conn-log/v1");
    if (row.event === "dropped_lines") droppedLines += row.count;
    if (row.event !== "request") continue;
    const timestamp = Date.parse(row.at);
    if (!Number.isFinite(timestamp) || typeof row.method !== "string")
      throw new Error("request lacks timestamp/method");
    const command = row.command ?? row.method,
      kind = requestClass(row.method, command);
    const key = JSON.stringify([row.pid, row.transport, row.conn]);
    if (!connectionIds.has(key)) connectionIds.set(key, connectionIds.size);
    requests.push({ offsetMs: timestamp, method: row.method, command, kind, connection: connectionIds.get(key) });
    methods[row.method] = (methods[row.method] ?? 0) + 1;
    commands[command] = (commands[command] ?? 0) + 1;
    classes[kind]++;
  }
  if (!requests.length) throw new Error("no request records in selected traffic window");
  requests.sort((a, b) => a.offsetMs - b.offsetMs);
  const first = requests[0].offsetMs;
  for (const row of requests) row.offsetMs -= first;
  const arrivalIntervalsMs = requests.slice(1).map((row, index) => row.offsetMs - requests[index].offsetMs);
  const seconds = new Map(),
    writes = new Map();
  for (const row of requests) {
    const second = Math.floor(row.offsetMs / 1000);
    seconds.set(second, (seconds.get(second) ?? 0) + 1);
    if (row.kind === "write") writes.set(second, (writes.get(second) ?? 0) + 1);
  }
  const durationMs = Math.max(1, requests.at(-1).offsetMs);
  return {
    schema: "center-traffic-model/v1",
    requests,
    methods,
    commands,
    classes,
    durationMs,
    arrivalIntervalsMs,
    connections: connectionIds.size,
    droppedLines,
    rate: {
      meanPerSecond: requests.length / (durationMs / 1000),
      busySecondP99: quantile([...seconds.values()], 0.99),
      maxPerSecond: Math.max(...seconds.values()),
      writeBusySecondP99: quantile([...writes.values()], 0.99),
    },
    limitations: [
      "Logs contain no request payloads; replay needs explicit synthetic bindings.",
      "Per-second quantiles include occupied seconds only; mean includes gaps.",
      "Connection identifiers are synthetic; repository, actor and PID are discarded.",
      "Writes include repo-write and arbiter declarations; admin and transport operations are control.",
    ],
  };
}

async function* readConnRecords(files) {
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(`${file}:${lineNumber}: ${error.message}`, { cause: error });
      }
      yield row;
    }
  }
}

export async function readTrafficLogs(files, { from = -Infinity, until = Infinity } = {}) {
  const records = [];
  for await (const row of readConnRecords(files)) {
    const at = Date.parse(row.at);
    if (at >= from && at < until) records.push(row);
  }
  return extractTrafficModel(records);
}

export async function countRecordedTraffic(files) {
  const tagged = {};
  let droppedLines = 0;
  for await (const row of readConnRecords(files)) {
    if (row.event === "dropped_lines") droppedLines += row.count;
    if (row.event !== "request" || !row.command?.startsWith("center-bench-trace-")) continue;
    const methods = (tagged[row.command] ??= {});
    methods[row.method] = (methods[row.method] ?? 0) + 1;
  }
  return { tagged, droppedLines };
}

// Iterate arrivals, then nodes: O(trace + N) memory, rather than an N-fold copied schedule.
export function* replaySchedule(model, { nodes = 1, speed = 1, durationMs = Infinity } = {}) {
  if (!Number.isSafeInteger(nodes) || nodes < 1 || nodes > 1000 || !(speed > 0))
    throw new Error("invalid replay parameters");
  for (const [index, row] of model.requests.entries()) {
    const offsetMs = row.offsetMs / speed;
    if (offsetMs >= durationMs) break;
    for (let node = 0; node < nodes; node++) yield { ...row, offsetMs, node, index };
  }
}

function quantile(values, p) {
  values.sort((a, b) => a - b);
  return values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
}

function latencyHistogram() {
  const histogram = createHistogram({ lowest: 1, highest: 3_600_000_000, figures: 3 });
  return {
    record: (ms) => histogram.record(Math.max(1, Math.round(ms * 1000))),
    result: () => ({
      count: histogram.count,
      p50Ms: histogram.count ? histogram.percentile(50) / 1000 : null,
      p99Ms: histogram.count ? histogram.percentile(99) / 1000 : null,
    }),
  };
}

export function requestAccumulator() {
  const read = latencyHistogram(),
    write = latencyHistogram(),
    control = latencyHistogram(),
    lag = latencyHistogram();
  const methods = {},
    errors = {};
  let count = 0,
    successful = 0,
    exposureMs = 0,
    exposureStart = null,
    exposureEnd = null;
  return {
    record(row) {
      count++;
      methods[row.method ?? "unknown"] = (methods[row.method ?? "unknown"] ?? 0) + 1;
      lag.record(Math.max(0, row.startedMs - row.scheduledMs));
      if (row.ok) {
        successful++;
        (({ read, write, control })[row.kind] ?? control).record(row.latencyMs);
      } else {
        errors[row.code] = (errors[row.code] ?? 0) + 1;
        // Records may complete out of order. Exposure is calculated by summarizeRequests instead.
        exposureStart = Math.min(exposureStart ?? Infinity, row.scheduledMs);
        exposureEnd = Math.max(exposureEnd ?? 0, row.endedMs);
        exposureMs = exposureEnd - exposureStart;
      }
    },
    result(elapsedMs) {
      return {
        requests: count,
        successful,
        errorRate: count ? (count - successful) / count : null,
        errors,
        methods,
        read: read.result(),
        write: write.result(),
        control: control.result(),
        generatorLag: lag.result(),
        failureExposureMs: exposureMs,
        failureExposureDefinition:
          "span from first failed scheduled arrival to last failed completion; not an outage estimate",
        successfulRequestsPerSecond: successful / (elapsedMs / 1000),
      };
    },
  };
}

export function summarizeRequests(rows, elapsedMs) {
  const accumulator = requestAccumulator();
  for (const row of rows) accumulator.record(row);
  return accumulator.result(elapsedMs);
}
