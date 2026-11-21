import path from "node:path";
import type { RuntimeSubscriptionQuotaV1 } from "@harness-anything/kernel";
import { cliOperationalPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { runtimeInstanceError } from "./agent-runtime-instance-config.ts";
import { parseRuntimeModelCatalogOutput, runExecutable } from "./agent-runtime-installation-discovery.ts";
import type { RuntimeCredentialSource, RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { runtimeKindForId } from "../runtime-engine/runtime-inventory.ts";
import { probeSessionModelCatalog } from "./runtime-account-model-catalog.ts";
import {
  agyNonInteractiveProbeEnv,
  probeProviderSubscriptionQuota,
  type KeychainLookupRunner,
} from "./runtime-subscription-quota-probe.ts";

export interface RuntimeAccountModelCatalog {
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly searchCapableModels?: readonly string[];
}

export function createRuntimeInstanceAccountProbe(
  platform: NodeJS.Platform,
  maxConcurrent = cliOperationalPolicy.defaultValue.batch.defaultConcurrency,
) {
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
        const probe = declaration.auth.accountModelProbe;
        if (probe === undefined) return null;
        if (probe.kind !== "command") return probeSessionModelCatalog(platform, input, probe.kind, signal, timeoutMs);
        if (input.kindId === "agy") agyAccountHome(input.env);
        const commandEnv = input.kindId === "agy" ? agyNonInteractiveProbeEnv(input.env, platform) : input.env;
        const output = await runExecutable(platform, input.executablePath, probe.args, {
            env: commandEnv,
            timeoutMs,
            captureOutput: true,
            input: "",
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
    probeQuota: (input: {
      readonly kindId: RuntimeInstanceKind;
      readonly credentialSource: RuntimeCredentialSource;
      readonly executablePath?: string;
      readonly env: NodeJS.ProcessEnv;
      readonly hasCustomProviderBaseUrl?: boolean;
      readonly signal?: AbortSignal;
      readonly now?: () => string;
      readonly fetchImpl?: typeof fetch;
      readonly resolveGithubToken?: () => Promise<string | null>;
      readonly runKeychainLookup?: KeychainLookupRunner;
      readonly onCredentialFingerprint?: (fingerprint: string) => void;
    }): Promise<RuntimeSubscriptionQuotaV1 | null> => {
      const timeoutMs = runtimeKindForId(input.kindId).auth.subscriptionProbeTimeoutMs,
        signal = probeSignal(input.signal, timeoutMs);
      return runBounded(signal, () =>
        probeProviderSubscriptionQuota(platform, {
          ...input,
          signal,
          timeoutMs,
          now: input.now ?? (() => new Date().toISOString()),
        }),
      );
    },
  });
}

export function appendAgyAccountDirectories(kindId: RuntimeInstanceKind, env: NodeJS.ProcessEnv, args: string[]): void {
  if (kindId !== "agy") return;
  const geminiDirectory = path.join(agyAccountHome(env), runtimeKindForId("agy").executable.configDirectory);
  args.push("--gemini-dir", geminiDirectory, "--app-data-dir", path.join(geminiDirectory, "antigravity-cli"));
}

function agyAccountHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw runtimeInstanceError("runtime_auth_probe_failed", "AGY account probe could not determine its HOME.");
  return home;
}

function probeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function boundedExecutor(
  limit: number,
): <T>(signal: AbortSignal | undefined, operation: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit <= Number.EPSILON)
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
