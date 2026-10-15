import { availableParallelism } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeResourceFields } from "./runtime-resource-settings.ts";
import { makeRuntimeResourceSampler, type RuntimeResourceSample } from "./runtime-resource-sample.ts";
import {
  defaultRuntimeResourceLimits,
  makeRuntimeResourceAdmission,
  runtimeResourceBlocks,
  type RuntimeResourceLimits,
} from "./runtime-resource-admission.ts";

const execute = promisify(execFile);
async function notifyOverload(): Promise<void> {
  if (process.platform === "darwin")
    await execute(
      "/usr/bin/osascript",
      [
        "-e",
        'display notification "New ordinary and review runs are queued until node resources recover." with title "Harness resource pressure"',
      ],
      { timeout: 4000 },
    );
}

/** One host shares reservations across all repository writers. No repository owns node capacity. */
export function openRuntimeResourceHost(
  nodeId: string,
  input: {
    readonly sample?: () => Promise<RuntimeResourceSample>;
    readonly now?: () => string;
    readonly notify?: () => Promise<void>;
    readonly limits?: RuntimeResourceLimits;
  } = {},
) {
  const admission = makeRuntimeResourceAdmission(nodeId),
    sample = input.sample ?? makeRuntimeResourceSampler();
  const now = input.now ?? (() => new Date().toISOString());
  const waiters = new Map<string, (admitted: boolean) => void>();
  let latest: RuntimeResourceSample | null = null,
    sampling = false,
    closed = false;
  const limits = input.limits ?? defaultRuntimeResourceLimits(availableParallelism());
  let error: string | null = null,
    pressureSince: string | null = null;
  let alert: { since: string; notifiedAt: string; notificationError: string | null } | null = null;
  const check = async () => {
    if (sampling || closed) return;
    sampling = true;
    try {
      const observed = await sample();
      if (closed) return;
      latest = observed;
      error = null;
      const at = now();
      // Reaching the concurrency cap is normal; sustained CPU/memory pressure triggers the alarm.
      if (runtimeResourceBlocks(observed, limits, 0).length === 0) {
        pressureSince = null;
        alert = null;
      } else {
        pressureSince ??= at;
        if (!alert && Date.parse(at) - Date.parse(pressureSince) >= runtimeResourceFields.alertAfterMs.defaultValue) {
          alert = { since: pressureSince, notifiedAt: at, notificationError: null };
          try {
            await (input.notify ?? notifyOverload)();
          } catch (cause) {
            alert.notificationError = cause instanceof Error ? cause.message : String(cause);
            throw cause;
          }
        }
      }
      admission.check(observed, limits, at);
    } catch (cause) {
      latest = null;
      error = cause instanceof Error ? cause.message : String(cause);
      // OS failure is exposed as unavailable, never converted into permission to launch.
      throw cause;
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(() => {
    void check().catch(console.error);
  }, runtimeResourceFields.sampleIntervalMs.defaultValue);
  timer.unref();
  const snapshot = () => ({
    nodeId,
    scope: "ordinary-and-review-dispatch" as const,
    sample: latest,
    limits,
    error,
    alert,
    ...admission.counts(),
  });
  return {
    acquire: (key: string, queuedSince: string): Promise<boolean> =>
      new Promise((resolve) => {
        waiters.set(key, resolve);
        admission.enqueue({
          key,
          queuedSince,
          observe: () => undefined,
          start: () => {
            waiters.delete(key);
            resolve(true);
          },
        });
      }),
    cancel: async (key: string) => {
      const removed = admission.cancel(key);
      if (removed) {
        waiters.get(key)?.(false);
        waiters.delete(key);
      }
      return removed;
    },
    release: async (key: string) => {
      admission.release(key);
    },
    adopt: async (key: string) => {
      admission.adopt(key);
    },
    transfer: async (from: string, to: string) => {
      admission.transfer(from, to);
    },
    read: async () => snapshot(),
    snapshot,
    check,
    close: () => {
      closed = true;
      clearInterval(timer);
      admission.close();
      for (const resolve of waiters.values()) resolve(false);
      waiters.clear();
    },
  };
}
export type RuntimeResourceHost = ReturnType<typeof openRuntimeResourceHost>;
export type RuntimeResourcePort = Pick<
  RuntimeResourceHost,
  "acquire" | "cancel" | "release" | "adopt" | "transfer" | "read"
>;
