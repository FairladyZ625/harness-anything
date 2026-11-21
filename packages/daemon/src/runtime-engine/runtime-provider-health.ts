import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";

export type RuntimeProviderHealth = {
  readonly instanceId: string;
  readonly failureStreak: number;
  readonly cooldownUntil: string | null;
  readonly frozen: boolean;
  readonly frozenUntil: string | null;
  readonly reason: string | null;
  readonly lastFailureAt: string | null;
  readonly lastResetAt: string | null;
  /** Independent subscription quota exhaustion cooldown, orthogonal to transport/auth health. */
  readonly quotaExhaustedUntil?: string | null;
  readonly quotaObservedAt?: string | null;
};

export function effectiveProviderBlockedUntil(
  health: Pick<RuntimeProviderHealth, "cooldownUntil" | "frozenUntil" | "quotaExhaustedUntil"> | undefined,
): string | null {
  if (!health) return null;
  const candidates = [health.frozenUntil, health.cooldownUntil, health.quotaExhaustedUntil ?? null].filter(
    (value): value is string => value !== null && Number.isFinite(Date.parse(value)),
  );
  if (candidates.length === 0) return health.frozenUntil ?? health.cooldownUntil ?? health.quotaExhaustedUntil ?? null;
  return candidates.sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;
}

const empty = (instanceId: string): RuntimeProviderHealth => ({
  instanceId,
  failureStreak: 0,
  cooldownUntil: null,
  frozen: false,
  frozenUntil: null,
  reason: null,
  lastFailureAt: null,
  lastResetAt: null,
  quotaExhaustedUntil: null,
  quotaObservedAt: null,
});

export function openRuntimeProviderHealthStore(userRoot: string) {
  const target = path.join(userRoot, "runtime-provider-health.json");
  const read = (): Record<string, RuntimeProviderHealth> => {
    if (!existsSync(target)) return {};
    return JSON.parse(readFileSync(target, "utf8")) as Record<string, RuntimeProviderHealth>;
  };
  const persist = (next: Record<string, RuntimeProviderHealth>): void => {
    /* @gate-identity state-store/runtime-instance.provider-health */ mkdirSync(userRoot, { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    /* @gate-identity state-store/runtime-instance.provider-health */ writeFileSync(
      temporary,
      `${JSON.stringify(next, null, 2)}\n`,
      { mode: 0o600 },
    );
    /* @gate-identity state-store/runtime-instance.provider-health */ renameSync(temporary, target);
  };
  const get = (instanceId: string): RuntimeProviderHealth => read()[instanceId] ?? empty(instanceId);
  const list = (): readonly RuntimeProviderHealth[] => Object.values(read());
  const reset = (instanceId: string, at: string): RuntimeProviderHealth => {
    const next = { ...read(), [instanceId]: { ...empty(instanceId), lastResetAt: at } };
    persist(next);
    return next[instanceId]!;
  };
  const clear = (instanceId: string): void => {
    const next = { ...read() };
    delete next[instanceId];
    persist(next);
  };
  const recordFailure = (input: {
    readonly instanceId: string;
    readonly reason: string;
    readonly occurredAt: string;
    readonly resetAt?: string;
    readonly cooldownBaseSeconds?: number;
    readonly cooldownMaxSeconds?: number;
    readonly freezeAfter?: number;
    readonly freezeDurationSeconds?: number;
    readonly permanentFreeze?: boolean;
  }): RuntimeProviderHealth => {
    const previous = get(input.instanceId),
      streak = previous.failureStreak + 1,
      base = Math.max(0, input.cooldownBaseSeconds ?? daemonRuntimePolicy.defaultValue.health.cooldownBaseSeconds),
      cap = Math.max(base, input.cooldownMaxSeconds ?? daemonRuntimePolicy.defaultValue.health.cooldownMaxSeconds),
      cooldownSeconds = Math.min(cap, base * 2 ** Math.max(0, streak - 1)),
      threshold = Math.max(1, input.freezeAfter ?? daemonRuntimePolicy.defaultValue.health.freezeAfter),
      frozen = input.permanentFreeze === true || previous.frozen,
      proposedCooldownUntil =
        input.resetAt ??
        (frozen ? null : new Date(Date.parse(input.occurredAt) + cooldownSeconds * 1_000).toISOString()),
      cooldownUntil = frozen
        ? proposedCooldownUntil
        : ([previous.cooldownUntil, proposedCooldownUntil]
            .filter((value): value is string => value !== null)
            .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null),
      frozenUntil = frozen
        ? null
        : streak >= threshold
          ? new Date(
              Date.parse(input.occurredAt) +
                Math.max(
                  0,
                  input.freezeDurationSeconds ?? daemonRuntimePolicy.defaultValue.health.freezeDurationSeconds,
                ) *
                  1_000,
            ).toISOString()
          : previous.frozenUntil;
    const next = {
      ...read(),
      [input.instanceId]: {
        ...previous,
        failureStreak: streak,
        cooldownUntil,
        frozen,
        frozenUntil,
        reason: input.reason.slice(0, 1024),
        lastFailureAt: input.occurredAt,
      },
    };
    persist(next);
    return next[input.instanceId]!;
  };
  const recordQuotaExhausted = (input: {
    readonly instanceId: string;
    readonly occurredAt: string;
    readonly resetAt: string;
  }): RuntimeProviderHealth => {
    const previous = get(input.instanceId),
      proposedTime = Date.parse(input.resetAt),
      previousQuotaUntil = previous.quotaExhaustedUntil ?? null,
      previousQuotaTime = previousQuotaUntil === null ? Number.NEGATIVE_INFINITY : Date.parse(previousQuotaUntil),
      quotaExhaustedUntil =
        previousQuotaUntil !== null && Number.isFinite(previousQuotaTime) && previousQuotaTime >= proposedTime
          ? previousQuotaUntil
          : input.resetAt;
    if (quotaExhaustedUntil === previousQuotaUntil && previous.quotaObservedAt === input.occurredAt) return previous;
    const next = {
      ...read(),
      [input.instanceId]: {
        ...previous,
        quotaExhaustedUntil,
        quotaObservedAt: input.occurredAt,
      },
    };
    persist(next);
    return next[input.instanceId]!;
  };
  const clearQuotaExhausted = (instanceId: string, at: string): RuntimeProviderHealth => {
    const previous = get(instanceId);
    if ((previous.quotaExhaustedUntil ?? null) === null) return previous;
    const next = {
      ...read(),
      [instanceId]: {
        ...previous,
        quotaExhaustedUntil: null,
        quotaObservedAt: at,
      },
    };
    persist(next);
    return next[instanceId]!;
  };
  const recordSuccess = (instanceId: string, attemptStartedAt: string): RuntimeProviderHealth => {
    const previous = get(instanceId),
      started = Date.parse(attemptStartedAt),
      failure = previous.lastFailureAt === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.lastFailureAt),
      resetAt = previous.lastResetAt === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.lastResetAt),
      quotaObserved =
        previous.quotaObservedAt == null ? Number.NEGATIVE_INFINITY : Date.parse(previous.quotaObservedAt),
      clearTransport = started > Math.max(failure, resetAt),
      clearQuota = (previous.quotaExhaustedUntil ?? null) !== null && started > quotaObserved;
    if (!clearTransport && !clearQuota) return previous;
    const next = {
      ...read(),
      [instanceId]: {
        ...(clearTransport ? empty(instanceId) : previous),
        lastResetAt: clearTransport ? attemptStartedAt : previous.lastResetAt,
        quotaExhaustedUntil: clearQuota ? null : (previous.quotaExhaustedUntil ?? null),
        quotaObservedAt: clearQuota ? attemptStartedAt : (previous.quotaObservedAt ?? null),
      },
    };
    persist(next);
    return next[instanceId]!;
  };
  return Object.freeze({
    get,
    list,
    reset,
    clear,
    recordFailure,
    recordQuotaExhausted,
    clearQuotaExhausted,
    recordSuccess,
  });
}

export type RuntimeProviderHealthStore = ReturnType<typeof openRuntimeProviderHealthStore>;
