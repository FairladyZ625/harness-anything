import {
  isDomainStatus,
  isPackageDisposition,
  isTerminalStatus,
  stablePayloadHash,
  type PresetManifest,
  type TaskContractSnapshot
} from "../../kernel/src/index.ts";

export type PresetRuntimeRequirement = "none" | "required" | "unknown";
export type PresetUninstallDecisionReason =
  | "declarative_snapshot_self_contained"
  | "preset_private_runtime_required"
  | "preset_private_runtime_unknown"
  | "task_contract_snapshot_invalid"
  | "task_contract_snapshot_metadata_mismatch"
  | "task_contract_snapshot_missing"
  | "task_state_unproven"
  | "terminal_snapshot_self_contained";

export interface PresetUninstallTarget {
  readonly id: string;
  readonly version: string;
  readonly runtimeRequirement: PresetRuntimeRequirement;
}

export interface PresetUninstallTaskReference {
  readonly taskId: string;
  readonly status: string;
  readonly packageDisposition: string;
  readonly metadata: {
    readonly vertical: string;
    readonly presetId: string;
    readonly profileId?: string;
  };
  readonly snapshot?: TaskContractSnapshot;
  readonly snapshotError?: string;
}

export interface PresetUninstallImpactEntry {
  readonly taskId: string;
  readonly status: string;
  readonly packageDisposition: string;
  readonly preset: {
    readonly id: string;
    readonly version?: string;
  };
  readonly snapshot: "invalid" | "matching" | "mismatch" | "missing";
  readonly runtime: "not_required" | "required" | "unknown";
  readonly decision: "allow" | "block";
  readonly reason: PresetUninstallDecisionReason;
}

export interface PresetUninstallImpactReport {
  readonly schema: "preset-uninstall-impact-report/v1";
  readonly preset: PresetUninstallTarget;
  readonly examinedTaskCount: number;
  readonly inboundTaskCount: number;
  readonly blockerCount: number;
  readonly allowed: boolean;
  readonly tasks: ReadonlyArray<PresetUninstallImpactEntry>;
}

export function analyzePresetUninstallImpact(input: {
  readonly preset: PresetUninstallTarget;
  readonly tasks: ReadonlyArray<PresetUninstallTaskReference>;
}): PresetUninstallImpactReport {
  const inbound = input.tasks.filter((task) =>
    task.metadata.presetId === input.preset.id || task.snapshot?.preset.id === input.preset.id
  );
  const tasks = inbound.map((task) => classifyInboundTask(input.preset, task));
  const blockerCount = tasks.filter((task) => task.decision === "block").length;
  return {
    schema: "preset-uninstall-impact-report/v1",
    preset: input.preset,
    examinedTaskCount: input.tasks.length,
    inboundTaskCount: tasks.length,
    blockerCount,
    allowed: blockerCount === 0,
    tasks
  };
}

export type PresetRuntimeAvailability =
  | { readonly status: "available" }
  | { readonly status: "not_applicable" }
  | {
    readonly status: "unavailable";
    readonly preset: { readonly id: string; readonly version: string };
    readonly reason: "identity_mismatch" | "not_installed";
  };

export function evaluatePresetRuntimeAvailability(input: {
  readonly requestedPresetId: string;
  readonly snapshot?: TaskContractSnapshot;
  readonly installedPreset?: PresetManifest;
}): PresetRuntimeAvailability {
  if (!input.snapshot || input.snapshot.preset.id !== input.requestedPresetId) {
    return { status: "not_applicable" };
  }
  const frozen = {
    id: input.snapshot.preset.id,
    version: input.snapshot.preset.version
  };
  if (!input.installedPreset) {
    return { status: "unavailable", preset: frozen, reason: "not_installed" };
  }
  const installedDigest = `sha256:${stablePayloadHash(input.installedPreset)}`;
  if (
    input.installedPreset.id !== frozen.id ||
    input.installedPreset.version !== frozen.version ||
    installedDigest !== input.snapshot.preset.digest
  ) {
    return { status: "unavailable", preset: frozen, reason: "identity_mismatch" };
  }
  return { status: "available" };
}

function classifyInboundTask(
  preset: PresetUninstallTarget,
  task: PresetUninstallTaskReference
): PresetUninstallImpactEntry {
  const base = {
    taskId: task.taskId,
    status: task.status,
    packageDisposition: task.packageDisposition,
    preset: {
      id: task.snapshot?.preset.id ?? task.metadata.presetId,
      ...(task.snapshot ? { version: task.snapshot.preset.version } : {})
    }
  };
  if (task.snapshotError) {
    return blocked(base, "invalid", "unknown", "task_contract_snapshot_invalid");
  }
  if (!task.snapshot) {
    return blocked(base, "missing", "unknown", "task_contract_snapshot_missing");
  }
  if (!snapshotMatchesMetadata(task)) {
    return blocked(base, "mismatch", "unknown", "task_contract_snapshot_metadata_mismatch");
  }
  if (!isDomainStatus(task.status) || !isPackageDisposition(task.packageDisposition)) {
    return blocked(base, "matching", "unknown", "task_state_unproven");
  }
  if (
    isTerminalStatus(task.status) ||
    task.packageDisposition === "archived" ||
    task.packageDisposition === "tombstoned"
  ) {
    return allowed(base, "matching", "not_required", "terminal_snapshot_self_contained");
  }
  if (preset.runtimeRequirement === "required") {
    return blocked(base, "matching", "required", "preset_private_runtime_required");
  }
  if (preset.runtimeRequirement === "unknown") {
    return blocked(base, "matching", "unknown", "preset_private_runtime_unknown");
  }
  return allowed(base, "matching", "not_required", "declarative_snapshot_self_contained");
}

function snapshotMatchesMetadata(task: PresetUninstallTaskReference): boolean {
  const snapshot = task.snapshot;
  if (!snapshot) return false;
  return snapshot.vertical === task.metadata.vertical &&
    snapshot.preset.id === task.metadata.presetId &&
    (!task.metadata.profileId || snapshot.profile.id === task.metadata.profileId);
}

function allowed(
  base: Pick<PresetUninstallImpactEntry, "packageDisposition" | "preset" | "status" | "taskId">,
  snapshot: PresetUninstallImpactEntry["snapshot"],
  runtime: PresetUninstallImpactEntry["runtime"],
  reason: PresetUninstallDecisionReason
): PresetUninstallImpactEntry {
  return { ...base, snapshot, runtime, decision: "allow", reason };
}

function blocked(
  base: Pick<PresetUninstallImpactEntry, "packageDisposition" | "preset" | "status" | "taskId">,
  snapshot: PresetUninstallImpactEntry["snapshot"],
  runtime: PresetUninstallImpactEntry["runtime"],
  reason: PresetUninstallDecisionReason
): PresetUninstallImpactEntry {
  return { ...base, snapshot, runtime, decision: "block", reason };
}
