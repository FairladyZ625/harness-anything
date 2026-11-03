import path from "node:path";
import { firstCliCommandIndex } from "../../cli/thin-command-help.ts";
import {
  localUserDaemonEndpoint,
  resolveLocalDaemonTarget,
} from "@harness-anything/daemon/internal/client/local-daemon-target";
import { readDaemonPid } from "@harness-anything/daemon/internal/daemon-singleton";
import { daemonFailure } from "../control-support.ts";
import { createCapturePort } from "./probe-capture.ts";
import { createProcessMetricsReader } from "./probe-metrics.ts";
import { parseProbeArgs, parseSummaryArgs } from "./probe-options.ts";
import { runProbeLoop, type ProbeRunResult, type ProbeSample } from "./probe-run.ts";
import { renderProbeSummary, runProbeSummary } from "./probe-summary.ts";
import { createTimelineWriter } from "./probe-timeline.ts";

type ControlFinisher = (receipt: Record<string, unknown>, exitCode: number) => number;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// `ha daemon probe` is an observer, not a control: it sends hello/status and reads process state.
// It gets its own entry ahead of the daemon-control credential guard so a dispatched worker can
// produce the required real-center evidence without gaining stop/start/signal authority.
export async function runDaemonProbeControl(
  argv: readonly string[],
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number> {
  const summary = isProbeSummary(argv);
  if (summary) {
    const parsed = parseSummaryArgs(argv);
    if (!parsed.ok) return finish(daemonFailure("daemon-probe-summary", "invalid_field", parsed.message), 2);
    const outcome = await runProbeSummary({ options: parsed.value, userRoot, daemonId }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error: messageOf(error) }),
    );
    if (!outcome.ok) {
      const receipt = daemonFailure(
        "daemon-probe-summary",
        "daemon_probe_summary_failed",
        `Could not read the probe timeline or daemon logs: ${outcome.error}. Check --user-root and --daemon-id.`,
      );
      return finish(receipt, 1);
    }
    if (parsed.value.json) return finish(outcome.result as unknown as Record<string, unknown>, 0);
    console.log(renderProbeSummary(outcome.result));
    return 0;
  }
  const parsed = parseProbeArgs(argv, userRoot);
  if (!parsed.ok) return finish(daemonFailure("daemon-probe", "invalid_field", parsed.message), 2);
  const options = parsed.value,
    socketPath = await resolveProbeSocket(userRoot, daemonId),
    writer = createTimelineWriter({
      dir: path.join(userRoot, "logs"),
      daemonId,
      keptDays: options.keptDays,
    }),
    stopped = { value: false },
    stop = (): void => {
      stopped.value = true;
    };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!options.json)
      process.stderr.write(
        `probing daemon=${daemonId} socket=${socketPath} every ${String(options.intervalMs)}ms; stop with Ctrl-C\n`,
      );
    const result = await runProbeLoop(
      {
        socketPath,
        timeoutMs: options.timeoutMs,
        slowMs: options.slowMs,
        now: () => Date.now(),
        wait,
        readPid: () => readDaemonPid(userRoot, daemonId),
        readMetrics: createProcessMetricsReader().read,
        writer,
        capture: createCapturePort(),
        jsStackMethod: options.jsStackMethod,
        sampleSeconds: options.sampleSeconds,
        shouldStop: () => stopped.value,
        onSample: options.json ? undefined : printSample,
      },
      {
        intervalMs: options.intervalMs,
        iterations: options.iterations,
        durationMs: options.durationMs,
        unresponsiveMs: options.unresponsiveMs,
        cpuPercent: options.cpuPercent,
        cpuSustainMs: options.cpuSustainMs,
        rssBytes: options.rssBytes,
        cooldownMs: options.cooldownMs,
        captureDir: options.captureDir,
      },
    );
    return finish(probeReceipt(daemonId, socketPath, result), 0);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await writer.close();
  }
}

export function isProbeSummary(argv: readonly string[]): boolean {
  const at = firstCliCommandIndex(argv);
  return argv[at] === "daemon" && argv[at + 1] === "probe" && argv[at + 2] === "summary";
}

async function resolveProbeSocket(userRoot: string, daemonId: string): Promise<string> {
  try {
    const target = await resolveLocalDaemonTarget({ rootDir: process.cwd(), userRoot, daemonId });
    return target.socketPath;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "daemon_target_conflict")
      throw error;
    const fallback = localUserDaemonEndpoint(userRoot, daemonId);
    return fallback;
  }
}

function probeReceipt(daemonId: string, socketPath: string, result: ProbeRunResult): Record<string, unknown> {
  return {
    schema: "daemon-probe-run/v1",
    ok: true,
    command: "daemon-probe",
    daemonId,
    socketPath,
    startedAt: new Date(result.startedAt).toISOString(),
    endedAt: new Date(result.endedAt).toISOString(),
    samples: result.samples,
    up: result.up,
    slow: result.slow,
    down: result.down,
    captures: result.captures,
    captureFiles: result.captureFiles,
    errors: result.errors,
  };
}

function printSample(sample: ProbeSample): void {
  console.log(
    `${new Date(sample.at).toISOString()} state=${sample.state} latency=${String(sample.latencyMs)}ms` +
      ` hello=${String(sample.helloMs)}ms status=${sample.statusMs === null ? "unknown" : `${String(sample.statusMs)}ms`}` +
      ` cpu=${formatMetric(sample.cpuPercent)}% rss=${formatBytes(sample.rssBytes)} threads=${formatMetric(sample.threadCount)}` +
      ` fds=${formatMetric(sample.openFileCount)}${sample.error === null ? "" : ` error=${sample.error}`}`,
  );
}

function formatMetric(value: number | null): string {
  return value === null ? "unknown" : String(Math.round(value * 10) / 10);
}

function formatBytes(value: number | null): string {
  if (value === null) return "unknown";
  const mib = value / (1024 * 1024);
  return `${String(Math.round(mib))}MiB`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
