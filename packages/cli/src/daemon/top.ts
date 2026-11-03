import {
  daemonDiagnosticsEndpoint,
  localUserDaemonEndpoint,
} from "@harness-anything/daemon/internal/client/local-daemon-target";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { openDiagnosticRpc } from "./diagnostics-rpc.ts";

const DEFAULT_INTERVAL_MS = 1_000;

export interface DaemonTopOptions {
  readonly intervalMs: number;
  readonly once: boolean;
  readonly json: boolean;
  readonly userRoot: string;
  readonly daemonId: string;
}

interface TopTrace {
  readonly requestsPerSecond: {
    readonly last1s: number;
    readonly last5s: number;
    readonly last60s: number;
  };
  readonly completed: number;
  readonly errors: number;
  readonly inFlight: number;
  readonly byMethod: readonly {
    readonly method: string;
    readonly count: number;
    readonly p50Ms: number;
    readonly p99Ms: number;
    readonly maxMs: number;
    readonly errors: number;
  }[];
  readonly byNode: readonly { readonly nodeId: string; readonly requests: number }[];
  readonly writeQueues: readonly {
    readonly repoId: string;
    readonly queueDepth: number | null;
    readonly ageMs: number;
  }[];
  readonly slowest: readonly {
    readonly method: string;
    readonly durationMs: number;
    readonly at: string;
    readonly ok: boolean;
    readonly nodeId: string | null;
  }[];
  readonly slowThresholdMs: number;
}

export function parseDaemonTopOptions(argv: readonly string[], userRoot: string, daemonId: string): DaemonTopOptions {
  const interval = daemonTopOption(argv, "--interval");
  return {
    intervalMs: interval === undefined ? DEFAULT_INTERVAL_MS : parseInterval(interval),
    once: argv.includes("--once"),
    json: argv.includes("--json"),
    userRoot,
    daemonId,
  };
}

export function parseInterval(value: string): number {
  const normalized = value.trim().toLowerCase(),
    match = /^(\d+)(ms|s)?$/u.exec(normalized);
  if (!match) throw invalidInterval(value);
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw invalidInterval(value);
  return match[2] === "s" ? amount * 1_000 : amount;
}

function invalidInterval(value: string): Error {
  return Object.assign(new Error(`Invalid --interval ${value}; use milliseconds or s (for example 1s or 500ms).`), {
    code: "invalid_field",
  });
}

export async function runDaemonTop(
  options: DaemonTopOptions,
  write: (line: string) => void = (line) => console.log(line),
  signal: AbortSignal = processSignal(),
): Promise<number> {
  const endpoint = daemonDiagnosticsEndpoint(
      process.env.HARNESS_DAEMON_ENDPOINT?.trim() || localUserDaemonEndpoint(options.userRoot, options.daemonId),
    ),
    rpc = await openDiagnosticRpc(endpoint, 2_000);
  try {
    for (;;) {
      const snapshot = await rpc.client.request("daemon.status", {}, 2_000);
      write(options.json ? JSON.stringify(topReceipt(snapshot, options)) : renderDaemonTop(snapshot, options));
      if (options.once || signal.aborted) return 0;
      await wait(options.intervalMs, signal);
    }
  } finally {
    rpc.client.close();
  }
}

function topReceipt(snapshot: JsonObject, options: DaemonTopOptions): JsonObject {
  return {
    schema: "daemon-top/v1",
    ok: true,
    command: "daemon-top",
    daemonId: options.daemonId,
    observedAt: new Date().toISOString(),
    ...snapshot,
  };
}

export function renderDaemonTop(snapshot: JsonObject, options?: { readonly daemonId?: string }): string {
  const daemonId = typeof snapshot.daemonId === "string" ? snapshot.daemonId : (options?.daemonId ?? "unknown"),
    state = typeof snapshot.state === "string" ? snapshot.state : "unknown",
    stalled = snapshot.stalled === true,
    heartbeatAgeMs = numberField(snapshot, "heartbeatAgeMs"),
    inFlight = Array.isArray(snapshot.inFlight) ? snapshot.inFlight : [],
    trace = topTrace(snapshot.trace),
    lines = [
      `daemon top: ${daemonId} state=${state} stalled=${stalled} heartbeatAgeMs=${heartbeatAgeMs} inFlight=${inFlight.length}`,
    ];
  if (!trace) {
    lines.push("trace: unavailable (this daemon predates request tracing; restart it on the current build)");
    return lines.join("\n");
  }
  lines.push(
    `rps 1s=${trace.requestsPerSecond.last1s} 5s=${trace.requestsPerSecond.last5s} 60s=${trace.requestsPerSecond.last60s}` +
      ` completed=${trace.completed} errors=${trace.errors}`,
  );
  if (trace.byMethod.length > 0) {
    lines.push("methods (last 60s): method count p50ms p99ms maxms errors");
    for (const row of trace.byMethod)
      lines.push(`  ${row.method} ${row.count} ${row.p50Ms} ${row.p99Ms} ${row.maxMs} ${row.errors}`);
  } else lines.push("methods (last 60s): none");
  if (trace.writeQueues.length > 0) {
    lines.push("write queues: repo queueDepth sampleAgeMs");
    for (const row of trace.writeQueues) lines.push(`  ${row.repoId} ${row.queueDepth ?? "unknown"} ${row.ageMs}`);
  } else lines.push("write queues: none");
  if (trace.byNode.length > 0) {
    lines.push("nodes (last 60s): node requests");
    for (const row of trace.byNode) lines.push(`  ${row.nodeId} ${row.requests}`);
  } else lines.push("nodes (last 60s): none");
  if (trace.slowest.length > 0) {
    lines.push(`slow requests >= ${trace.slowThresholdMs}ms (last 60s):`);
    for (const row of trace.slowest)
      lines.push(`  ${row.method} ${row.durationMs}ms at=${row.at} ok=${row.ok} node=${row.nodeId ?? "local"}`);
  }
  const oldest = inFlight
    .flatMap((value) => (record(value) ? [{ value, elapsed: numberField(value, "elapsedMs") }] : []))
    .sort((left, right) => right.elapsed - left.elapsed)
    .slice(0, 8);
  if (oldest.length > 0) {
    lines.push("in-flight (oldest first): method repo phase elapsedMs traceId");
    for (const { value } of oldest)
      lines.push(
        `  ${String(value.method ?? "unknown")} ${String(value.repoId ?? "none")} ${String(value.phase ?? "unknown")} ` +
          `${numberField(value, "elapsedMs")} ${String(value.traceId ?? "none")}`,
      );
  }
  return lines.join("\n");
}

function topTrace(value: unknown): TopTrace | null {
  if (!record(value) || !record(value.requestsPerSecond)) return null;
  return {
    requestsPerSecond: {
      last1s: numberField(value.requestsPerSecond, "last1s"),
      last5s: numberField(value.requestsPerSecond, "last5s"),
      last60s: numberField(value.requestsPerSecond, "last60s"),
    },
    completed: numberField(value, "completed"),
    errors: numberField(value, "errors"),
    inFlight: numberField(value, "inFlight"),
    byMethod: array(value.byMethod).flatMap((row) =>
      record(row) && typeof row.method === "string"
        ? [
            {
              method: row.method,
              count: numberField(row, "count"),
              p50Ms: numberField(row, "p50Ms"),
              p99Ms: numberField(row, "p99Ms"),
              maxMs: numberField(row, "maxMs"),
              errors: numberField(row, "errors"),
            },
          ]
        : [],
    ),
    byNode: array(value.byNode).flatMap((row) =>
      record(row) && typeof row.nodeId === "string"
        ? [{ nodeId: row.nodeId, requests: numberField(row, "requests") }]
        : [],
    ),
    writeQueues: array(value.writeQueues).flatMap((row) =>
      record(row) && typeof row.repoId === "string"
        ? [
            {
              repoId: row.repoId,
              queueDepth: typeof row.queueDepth === "number" ? row.queueDepth : null,
              ageMs: numberField(row, "ageMs"),
            },
          ]
        : [],
    ),
    slowest: array(value.slowest).flatMap((row) =>
      record(row) && typeof row.method === "string"
        ? [
            {
              method: row.method,
              durationMs: numberField(row, "durationMs"),
              at: typeof row.at === "string" ? row.at : "",
              ok: row.ok === true,
              nodeId: typeof row.nodeId === "string" ? row.nodeId : null,
            },
          ]
        : [],
    ),
    slowThresholdMs: numberField(value, "slowThresholdMs") || 1_000,
  };
}

function daemonTopOption(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function numberField(value: Record<string, unknown>, key: string): number {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : 0;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
function processSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  return controller.signal;
}
