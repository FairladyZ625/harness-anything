import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism, cpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface RuntimeResourceSample {
  readonly cores: number;
  readonly cpu: number | null;
  readonly cpuMetric: "idle-fraction";
  readonly availableMemoryFraction: number;
}
export interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

// Validate only external OS readings. Invalid/missing readings must never become idle capacity.
export function availableMemoryFraction(platform: NodeJS.Platform, reading: string, total: number): number {
  const match =
    platform === "darwin"
      ? /System-wide memory free percentage:\s*(\d+)%/u.exec(reading)
      : /^MemAvailable:\s*(\d+)\s+kB$/mu.exec(reading);
  const fraction = match ? Number(match[1]) * (platform === "darwin" ? 0.01 : 1024 / total) : NaN;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
    throw new Error(`Invalid ${platform} available memory reading`);
  return fraction;
}

export function cpuBusyFraction(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (previous === null) return null;
  const elapsed = current.total - previous.total,
    idle = current.idle - previous.idle;
  if (elapsed <= 0 || idle < 0 || idle > elapsed) throw new Error("Invalid CPU counter interval");
  return 1 - idle / elapsed;
}

export function cpuIdleFraction(previous: CpuTimes | null, current: CpuTimes): number | null {
  const busy = cpuBusyFraction(previous, current);
  return busy === null ? null : 1 - busy;
}

export function makeRuntimeResourceSampler() {
  let previous: CpuTimes | null = null;
  return async (): Promise<RuntimeResourceSample> => {
    const platform = process.platform,
      cores = availableParallelism(),
      total = totalmem();
    let memory: number;
    if (platform === "darwin") {
      const { stdout } = await execute("/usr/bin/memory_pressure", [], {
        timeout: 4000,
        env: { ...process.env, LC_ALL: "C" },
      });
      memory = availableMemoryFraction(platform, stdout, total);
    } else if (platform === "linux") {
      memory = availableMemoryFraction(platform, await readFile("/proc/meminfo", "utf8"), total);
    } else if (platform === "win32") {
      memory = freemem() / total;
    } else throw new Error(`Resource admission does not support ${platform}`);
    let cpu: number | null;
    if (platform === "win32") {
      const current = cpus().reduce(
        (sum, { times }) => ({
          idle: sum.idle + times.idle,
          total: sum.total + Object.values(times).reduce((a, b) => a + b, 0),
        }),
        { idle: 0, total: 0 },
      );
      cpu = cpuIdleFraction(previous, current);
      previous = current;
    } else {
      const current = cpus().reduce(
        (sum, { times }) => ({
          idle: sum.idle + times.idle,
          total: sum.total + Object.values(times).reduce((a, b) => a + b, 0),
        }),
        { idle: 0, total: 0 },
      );
      cpu = cpuIdleFraction(previous, current);
      previous = current;
    }
    return {
      cores,
      cpu,
      cpuMetric: "idle-fraction",
      availableMemoryFraction: memory,
    };
  };
}
