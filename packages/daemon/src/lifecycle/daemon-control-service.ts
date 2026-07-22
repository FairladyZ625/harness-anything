import { randomUUID } from "node:crypto";
import {
  daemonControlInProgressError,
  type DaemonControlErrorHostServices,
  type DaemonActiveControlStatus,
  type DaemonControlErrorV1,
  type DaemonControlService,
  type DaemonStatusResultV2
} from "@harness-anything/application";
import {
  projectDaemonLaunchConfiguration,
  type DaemonLaunchConfiguration
} from "../client/local-json-rpc-client.ts";

export type { DaemonLaunchConfiguration } from "../client/local-json-rpc-client.ts";

export function createDaemonControlService<
  PresentedError extends object
>(input: {
  readonly launchConfiguration: DaemonLaunchConfiguration;
  readonly preflightReplacement: (configuration: DaemonLaunchConfiguration) => Promise<void>;
  readonly status: () => DaemonStatusResultV2;
  readonly activeControl: () => DaemonActiveControlStatus | null;
  readonly setActiveControl: (active: DaemonActiveControlStatus) => void;
  readonly setDrainTimeout: (timeoutMs: number) => void;
  readonly requestStop: (request: {
    readonly reason: "control";
    readonly kind: "restart" | "refresh" | "upgrade";
    readonly operationId: string;
  }) => void;
}, hostServices: DaemonControlErrorHostServices<PresentedError>): DaemonControlService {
  return {
    requestControl: async (kind, request) => {
      const activeControl = input.activeControl();
      if (activeControl) return { ok: false, error: daemonControlInProgressError(activeControl) };
      if (request.daemonGeneration !== undefined
        && (input.launchConfiguration.machineId === undefined
          || input.launchConfiguration.daemonGeneration === undefined
          || request.daemonGeneration !== input.launchConfiguration.daemonGeneration)) {
        return {
          ok: false,
          error: {
            code: "daemon_control_generation_mismatch",
            hint: input.launchConfiguration.daemonGeneration === undefined
              ? "Generation-aware daemon control requires durable generation publication, but this daemon is running in legacy mode. Omit payload.daemonGeneration to use legacy control, or retry on a supported POSIX host."
              : `Requested daemon generation ${request.daemonGeneration} is invalid because it does not match current generation ${input.launchConfiguration.daemonGeneration}. Retry the control request with payload.daemonGeneration=${input.launchConfiguration.daemonGeneration}.`,
            operationId: null
          }
        };
      }
      if (kind !== "restart") {
        try {
          await input.preflightReplacement(input.launchConfiguration);
        } catch (error) {
          return {
            ok: false,
            error: {
              ...hostServices.present({
                code: "daemon_refresh_build_failed",
                context: { cause: error instanceof Error ? error.message : String(error) }
              }),
              operationId: null
            } as unknown as DaemonControlErrorV1
          };
        }
      }
      const before = input.status();
      const operationId = `control_${randomUUID()}`;
      const requestedAt = new Date().toISOString();
      const generationCapability = request.daemonGeneration !== undefined || request.connectionId !== undefined;
      const generationAxes = generationCapability
        && input.launchConfiguration.machineId !== undefined
        && input.launchConfiguration.daemonGeneration !== undefined
        ? {
            machineId: input.launchConfiguration.machineId,
            daemonGeneration: input.launchConfiguration.daemonGeneration
          }
        : {};
      input.setActiveControl({ operationId, kind, phase: "accepted", requestedAt, ...generationAxes });
      return {
        ok: true,
        accepted: {
          schema: "daemon-control-accepted/v1",
          accepted: true,
          operationId,
          kind,
          scope: "service",
          requestedAt,
          ...generationAxes,
          ...(request.connectionId !== undefined ? { connectionId: request.connectionId } : {}),
          before: {
            pid: before.service.pid,
            loadedIdentity: before.service.build.loadedIdentity,
            repoCount: before.service.repoCount,
            queueDepth: before.service.queue.depth,
            launchConfiguration: projectDaemonLaunchConfiguration(input.launchConfiguration, generationCapability),
            ...(generationCapability && input.launchConfiguration.daemonGeneration !== undefined
              ? { daemonGeneration: input.launchConfiguration.daemonGeneration } : {})
          }
        },
        afterResponse: () => {
          if (input.activeControl()?.operationId !== operationId) return;
          input.setActiveControl({ operationId, kind, phase: "draining", requestedAt, ...generationAxes });
          input.setDrainTimeout(request.drainTimeoutMs);
          input.requestStop({ reason: "control", kind, operationId });
        }
      };
    }
  };
}
