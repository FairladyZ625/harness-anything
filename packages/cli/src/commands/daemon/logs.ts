import {
  decodeDaemonLogPage,
  type DaemonLogLevel,
  type DaemonLogListInputV1,
  type DaemonLogPageV1
} from "../../../../application/src/index.ts";
import type { JsonObject } from "../../../../daemon/src/index.ts";
import { readOption } from "../../cli/parse-options.ts";
import { requestLocalDaemonJsonRpc, resolveLocalDaemonTarget } from "../../daemon/client.ts";
import type { DaemonCommandInput } from "./productization.ts";

export async function runDaemonLogsCommand(input: DaemonCommandInput): Promise<number> {
  const target = resolveLocalDaemonTarget({
    rootDir: input.rootDir,
    repoIdOverride: readOption(input.args, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID,
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
    const error = isDaemonLogReceiptRecord(receipt.error) ? receipt.error : {};
    throw new Error(typeof error.hint === "string" ? error.hint : "Daemon log query failed.");
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
