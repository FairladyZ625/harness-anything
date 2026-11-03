import { readdir, readFile } from "node:fs/promises";
import { runProbeCommand } from "./process-port.ts";

// Resource sampling is deliberately best-effort per field: the availability verdict must survive a
// platform where one counter is unavailable. Missing values are named in `unavailable`; they are
// never encoded as zero, which would silently satisfy or trip a threshold.
export type MetricsSource = "proc" | "ps" | "windows" | "unsupported";

export interface ProcessMetrics {
  readonly pid: number | null;
  readonly cpuPercent: number | null;
  readonly rssBytes: number | null;
  readonly threadCount: number | null;
  readonly openFileCount: number | null;
  readonly source: MetricsSource;
  readonly unavailable: readonly string[];
  readonly error: string | null;
}

export interface ProcessMetricsReader {
  readonly read: (pid: number | null) => Promise<ProcessMetrics>;
}

export interface MetricsReaderOptions {
  readonly platform?: NodeJS.Platform;
  readonly procRoot?: string;
  readonly readFileText?: (file: string) => Promise<string>;
  readonly readDirNames?: (dir: string) => Promise<readonly string[]>;
  readonly runCommand?: typeof runProbeCommand;
  readonly now?: () => number;
  readonly clockTicksPerSecond?: number;
}

export interface ProcStat {
  readonly utimeTicks: number;
  readonly stimeTicks: number;
  readonly startTicks: number;
  readonly rssPages: number;
}

export function createProcessMetricsReader(options: MetricsReaderOptions = {}): ProcessMetricsReader {
  const platform = options.platform ?? process.platform,
    procRoot = options.procRoot ?? "/proc",
    readText = options.readFileText ?? ((file: string) => readFile(file, "utf8")),
    readDir = options.readDirNames ?? ((dir: string) => readdir(dir)),
    run = options.runCommand ?? runProbeCommand,
    now = options.now ?? (() => Date.now()),
    hz = options.clockTicksPerSecond ?? 100;
  let previous: { readonly pid: number; readonly ticks: number; readonly at: number } | null = null;
  let previousWindows: { readonly pid: number; readonly cpuMs: number; readonly at: number } | null = null;
  return {
    read: async (pid) => {
      if (pid === null)
        return {
          pid: null,
          cpuPercent: null,
          rssBytes: null,
          threadCount: null,
          openFileCount: null,
          source: platform === "linux" ? "proc" : platform === "darwin" ? "ps" : "unsupported",
          unavailable: ["pid"],
          error: "The daemon pid is unknown (its pid file is missing).",
        };
      if (platform === "linux") {
        const at = now(),
          result = await readLinuxMetrics(pid, procRoot, readText, readDir);
        let cpuPercent: number | null = null;
        if (result.stat !== null) {
          const ticks = result.stat.utimeTicks + result.stat.stimeTicks;
          if (previous !== null && previous.pid === pid && at > previous.at)
            cpuPercent = Math.max(0, ((ticks - previous.ticks) / hz / (at - previous.at)) * 100);
          previous = { pid, ticks, at };
        }
        return withUnavailable({ ...result.metrics, cpuPercent });
      }
      if (platform === "darwin") return readDarwinMetrics(pid, run, now);
      if (platform === "win32") {
        const at = now(),
          result = await readWindowsMetrics(pid, run);
        if (result.cpuMs !== null && result.cpuMs !== undefined) {
          const cpuPercent =
            previousWindows !== null && previousWindows.pid === pid && at > previousWindows.at
              ? Math.max(0, ((result.cpuMs - previousWindows.cpuMs) / (at - previousWindows.at)) * 100)
              : null;
          previousWindows = { pid, cpuMs: result.cpuMs, at };
          return { ...result.metrics, cpuPercent };
        }
        return result.metrics;
      }
      return {
        pid,
        cpuPercent: null,
        rssBytes: null,
        threadCount: null,
        openFileCount: null,
        source: "unsupported",
        unavailable: ["cpuPercent", "rssBytes", "threadCount", "openFileCount"],
        error: `Process resource sampling is not implemented for platform ${platform}.`,
      };
    },
  };
}

interface LinuxReadResult {
  readonly metrics: ProcessMetrics;
  readonly stat: ProcStat | null;
}

async function readLinuxMetrics(
  pid: number,
  procRoot: string,
  readText: (file: string) => Promise<string>,
  readDir: (dir: string) => Promise<readonly string[]>,
): Promise<LinuxReadResult> {
  const base = `${procRoot}/${pid}`,
    unavailable: string[] = [];
  let stat: ProcStat | null = null,
    rssBytes: number | null = null,
    threadCount: number | null = null,
    openFileCount: number | null = null;
  const errors: string[] = [];
  const statRead = await attempt(async () => parseProcStat(await readText(`${base}/stat`)));
  if (statRead.ok) stat = statRead.value;
  else {
    unavailable.push("cpuPercent");
    errors.push(`stat: ${statRead.error}`);
  }
  const statusRead = await attempt(async () => parseProcStatus(await readText(`${base}/status`)));
  if (statusRead.ok) {
    rssBytes = statusRead.value.rssBytes;
    threadCount = statusRead.value.threadCount;
    if (rssBytes === null) unavailable.push("rssBytes");
    if (threadCount === null) unavailable.push("threadCount");
  } else {
    unavailable.push("rssBytes", "threadCount");
    errors.push(`status: ${statusRead.error}`);
  }
  if (rssBytes === null && stat !== null) rssBytes = stat.rssPages * 4096;
  const fdRead = await attempt(async () => (await readDir(`${base}/fd`)).length);
  if (fdRead.ok) openFileCount = fdRead.value;
  else {
    unavailable.push("openFileCount");
    errors.push(`fd: ${fdRead.error}`);
  }
  // The first sample has no delta yet; the avg-since-start fallback is deliberately not used,
  // because a process that has been busy all day would trigger instantly on a fresh probe.
  return {
    metrics: {
      pid,
      cpuPercent: null,
      rssBytes,
      threadCount,
      openFileCount,
      source: "proc",
      unavailable,
      error: errors.length > 0 ? errors.join("; ") : null,
    },
    stat,
  };
}

async function readDarwinMetrics(pid: number, run: typeof runProbeCommand, now: () => number): Promise<ProcessMetrics> {
  const unavailable: string[] = [],
    errors: string[] = [];
  let cpuPercent: number | null = null,
    rssBytes: number | null = null,
    threadCount: number | null = null;
  const ps = await run("ps", ["-p", String(pid), "-o", "%cpu=,rss="], 5_000);
  if (ps.error !== null) {
    unavailable.push("cpuPercent", "rssBytes");
    errors.push(`ps: ${ps.error}`);
  } else {
    const parsed = parseDarwinPs(ps.stdout);
    cpuPercent = parsed.cpuPercent;
    rssBytes = parsed.rssBytes;
    if (cpuPercent === null) unavailable.push("cpuPercent");
    if (rssBytes === null) unavailable.push("rssBytes");
  }
  const threads = await run("ps", ["-M", "-p", String(pid)], 5_000);
  if (threads.error !== null) {
    unavailable.push("threadCount");
    errors.push(`ps -M: ${threads.error}`);
  } else {
    threadCount = parseDarwinThreadCount(threads.stdout);
    if (threadCount === null) unavailable.push("threadCount");
  }
  const files = await run("lsof", ["-p", String(pid), "-Fn"], 10_000),
    // lsof may report per-fd permission warnings yet still list the process's descriptors.
    openFileCount = parseLsofFileCount(files.stdout);
  if (openFileCount === null) {
    unavailable.push("openFileCount");
    errors.push(`lsof: ${files.error ?? "no descriptor records"}`);
  }
  void now;
  return {
    pid,
    cpuPercent,
    rssBytes,
    threadCount,
    openFileCount,
    source: "ps",
    unavailable,
    error: errors.length > 0 ? errors.join("; ") : null,
  };
}

async function readWindowsMetrics(
  pid: number,
  run: typeof runProbeCommand,
): Promise<{ readonly metrics: ProcessMetrics; readonly cpuMs: number | null }> {
  const script =
    `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
    `Write-Output ("{0} {1} {2} {3}" -f [int64]$p.TotalProcessorTime.TotalMilliseconds, ` +
    `$p.WorkingSet64, $p.Threads.Count, $p.HandleCount)`;
  const result = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 10_000);
  const fields = result.stdout.trim().split(/\s+/u);
  const numbers = fields.map((field) => Number(field));
  const cpuMs = numbers.length === 4 && numbers.every(Number.isFinite) ? numbers[0]! : null;
  if (result.error !== null || cpuMs === null)
    return {
      cpuMs: null,
      metrics: {
        pid,
        cpuPercent: null,
        rssBytes: null,
        threadCount: null,
        openFileCount: null,
        source: "windows",
        unavailable: ["cpuPercent", "rssBytes", "threadCount", "openFileCount"],
        error: result.error ?? "PowerShell returned no process counters.",
      },
    };
  return {
    cpuMs,
    metrics: {
      pid,
      cpuPercent: null,
      rssBytes: numbers[1]!,
      threadCount: numbers[2]!,
      openFileCount: numbers[3]!,
      source: "windows",
      unavailable: [],
      error: null,
    },
  };
}

export function parseDarwinPs(stdout: string): {
  readonly cpuPercent: number | null;
  readonly rssBytes: number | null;
} {
  const fields = stdout.trim().split(/\s+/u);
  if (fields.length < 2) return { cpuPercent: null, rssBytes: null };
  const cpu = Number(fields[0]),
    rssKb = Number(fields[1]);
  return {
    cpuPercent: Number.isFinite(cpu) ? cpu : null,
    rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : null,
  };
}

export function parseDarwinThreadCount(stdout: string): number | null {
  const rows = stdout.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !/^USER\b/u.test(trimmed);
  });
  return rows.length > 0 ? rows.length : null;
}

export function parseLsofFileCount(stdout: string): number | null {
  let count = 0;
  for (const line of stdout.split("\n")) if (line.startsWith("n")) count += 1;
  return count > 0 ? count : null;
}

// /proc/<pid>/stat field 2 (comm) may contain spaces and parentheses, so split after the final
// ')'. Indices below are 0-based into the post-state remainder: utime is field 14 (index 11),
// stime 15 (12), starttime 22 (19), rss 24 (21).
export function parseProcStat(text: string): ProcStat {
  const close = text.lastIndexOf(")");
  if (close < 0) throw new Error("proc stat has no comm terminator");
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const numberAt = (index: number): number => {
    const value = Number(fields[index]);
    if (!Number.isFinite(value)) throw new Error(`proc stat field ${index + 3} is not numeric`);
    return value;
  };
  return {
    utimeTicks: numberAt(11),
    stimeTicks: numberAt(12),
    startTicks: numberAt(19),
    rssPages: numberAt(21),
  };
}

export function parseProcStatus(text: string): {
  readonly rssBytes: number | null;
  readonly threadCount: number | null;
} {
  const rssKb = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(text)?.[1],
    threads = /^Threads:\s+(\d+)$/mu.exec(text)?.[1];
  return {
    rssBytes: rssKb === undefined ? null : Number(rssKb) * 1024,
    threadCount: threads === undefined ? null : Number(threads),
  };
}

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

async function attempt<T>(read: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

function withUnavailable(metrics: ProcessMetrics): ProcessMetrics {
  const unavailable = [
    ...(metrics.pid === null ? ["pid"] : []),
    ...(metrics.cpuPercent === null ? ["cpuPercent"] : []),
    ...(metrics.rssBytes === null ? ["rssBytes"] : []),
    ...(metrics.threadCount === null ? ["threadCount"] : []),
    ...(metrics.openFileCount === null ? ["openFileCount"] : []),
  ];
  return { ...metrics, unavailable };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
