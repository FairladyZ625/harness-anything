#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toCliError } from "./cli/error-mapper.ts";
import { CliErrorCode } from "./cli/error-codes.ts";
import { actionTaskId, parseArgs } from "./cli/parse-args.ts";
import { stripGlobalOptions } from "./cli/parse-options.ts";
import { runRegisteredCommand } from "./cli/runner-registry.ts";
import { Effect } from "effect";
import { createDaemonRuntime, makeLocalLifecycleEngine, makeLocalWriteCoordinator, runLedgerMaterializer } from "../../adapters/local/src/index.ts";
import { bindCreateProvenance, makeDecisionWriteService, makeEnvironmentCurrentSessionProbe, makeFactWriteService, makeProvenanceSessionExporter, makeRuntimeEventLedgerService, type ProvenanceSessionExporterRejected, type ProvenanceSessionExportResult } from "../../application/src/index.ts";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "../../kernel/src/index.ts";
import { commitAuthoredPaths } from "./commands/core/authored-git.ts";
import { receiptDetailsData, renderReceiptText, toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "./cli/receipt.ts";
import type { CliResult, CommandRegistryEntry } from "./cli/types.ts";

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const daemonExit = await maybeRunDaemonCommand(argv);
  if (daemonExit !== undefined) return daemonExit;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    emit(toCommandReceipt({ ok: false, command: "parse", error: parsed.error }), true);
    return 2;
  }

  const layoutInput = {
    rootDir: parsed.value.rootDir,
    layoutOverrides: parsed.value.layoutOverrides
  };
  let currentSessionProbe: ReturnType<typeof makeEnvironmentCurrentSessionProbe> | undefined;
  const getCurrentSessionProbe = () => {
    currentSessionProbe ??= makeEnvironmentCurrentSessionProbe();
    return currentSessionProbe;
  };
  let sessionBranchResolved = false;
  let sessionBranchId: string | undefined;
  const getSessionBranchId = () => {
    if (!sessionBranchResolved) {
      const session = Effect.runSync(getCurrentSessionProbe().currentSession);
      sessionBranchId = session.source === "runtime" ? session.sessionId : undefined;
      sessionBranchResolved = true;
    }
    return sessionBranchId;
  };
  const makeSessionExporter = () => makeProvenanceSessionExporter({
    rootInput: layoutInput,
    currentSessionProbe: getCurrentSessionProbe()
  });
  const syncExportedSession = (result: ProvenanceSessionExportResult): Effect.Effect<void, ProvenanceSessionExporterRejected> => Effect.try({
    try: () => {
      try {
        commitAuthoredPaths(layoutInput, [result.path], `session(export): ${result.session.sessionId}`);
      } catch (error) {
        if (error instanceof Error && error.message === "authored root is ignored by Git but is not a nested Git repository") return;
        throw error;
      }
    },
    catch: (error) => ({
      _tag: "ProvenanceSessionExporterRejected" as const,
      sessionId: result.session.sessionId,
      reason: error instanceof Error ? error.message : "session git commit failed"
    })
  }).pipe(Effect.asVoid);

  const result = await Effect.runPromise(runRegisteredCommand(parsed.value, () => makeLocalLifecycleEngine({
    rootDir: parsed.value.rootDir,
    layoutOverrides: parsed.value.layoutOverrides,
    coordinator: makeLocalWriteCoordinator({
      rootDir: parsed.value.rootDir,
      layoutOverrides: parsed.value.layoutOverrides,
      actor: { kind: "agent", id: "local-lifecycle" },
      sessionId: getSessionBranchId()
    }),
    bindCreateProvenance: (boundAt) => bindCreateProvenance({
      currentSessionProbe: getCurrentSessionProbe(),
      provenanceSessionExporter: makeSessionExporter(),
      syncExportedSession
    }, boundAt)
  }), getCurrentSessionProbe, makeSessionExporter, syncExportedSession, (actor) => makeLocalWriteCoordinator({
    rootDir: parsed.value.rootDir,
    layoutOverrides: parsed.value.layoutOverrides,
    actor,
    sessionId: getSessionBranchId()
  }), () => makeDecisionWriteService({
    rootInput: layoutInput,
    coordinator: makeLocalWriteCoordinator({
      rootDir: parsed.value.rootDir,
      layoutOverrides: parsed.value.layoutOverrides,
      actor: { kind: "agent", id: "decision-cli" },
      sessionId: getSessionBranchId()
    }),
    currentSessionProbe: getCurrentSessionProbe(),
    provenanceSessionExporter: makeSessionExporter(),
    syncExportedSession
  }), () => makeFactWriteService({
    rootInput: layoutInput,
    coordinator: makeLocalWriteCoordinator({
      rootDir: parsed.value.rootDir,
      layoutOverrides: parsed.value.layoutOverrides,
      actor: { kind: "agent", id: "fact-cli" },
      sessionId: getSessionBranchId()
    }),
    currentSessionProbe: getCurrentSessionProbe(),
    provenanceSessionExporter: makeSessionExporter(),
    syncExportedSession
  }), () => makeRuntimeEventLedgerService({
    rootInput: layoutInput
  }), runLedgerMaterializer).pipe(
    Effect.match({
      onFailure: (error): CliResult => ({
        ok: false,
        command: parsed.value.action.kind,
        taskId: actionTaskId(parsed.value.action),
        error: toCliError(error)
      }),
      onSuccess: (value) => value
    })
  ));

  const output = toCommandReceipt(result);
  emit(output, parsed.value.json);
  return output.ok ? 0 : 1;
}

async function maybeRunDaemonCommand(argv: ReadonlyArray<string>): Promise<number | undefined> {
  const stripped = stripGlobalOptions(argv);
  if (stripped.args[0] !== "daemon") return undefined;
  const action = stripped.args[1] ?? "status";
  const layoutOverrides = stripped.authoredRoot ? { authoredRoot: stripped.authoredRoot } : undefined;
  const runtimeContext = createHarnessRuntimeContext(stripped.rootDir, layoutOverrides);
  const layout = resolveHarnessLayout(runtimeContext);
  const lockPath = path.join(layout.locksRoot, "global.lock");
  try {
    if (action === "start") {
      const foreground = stripped.args.includes("--foreground");
      const runtime = createDaemonRuntime({
        rootDir: stripped.rootDir,
        layoutOverrides,
        materializerPollMs: foreground ? 5_000 : false
      });
      const status = await runtime.start();
      emitDaemonResult("daemon-start", {
        ...status,
        mode: foreground ? "foreground" : "oneshot",
        guidance: "submit writes through the daemon-backed ha client/API; legacy direct WriteCoordinator writes fail closed while this lock is held"
      }, stripped.json);
      if (!foreground) {
        await runtime.stop();
        return 0;
      }
      await waitForStopSignal();
      await runtime.stop();
      return 0;
    }
    if (action === "status") {
      emitDaemonResult("daemon-status", readDaemonLock(lockPath), stripped.json);
      return 0;
    }
    if (action === "stop") {
      const status = readDaemonLock(lockPath);
      if (status.started && typeof status.pid === "number") {
        process.kill(status.pid, "SIGTERM");
      }
      emitDaemonResult("daemon-stop", { ...status, signaled: status.started }, stripped.json);
      return 0;
    }
    emitDaemonError(`unknown daemon command: ${action}`, stripped.json, CliErrorCode.UnknownCommand);
    return 2;
  } catch (error) {
    emitDaemonError(error instanceof Error ? error.message : String(error), stripped.json, CliErrorCode.JournalUnavailable);
    return 1;
  }
}

function readDaemonLock(lockPath: string): Record<string, unknown> {
  if (!existsSync(lockPath)) {
    return { started: false, lockPath };
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    readonly pid?: unknown;
    readonly hostname?: unknown;
    readonly heartbeatAt?: unknown;
    readonly ownerKind?: unknown;
  };
  return {
    started: lock.ownerKind === "daemon",
    lockPath,
    pid: lock.pid,
    hostname: lock.hostname,
    heartbeatAt: lock.heartbeatAt,
    ownerKind: lock.ownerKind
  };
}

function emitDaemonResult(command: string, result: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, schema: "daemon-command/v1", command, ...result }));
    return;
  }
  const parts = [`ok`, `command=${command}`];
  if (typeof result.started === "boolean") parts.push(`started=${String(result.started)}`);
  if (typeof result.mode === "string") parts.push(`mode=${result.mode}`);
  if (typeof result.lockPath === "string") parts.push(`lock=${result.lockPath}`);
  if (typeof result.pid === "number") parts.push(`pid=${String(result.pid)}`);
  if (typeof result.guidance === "string") parts.push(`guidance=${JSON.stringify(result.guidance)}`);
  console.log(parts.join(" "));
}

function emitDaemonError(message: string, json: boolean, code: CliErrorCode): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, schema: "daemon-command/v1", command: "daemon", error: { code, hint: message } }));
    return;
  }
  console.error(`error code=${code} hint=${message}`);
}

async function waitForStopSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function emit(output: CommandReceipt | CommandFailureReceipt, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(output));
    return;
  }

  if (output.ok) {
    const data = receiptDetailsData(output);
    if (output.command === "version") {
      console.log(`harness-anything ${String(data.version ?? "unknown")}`);
      return;
    }
    if (output.command === "help" && Array.isArray(data.commands)) {
      console.log(renderHelp(data));
      return;
    }
    console.log(renderReceiptText(output));
    return;
  }

  console.error(`error code=${output.error?.code ?? "unknown"} hint=${output.error?.hint ?? "Command failed."}`);
}

function renderHelp(result: Record<string, unknown>): string {
  const commands = Array.isArray(result.commands) ? result.commands as ReadonlyArray<CommandRegistryEntry> : [];
  const report = helpReport(result.report);
  if (report?.kind === "command" && commands.length === 1) {
    return renderCommandHelp(commands[0]!);
  }
  if (report?.kind === "prefix") {
    const prefix = Array.isArray(report.prefix) ? report.prefix.join(" ") : "";
    return [
      `Usage: harness-anything ${prefix} <subcommand> [options]`,
      `Alias: ha ${prefix} <subcommand> [options]`,
      "",
      "Commands:",
      ...commands.map((entry) => `  ${entry.primary} - ${entry.summary}`)
    ].join("\n");
  }
  return [
    "Usage: harness-anything <command> [options]",
    "Alias: ha <command> [options]",
    "",
    "Commands:",
    ...commands.map((entry) => `  ${entry.primary}`)
  ].join("\n");
}

function renderCommandHelp(command: CommandRegistryEntry): string {
  const aliases = command.aliases.length > 0 ? ["", "Aliases:", ...command.aliases.map((alias) => `  ${alias}`)] : [];
  const options = command.options.length > 0 ? ["", "Options:", ...command.options.map((option) => `  ${option.flag.padEnd(18)} ${option.description}`)] : [];
  const examples = command.examples.length > 0 ? ["", "Example:", ...command.examples.map((example) => `  ${example}`)] : [];
  return [
    `Usage: ${command.primary}`,
    "",
    command.summary,
    ...aliases,
    ...options,
    ...examples
  ].join("\n");
}

function helpReport(report: unknown): { readonly kind: "global" | "command" | "prefix"; readonly prefix?: unknown } | undefined {
  if (!report || typeof report !== "object") return undefined;
  const candidate = report as { readonly schema?: unknown; readonly kind?: unknown; readonly prefix?: unknown };
  if (candidate.schema !== "cli-help-report/v1") return undefined;
  if (candidate.kind !== "global" && candidate.kind !== "command" && candidate.kind !== "prefix") return undefined;
  return { kind: candidate.kind, prefix: candidate.prefix };
}

function isCliEntrypoint(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return invokedPath.endsWith("packages/cli/src/index.ts");
  }
}

if (isCliEntrypoint()) {
  process.exitCode = await main();
}
