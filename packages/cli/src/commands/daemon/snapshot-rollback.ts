import type { DaemonLaunchConfiguration } from "../../daemon/daemon-launch-spec.ts";
import {
  isCompleteReplacement,
  normalizeDaemonLifecycleStatus,
  type DaemonGenerationConvergenceExpectation
} from "./control-convergence.ts";
import type { DaemonControlKind } from "./control.ts";
import type { DaemonControlLifecycle } from "./control-replacement.ts";

export async function rollbackDaemonReplacement(input: {
  readonly lifecycle: DaemonControlLifecycle;
  readonly replacementFailure: unknown;
  readonly beforePid: number;
  readonly expectedIdentity: string | undefined;
  readonly operationId: string;
  readonly timeoutMs: number;
  readonly kind: DaemonControlKind;
  readonly launchConfiguration: DaemonLaunchConfiguration;
  readonly expectedGeneration: DaemonGenerationConvergenceExpectation | undefined;
}): Promise<never> {
  const restoration = input.kind === "upgrade" ? "previous snapshot rollback" : "service restoration";
  const occupied = await input.lifecycle.probeStatus(
    input.lifecycle.target,
    input.expectedGeneration ? { includeGenerationAxes: true } : undefined
  );
  if (occupied) {
    const occupiedLifecycle = normalizeDaemonLifecycleStatus(occupied);
    if (occupiedLifecycle?.pid === input.beforePid) throw input.replacementFailure;
    throw new Error(
      `${rollbackErrorMessage(input.replacementFailure)}; ${restoration} was not started because the endpoint is still owned`
    );
  }
  try {
    const restored = await input.lifecycle.startReplacement(
      input.lifecycle.target,
      input.timeoutMs,
      input.launchConfiguration,
      input.expectedGeneration ? { includeGenerationAxes: true } : undefined
    );
    const restoredLifecycle = normalizeDaemonLifecycleStatus(restored);
    if (!restoredLifecycle
      || !isCompleteReplacement(
        restoredLifecycle,
        input.beforePid,
        input.operationId,
        input.expectedIdentity,
        input.expectedGeneration
      )) {
      throw new Error("restored daemon did not become reachable with the expected build and authority generation");
    }
  } catch (rollbackError) {
    throw new Error(
      `${rollbackErrorMessage(input.replacementFailure)}; ${restoration} failed: ${rollbackErrorMessage(rollbackError)}. `
      + `Restore the daemon with: ${daemonRecoveryCommand(input.launchConfiguration)}`
    );
  }
  const outcome = input.kind === "upgrade"
    ? "previous snapshot restored and authority converged"
    : "service restored and reachable";
  throw new Error(`${rollbackErrorMessage(input.replacementFailure)}; ${outcome}`);
}

export function daemonRecoveryCommand(configuration: DaemonLaunchConfiguration): string {
  return [configuration.execPath, ...configuration.execArgv, configuration.entrypoint, ...configuration.args]
    .map(quoteDaemonRecoveryArgument)
    .join(" ");
}

export function quoteDaemonRecoveryArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function rollbackErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
