import {
  decodeDaemonLogPage,
  type DaemonLogLevel,
  type DaemonLogListInputV1,
  type DaemonLogPageV1
} from "@harness-anything/application";
import type { JsonObject } from "@harness-anything/daemon";
import { CliErrorCode, withCliErrorCode } from "../../cli/error-codes.ts";
import { readOption } from "../../cli/parse-options.ts";
import { requestLocalDaemonJsonRpc, resolveLocalDaemonTarget } from "../../daemon/client.ts";
import type { DaemonCommandInput } from "./productization.ts";

export async function runDaemonLogsCommand(input: DaemonCommandInput): Promise<number> {
  const target = resolveLocalDaemonTarget({
    rootDir: input.rootDir,
    repoIdOverride: readOption(input.args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID,
    layoutOverrides: input.layoutOverrides,
    autoRegisterSingleRepo: false
  });
  const levels = readOption(input.args, "--levels")?.split(",").filter((value): value is DaemonLogLevel => value.length > 0);
  const limitOption = readOption(input.args, "--limit");
  const cursor = readOption(input.args, "--cursor");
  const since = readOption(input.args, "--since");
  const payload: DaemonLogListInputV1 = {
    ...(cursor ? { cursor } : {}),
    ...(limitOption ? { limit: Number(limitOption) } : {}),
    ...(since ? { since } : {}),
    ...(levels ? { levels } : {}),
    ...(input.args.includes("--errors") ? { errorOnly: true } : {})
  };
  const receipt = await requestLocalDaemonJsonRpc(
    target.canonicalRoot,
    "repo.daemon.logs.list",
    { repo: { repoId: target.repoId }, payload: payload as unknown as JsonObject },
    2_000,
    {
      userRoot: target.userRoot,
      daemonId: target.daemonId,
      socketPath: target.socketPath,
      allowLegacySocket: true
    }
  );
  const details = isDaemonLogReceiptRecord(receipt.details) ? receipt.details : {};
  if (receipt.ok !== true) {
    throw daemonLogReceiptError(receipt.error);
  }
  emitDaemonLogs(decodeDaemonLogPage(details.data), input.json);
  return 0;
}

function emitDaemonLogs(page: DaemonLogPageV1, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, schema: "daemon-command/v1", command: "daemon-logs", page }));
    return;
  }
  for (const entry of page.entries) {
    console.log(`${entry.timestamp} ${entry.level.toUpperCase()} ${entry.component} ${entry.event} ${entry.message}`);
  }
  if (page.truncated || page.droppedCount > 0) console.error(`warning dropped=${page.droppedCount} truncated=${page.truncated}`);
  if (page.nextCursor) console.log(`nextCursor=${page.nextCursor}`);
}

function isDaemonLogReceiptRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function daemonLogReceiptError(errorValue: unknown): Error {
  const error = isDaemonLogReceiptRecord(errorValue) ? errorValue : {};
  const hint = readOptionalString(error, "hint") ?? "Daemon log query failed.";
  const tag = readOptionalString(error, "code");
  if (tag === "invalid_daemon_log_list_input") {
    return withCliErrorCode(new Error(hint), CliErrorCode.InvalidDaemonLogInput);
  }
  return new Error(hint);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
