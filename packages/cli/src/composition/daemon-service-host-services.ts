import type { DaemonControlErrorV1, DaemonServiceHostServices } from "@harness-anything/application";
import type { AuthenticatedActor } from "@harness-anything/daemon";
import type { HarnessDaemonRuntime } from "@harness-anything/daemon";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { loadDaemonIdentity } from "../commands/daemon/productization.ts";
import { makeDaemonGuiControllerOptions } from "../commands/extensions/gui-controller-options.ts";
import { resolveManagedSectionPolicy } from "../commands/extensions/managed-section-policy.ts";
import { leaseEnforcementEnabled } from "../commands/settings.ts";
import { resolveCliVersion } from "../commands/core/version.ts";
import { daemonActorAttribution } from "./actor-attribution.ts";
import { cliDaemonCommandHostServices } from "./daemon-command-host-services.ts";

type LoadedDaemonIdentity = ReturnType<typeof loadDaemonIdentity>;

export const cliDaemonServiceHostServices = {
  command: cliDaemonCommandHostServices,
  errors: {
    present: (error) => error.code === "daemon_refresh_build_failed"
      ? {
        ...cliError(CliErrorCode.DaemonRefreshBuildFailed, `Daemon refresh replacement preflight failed before the running daemon was changed: ${error.context.cause}`),
        code: "daemon_refresh_build_failed" as const
      }
      : {
        ...cliError(CliErrorCode.DaemonQueueDrainTimeout, `Daemon ${error.context.kind} requires the write queue to drain within the deadline, but in-flight operations failed to settle in time. Run \`ha daemon status --json\`, inspect the reported queue operation tuples, resolve or recover them, then retry the control request.`),
        code: "daemon_queue_drain_timeout" as const
      }
  },
  docSync: { resolveManagedSectionPolicy },
  loadDaemonIdentity,
  daemonActorAttribution,
  makeGuiControllerOptions: (runtime, rootInput, commandOptions) => makeDaemonGuiControllerOptions(
    runtime,
    rootInput,
    commandOptions,
    cliDaemonCommandHostServices
  ),
  leaseEnforcementEnabled,
  version: resolveCliVersion
} satisfies DaemonServiceHostServices<
  ParsedCommand,
  CliResult,
  AuthenticatedActor,
  HarnessDaemonRuntime,
  LoadedDaemonIdentity,
  Pick<DaemonControlErrorV1, "code" | "hint">
>;
