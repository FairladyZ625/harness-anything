#!/usr/bin/env node
import { cliErrorMessage } from "./cli-error.ts";
import { cliFailure, emitMeta, taskCreateHelpCatalog } from "./cli-meta.ts";
import { cliDispatchError } from "./cli-render.ts";
import { isRuntimeFacadeCommand, runRuntimeFacadeCommand } from "./cli-runtime-command.ts";
import {
  cliCommandDomains,
  firstCliCommand,
  helpDomain,
  parseThinCommand,
  renderThinHelp,
  type ThinCommand,
  unsupportedCommandHint,
} from "./cli/thin-command.ts";
import { beginCliTiming, cliPhaseEnd, cliPhaseStart, daemonRequestTimer, finishCliTiming } from "./cli/timing.ts";
import { isRetiredEntityExplain, taskExplainHelpOverlay } from "./cli/thin-command-explain.ts";
import { renderCliReceipt } from "./cli/receipt-render-registry.ts";
import {
  daemonAutostartFailureCode,
  daemonBuildStaleCode,
  daemonResponseTimeoutCode,
  daemonTargetFailureCode,
  consumeKnownError,
  runCommandThroughDaemon,
} from "./daemon/client.ts";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
export { resolveCliVersion } from "./cli-meta.ts";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  beginCliTiming();
  try {
    const exitCode = await runThinCli(argv);
    finishTimingWithoutChangingOutcome(argv, exitCode);
    return exitCode;
  } catch (error) {
    finishTimingWithoutChangingOutcome(argv, 1);
    throw error;
  }
}

async function runThinCli(argv: readonly string[]): Promise<number> {
  const command = firstCliCommand(argv),
    explainHelpOverlay = taskExplainHelpOverlay(argv);
  if (argv.includes("--version") || argv.includes("-v") || command === "version")
    return emitMeta("version", argv.includes("--json"));
  if (command === "capabilities") return emitMeta("capabilities", argv.includes("--json"));
  if (isRetiredEntityExplain(argv)) {
    emit(
      cliFailure(
        "entity explain",
        "unsupported_command",
        "Use ha explain task|person|squad for a catalog, or ha explain " +
          "task/<task-id>|person/<person-id>|squad/<squad-id> for an object evaluation.",
      ),
      argv.includes("--json"),
    );
    return 2;
  }
  if (explainHelpOverlay && !explainHelpOverlay.ok) {
    emit(
      cliFailure("entity-action-explain", explainHelpOverlay.code, explainHelpOverlay.nextAction),
      explainHelpOverlay.json,
    );
    return 2;
  }
  if (explainHelpOverlay === undefined && (argv.length === 0 || argv.includes("--help"))) {
    const domain = helpDomain(argv);
    if (domain !== undefined && !cliCommandDomains().includes(domain)) {
      emit(cliFailure("help", "unsupported_command", unsupportedCommandHint([domain])), argv.includes("--json"));
      return 2;
    }
    const rows = await taskCreateHelpCatalog(argv),
      helpRenderStartedAt = cliPhaseStart();
    console.log(rows.length === 0 && domain === undefined ? renderThinHelp() : renderThinHelp(rows, domain));
    cliPhaseEnd("render", helpRenderStartedAt);
    return 0;
  }
  if (command === "daemon" || command === "gui") {
    const { runDaemonControl } = await import("./daemon/control.ts");
    return runDaemonControl(argv, emit);
  }
  const parseStartedAt = cliPhaseStart(),
    parsed = parseThinCommand(explainHelpOverlay?.argv ?? argv);
  cliPhaseEnd("parse", parseStartedAt);
  if (!parsed.ok) {
    emit(cliFailure("parse", parsed.code, parsed.nextAction), parsed.json);
    return 2;
  }
  let typedCommand: ThinCommand;
  try {
    typedCommand = materializeDecisionStdin(parsed.command);
  } catch (error) {
    emit(
      cliFailure(
        parsed.command.action.kind,
        "invalid_field",
        `--json-input @- could not read stdin: ${cliErrorMessage(error)}`,
      ),
      parsed.command.json,
    );
    return 2;
  }
  // emit is inside the dispatch try by design, so a render throw still lands on the classified
  // failure path. The flag keeps that shape while stopping the catch from adding the dispatch
  // window a second time when the throw came from the renderer rather than the dispatcher.
  const dispatchStartedAt = cliPhaseStart();
  let dispatchMeasured = false;
  try {
    const receipt = isRuntimeFacadeCommand(typedCommand)
      ? await runRuntimeFacadeCommand(typedCommand)
      : await runCommandThroughDaemon(
          typedCommand,
          (phase) => emit(phase, typedCommand.json),
          undefined,
          daemonRequestTimer,
        );
    dispatchMeasured = true;
    cliPhaseEnd("dispatch", dispatchStartedAt);
    const renderStartedAt = cliPhaseStart();
    emit(receipt, typedCommand.json);
    cliPhaseEnd("render", renderStartedAt);
    return Number.isInteger(receipt.exitCode)
      ? Number(receipt.exitCode)
      : receipt.ok === true || receipt.schema === "entity-action-explanation/v1"
        ? 0
        : receipt.code === "missing_field"
          ? 2
          : 1;
  } catch (error) {
    if (!dispatchMeasured) cliPhaseEnd("dispatch", dispatchStartedAt);
    const autostartCode = daemonAutostartFailureCode(error),
      timeoutCode = daemonResponseTimeoutCode(error),
      targetCode = daemonTargetFailureCode(error),
      buildStaleCode = daemonBuildStaleCode(error),
      direct = autostartCode ?? targetCode ?? buildStaleCode;
    const failure = cliDispatchError({ error, directCode: direct, timeoutCode });
    emit(cliFailure(parsed.command.action.kind, failure.code, failure.hint), parsed.command.json);
    return 1;
  }
}

function finishTimingWithoutChangingOutcome(argv: readonly string[], exitCode: number): void {
  try {
    finishCliTiming(argv, exitCode);
  } catch (error) {
    // Instrumentation must never replace the command's receipt or exit outcome. In particular, a
    // stale HA_CLI_TIMING_FILE path is an observability failure, not a command failure.
    consumeKnownError(error);
  }
}

export function materializeDecisionStdin(
  command: ThinCommand,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): ThinCommand {
  if (command.action.kind !== "decision-propose" || command.action.jsonInput !== "@-") return command;
  return {
    ...command,
    action: { ...command.action, jsonInput: readStdin() },
  };
}

export function emit(receipt: Record<string, unknown>, json: boolean): void {
  if (json) console.log(JSON.stringify(receipt));
  else {
    const rendered = renderCliReceipt(receipt);
    console[rendered.stream === "stderr" ? "error" : "log"](rendered.text);
  }
}

function isCliEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return invoked.endsWith("packages/cli/src/index.ts");
  }
}
if (isCliEntrypoint()) process.exitCode = await main();
