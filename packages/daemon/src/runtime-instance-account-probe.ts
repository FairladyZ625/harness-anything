import path from "node:path";
import { runtimeInstanceError } from "./agent-runtime-instance-config.ts";
import {
  parseRuntimeModelCatalogOutput,
  runExecutable,
  runExecutableResult,
} from "./agent-runtime-installation-discovery.ts";
import type { RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";

export interface RuntimeAccountModelCatalog {
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly searchCapableModels?: readonly string[];
}

export function createRuntimeInstanceAccountProbe(platform: NodeJS.Platform, maxConcurrent = 2) {
  const runBounded = boundedExecutor(maxConcurrent);
  return Object.freeze({
    probeModels: (input: {
      readonly kindId: RuntimeInstanceKind;
      readonly executablePath: string;
      readonly env: NodeJS.ProcessEnv;
      readonly signal?: AbortSignal;
    }): Promise<RuntimeAccountModelCatalog | null> => {
      const timeoutMs = runtimeKindForId(input.kindId).auth.subscriptionProbeTimeoutMs,
        signal = probeSignal(input.signal, timeoutMs);
      return runBounded(signal, async () => {
        const declaration = runtimeKindForId(input.kindId);
        if (declaration.executable.modelProbe === null) return null;
        const args = [...declaration.executable.modelProbe];
        appendAgyAccountDirectories(input.kindId, input.env, args);
        const output = await runExecutable(platform, input.executablePath, args, {
            env: input.env,
            timeoutMs,
            captureOutput: true,
            signal,
          }),
          models = parseRuntimeModelCatalogOutput(input.kindId, output);
        if (models.length === 0) return null;
        return {
          models,
          defaultModel: models[0]!,
        };
      });
    },
    probeAgyQuota: (input: {
      readonly executablePath: string;
      readonly env: NodeJS.ProcessEnv;
      readonly signal?: AbortSignal;
    }): Promise<string | undefined> => {
      const timeoutMs = runtimeKindForId("agy").auth.subscriptionProbeTimeoutMs,
        signal = probeSignal(input.signal, timeoutMs);
      return runBounded(signal, async () => {
        const args = ["-p", "/quota", "--output-format", "json"];
        appendAgyAccountDirectories("agy", input.env, args);
        const result = await runExecutableResult(platform, input.executablePath, args, {
          env: input.env,
          timeoutMs,
          signal,
        });
        if (result.exitCode !== 0)
          throw runtimeInstanceError(
            "runtime_quota_probe_failed",
            `AGY quota probe exited with status ${result.exitCode}.`,
          );
        return quotaResetTime(result.stdout);
      });
    },
  });
}

export function quotaResetTime(output: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota response is not valid JSON.");
  }
  const root = record(parsed, "AGY quota response"),
    command = record(root.command, "AGY quota command response"),
    data = record(command.data, "AGY quota command data");
  if (!Array.isArray(data.groups) || data.groups.length === 0)
    throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota response has no groups array.");
  const exhausted: { readonly value: string; readonly time: number }[] = [];
  for (const groupValue of data.groups) {
    const group = record(groupValue, "AGY quota group");
    if (!Array.isArray(group.buckets))
      throw runtimeInstanceError("runtime_quota_response_invalid", "AGY quota group has no buckets array.");
    for (const bucketValue of group.buckets) {
      const bucket = record(bucketValue, "AGY quota bucket");
      if (typeof bucket.remaining_fraction !== "number" || !Number.isFinite(bucket.remaining_fraction))
        throw runtimeInstanceError(
          "runtime_quota_response_invalid",
          "AGY quota bucket has no numeric remaining_fraction.",
        );
      if (bucket.remaining_fraction > 0) continue;
      const reset = resetTimestamp(bucket.reset_time);
      if (reset) exhausted.push(reset);
    }
  }
  return exhausted.sort((left, right) => right.time - left.time)[0]?.value;
}

export function appendAgyAccountDirectories(kindId: RuntimeInstanceKind, env: NodeJS.ProcessEnv, args: string[]): void {
  if (kindId !== "agy") return;
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw runtimeInstanceError("runtime_auth_probe_failed", "AGY account probe could not determine its HOME.");
  const geminiDirectory = path.join(home, runtimeKindForId("agy").executable.configDirectory);
  args.push("--gemini-dir", geminiDirectory, "--app-data-dir", path.join(geminiDirectory, "antigravity-cli"));
}

function resetTimestamp(value: unknown): { readonly value: string; readonly time: number } | undefined {
  const time =
    typeof value === "string"
      ? Date.parse(value)
      : typeof value === "number"
        ? value < 10_000_000_000
          ? value * 1_000
          : value
        : Number.NaN;
  if (!Number.isFinite(time)) return undefined;
  return { value: typeof value === "string" ? value : new Date(time).toISOString(), time };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw runtimeInstanceError("runtime_quota_response_invalid", `${label} is invalid.`);
}

function probeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function boundedExecutor(
  limit: number,
): <T>(signal: AbortSignal | undefined, operation: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("Runtime account probe concurrency must be a positive integer.");
  let active = 0;
  type Waiter = {
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
    readonly signal?: AbortSignal;
    abort?: () => void;
  };
  const waiters: Waiter[] = [];
  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      if (next.abort) next.signal?.removeEventListener("abort", next.abort);
      next.resolve();
    } else active -= 1;
  };
  return async <T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> => {
    if (signal?.aborted) throw signal.reason;
    if (active < limit) active += 1;
    else
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
        if (signal) {
          waiter.abort = () => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(signal.reason);
          };
          signal.addEventListener("abort", waiter.abort, { once: true });
        }
        waiters.push(waiter);
      });
    try {
      if (signal?.aborted) throw signal.reason;
      return await operation();
    } finally {
      release();
    }
  };
}
