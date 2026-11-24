import path from "node:path";
import type { RuntimeSubscriptionQuotaV1 } from "@harness-anything/kernel";
import { cliOperationalPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { available, runtimeInstanceError, unavailable } from "./agent-runtime-instance-config.ts";
import { parseRuntimeModelCatalogOutput, runExecutable } from "./agent-runtime-installation-discovery.ts";
import type {
  RuntimeAuthReadiness,
  RuntimeCredentialSource,
  RuntimeInstallationWitness,
  RuntimeInstanceConfig,
  RuntimeInstanceKind,
} from "./agent-runtime-instance-types.ts";
import { runtimeKindForId, runtimeKindIds } from "../runtime-engine/runtime-inventory.ts";
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

export type RuntimeAccountProbe = ReturnType<typeof createRuntimeInstanceAccountProbe>;

export function probeAccountModelCatalog(
  accountProbe: RuntimeAccountProbe,
  config: RuntimeInstanceConfig,
  installation: RuntimeInstallationWitness,
  env: NodeJS.ProcessEnv,
  status: RuntimeAuthReadiness,
  signal?: AbortSignal,
): Promise<{
  readonly readiness: RuntimeAuthReadiness;
  readonly availableModels?: readonly string[];
  readonly modelCatalogReadiness?: RuntimeAuthReadiness;
}> {
  return accountProbe
    .probeModels({ kindId: config.kindId, executablePath: installation.executablePath, env, signal })
    .then(
      (catalog) => ({
        availableModels: catalog?.models,
        readiness: status,
        modelCatalogReadiness: catalog
          ? available("provider")
          : unavailable("runtime_model_catalog_empty", "The provider returned no account models."),
      }),
      (error: unknown) => {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        const authFailure = code === "runtime_subscription_required" || code === "runtime_auth_probe_failed";
        return {
          availableModels: undefined,
          readiness: authFailure
            ? unavailable(
                code,
                code === "runtime_subscription_required"
                  ? "ACP requires subscription sign-in for this instance."
                  : "ACP authentication could not determine readiness. Retry the probe.",
              )
            : status,
          modelCatalogReadiness: authFailure
            ? unavailable(
                "runtime_model_catalog_not_probed",
                "Account models were not probed because ACP authentication is unavailable.",
              )
            : unavailable(
                "runtime_model_catalog_probe_failed",
                `Account model refresh failed${typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? ` (exit ${error.status})` : ""}; authentication status is unchanged. Retry the model refresh.`,
              ),
        };
      },
    );
}

export function runtimeAuthProbeDedupKey(
  cut: unknown,
  config: Pick<RuntimeInstanceConfig, "isolationState" | "defaultModel">,
  installation: Pick<RuntimeInstallationWitness, "executablePath" | "version"> | undefined,
  baseUrl: string | undefined,
  startCredentialGen?: string,
): string {
  return JSON.stringify([
    cut,
    installation?.executablePath ?? null,
    installation?.version ?? null,
    config.isolationState,
    baseUrl ?? null,
    config.defaultModel,
    startCredentialGen ?? null,
  ]);
}

export function resolveRuntimeAccountProbeTarget(
  config: Pick<RuntimeInstanceConfig, "kindId" | "installationId">,
  witnessed: readonly RuntimeInstallationWitness[],
): { readonly kindId: RuntimeInstanceKind; readonly installation: RuntimeInstallationWitness } {
  const credentialCommand = runtimeKindForId(config.kindId).executable.credentialCommand;
  if (!credentialCommand) {
    const installation = witnessed.find(
      (entry) => entry.installationId === config.installationId && entry.kindId === config.kindId,
    );
    if (installation) return { kindId: config.kindId, installation };
    throw runtimeInstanceError(
      "runtime_installation_not_found",
      `The bound ${config.kindId} installation ${config.installationId} is not currently witnessed for account operations.`,
    );
  }
  const candidates = runtimeKindIds.flatMap((kindId) =>
    runtimeKindForId(kindId).executable.command === credentialCommand
      ? witnessed.filter((entry) => entry.kindId === kindId).map((installation) => ({ kindId, installation }))
      : [],
  );
  const exact = candidates.find(({ installation }) => installation.installationId === config.installationId);
  if (exact) return exact;
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0)
    throw runtimeInstanceError(
      "runtime_credential_command_not_found",
      `A witnessed ${credentialCommand} credential command is required for ${config.kindId} account operations.`,
    );
  throw runtimeInstanceError(
    "runtime_installation_ambiguous",
    `Multiple witnessed ${credentialCommand} credential installations are available for ${config.kindId}; bind one explicitly to the account instance.`,
  );
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

/**
 * Deduplicates concurrent in-flight account probes per instance for the same account cut and
 * credential generation. Waiters attach their own AbortSignals independently; the underlying
 * probe is aborted only when every active waiter has cancelled.
 */
export function createInFlightProbeDeduper<T>() {
  type Entry = {
    readonly key: string;
    readonly controller: AbortController;
    promise: Promise<T>;
    waiters: number;
    settled: boolean;
  };
  const active: Record<string, Entry> = {};
  return (
    instanceId: string,
    key: string,
    signal: AbortSignal | undefined,
    operation: (sharedSignal: AbortSignal) => Promise<T>,
    register = true,
  ): Promise<T> => {
    const existing = Object.hasOwn(active, instanceId) ? active[instanceId] : undefined;
    if (signal?.aborted && existing && existing.key === key && !existing.settled) {
      return Promise.reject(signal.reason);
    }
    if (!register && !(existing && existing.key === key && !existing.settled)) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal!.reason);
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      return Promise.resolve()
        .then(() => operation(controller.signal))
        .finally(() => {
          if (signal) signal.removeEventListener("abort", onAbort);
        });
    }
    let entry: Entry;
    if (existing && existing.key === key && !existing.settled) {
      entry = existing;
    } else {
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      entry = { key, controller, promise: undefined as unknown as Promise<T>, waiters: 0, settled: false };
      const current = entry;
      const promise = Promise.resolve()
        .then(() => operation(controller.signal))
        .finally(() => {
          current.settled = true;
          if (active[instanceId] === current) Reflect.deleteProperty(active, instanceId);
        });
      current.promise = promise;
      // Suppress unhandledRejection if every waiter aborts before the shared probe settles.
      void promise.then(
        () => undefined,
        () => undefined,
      );
      active[instanceId] = current;
    }
    entry.waiters += 1;
    const current = entry;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        // When another waiter is still relying on this shared probe, detach only this caller so
        // the underlying probe keeps running for the remaining waiter(s). When this is the last
        // waiter, forward the abort into the shared controller and let the operation settle with
        // its structured timeout/abort readiness verdict rather than bypassing it with a raw throw.
        if (current.waiters > 1) {
          done = true;
          current.waiters -= 1;
          reject(signal!.reason);
          return;
        }
        if (!current.settled) current.controller.abort(signal!.reason);
      };
      if (signal && !signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
      current.promise.then(
        (value) => {
          if (done) return;
          done = true;
          if (signal) signal.removeEventListener("abort", onAbort);
          current.waiters -= 1;
          resolve(value);
        },
        (error) => {
          if (done) return;
          done = true;
          if (signal) signal.removeEventListener("abort", onAbort);
          current.waiters -= 1;
          reject(error);
        },
      );
    });
  };
}

/**
 * Coordinates one-shot, event-driven background auth readiness warmups with bounded concurrency
 * and deterministic abort + drain on shutdown. Never uses polling intervals.
 */
export function createRuntimeAuthWarmupCoordinator<TConfig, TWitness>(input: {
  readonly enabled: boolean;
  readonly maxConcurrent?: number;
  readonly selectCandidates: () => readonly TConfig[];
  readonly readTarget: (instanceId: string) => TConfig | null;
  readonly shouldWarm: (config: TConfig) => boolean;
  readonly resolveBatchWitnessed: () => Promise<readonly TWitness[]>;
  readonly resolveInstanceWitnessed: (config: TConfig) => Promise<readonly TWitness[]>;
  readonly refreshOne: (config: TConfig, witnessed: readonly TWitness[], signal: AbortSignal) => Promise<unknown>;
  readonly onWarmFailure: (config: TConfig, code: string, message: string) => void;
}) {
  const controller = new AbortController();
  let tasks: Promise<void>[] = [];
  const concurrency = Math.max(1, input.maxConcurrent ?? 2);
  const runOne = (config: TConfig, witnessed: readonly TWitness[], signal: AbortSignal): Promise<void> =>
    input.refreshOne(config, witnessed, signal).then(
      () => undefined,
      (error: unknown) => {
        if (signal.aborted) return;
        const code =
          typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
            ? error.code
            : undefined;
        if (code === "runtime_instance_probe_stale" || code === "runtime_instance_not_found") return;
        input.onWarmFailure(
          config,
          code ?? "runtime_auth_probe_failed",
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  const track = (runner: () => Promise<void>): Promise<void> => {
    const task = runner()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        tasks = tasks.filter((item) => item !== task);
      });
    tasks.push(task);
    return task;
  };
  return {
    warmAll: (signal?: AbortSignal): Promise<void> => {
      const effectiveSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      if (effectiveSignal.aborted) return Promise.resolve();
      return track(async () => {
        await Promise.resolve();
        if (effectiveSignal.aborted) return;
        const candidates = input.selectCandidates();
        if (candidates.length === 0) return;
        const witnessed = await input.resolveBatchWitnessed();
        if (effectiveSignal.aborted) return;
        let cursor = 0;
        await Promise.allSettled(
          Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
            while (cursor < candidates.length && !effectiveSignal.aborted) {
              const config = candidates[cursor++]!;
              if (!input.shouldWarm(config)) continue;
              await runOne(config, witnessed, effectiveSignal);
            }
          }),
        );
      });
    },
    scheduleInstance: (instanceId: string): void => {
      if (!input.enabled || controller.signal.aborted) return;
      void track(async () => {
        await Promise.resolve();
        if (controller.signal.aborted) return;
        const initial = input.readTarget(instanceId);
        if (!initial || !input.shouldWarm(initial)) return;
        const witnessed = await input.resolveInstanceWitnessed(initial);
        if (controller.signal.aborted) return;
        const latest = input.readTarget(instanceId);
        if (!latest || !input.shouldWarm(latest)) return;
        await runOne(latest, witnessed, controller.signal);
      });
    },
    close: async (): Promise<void> => {
      controller.abort(new Error("runtime auth warmup closed"));
      while (tasks.length > 0) await Promise.allSettled([...tasks]);
    },
  };
}
