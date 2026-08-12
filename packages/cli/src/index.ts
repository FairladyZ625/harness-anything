#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseThinCommand, renderThinHelp } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes("--help")) { console.log(renderThinHelp()); return 0; }
  if (argv.includes("daemon")) {
    const { runDaemonControl } = await import("./daemon/control.ts");
    return runDaemonControl(argv);
  }
  const parsed = parseThinCommand(argv);
  if (!parsed.ok) { emit(cliFailure("parse", parsed.code, parsed.nextAction), parsed.json); return 2; }
  try {
    const receipt = await runCommandThroughDaemon(parsed.command);
    emit(receipt, parsed.command.json);
    return receipt.ok === true ? 0 : 1;
  } catch (error) {
    emit(cliFailure(parsed.command.action.kind, "daemon_unavailable", `Start the explicit daemon and retry. Cause: ${error instanceof Error ? error.message : String(error)}`), parsed.command.json);
    return 1;
  }
}

function cliFailure(command: string, code: string, nextAction: string): Record<string, unknown> {
  return { schema: "command-receipt/v2", ok: false, command, outcome: "rejected", opId: "N/A", origin: "cli", code,
    evidence: `rejection:${code}`, error: { code, hint: nextAction }, nextAction };
}
function emit(receipt: Record<string, unknown>, json: boolean): void {
  if (json) console.log(JSON.stringify(receipt));
  else if (receipt.ok === true) console.log(String(receipt.summary ?? `${receipt.command ?? "command"}: ${receipt.outcome ?? "applied"}`));
  else console.error(`error code=${String((receipt.error as { code?: unknown } | undefined)?.code ?? "unknown")} hint=${String(receipt.nextAction ?? "Command failed.")}`);
}
function isCliEntrypoint(): boolean { const invoked = process.argv[1]; if (!invoked) return false;
  try { return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url)); } catch { return invoked.endsWith("packages/cli/src/index.ts"); } }
if (isCliEntrypoint()) process.exitCode = await main();
