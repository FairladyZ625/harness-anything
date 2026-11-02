#!/usr/bin/env node
import { cliErrorMessage } from "./cli-error.ts";
import { cliFailure, emitMeta, taskCreateHelpCatalog, taskCreateHelpWorks } from "./cli-meta.ts";
import { cliDispatchError } from "./cli-render.ts";
import { isRuntimeFacadeCommand, runRuntimeFacadeCommand } from "./cli-runtime-command.ts";
import {
  cliCommandDomains,
  firstCliCommand,
  firstCliCommandIndex,
  helpCommandPrefix,
  helpDomain,
  parseThinCommand,
  renderThinHelp,
  type ThinCommand,
  unsupportedCommandHint,
} from "./cli/thin-command.ts";
import { beginCliTiming, cliPhaseEnd, cliPhaseStart, daemonRequestTimer, finishCliTiming } from "./cli/timing.ts";
import { isRetiredEntityExplain, taskExplainHelpOverlay } from "./cli/thin-command-explain.ts";
import { parseTaskArtifactRunInvocation, runTaskArtifactCommand } from "./cli-task-artifact-run.ts";
import { doctorInvocation, renderDoctorReport, runDoctor } from "./cli/thin-command-doctor.ts";
import { parseAgentRollbackCommand, runAgentRollback } from "./cli-agent-rollback.ts";
import { parseBackupRetentionInvocation, runBackupRetention } from "./cli/thin-command-backup-retention.ts";
import { runDoctorHealth } from "./cli/thin-command-doctor-health.ts";
import { renderCliReceipt } from "./cli/receipt-render-registry.ts";
import { withFactStatementGuidance, withTitleFocusGuidance } from "./cli/guidance-plane.ts";
import {
  daemonAutostartFailureCode,
  cliEntryFailureCode,
  cliInputFailureCode,
  daemonResponseTimeoutCode,
  daemonTargetFailureCode,
  consumeKnownError,
  runCommandThroughDaemon,
} from "./daemon/client.ts";
import { runOfflineCommandThroughDaemonBin } from "./daemon/offline-command.ts";
import { createReadStream, readFileSync, realpathSync, unlinkSync } from "node:fs";
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
  if (
    (command === "restore" && !argv.includes("--drill") && !argv.includes("--help")) ||
    command === "events" ||
    (command === "migrate" &&
      ["ledger", "completion", "agent-declaration", "settings", "writer-epoch"].includes(
        argv[firstCliCommandIndex(argv) + 1] ?? "",
      ))
  ) {
    return runOfflineCommandThroughDaemonBin(argv, emit);
  }
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
    if (domain !== undefined && !cliCommandDomains.includes(domain)) {
      emit(cliFailure("help", "unsupported_command", unsupportedCommandHint([domain])), argv.includes("--json"));
      return 2;
    }
    const rows = await taskCreateHelpCatalog(argv),
      // `ha task create --help` is where a create is decided; it names the open works the same
      // daemon route `ha work list` serves, so --work is chosen from facts before the write.
      works = await taskCreateHelpWorks(argv),
      helpRenderStartedAt = cliPhaseStart();
    console.log(
      rows.length === 0 && works.length === 0 && domain === undefined
        ? renderThinHelp()
        : renderThinHelp(rows, domain, helpCommandPrefix(argv), works),
    );
    cliPhaseEnd("render", helpRenderStartedAt);
    return 0;
  }
  const artifactRunInvocation = parseTaskArtifactRunInvocation(argv);
  if (artifactRunInvocation) {
    const receipt = await runTaskArtifactCommand(artifactRunInvocation);
    emit(receipt, artifactRunInvocation.json);
    return receiptExitCode(receipt);
  }
  if (command === "doctor") {
    const invocation = doctorInvocation(argv);
    if (!invocation.ok) {
      emit(cliFailure("doctor", "invalid_field", invocation.reason), argv.includes("--json"));
      return 2;
    }
    if (invocation.mode === "commands")
      return renderDoctorReport(runDoctor(invocation.rootDir), argv.includes("--json"));
    return runDoctorHealth(argv, emit);
  }
  if (command === "backup" && argv[firstCliCommandIndex(argv) + 1] === "retention") {
    const invocation = parseBackupRetentionInvocation(argv);
    if (typeof invocation === "string") {
      emit(cliFailure("backup retention", "invalid_field", invocation), argv.includes("--json"));
      return 2;
    }
    return runBackupRetention(invocation);
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
    typedCommand = materializePacketStdin(parsed.command);
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
  let returnedReceipt: Record<string, unknown> | undefined;
  try {
    const receipt = withTitleFocusGuidance(
      withFactStatementGuidance(
        typedCommand.action.kind === "agent-rollback"
          ? await runAgentRollback(
              parseAgentRollbackCommand(typedCommand),
              (requested) => runCommandThroughDaemon(requested, (phase) => emit(phase, typedCommand.json)),
              { rootDir: typedCommand.rootDir, ...(typedCommand.repoId ? { repoId: typedCommand.repoId } : {}) },
            )
          : isRuntimeFacadeCommand(typedCommand)
            ? await runRuntimeFacadeCommand(typedCommand)
            : await runCommandThroughDaemon(
                typedCommand,
                (phase) => emit(phase, typedCommand.json),
                undefined,
                daemonRequestTimer,
              ),
        typedCommand.action,
      ),
      typedCommand.action,
    );
    returnedReceipt = receipt;
    dispatchMeasured = true;
    cliPhaseEnd("dispatch", dispatchStartedAt);
    const renderStartedAt = cliPhaseStart();
    if (typedCommand.action.kind === "doc-show" && receipt.ok === true && typeof receipt.evidenceFile === "string") {
      await renderDocumentDescriptor(receipt, typedCommand);
    } else if (
      typedCommand.action.kind === "template-render" &&
      typedCommand.action.raw === true &&
      receipt.ok === true
    )
      process.stdout.write(rawTemplateBody(receipt));
    else if (typedCommand.action.kind === "doc-show" && typedCommand.action.raw === true && receipt.ok === true)
      process.stdout.write(rawDocumentBody(receipt));
    else emit(receipt, typedCommand.json, explainRequestRefs(typedCommand));
    cliPhaseEnd("render", renderStartedAt);
    return receiptExitCode(receipt);
  } catch (error) {
    if (!dispatchMeasured) cliPhaseEnd("dispatch", dispatchStartedAt);
    const autostartCode = daemonAutostartFailureCode(error),
      timeoutCode = daemonResponseTimeoutCode(error),
      targetCode = daemonTargetFailureCode(error),
      entryCode = cliEntryFailureCode(error),
      inputCode = cliInputFailureCode(error),
      direct = autostartCode ?? targetCode ?? entryCode ?? inputCode;
    const failure = cliDispatchError({ error, directCode: direct, timeoutCode, returnedReceipt });
    emit(cliFailure(parsed.command.action.kind, failure.code, failure.hint), parsed.command.json);
    return 1;
  }
}

function finishTimingWithoutChangingOutcome(argv: readonly string[], exitCode: number): void {
  try {
    finishCliTiming(argv, exitCode);
  } catch (error) {
    // Instrumentation must never replace the command's receipt or exit outcome: a failed stderr
    // write is an observability failure, not a command failure.
    consumeKnownError(error);
  }
}

export function materializePacketStdin(
  command: ThinCommand,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): ThinCommand {
  if (command.action.jsonInput !== "@-") return command;
  return {
    ...command,
    action: { ...command.action, jsonInput: readStdin() },
  };
}

export function emit(receipt: Record<string, unknown>, json: boolean, explainRefs?: readonly string[]): void {
  if (json) console.log(JSON.stringify(receipt));
  else {
    const rendered = renderCliReceipt(receipt, explainRefs);
    const warning = versionWarningText(receipt);
    const text = warning ? `${rendered.text}\n${warning}` : rendered.text;
    console[rendered.stream === "stderr" ? "error" : "log"](text);
  }
}

function versionWarningText(receipt: Record<string, unknown>): string | null {
  const warning =
    typeof receipt.versionWarning === "object" && receipt.versionWarning !== null
      ? (receipt.versionWarning as {
          readonly centerBuildCommit?: unknown;
          readonly localBuildCommit?: unknown;
          readonly upgradeCommand?: unknown;
        })
      : null;
  return warning && typeof warning.centerBuildCommit === "string" && typeof warning.localBuildCommit === "string"
    ? `WARNING version mismatch center=${warning.centerBuildCommit} local=${warning.localBuildCommit}; upgrade with ${String(warning.upgradeCommand ?? "ha update")}`
    : null;
}

function writeDescriptorVersionWarning(receipt: Record<string, unknown>, raw: boolean): void {
  const warning = versionWarningText(receipt);
  if (warning) (raw ? process.stderr : process.stdout).write(`${warning}\n`);
}

async function renderDocumentDescriptor(receipt: Record<string, unknown>, command: ThinCommand): Promise<void> {
  if (command.json) {
    emit(receipt, true, explainRequestRefs(command));
    return;
  }
  const raw = command.action.raw === true;
  await streamDocumentFile(receipt, raw);
  writeDescriptorVersionWarning(receipt, raw);
}

// Failure subjects for invalid refs carry ref: null by contract, so the renderer needs the refs the
// user actually typed, positionally aligned with the subjects the daemon returned.
function explainRequestRefs(command: ThinCommand): readonly string[] | undefined {
  if (command.action.kind !== "entity-action-explain") return undefined;
  const refs: unknown = command.action.refs;
  return Array.isArray(refs) && refs.every((ref) => typeof ref === "string") ? refs : undefined;
}

export function receiptExitCode(receipt: Record<string, unknown>): number {
  if (Number.isInteger(receipt.exitCode)) return Number(receipt.exitCode);
  if (receipt.ok === true) return 0;
  // Explanation sets are read receipts without an ok flag; their schema-validated mode "failure"
  // means at least one subject failed, which the JSON door must report through the exit code too.
  if (receipt.schema === "entity-action-explanation/v1") return receipt.mode === "failure" ? 1 : 0;
  return receipt.code === "missing_field" ? 2 : 1;
}

export function rawTemplateBody(receipt: Record<string, unknown>): string {
  if (receipt.ok !== true || typeof receipt.evidence !== "string")
    throw new TypeError("Raw template rendering requires a successful template receipt.");
  const rendered: unknown = JSON.parse(receipt.evidence);
  if (typeof rendered !== "object" || rendered === null || !("body" in rendered) || typeof rendered.body !== "string")
    throw new TypeError("Template receipt is missing its rendered body.");
  return rendered.body;
}

// doc-show --raw: evidence is the projected document body itself; it is written
// verbatim (no receipt decoration) so its sha256 matches the file on disk.
export function rawDocumentBody(receipt: Record<string, unknown>): string {
  if (receipt.ok !== true || typeof receipt.evidence !== "string")
    throw new TypeError("Raw document output requires a successful doc-show receipt.");
  return receipt.evidence;
}

/** Stream an edge-owned sealed document without materializing the full receipt in the CLI. */
async function streamDocumentFile(receipt: Record<string, unknown>, raw: boolean): Promise<void> {
  const file = String(receipt.evidenceFile),
    encoding = receipt.evidenceContentEncoding;
  if (encoding !== "utf8" && encoding !== "base64")
    throw new TypeError("Fleet document descriptor has an invalid content encoding.");
  let carry = Buffer.alloc(0);
  let completed = false;
  try {
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      const bytes = Buffer.concat([carry, Buffer.from(chunk)]);
      if (encoding === "utf8") {
        if (!process.stdout.write(bytes)) await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
        continue;
      }
      const complete = bytes.byteLength - (bytes.byteLength % 3);
      carry = bytes.subarray(complete);
      if (complete > 0) {
        const encoded = bytes.subarray(0, complete).toString("base64");
        if (!process.stdout.write(encoded)) await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
      }
    }
    if (encoding === "base64" && carry.byteLength > 0) process.stdout.write(carry.toString("base64"));
    if (!raw) process.stdout.write("\n");
    completed = true;
  } finally {
    if (completed) cleanupConsumedDocumentDescriptor(file);
  }
}

function cleanupConsumedDocumentDescriptor(file: string): void {
  const metadata = file.endsWith(".sealed") ? `${file.slice(0, -".sealed".length)}.json` : `${file}.json`;
  for (const candidate of [file, metadata]) {
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-139 */ unlinkSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
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
