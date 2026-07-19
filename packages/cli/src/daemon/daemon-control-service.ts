import { randomUUID } from "node:crypto";
import {
  daemonControlInProgressError,
  type DaemonActiveControlStatus,
  type DaemonControlService,
  type DaemonStatusResultV2
} from "../../../application/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { DaemonLaunchConfiguration } from "./daemon-launch-spec.ts";

export type { DaemonLaunchConfiguration } from "./daemon-launch-spec.ts";

export function createDaemonControlService(input: {
  readonly launchConfiguration: DaemonLaunchConfiguration;
  readonly preflightReplacement: (configuration: DaemonLaunchConfiguration) => Promise<void>;
  readonly status: () => DaemonStatusResultV2;
  readonly activeControl: () => DaemonActiveControlStatus | null;
  readonly setActiveControl: (active: DaemonActiveControlStatus) => void;
  readonly setDrainTimeout: (timeoutMs: number) => void;
  readonly requestStop: (request: {
    readonly reason: "control";
    readonly kind: "restart" | "refresh";
    readonly operationId: string;
  }) => void;
}): DaemonControlService {
  return {
    requestControl: async (kind, request) => {
      const activeControl = input.activeControl();
      if (activeControl) return { ok: false, error: daemonControlInProgressError(activeControl) };
      if (kind === "refresh") {
        try {
          await input.preflightReplacement(input.launchConfiguration);
        } catch (error) {
          return {
            ok: false,
            error: {
              ...cliError(
                CliErrorCode.DaemonRefreshBuildFailed,
                `Daemon refresh replacement preflight failed before the running daemon was changed: ${error instanceof Error ? error.message : String(error)}`
              ),
              code: CliErrorCode.DaemonRefreshBuildFailed,
              operationId: null
            }
          };
        }
      }
      const before = input.status();
      const operationId = `control_${randomUUID()}`;
      const requestedAt = new Date().toISOString();
      input.setActiveControl({ operationId, kind, phase: "accepted", requestedAt });
      return {
        ok: true,
        accepted: {
          schema: "daemon-control-accepted/v1",
          accepted: true,
          operationId,
          kind,
          scope: "service",
          requestedAt,
          before: {
            pid: before.service.pid,
            loadedIdentity: before.service.build.loadedIdentity,
            repoCount: before.service.repoCount,
            queueDepth: before.service.queue.depth,
            launchConfiguration: input.launchConfiguration
          }
        },
        afterResponse: () => {
          if (input.activeControl()?.operationId !== operationId) return;
          input.setActiveControl({ operationId, kind, phase: "draining", requestedAt });
          input.setDrainTimeout(request.drainTimeoutMs);
          input.requestStop({ reason: "control", kind, operationId });
        }
      };
    }
  };
}
