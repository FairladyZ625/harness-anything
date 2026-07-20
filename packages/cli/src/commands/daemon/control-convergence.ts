export type DaemonLifecycleStatus = {
  readonly schema: "daemon-status/v1" | "daemon-status/v2";
  readonly started: true;
  readonly pid: number;
  readonly loadedIdentity?: string;
  readonly installedIdentity?: string;
  readonly operationCleared?: true;
  readonly activeOperationId?: string;
};

export function daemonControlFailure(
  status: Record<string, unknown> | undefined,
  operationId: string
): string | undefined {
  if (!status || status.schema !== "daemon-status/v2") return undefined;
  const service = isRecord(status.service) ? status.service : undefined;
  const activeControl = isRecord(service?.activeControl) ? service.activeControl : undefined;
  const failure = isRecord(activeControl?.failure) ? activeControl.failure : undefined;
  if (activeControl?.operationId !== operationId
    || activeControl.phase !== "failed"
    || typeof failure?.hint !== "string") return undefined;
  return typeof failure.code === "string"
    ? `${failure.code}: ${failure.hint}`
    : failure.hint;
}

export function normalizeDaemonLifecycleStatus(
  status: Record<string, unknown>
): DaemonLifecycleStatus | undefined {
  const isV2 = status.schema === "daemon-status/v2";
  const lifecycle = isV2
    ? (isRecord(status.service) ? status.service : undefined)
    : status.schema === "daemon-status/v1" ? status : undefined;
  if (lifecycle?.started !== true || !isPositivePid(lifecycle.pid)) return undefined;
  if (!isV2) return { schema: "daemon-status/v1", started: true, pid: lifecycle.pid };
  const build = isRecord(lifecycle.build) ? lifecycle.build : {};
  const activeControl = isRecord(lifecycle.activeControl) ? lifecycle.activeControl : undefined;
  return {
    schema: "daemon-status/v2",
    started: true,
    pid: lifecycle.pid,
    ...(typeof build.loadedIdentity === "string" ? { loadedIdentity: build.loadedIdentity } : {}),
    ...(typeof build.installedIdentity === "string" ? { installedIdentity: build.installedIdentity } : {}),
    ...(lifecycle.activeControl === null ? { operationCleared: true as const } : {}),
    ...(typeof activeControl?.operationId === "string" ? { activeOperationId: activeControl.operationId } : {})
  };
}

export function isCompleteReplacement(
  status: DaemonLifecycleStatus,
  beforePid: number,
  operationId: string,
  expectedIdentity: string | undefined
): boolean {
  if (status.pid === beforePid || status.schema === "daemon-status/v1") return false;
  return typeof status.loadedIdentity === "string"
    && typeof status.installedIdentity === "string"
    && status.loadedIdentity === status.installedIdentity
    && (expectedIdentity === undefined || status.loadedIdentity === expectedIdentity)
    && status.operationCleared === true
    && status.activeOperationId !== operationId;
}

export function replacementIdentityIsInvalid(
  status: DaemonLifecycleStatus,
  expectedIdentity: string | undefined
): boolean {
  return status.schema === "daemon-status/v1"
    || typeof status.loadedIdentity !== "string"
    || typeof status.installedIdentity !== "string"
    || status.loadedIdentity !== status.installedIdentity
    || (expectedIdentity !== undefined && status.loadedIdentity !== expectedIdentity);
}

export function incompleteReplacementReason(
  status: DaemonLifecycleStatus,
  beforePid: number,
  operationId: string,
  expectedIdentity: string | undefined
): string {
  if (status.pid === beforePid) return `PID did not change: ${String(status.pid)}`;
  if (status.schema === "daemon-status/v1") return "did not expose daemon-status/v2 replacement criteria";
  if (typeof status.loadedIdentity !== "string" || typeof status.installedIdentity !== "string") {
    return "did not expose loaded and installed identities";
  }
  if (status.loadedIdentity !== status.installedIdentity) {
    return `loaded identity did not converge on the installed identity: loaded=${status.loadedIdentity} installed=${status.installedIdentity}`;
  }
  if (expectedIdentity !== undefined && status.loadedIdentity !== expectedIdentity) {
    return `loaded identity did not match the replacement identity calculated before handoff: loaded=${status.loadedIdentity} expected=${expectedIdentity}`;
  }
  if (status.activeOperationId === operationId) return `did not clear the accepted control operation ${operationId}`;
  if (status.operationCleared !== true) return "did not expose a cleared control operation state";
  return "did not satisfy replacement criteria";
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
