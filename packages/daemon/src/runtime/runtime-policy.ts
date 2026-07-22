export interface DaemonRuntimePolicy {
  readonly write: {
    readonly lockTtlMs: number;
    readonly interactiveMicroBatchMs: number;
    readonly maxInteractiveOpsPerCommit: number;
  };
  readonly materializer: {
    readonly pollMs: number;
    readonly maxBranchesPerBatch: number;
  };
  readonly projection: {
    readonly reconcileIntervalMs: number;
  };
  readonly registry: {
    readonly reconcileIntervalMs: number;
  };
}

export interface DaemonRuntimePolicyValues {
  readonly writeLockTtlMs?: number;
  readonly interactiveMicroBatchMs?: number;
  readonly maxInteractiveOpsPerCommit?: number;
  readonly materializerPollMs?: number;
  readonly materializerMaxBranchesPerBatch?: number;
  readonly projectionReconcileIntervalMs?: number;
  readonly registryReconcileIntervalMs?: number;
}

export const defaultDaemonRuntimePolicy: DaemonRuntimePolicy = Object.freeze({
  write: Object.freeze({ lockTtlMs: 60_000, interactiveMicroBatchMs: 10, maxInteractiveOpsPerCommit: 32 }),
  materializer: Object.freeze({ pollMs: 5_000, maxBranchesPerBatch: 1 }),
  projection: Object.freeze({ reconcileIntervalMs: 30_000 }),
  registry: Object.freeze({ reconcileIntervalMs: 1_000 })
});

export function resolveDaemonRuntimePolicy(env: NodeJS.ProcessEnv = process.env, yaml: DaemonRuntimePolicyValues = {}): DaemonRuntimePolicy {
  return Object.freeze({
    write: Object.freeze({
      lockTtlMs: value("HARNESS_DAEMON_WRITE_LOCK_TTL_MS", env.HARNESS_DAEMON_WRITE_LOCK_TTL_MS, yaml.writeLockTtlMs ?? 60_000, 1, 24 * 60 * 60 * 1_000),
      interactiveMicroBatchMs: value("HARNESS_DAEMON_INTERACTIVE_MICROBATCH_MS", env.HARNESS_DAEMON_INTERACTIVE_MICROBATCH_MS, yaml.interactiveMicroBatchMs ?? 10, 0, 60_000),
      maxInteractiveOpsPerCommit: value("HARNESS_DAEMON_MAX_INTERACTIVE_OPS_PER_COMMIT", env.HARNESS_DAEMON_MAX_INTERACTIVE_OPS_PER_COMMIT, yaml.maxInteractiveOpsPerCommit ?? 32, 1, 10_000)
    }),
    materializer: Object.freeze({
      pollMs: value("HARNESS_DAEMON_MATERIALIZER_POLL_MS", env.HARNESS_DAEMON_MATERIALIZER_POLL_MS, yaml.materializerPollMs ?? 5_000, 1, 60 * 60 * 1_000),
      maxBranchesPerBatch: value("HARNESS_DAEMON_MATERIALIZER_MAX_BRANCHES_PER_BATCH", env.HARNESS_DAEMON_MATERIALIZER_MAX_BRANCHES_PER_BATCH, yaml.materializerMaxBranchesPerBatch ?? 1, 1, 10_000)
    }),
    projection: Object.freeze({
      reconcileIntervalMs: value("HARNESS_DAEMON_PROJECTION_RECONCILE_INTERVAL_MS", env.HARNESS_DAEMON_PROJECTION_RECONCILE_INTERVAL_MS, yaml.projectionReconcileIntervalMs ?? 30_000, 1, 60 * 60 * 1_000)
    }),
    registry: Object.freeze({
      reconcileIntervalMs: value("HARNESS_DAEMON_REGISTRY_RECONCILE_INTERVAL_MS", env.HARNESS_DAEMON_REGISTRY_RECONCILE_INTERVAL_MS, yaml.registryReconcileIntervalMs ?? 1_000, 1, 60 * 60 * 1_000)
    })
  });
}

function value(name: string, raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/u.test(raw.trim())) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
