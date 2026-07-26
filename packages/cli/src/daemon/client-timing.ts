import type { LocalDaemonAutostartPhase } from "@harness-anything/daemon";
import type { ParsedCommand } from "../cli/types.ts";
import { startCliTimingPhase, type CliTimingPhase } from "../cli/timing.ts";

export function daemonAutostartOptions(
  command: ParsedCommand,
  config: { readonly idleExitMs: number; readonly autostartTimeoutMs: number; readonly requestTimeoutMs: number },
  onPhase: (phase: LocalDaemonAutostartPhase) => void,
  entryPath: string
) {
  return {
    entryPath,
    idleExitMs: config.idleExitMs,
    timeoutMs: config.autostartTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    layoutOverrides: command.layoutOverrides,
    onPhase
  };
}

export function daemonTimingObserver(): {
  readonly observe: (event: LocalDaemonAutostartPhase) => void;
  readonly finish: () => void;
} {
  let finishPhase: (() => void) | undefined;
  let launchReported = false;
  const transition = (phase?: CliTimingPhase) => {
    finishPhase?.();
    finishPhase = phase ? startCliTimingPhase(phase) : undefined;
  };
  return {
    observe: (event) => {
      if (event === "connect-start") transition("daemon_connect");
      if (event === "launch-start") {
        transition("daemon_launch_authority_ready");
        if (!launchReported && process.env.HA_PROGRESS !== "0") {
          launchReported = true;
          console.error("[ha] Starting local daemon; waiting for authority readiness.");
        }
      }
      if (event === "ready") transition();
      if (event === "request-start") transition("command_execute");
      if (event === "request-end") transition();
    },
    finish: () => transition()
  };
}
