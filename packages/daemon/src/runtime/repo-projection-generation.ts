import { createDaemonProjectionGenerationManager } from "./projection-generation-manager.ts";
import type { DaemonRepoRuntimeOptions } from "./repo-runtime-options.ts";
import { defaultDaemonRuntimePolicy } from "./runtime-policy.ts";

export function createRepoProjectionGenerationManager(
  rootDir: string,
  options: Pick<
    DaemonRepoRuntimeOptions,
    "layoutOverrides" | "projectionSourceFenceFactory" | "projectionReconcileIntervalMs"
  >
) {
  return createDaemonProjectionGenerationManager({
    rootDir,
    ...(options.layoutOverrides ? { layoutOverrides: options.layoutOverrides } : {}),
    ...(options.projectionSourceFenceFactory ? {
      sourceFence: options.projectionSourceFenceFactory({
        rootDir,
        ...(options.layoutOverrides ? { layoutOverrides: options.layoutOverrides } : {})
      })
    } : {}),
    reconcileIntervalMs: options.projectionReconcileIntervalMs
      ?? defaultDaemonRuntimePolicy.projection.reconcileIntervalMs
  });
}
