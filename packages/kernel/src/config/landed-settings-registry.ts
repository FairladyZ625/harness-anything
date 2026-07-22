export type LandedSettingUnit = "milliseconds" | "bytes" | "count" | "url";
export type LandedSettingSource = "default" | "yaml" | "env" | "flag";

export interface LandedSettingDefinition {
  readonly key: string;
  readonly cluster: "H-01" | "H-02" | "H-04" | "E-02" | "E-03" | "E-08" | "E-09" | "E-10" | "E-11" | "D-02" | "D-03" | "D-04" | "D-05" | "D-12";
  readonly description: string;
  readonly unit: LandedSettingUnit;
  readonly defaultValue: number | string | undefined;
  readonly yamlPath?: ReadonlyArray<string>;
  readonly env: string;
  readonly flag?: string;
  readonly callerOption?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly emptyEnvironmentIsUnset?: boolean;
  readonly overrideChain: ReadonlyArray<LandedSettingSource | "caller-option">;
}

export const landedSettingDefaults = Object.freeze({
  taskLeaseTtlMs: 24 * 60 * 60 * 1_000,
  executionConsentTtlMs: 24 * 60 * 60 * 1_000,
  multicaStaleTtlMs: 5 * 60 * 1_000,
  fdeProbeTimeoutMs: 10_000,
  fdeProbeMaxBufferBytes: 1024 * 1024,
  gitMaxBufferBytes: 256 * 1024 * 1024,
  projectionMaxChangedPaths: 50_000,
  runtimeLogSearchDepth: 8,
  electronRendererUrl: undefined,
  benchLockMaxWaitMs: 100,
  benchLockInitialDelayMs: 5,
  benchLockMaxDelayMs: 10,
  benchBarrierTimeoutMs: 10_000,
  benchBarrierPollMs: 5,
  presetContextMaxMilestones: 20,
  presetContextMaxNotes: 3,
  daemonWriteLockTtlMs: 60_000,
  daemonInteractiveMicroBatchMs: 10,
  daemonMaxInteractiveOpsPerCommit: 32,
  daemonMaterializerPollMs: 5_000,
  daemonMaterializerMaxBranchesPerBatch: 1,
  daemonProjectionReconcileIntervalMs: 30_000,
  daemonRegistryReconcileIntervalMs: 1_000
});

const positiveIntegerMaximum = Number.MAX_SAFE_INTEGER;

export const landedSettingsRegistry = Object.freeze([
  setting("tasks.leaseTtlMs", "H-01", "Task-holder lease lifetime", "milliseconds", landedSettingDefaults.taskLeaseTtlMs, "HARNESS_TASK_LEASE_TTL_MS", {
    yamlPath: ["tasks", "leaseTtlMs"], flag: "task claim --ttl-ms", maximum: positiveIntegerMaximum, emptyEnvironmentIsUnset: true, overrideChain: ["default", "yaml", "env", "flag"]
  }),
  setting("execution.consentTtlMs", "H-02", "Execution consent validity window", "milliseconds", landedSettingDefaults.executionConsentTtlMs, "HARNESS_EXECUTION_CONSENT_TTL_MS", {
    yamlPath: ["execution", "consentTtlMs"], maximum: positiveIntegerMaximum, overrideChain: ["default", "yaml", "env"]
  }),
  setting("adapters.multica.staleTtlMs", "H-04", "Multica cached-data stale threshold", "milliseconds", landedSettingDefaults.multicaStaleTtlMs, "HARNESS_MULTICA_STALE_TTL_MS", {
    yamlPath: ["adapters", "multica", "staleTtlMs"], maximum: positiveIntegerMaximum, overrideChain: ["default", "yaml", "env"]
  }),
  setting("fde.probeTimeoutMs", "E-02", "Full-disk-encryption probe timeout", "milliseconds", landedSettingDefaults.fdeProbeTimeoutMs, "HARNESS_FDE_PROBE_TIMEOUT_MS", { maximum: 120_000 }),
  setting("fde.probeMaxBufferBytes", "E-02", "Full-disk-encryption probe output ceiling", "bytes", landedSettingDefaults.fdeProbeMaxBufferBytes, "HARNESS_FDE_PROBE_MAX_BUFFER_BYTES", { maximum: 64 * 1024 * 1024 }),
  setting("git.maxBufferBytes", "E-03", "Git subprocess output ceiling", "bytes", landedSettingDefaults.gitMaxBufferBytes, "HARNESS_GIT_MAX_BUFFER_BYTES", { maximum: 1024 * 1024 * 1024 }),
  setting("projection.maxChangedPaths", "E-03", "Changed-path projection cardinality ceiling", "count", landedSettingDefaults.projectionMaxChangedPaths, "HARNESS_PROJECTION_MAX_CHANGED_PATHS", { maximum: 1_000_000 }),
  setting("runtimeLogs.searchDepth", "E-08", "Runtime log directory search depth", "count", landedSettingDefaults.runtimeLogSearchDepth, "HARNESS_RUNTIME_LOG_SEARCH_DEPTH", {
    maximum: 64, callerOption: "maxSearchDepth", emptyEnvironmentIsUnset: true, overrideChain: ["default", "env", "caller-option"]
  }),
  setting("gui.rendererUrl", "E-09", "Explicit loopback Electron development renderer URL", "url", landedSettingDefaults.electronRendererUrl, "ELECTRON_RENDERER_URL", { emptyEnvironmentIsUnset: true }),
  setting("benchmark.lockMaxWaitMs", "E-10", "Receipt benchmark lock retry budget", "milliseconds", landedSettingDefaults.benchLockMaxWaitMs, "HARNESS_BENCH_LOCK_MAX_WAIT_MS", {
    flag: "--lock-max-wait-ms", maximum: 60_000, overrideChain: ["default", "env", "flag"]
  }),
  setting("benchmark.lockInitialDelayMs", "E-10", "Receipt benchmark initial retry delay", "milliseconds", landedSettingDefaults.benchLockInitialDelayMs, "HARNESS_BENCH_LOCK_INITIAL_DELAY_MS", {
    flag: "--lock-initial-delay-ms", maximum: 10_000, overrideChain: ["default", "env", "flag"]
  }),
  setting("benchmark.lockMaxDelayMs", "E-10", "Receipt benchmark maximum retry delay", "milliseconds", landedSettingDefaults.benchLockMaxDelayMs, "HARNESS_BENCH_LOCK_MAX_DELAY_MS", {
    flag: "--lock-max-delay-ms", maximum: 10_000, overrideChain: ["default", "env", "flag"]
  }),
  setting("benchmark.barrierTimeoutMs", "E-10", "Receipt benchmark barrier timeout", "milliseconds", landedSettingDefaults.benchBarrierTimeoutMs, "HARNESS_BENCH_BARRIER_TIMEOUT_MS", {
    flag: "--barrier-timeout-ms", maximum: 120_000, overrideChain: ["default", "env", "flag"]
  }),
  setting("benchmark.barrierPollMs", "E-10", "Receipt benchmark barrier poll interval", "milliseconds", landedSettingDefaults.benchBarrierPollMs, "HARNESS_BENCH_BARRIER_POLL_MS", {
    flag: "--barrier-poll-ms", maximum: 10_000, overrideChain: ["default", "env", "flag"]
  }),
  setting("presetContext.maxMilestones", "E-11", "Preset context milestone file ceiling", "count", landedSettingDefaults.presetContextMaxMilestones, "HARNESS_PRESET_CONTEXT_MAX_MILESTONES", {
    maximum: 200, callerOption: "maxMilestoneFiles", overrideChain: ["default", "env", "caller-option"]
  }),
  setting("presetContext.maxNotes", "E-11", "Preset context milestone note ceiling", "count", landedSettingDefaults.presetContextMaxNotes, "HARNESS_PRESET_CONTEXT_MAX_NOTES", {
    maximum: 50, callerOption: "maxMilestoneNotes", overrideChain: ["default", "env", "caller-option"]
  }),
  setting("daemonRuntime.writeLockTtlMs", "D-02", "Daemon write-lock stale lifetime", "milliseconds", landedSettingDefaults.daemonWriteLockTtlMs, "HARNESS_DAEMON_WRITE_LOCK_TTL_MS", {
    yamlPath: ["daemonRuntime", "writeLockTtlMs"], maximum: 24 * 60 * 60 * 1_000, overrideChain: ["default", "yaml", "env"]
  }),
  setting("daemonRuntime.interactiveMicroBatchMs", "D-03", "Interactive write micro-batch delay", "milliseconds", landedSettingDefaults.daemonInteractiveMicroBatchMs, "HARNESS_DAEMON_INTERACTIVE_MICROBATCH_MS", {
    yamlPath: ["daemonRuntime", "interactiveMicroBatchMs"], minimum: 0, maximum: 60_000, overrideChain: ["default", "yaml", "env"]
  }),
  setting("daemonRuntime.maxInteractiveOpsPerCommit", "D-03", "Interactive operations per commit ceiling", "count", landedSettingDefaults.daemonMaxInteractiveOpsPerCommit, "HARNESS_DAEMON_MAX_INTERACTIVE_OPS_PER_COMMIT", {
    yamlPath: ["daemonRuntime", "maxInteractiveOpsPerCommit"], maximum: 10_000, overrideChain: ["default", "yaml", "env"]
  }),
  setting("daemonRuntime.materializerPollMs", "D-04", "Ledger materializer idle poll interval", "milliseconds", landedSettingDefaults.daemonMaterializerPollMs, "HARNESS_DAEMON_MATERIALIZER_POLL_MS", {
    yamlPath: ["daemonRuntime", "materializerPollMs"], maximum: 60 * 60 * 1_000, overrideChain: ["default", "yaml", "env"]
  }),
  setting("daemonRuntime.materializerMaxBranchesPerBatch", "D-04", "Ledger branches materialized per batch", "count", landedSettingDefaults.daemonMaterializerMaxBranchesPerBatch, "HARNESS_DAEMON_MATERIALIZER_MAX_BRANCHES_PER_BATCH", {
    yamlPath: ["daemonRuntime", "materializerMaxBranchesPerBatch"], maximum: 10_000, overrideChain: ["default", "yaml", "env"]
  }),
  setting("daemonRuntime.projectionReconcileIntervalMs", "D-05", "Projection reconciliation interval", "milliseconds", landedSettingDefaults.daemonProjectionReconcileIntervalMs, "HARNESS_DAEMON_PROJECTION_RECONCILE_INTERVAL_MS", {
    yamlPath: ["daemonRuntime", "projectionReconcileIntervalMs"], maximum: 60 * 60 * 1_000, overrideChain: ["default", "yaml", "env"]
  }),
  setting("daemonRuntime.registryReconcileIntervalMs", "D-12", "Daemon registry reconciliation interval", "milliseconds", landedSettingDefaults.daemonRegistryReconcileIntervalMs, "HARNESS_DAEMON_REGISTRY_RECONCILE_INTERVAL_MS", {
    yamlPath: ["daemonRuntime", "registryReconcileIntervalMs"], maximum: 60 * 60 * 1_000, overrideChain: ["default", "yaml", "env"]
  })
] as const satisfies ReadonlyArray<LandedSettingDefinition>);

function setting(
  key: string,
  cluster: LandedSettingDefinition["cluster"],
  description: string,
  unit: LandedSettingUnit,
  defaultValue: number | string | undefined,
  env: string,
  options: Partial<Omit<LandedSettingDefinition, "key" | "cluster" | "description" | "unit" | "defaultValue" | "env">> = {}
): LandedSettingDefinition {
  return Object.freeze({
    key,
    cluster,
    description,
    unit,
    defaultValue,
    env,
    minimum: options.minimum ?? (unit === "url" ? undefined : 1),
    overrideChain: options.overrideChain ?? (["default", "env"] as const),
    ...options
  });
}
