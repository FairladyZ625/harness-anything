import { openDaemonJsonRpcClientAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { resolveLocalDaemonTarget } from "@harness-anything/daemon/internal/client/local-daemon-target";
import {
  validateObserveTailResult,
  type ObserveTailCursor,
  type ObserveTailResult,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol-gui-types";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { requestWindowMetrics } from "./metrics-summary.ts";
import { daemonOption } from "./control-support.ts";
import { firstCliCommandIndex } from "../cli/thin-command-help.ts";

const windows = { "15m": 900_000, "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };

export async function runDaemonMetrics(argv: readonly string[], userRoot: string, daemonId: string) {
  const at = firstCliCommandIndex(argv);
  const options = [...argv.slice(0, at), ...argv.slice(at + 2)];
  for (let index = 0; index < options.length; index += 1) {
    const flag = options[index];
    if (flag === "--json") continue;
    if (
      !["--window", "--root", "--repo", "--user-root", "--daemon-id"].includes(flag) ||
      !options[index + 1] ||
      options[index + 1]!.startsWith("--")
    )
      throw Object.assign(new Error(`Invalid metrics option ${flag}; use ha daemon metrics --help.`), {
        code: "invalid_field",
      });
    index += 1;
  }
  const window = daemonOption(argv, "--window") ?? "24h";
  if (!Object.hasOwn(windows, window))
    throw Object.assign(new Error("Use --window 15m|1h|24h|7d."), { code: "invalid_field" });
  const target = await resolveLocalDaemonTarget({
    rootDir: daemonOption(argv, "--root") ?? process.cwd(),
    repoIdOverride: daemonOption(argv, "--repo"),
    userRoot,
    daemonId,
  });
  const client = await openDaemonJsonRpcClientAt(target.socketPath);
  try {
    const untilMs = Date.now();
    const retained = await readMetricsHistory(async (cursor) => {
      const result = await client.request("observe.tail", {
        repo: { repoId: target.repoId },
        payload: {
          kind: "repo-log",
          direction: "history",
          ...(cursor ? { cursor: cursor as unknown as JsonObject } : {}),
        },
      });
      const errors = validateObserveTailResult(result);
      if (errors.length) throw new Error(`Invalid observe.tail result: ${errors.join("; ")}`);
      return result as unknown as ObserveTailResult;
    });
    return {
      schema: "daemon-request-metrics/v1",
      ok: true,
      command: "daemon-metrics",
      repoId: target.repoId,
      window,
      source: "repo-log",
      history: retained.history,
      ...requestWindowMetrics(retained.records, untilMs - windows[window as keyof typeof windows], untilMs),
    };
  } finally {
    client.close();
  }
}

/** History cursor moves backward; only the reader's done signal proves retained history exhausted. */
export async function readMetricsHistory(read: (cursor?: ObserveTailCursor) => Promise<ObserveTailResult>) {
  const records: Readonly<Record<string, unknown>>[] = [];
  let cursor: ObserveTailCursor | undefined,
    pages = 0;
  while (true) {
    const page = await read(cursor);
    pages += 1;
    if (page.status !== "ready")
      throw Object.assign(
        new Error(
          `Metrics history ${page.status}: ${JSON.stringify(page.status === "gap" ? page.gap : page.status === "unavailable" ? page.unavailable : {})}`,
        ),
        { code: "service_rejected" },
      );
    records.push(...page.items.map((item) => ({ ...item })));
    if (page.done)
      return { records, history: { pages, retainedHistoryExhausted: true, sourceCursor: page.sourceCursor } };
    if (page.historyCursor === null || JSON.stringify(page.historyCursor) === JSON.stringify(cursor))
      throw Object.assign(new Error("Metrics history cursor did not advance."), { code: "service_rejected" });
    cursor = page.historyCursor;
  }
}

export function renderDaemonMetrics(receipt: Awaited<ReturnType<typeof runDaemonMetrics>>): string {
  const { durationMs, serviceMs, dispatchDelayMs, note } = receipt.latency;
  const format = (label: string, timing: typeof durationMs) =>
    `${label}: n=${timing.sampleCount}, missing=${timing.missingCount}, P50=${timing.p50Ms ?? "unknown"}ms, P95=${timing.p95Ms ?? "unknown"}ms, max=${timing.maxMs ?? "unknown"}ms${timing.lowSample ? " (low sample)" : ""}`;
  return [
    `daemon metrics: ${receipt.repoId} ${receipt.window} [${receipt.since}, ${receipt.until}]`,
    `Completed requests=${receipt.requestCount}; await excluded from latency=${receipt.excludedAwaitRequests}`,
    `Observed ${receipt.coverage.firstObservedAt ?? "unknown"} to ${receipt.coverage.lastObservedAt ?? "unknown"}; span=${receipt.coverage.observedSpanMs}ms; continuity=unknown`,
    `Unobserved leading=${receipt.coverage.leadingUnobservedMs}ms, trailing=${receipt.coverage.trailingUnobservedMs}ms; silent intervals >1h=${receipt.coverage.silentIntervals.length}`,
    format("Duration", durationMs),
    format("Service", serviceMs),
    format("Dispatch delay", dispatchDelayMs),
    receipt.coverage.note,
    note,
  ].join("\n");
}
