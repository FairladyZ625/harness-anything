interface ProductionRecoveryAdmissionState {
  readonly status: "recovering" | "complete" | "failed";
  readonly error?: string;
  readonly promise: Promise<void>;
}

// Return a fail-closed recovery receipt before the repo-write transport's 30s
// request deadline so the supervisor leaves the recovering child alive.
export const defaultProductionRecoveryAdmissionTimeoutMs = 25_000;

export async function waitForProductionRecovery(
  material: {
    readonly repoId: string;
    readonly recovery: ProductionRecoveryAdmissionState;
  },
  timeoutMs = defaultProductionRecoveryAdmissionTimeoutMs
): Promise<string | undefined> {
  if (material.recovery.status !== "recovering") return recoveryUnavailableReason(material);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    material.recovery.promise.then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (!timedOut) return recoveryUnavailableReason(material);
  if (material.recovery.status !== "recovering") return recoveryUnavailableReason(material);
  return `AUTHORITY_RECOVERY_WAIT_TIMEOUT:repoId=${material.repoId};waitedMs=${timeoutMs}; run \`ha daemon start --service\`, then retry this command against the service daemon so recovery progress is preserved`;
}

function recoveryUnavailableReason(material: {
  readonly repoId: string;
  readonly recovery: ProductionRecoveryAdmissionState;
}): string | undefined {
  if (material.recovery.status === "complete") return undefined;
  if (material.recovery.status === "recovering") {
    return `AUTHORITY_RECOVERY_IN_PROGRESS:repoId=${material.repoId}`;
  }
  return `AUTHORITY_RECOVERY_FAILED:repoId=${material.repoId};error=${material.recovery.error ?? "unknown"}`;
}
