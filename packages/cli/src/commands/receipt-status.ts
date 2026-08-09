import type { CommandFailureReceipt, CommandReceipt } from "@harness-anything/application";
import { requestLocalDaemonJsonRpcForTarget } from "@harness-anything/daemon";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { stripGlobalOptions } from "../cli/parse-options.ts";
import { toCommandReceipt } from "../cli/receipt.ts";
import {
  daemonClientCliEntrypointPath,
  readDaemonClientConfig,
  resolveLocalDaemonTarget
} from "../daemon/client.ts";

type ReceiptStatusEnvelope = CommandReceipt | CommandFailureReceipt;

export async function runReceiptStatusCommand(
  argv: ReadonlyArray<string>
): Promise<{ readonly receipt: ReceiptStatusEnvelope; readonly json: boolean }> {
  const stripped = stripGlobalOptions(argv);
  const receiptId = stripped.args[2];
  if (stripped.args[1] !== "status" || !receiptId || stripped.args.length !== 3) {
    return {
      receipt: receiptStatusFailure(
        "invalid-command",
        "Use `ha receipt status <receipt-id> --json`."
      ),
      json: stripped.json
    };
  }
  const layoutOverrides = stripped.authoredRoot
    ? { authoredRoot: stripped.authoredRoot }
    : undefined;
  const config = readDaemonClientConfig(
    process.env,
    stripped.rootDir,
    stripped.daemonMode,
    stripped.daemonProfile,
    layoutOverrides
  );
  if (config.mode !== "local") {
    return {
      receipt: receiptStatusFailure(
        "local-daemon-required",
        "Receipt settlement lookup currently requires the local daemon; use the repo where the receipt was accepted."
      ),
      json: stripped.json
    };
  }
  try {
    const target = resolveLocalDaemonTarget({
      rootDir: stripped.rootDir,
      repoIdOverride: stripped.daemonRepoId,
      userRoot: config.userRoot,
      daemonId: config.daemonId,
      autoRegisterSingleRepo: true,
      layoutOverrides
    });
    const response = await requestLocalDaemonJsonRpcForTarget(
      target,
      "repo.write.receipt.status",
      {
        repo: { repoId: target.repoId },
        payload: { receiptId }
      },
      200,
      {
        entryPath: daemonClientCliEntrypointPath(),
        idleExitMs: config.idleExitMs,
        timeoutMs: config.autostartTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        layoutOverrides
      }
    );
    return {
      receipt: isReceiptStatusEnvelope(response)
        ? response
        : receiptStatusFailure(
          "invalid-response",
          "The daemon did not return command-receipt/v2 for the settlement lookup."
        ),
      json: stripped.json
    };
  } catch (error) {
    return {
      receipt: receiptStatusFailure(
        "unavailable",
        error instanceof Error ? error.message : String(error)
      ),
      json: stripped.json
    };
  }
}

function receiptStatusFailure(
  kind: "invalid-command" | "local-daemon-required" | "invalid-response" | "unavailable",
  hint: string
): CommandFailureReceipt {
  const error = kind === "invalid-command"
    ? cliError(CliErrorCode.InvalidEntrypoint, hint)
    : kind === "local-daemon-required"
      ? cliError(CliErrorCode.DaemonBackedPathRequired, hint)
      : kind === "invalid-response"
        ? cliError(CliErrorCode.CommandReceiptContractMismatch, hint)
        : cliError(CliErrorCode.DaemonUnavailable, hint);
  return toCommandReceipt({ ok: false, command: "receipt-status", error }) as CommandFailureReceipt;
}

function isReceiptStatusEnvelope(value: unknown): value is ReceiptStatusEnvelope {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "ok" in value && "schema" in value;
}
