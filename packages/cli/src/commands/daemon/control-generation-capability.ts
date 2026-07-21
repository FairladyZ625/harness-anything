import {
  normalizeDaemonLifecycleStatus,
  type DaemonGenerationConvergenceExpectation
} from "./control-convergence.ts";

export function acceptedGenerationExpectation(
  receipt: Record<string, unknown>,
  before: Record<string, unknown>,
  probed: DaemonGenerationConvergenceExpectation | undefined
): DaemonGenerationConvergenceExpectation | undefined {
  const hasGenerationCapability = receipt.machineId !== undefined
    || receipt.daemonGeneration !== undefined
    || before.daemonGeneration !== undefined;
  if (!hasGenerationCapability) {
    if (probed) throw new Error("daemon control accepted receipt omitted the probed generation capability");
    return undefined;
  }
  if (typeof receipt.machineId !== "string" || receipt.machineId.length === 0
    || !isPositiveInteger(receipt.daemonGeneration)
    || !isPositiveInteger(before.daemonGeneration)
    || receipt.daemonGeneration !== before.daemonGeneration) {
    throw new Error("daemon control accepted receipt exposed an incomplete or inconsistent generation capability");
  }
  if (probed && (receipt.machineId !== probed.machineId || receipt.daemonGeneration !== probed.daemonGeneration)) {
    throw new Error("daemon control accepted receipt did not match the probed generation owner");
  }
  return { machineId: receipt.machineId, daemonGeneration: receipt.daemonGeneration };
}

export function generationExpectationFromCapabilityStatus(
  status: Record<string, unknown> | undefined,
  platform: NodeJS.Platform
): DaemonGenerationConvergenceExpectation | undefined {
  const lifecycle = status ? normalizeDaemonLifecycleStatus(status) : undefined;
  const hasAnyAxis = lifecycle?.machineId !== undefined || lifecycle?.daemonGeneration !== undefined;
  if (lifecycle?.machineId !== undefined && lifecycle.daemonGeneration !== undefined) {
    return { machineId: lifecycle.machineId, daemonGeneration: lifecycle.daemonGeneration };
  }
  if (platform === "win32" && !hasAnyAxis) return undefined;
  throw new Error(
    "DAEMON_GENERATION_CAPABILITY_INCOMPLETE: generation-aware daemon control requires a reachable status response with machineId and daemonGeneration"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
