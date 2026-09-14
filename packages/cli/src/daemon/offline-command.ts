import { spawnSync } from "node:child_process";
import { daemonServeEntry } from "./client.ts";

export function runOfflineCommandThroughDaemonBin(
  argv: readonly string[],
  emit: (receipt: Record<string, unknown>, json: boolean) => void,
): number {
  const json = argv.includes("--json"),
    result = spawnSync(process.execPath, [daemonServeEntry(), "offline", ...argv, ...(json ? [] : ["--json"])], {
      encoding: "utf8",
      env: process.env,
      windowsHide: true,
    });
  if (result.error) throw result.error;
  const output = result.stdout.trim();
  if (!output)
    throw new Error(result.stderr.trim() || `offline daemon host exited with ${result.status ?? "no status"}`);
  const receipt = JSON.parse(output) as Record<string, unknown>;
  if (!json && argv[0] === "events" && argv[1] === "tail" && Array.isArray(receipt.events))
    for (const event of receipt.events) console.log(JSON.stringify(event));
  else emit(receipt, json);
  return result.status ?? 1;
}
