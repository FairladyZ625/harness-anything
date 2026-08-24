#!/usr/bin/env node
import { cliFailure, emitMeta, taskCreateHelpCatalog } from "./cli-meta.ts";
import {
  contractMigrationDryRunSummary,
  humanError,
  renderDispatchRow,
  renderRuntimeBatchRow,
  renderSquadRunRow,
} from "./cli-render.ts";
import {
  isRuntimeFacadeCommand,
  runRuntimeFacadeCommand,
} from "./cli-runtime-command.ts";
import {
  cliCommandDomains,
  firstCliCommand,
  helpDomain,
  parseThinCommand,
  renderThinHelp,
  unsupportedCommandHint,
} from "./cli/thin-command.ts";
import {
  daemonAutostartFailureCode,
  daemonResponseTimeoutCode,
  daemonTargetFailureCode,
  runCommandThroughDaemon,
} from "./daemon/client.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
export { resolveCliVersion } from "./cli-meta.ts";

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const command = firstCliCommand(argv);
  if (
    argv.includes("--version") ||
    argv.includes("-v") ||
    command === "version"
  )
    return emitMeta("version", argv.includes("--json"));
  if (command === "capabilities")
    return emitMeta("capabilities", argv.includes("--json"));
  if (argv.length === 0 || argv.includes("--help")) {
    const domain = helpDomain(argv);
    if (domain !== undefined && !cliCommandDomains().includes(domain)) {
      emit(
        cliFailure(
          "help",
          "unsupported_command",
          unsupportedCommandHint([domain]),
        ),
        argv.includes("--json"),
      );
      return 2;
    }
    const rows = await taskCreateHelpCatalog(argv);
    console.log(
      rows.length === 0 && domain === undefined
        ? renderThinHelp()
        : renderThinHelp(rows, domain),
    );
    return 0;
  }
  if (command === "daemon" || command === "gui") {
    const { runDaemonControl } = await import("./daemon/control.ts");
    return runDaemonControl(argv, emit);
  }
  const parsed = parseThinCommand(argv);
  if (!parsed.ok) {
    emit(cliFailure("parse", parsed.code, parsed.nextAction), parsed.json);
    return 2;
  }
  try {
    const receipt = isRuntimeFacadeCommand(parsed.command)
      ? await runRuntimeFacadeCommand(parsed.command)
      : await runCommandThroughDaemon(parsed.command, (phase) =>
          emit(phase, parsed.command.json),
        );
    if (parsed.command.action.kind === "squad-run")
      emitSquadRun(receipt, parsed.command.json);
    else emit(receipt, parsed.command.json);
    return Number.isInteger(receipt.exitCode)
      ? Number(receipt.exitCode)
      : receipt.ok === true
        ? 0
        : 1;
  } catch (error) {
    const autostartCode = daemonAutostartFailureCode(error),
      timeoutCode = daemonResponseTimeoutCode(error),
      targetCode = daemonTargetFailureCode(error),
      direct = autostartCode ?? targetCode;
    emit(
      cliFailure(
        parsed.command.action.kind,
        direct ?? timeoutCode ?? "daemon_unavailable",
        direct
          ? error instanceof Error
            ? error.message
            : String(error)
          : `Local daemon request failed. Cause: ${error instanceof Error ? error.message : String(error)}`,
      ),
      parsed.command.json,
    );
    return 1;
  }
}

export function emit(receipt: Record<string, unknown>, json: boolean): void {
  if (json) console.log(JSON.stringify(receipt));
  else if (
    receipt.command === "runtime-batch" &&
    Array.isArray(receipt.dispatches)
  )
    console.log(
      receipt.dispatches.length
        ? receipt.dispatches.map(renderRuntimeBatchRow).join("\n")
        : "No batch dispatches.",
    );
  else if (
    receipt.ok === true ||
    (receipt.command === "migrate-import" &&
      typeof receipt.summary === "string")
  ) {
    const summary = contractMigrationDryRunSummary(receipt);
    if (Array.isArray(receipt.dispatches))
      console.log(
        receipt.dispatches.length
          ? receipt.dispatches.map(renderDispatchRow).join("\n")
          : "No dispatches.",
      );
    else
      console.log(
        String(
          summary ??
            (receipt.command === "doc-show"
              ? receipt.evidence
              : receipt.command === "init"
                ? [
                    String(receipt.summary),
                    `outcome: ${receipt.outcome ?? "applied"}`,
                    ...["created", "updated", "preserved", "drifted"].map(
                      (key) => `${key}: ${JSON.stringify(receipt[key] ?? [])}`,
                    ),
                    `commit: ${String(receipt.commit ?? "none")}`,
                    `next: ${String(receipt.next ?? "")}`,
                  ].join("\n")
                : (receipt.summary ??
                  `${receipt.command ?? "command"}: ${receipt.outcome ?? "applied"}`)),
        ),
      );
  } else {
    const error = humanError(receipt);
    console.error(`error code=${error.code} hint=${error.hint}`);
  }
}

function emitSquadRun(
  receipt: Record<string, unknown>,
  json: boolean,
): void {
  if (json) return emit(receipt, true);
  const dispatches = receipt.dispatches;
  if (Array.isArray(dispatches))
    console.log(
      dispatches.length
        ? dispatches.map(renderSquadRunRow).join("\n")
        : "No squad dispatches.",
    );
  else emit(receipt, false);
}

function isCliEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return (
      realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return invoked.endsWith("packages/cli/src/index.ts");
  }
}
if (isCliEntrypoint()) process.exitCode = await main();
