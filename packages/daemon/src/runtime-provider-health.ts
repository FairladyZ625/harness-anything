import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RuntimeProviderHealth = {
  readonly instanceId: string;
  readonly failureStreak: number;
  readonly cooldownUntil: string | null;
  readonly frozen: boolean;
  readonly frozenUntil: string | null;
  readonly reason: string | null;
  readonly lastFailureAt: string | null;
  readonly lastResetAt: string | null;
};

const empty = (instanceId: string): RuntimeProviderHealth => ({
  instanceId,
  failureStreak: 0,
  cooldownUntil: null,
  frozen: false,
  frozenUntil: null,
  reason: null,
  lastFailureAt: null,
  lastResetAt: null,
});

export function openRuntimeProviderHealthStore(userRoot: string) {
  const target = path.join(userRoot, "runtime-provider-health.json");
  const read = (): Record<string, RuntimeProviderHealth> => {
    if (!existsSync(target)) return {};
    return JSON.parse(readFileSync(target, "utf8")) as Record<string, RuntimeProviderHealth>;
  };
  const persist = (next: Record<string, RuntimeProviderHealth>): void => {
    mkdirSync(userRoot, { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  };
  const get = (instanceId: string): RuntimeProviderHealth => read()[instanceId] ?? empty(instanceId);
  const list = (): readonly RuntimeProviderHealth[] => Object.values(read());
  const reset = (instanceId: string, at: string): RuntimeProviderHealth => {
    const next = { ...read(), [instanceId]: { ...empty(instanceId), lastResetAt: at } };
    persist(next);
    return next[instanceId]!;
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
      base = Math.max(0, input.cooldownBaseSeconds ?? 30),
      cap = Math.max(base, input.cooldownMaxSeconds ?? 300),
      cooldownSeconds = Math.min(cap, base * 2 ** Math.max(0, streak - 1)),
      threshold = Math.max(1, input.freezeAfter ?? 5),
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
              Date.parse(input.occurredAt) + Math.max(0, input.freezeDurationSeconds ?? 1800) * 1_000,
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
  const recordSuccess = (instanceId: string, attemptStartedAt: string): RuntimeProviderHealth => {
    const previous = get(instanceId),
      started = Date.parse(attemptStartedAt),
      failure = previous.lastFailureAt === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.lastFailureAt),
      resetAt = previous.lastResetAt === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.lastResetAt);
    if (started <= Math.max(failure, resetAt)) return previous;
    return reset(instanceId, attemptStartedAt);
  };
  return Object.freeze({ get, list, reset, recordFailure, recordSuccess });
}

export type RuntimeProviderHealthStore = ReturnType<typeof openRuntimeProviderHealthStore>;
