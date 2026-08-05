import { cliError, CliErrorCode, errorCodeFromThrown } from "../../cli/error-codes.ts";
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
    const code = errorCodeFromThrown(error) ?? CliErrorCode.UnclassifiedCommandFailure;
    emitDaemonStatusError(code, error instanceof Error ? error.message : String(error), input.json);
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
  if (isDaemonCommandRecord(result.repositoryService)) {
    parts.push(`repoService=${JSON.stringify(result.repositoryService.state)}`);
    const owner = isDaemonCommandRecord(result.repositoryService.daemon) ? result.repositoryService.daemon : undefined;
    if (owner?.pid !== undefined && owner.pid !== null) parts.push(`servingPid=${JSON.stringify(owner.pid)}`);
    if (owner?.hostname !== undefined && owner.hostname !== null) parts.push(`servingHost=${JSON.stringify(owner.hostname)}`);
    if (owner?.userRoot !== undefined && owner.userRoot !== null) parts.push(`servingUserRoot=${JSON.stringify(owner.userRoot)}`);
    if (owner?.endpoint !== undefined && owner.endpoint !== null) parts.push(`servingEndpoint=${JSON.stringify(owner.endpoint)}`);
  }
  console.log(parts.join(" "));
}

function isDaemonCommandRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emitDaemonStatusError(code: CliErrorCode, message: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      schema: "daemon-command/v1",
      command: "daemon",
      error: cliError(code, message)
    }));
    return;
  }
  console.error(`error code=${code} hint=${message}`);
}
