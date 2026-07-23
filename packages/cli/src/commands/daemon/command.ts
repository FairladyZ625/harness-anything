import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { DaemonCommandInput } from "./command-types.ts";
import {
  runDaemonProductCommand as runBaselineDaemonProductCommand
} from "./productization.ts";
import { runDaemonDeploymentStatusCommand } from "./status-command.ts";

export type { DaemonServeHooks } from "./command-types.ts";

export async function runDaemonCommand(input: DaemonCommandInput): Promise<number> {
  const action = input.args[1] ?? "status";
  const helpRequested = action === "--help"
    || action === "-h"
    || input.args.includes("--help")
    || input.args.includes("-h");
  if (action !== "status" || helpRequested) {
    return runBaselineDaemonProductCommand(input);
  }
  try {
    const status = await runDaemonDeploymentStatusCommand(input);
    emitDaemonStatusResult(status.result, input.json);
    return status.exitCode;
  } catch (error) {
    emitDaemonStatusError(error instanceof Error ? error.message : String(error), input.json);
    return 1;
  }
}

function emitDaemonStatusResult(result: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, schema: "daemon-command/v1", command: "daemon-status", ...result }));
    return;
  }
  const parts = ["ok", "command=daemon-status"];
  for (const key of ["started", "reachable", "queueDepth", "version", "protocolVersion", "pid", "rootDir", "repoId", "endpoint"] as const) {
    if (result[key] !== undefined) parts.push(`${key}=${JSON.stringify(result[key])}`);
  }
  if (typeof result.lockPath === "string") parts.push(`lock=${result.lockPath}`);
  console.log(parts.join(" "));
}

function emitDaemonStatusError(message: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      schema: "daemon-command/v1",
      command: "daemon",
      error: cliError(CliErrorCode.JournalUnavailable, message)
    }));
    return;
  }
  console.error(`error code=${CliErrorCode.JournalUnavailable} hint=${message}`);
}
