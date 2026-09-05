/**
 * Frozen S1 controller interface for S2-S4.
 *
 * Exports:
 * - createSeededScenario({ seed, requests })
 * - runScenario({ scenario, adapter, receiptLog, barrier, watchdogMs })
 * - withWatchdog(operation, { timeoutMs, label })
 * - createProcessTree()
 *
 * Adapters expose submit(request, { signal, barrier }). Barriers receive a
 * deterministic event before send and after terminal receipt. Transport loss
 * leaves the already-durable request unacknowledged.
 */
import { spawn } from "node:child_process";

export class StressBlockedError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} exceeded watchdog ${timeoutMs}ms`);
    this.name = "StressBlockedError";
    this.code = "stress_watchdog_timeout";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export function createSeededScenario({ seed, requests, shuffle = false }) {
  const ordered = shuffle ? seededOrder(requests, seed) : [...requests];
  return Object.freeze({
    seed,
    requests: Object.freeze(
      ordered.map((request, index) =>
        Object.freeze({
          ...request,
          requestId: request.requestId ?? `request-${String(index + 1).padStart(4, "0")}`,
          callSequence: index + 1,
        }),
      ),
    ),
  });
}

export async function runScenario({
  scenario,
  adapter,
  receiptLog,
  barrier = async () => undefined,
  watchdogMs = 15_000,
}) {
  const observations = [];
  for (const request of scenario.requests) {
    receiptLog.recordRequest(request);
    await barrier({ phase: "before", boundary: request.boundary ?? "request-send", request });
    try {
      const receipt = await withWatchdog((signal) => adapter.submit(request, { signal, barrier }), {
        timeoutMs: watchdogMs,
        label: request.requestId,
      });
      receiptLog.recordReceipt(request.requestId, receipt);
      observations.push({ requestId: request.requestId, receipt });
      await barrier({ phase: "after", boundary: request.boundary ?? "receipt-received", request, receipt });
    } catch (error) {
      observations.push({
        requestId: request.requestId,
        receipt: null,
        errorCode: error?.code ?? "transport_lost",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  receiptLog.close();
  return { seed: scenario.seed, observations };
}

export async function withWatchdog(operation, { timeoutMs, label }) {
  const abort = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      operation(abort.signal),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          abort.abort();
          reject(new StressBlockedError(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createProcessTree() {
  const children = new Set();
  return {
    spawn: (command, args, options = {}) => {
      const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
      children.add(child);
      child.once("close", () => children.delete(child));
      return child;
    },
    terminate: (signal = "SIGKILL") => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      }
    },
    pids: () => [...children].map((child) => child.pid).filter((pid) => pid !== undefined),
  };
}

function seededOrder(requests, seed) {
  const ordered = [...requests];
  let state = hashSeed(seed) || 0x9e3779b9;
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const swap = (state >>> 0) % (index + 1);
    [ordered[index], ordered[swap]] = [ordered[swap], ordered[index]];
  }
  return ordered;
}

function hashSeed(seed) {
  let value = 2166136261;
  for (const character of String(seed)) {
    value ^= character.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
