// PLT-Honest: classifies daemon lifecycle failures into one of three honest
// states (not-present / starting / unavailable) and emits a ready-to-show
// CliError whose hint is written so an agent following it verbatim never kills
// a recovering daemon. Extracted from client.ts to keep that file under the
// complexity budget. The classification is the direct fix for the incident
// where the old "daemon_unavailable + direct-mode" hint sent an operator to
// run ha daemon restart on a still-starting daemon.
import {
  DaemonAutostartCircuitOpenError,
  DaemonAutostartProcessExitedError,
  DaemonAutostartTimeoutError
} from "@harness-anything/daemon";
import { CliErrorCode, cliError, type CliError } from "../cli/error-codes.ts";
import type { CommandFailureReceipt } from "../cli/receipt.ts";
import { toCommandReceipt } from "../cli/receipt.ts";
import { receiptCommandKind } from "../cli/receipt-command-kind.ts";
import type { ParsedCommand } from "../cli/types.ts";
import {
  remoteDaemonUnavailableHint,
  type RemoteDaemonConfig
} from "./remote-config.ts";

/**
 * Renders the documented direct-mode recovery command line. Lives here so the
 * classification hints can reference it without a circular import on
 * client.ts; client.ts re-exports it for its own callers.
 */
export function directRecoveryCommandLine(argv: ReadonlyArray<string> = process.argv.slice(2)): string {
  const args = withoutOption(argv, "--daemon-mode");
  const renderedArgs = args.map(shellQuote).join(" ");
  return `HARNESS_DAEMON_MODE=direct HARNESS_DIRECT_WRITE_REASON=recovery ha${renderedArgs ? ` ${renderedArgs}` : " <command>"}`;
}

function withoutOption(argv: ReadonlyArray<string>, option: string): ReadonlyArray<string> {
  return argv.filter((arg, index) => arg !== option && argv[index - 1] !== option);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface DaemonLifecycleClassificationDeps {
  readonly directRecoveryCommandLine: (argv?: ReadonlyArray<string>) => string;
}

export function createDaemonLifecycleClassifier(deps: DaemonLifecycleClassificationDeps) {
  return function classifyLocalDaemonLifecycle(error: unknown): CliError {
    const cause = error instanceof Error ? error.message : String(error);

    // Circuit breaker: the autostart path already gave up honestly after N
    // consecutive daemon deaths. Surface that verbatim; it already carries the
    // correct "do not restart" guidance.
    if (error instanceof DaemonAutostartCircuitOpenError) {
      return cliError(CliErrorCode.DaemonUnavailable, (error.message + " Cause: " + cause));
    }

    // Process exited before readiness: a genuine startup failure (not slow
    // start). The daemon is NOT running, so ha daemon start is safe, but the
    // operator-mode direct recovery hatch also applies for an explicit recovery.
    if (error instanceof DaemonAutostartProcessExitedError) {
      return cliError(
        CliErrorCode.DaemonNotPresent,
        "The daemon process exited before becoming ready, so no daemon is currently running. " + cause
        + " This is a real startup failure, not a slow cold start. Inspect the launch log shown above, fix the cause, then start the daemon with 'ha daemon start --service'."
        + " If this write must be recovered locally while the daemon is down, run '" + deps.directRecoveryCommandLine() + "'."
      );
    }

    // Autostart timeout where the spawned process is STILL ALIVE: the daemon is
    // honestly still starting. Cold start on a large ledger can take 60-90s.
    // NEVER suggest restart or direct mode here — both kill/bypass the
    // recovering daemon.
    if (error instanceof DaemonAutostartTimeoutError) {
      const waitedSeconds = Math.round(error.timeoutMs / 1000);
      if (error.spawnedPid !== undefined && localDaemonProcessIsAlive(error.spawnedPid)) {
        return cliError(
          CliErrorCode.DaemonStarting,
          "The daemon is still starting (spawned pid " + error.spawnedPid + " is alive; waited " + waitedSeconds + "s)."
          + " Cold start on a large ledger can take 60-90s as the writer loads."
          + " Do NOT run 'ha daemon restart' — that kills this recovering daemon."
          + " Do NOT use HARNESS_DAEMON_MODE=direct — that bypasses the single-writer fence."
          + " Wait, then poll 'ha daemon status --json' until it reports ready."
          + " If the daemon is genuinely wedged (not progressing), inspect its logs before acting."
          + " Probe failure: " + cause
        );
      }
      // Timeout with a dead/unknown pid: treat as not-present; the daemon is not
      // honestly recovering, so the start/direct guidance is safe.
      return cliError(
        CliErrorCode.DaemonNotPresent,
        "The daemon did not become ready within " + waitedSeconds + "s and its spawned process is not running."
        + " No daemon is currently running. Start one with 'ha daemon start --service', then retry."
        + " If this write must be recovered locally while the daemon is down, run '" + deps.directRecoveryCommandLine() + "'."
        + " Probe failure: " + cause
      );
    }

    // Connection-refused / missing socket with no live owner: nothing is there.
    if (isDaemonEndpointUnoccupied(error)) {
      return cliError(
        CliErrorCode.DaemonNotPresent,
        "No daemon is listening at the expected socket. Start one with 'ha daemon start --service', then retry."
        + " If this write must be recovered locally while the daemon is down, run '" + deps.directRecoveryCommandLine() + "'."
        + " Cause: " + cause
      );
    }

    // Fallback: truly unavailable. Keep the direct recovery hatch since the
    // daemon is neither starting nor absent in a known way; the operator must
    // diagnose. This preserves the pre-existing escape hatch without lying.
    return cliError(
      CliErrorCode.DaemonUnavailable,
      "Daemon unavailable. Run 'ha daemon status --json' to inspect the daemon state."
      + " If no daemon is running, start one with 'ha daemon start --service'."
      + " If the daemon is truly stuck (not starting, not recovering) and this write must be recovered locally, run '" + deps.directRecoveryCommandLine() + "'."
      + " Cause: " + cause
    );
  };
}

export function isDaemonEndpointUnoccupied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  // ECONNREFUSED / ENOENT on the socket, or the namespace diagnostic reporting
  // a missing/unowned endpoint shape. These mean nothing is listening.
  return /ECONNREFUSED|ENOENT|EACCES|ECONNRESET/u.test(message)
    || /DAEMON_SOCKET_NAMESPACE_INVALID:[^;]*shape=missing/u.test(message)
    || /DAEMON_SOCKET_NAMESPACE_INVALID:[^;]*owner=unowned/u.test(message);
}

const classifyLocalDaemonLifecycle = createDaemonLifecycleClassifier({
  directRecoveryCommandLine: () => directRecoveryCommandLine()
});

/**
 * Builds the caller-facing failure receipt for a daemon-unavailable error,
 * routing to the honest lifecycle classification. Root-resolution failures
 * never reach here; runCommandThroughDaemon answers them with the dedicated
 * harness_root_unresolved receipt. Exported so client.ts stays under its
 * complexity budget.
 */
export function daemonUnavailableReceipt(
  command: ParsedCommand,
  error: unknown,
  remote?: RemoteDaemonConfig
): CommandFailureReceipt {
  if (remote) {
    return failureReceipt(command, cliError(
      CliErrorCode.DaemonUnavailable,
      `${remoteDaemonUnavailableHint(remote)} Cause: ${error instanceof Error ? error.message : String(error)}`
    ));
  }
  return failureReceipt(command, classifyLocalDaemonLifecycle(error));
}

function failureReceipt(command: ParsedCommand, error: CliError): CommandFailureReceipt {
  const receipt = toCommandReceipt({
    ok: false,
    command: receiptCommandKind(command.action),
    error
  });
  if (receipt.ok) throw new Error("daemon unavailable receipt unexpectedly succeeded");
  return receipt;
}

export { classifyLocalDaemonLifecycle };

export function localDaemonProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error !== null && typeof error === "object" && "code" in error
      && (error as { readonly code?: unknown }).code === "ESRCH");
  }
}
