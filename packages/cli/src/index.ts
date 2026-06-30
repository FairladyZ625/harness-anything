#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isExtensionAction, runExtensionCommand } from "./commands/extensions/index.ts";
import { toCliError } from "./cli/error-mapper.ts";
import { actionTaskId, parseArgs } from "./cli/parse-args.ts";
import { Effect } from "effect";
import { makeLocalLifecycleEngine } from "../../adapters/local/src/index.ts";
import { runCommand } from "./commands/lifecycle.ts";
import type { CliResult, CommandRegistryEntry } from "./cli/types.ts";

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    emit({ ok: false, command: "parse", error: parsed.error }, true);
    return 2;
  }

  if (isExtensionAction(parsed.value.action)) {
    const result = runExtensionCommand(parsed.value);
    emit(result, parsed.value.json);
    return result.ok ? 0 : 1;
  }

  if (parsed.value.action.kind === "gui") {
    const result = launchGui(parsed.value.rootDir);
    emit(result, parsed.value.json);
    return 0;
  }

  const engine = makeLocalLifecycleEngine({ rootDir: parsed.value.rootDir });
  const result = await Effect.runPromise(runCommand(engine, parsed.value).pipe(
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

  emit(result, parsed.value.json);
  return result.ok ? 0 : 1;
}

function launchGui(rootDir: string): CliResult {
  const command = ["npm", "--workspace", "@harness-anything/gui", "run", "dev"] as const;
  const dryRun = process.env.HARNESS_GUI_DRY_RUN === "1";
  if (dryRun) {
    return {
      ok: true,
      command: "gui",
      launchPlan: {
        packageName: "@harness-anything/gui",
        mode: "local-desktop-controller",
        apiHost: "127.0.0.1",
        delegated: true,
        dryRun,
        command
      }
    };
  }

  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HARNESS_GUI_ROOT: path.resolve(rootDir)
    }
  });
  child.unref();

  return {
    ok: true,
    command: "gui",
    launchPlan: {
      packageName: "@harness-anything/gui",
      mode: "local-desktop-controller",
      apiHost: "127.0.0.1",
      delegated: true,
      dryRun,
      command,
      pid: child.pid
    }
  };
}

function emit(result: CliResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.ok) {
    if (result.command === "help" && result.commands) {
      console.log(renderHelp(result));
      return;
    }
    const suffix = result.status ? ` status=${result.status}` : result.path ? ` path=${result.path}` : result.rows !== undefined ? ` rows=${result.rows}` : result.launchPlan ? ` mode=${result.launchPlan.mode} package=${result.launchPlan.packageName}` : "";
    console.log(`ok command=${result.command} task=${result.taskId ?? ""}${suffix}`);
    return;
  }

  console.error(`error code=${result.error?.code ?? "unknown"} hint=${result.error?.hint ?? "Command failed."}`);
}

function renderHelp(result: CliResult): string {
  const commands = result.commands ?? [];
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
