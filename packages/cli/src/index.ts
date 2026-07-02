#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toCliError } from "./cli/error-mapper.ts";
import { actionTaskId, parseArgs } from "./cli/parse-args.ts";
import { runRegisteredCommand } from "./cli/runner-registry.ts";
import { Effect } from "effect";
import { makeLocalLifecycleEngine, makeLocalWriteCoordinator } from "../../adapters/local/src/index.ts";
import { makeDecisionWriteService, makeEnvironmentCurrentSessionProbe, makeFactWriteService } from "../../application/src/index.ts";
import { renderReceiptText, toCommandReceipt, type CommandReceipt } from "./cli/receipt.ts";
import type { CliResult, CommandRegistryEntry } from "./cli/types.ts";

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    emit({ ok: false, command: "parse", error: parsed.error }, true);
    return 2;
  }

  const result = await Effect.runPromise(runRegisteredCommand(parsed.value, () => makeLocalLifecycleEngine({
    rootDir: parsed.value.rootDir,
    layoutOverrides: parsed.value.layoutOverrides
  }), () => makeEnvironmentCurrentSessionProbe(), () => makeDecisionWriteService({
    coordinator: makeLocalWriteCoordinator({
      rootDir: parsed.value.rootDir,
      layoutOverrides: parsed.value.layoutOverrides,
      actor: { kind: "agent", id: "decision-cli" }
    })
  }), () => makeFactWriteService({
    rootInput: {
      rootDir: parsed.value.rootDir,
      layoutOverrides: parsed.value.layoutOverrides
    },
    coordinator: makeLocalWriteCoordinator({
      rootDir: parsed.value.rootDir,
      layoutOverrides: parsed.value.layoutOverrides,
      actor: { kind: "agent", id: "fact-cli" }
    })
  })).pipe(
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

function emit(output: CommandReceipt | (CliResult & { readonly ok: false }), json: boolean): void {
  if (json) {
    console.log(JSON.stringify(output));
    return;
  }

  if (output.ok) {
    if (output.command === "version") {
      console.log(`harness-anything ${String(output.data?.version ?? "unknown")}`);
      return;
    }
    if (output.command === "help" && Array.isArray(output.data?.commands)) {
      console.log(renderHelp(output.data));
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
