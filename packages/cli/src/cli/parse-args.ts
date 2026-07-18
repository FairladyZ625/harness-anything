import { findCommandHelpContext, findCommandHelpMatch } from "./command-registry.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { applyJsonInputLayer } from "./json-input.ts";
import { parseRegisteredCommand } from "./parser-registry.ts";
import { stripGlobalOptions } from "./parse-options.ts";
import type { HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import type { CliResult, ParsedCommand } from "./types.ts";
import { withDeprecatedInvocation } from "./command-deprecations.ts";

export function parseArgs(argv: ReadonlyArray<string>): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } {
  const { rootDir, authoredRoot, daemonRepoId, actor, daemonMode, daemonProfile, json, args: rawArgs } = stripGlobalOptions(argv);
  const jsonInput = applyJsonInputLayer(rawArgs, process.cwd());
  if (!jsonInput.ok) return { ok: false, error: jsonInput.error };
  const args = jsonInput.args;
  const layoutOverrides = authoredRoot ? { authoredRoot } : undefined;

  const help = parseHelpRequest(args, rootDir, json, layoutOverrides);
  if (help) return attachDeprecation(attachDaemonOverrides(attachActor(attachDaemonRepoId(help, daemonRepoId), actor), daemonMode, daemonProfile), args);

  const parsed = parseRegisteredCommand(args, rootDir, json, jsonInput.input);
  if (parsed) return attachDeprecation(attachDaemonOverrides(attachActor(attachDaemonRepoId(attachLayoutOverrides(parsed, layoutOverrides), daemonRepoId), actor), daemonMode, daemonProfile), args);
  return {
    ok: false,
    error: cliError(CliErrorCode.UnknownCommand, unknownCommandHint(args))
  };
}

function attachDeprecation(
  parsed: { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] },
  args: ReadonlyArray<string>
): typeof parsed {
  return parsed.ok ? { ok: true, value: withDeprecatedInvocation(parsed.value, args) } : parsed;
}

function attachDaemonOverrides(
  parsed: { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] },
  daemonMode: ParsedCommand["daemonModeOverride"],
  daemonProfile: ParsedCommand["daemonProfileOverride"]
): typeof parsed {
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      ...parsed.value,
      ...(daemonMode ? { daemonModeOverride: daemonMode } : {}),
      ...(daemonProfile ? { daemonProfileOverride: daemonProfile } : {})
    }
  };
}

function attachActor(
  parsed: { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] },
  actor: string | undefined
): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!parsed.ok || !actor) return parsed;
  return { ok: true, value: { ...parsed.value, actor } };
}

function parseHelpRequest(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean,
  layoutOverrides?: HarnessLayoutOverrides
): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } | null {
  if (args.length === 0) {
    return { ok: true, value: commandWithLayoutOverrides({ rootDir, json, action: { kind: "help" } }, layoutOverrides) };
  }

  const first = args[0] ?? "";
  const isExplicitHelpCommand = first === "help";
  const hasHelpFlag = args.includes("--help") || args.includes("-h");
  if (!isExplicitHelpCommand && !hasHelpFlag) return null;

  const topic = isExplicitHelpCommand
    ? args.slice(1)
    : args.filter((arg) => arg !== "--help" && arg !== "-h");
  const match = findCommandHelpMatch(topic);
  if (match.kind === "global") {
    return { ok: true, value: commandWithLayoutOverrides({ rootDir, json, action: { kind: "help" } }, layoutOverrides) };
  }
  if (match.kind === "command") {
    return { ok: true, value: commandWithLayoutOverrides({ rootDir, json, action: { kind: "help", commandKind: match.entry.kind } }, layoutOverrides) };
  }
  if (match.kind === "prefix") {
    return { ok: true, value: commandWithLayoutOverrides({ rootDir, json, action: { kind: "help", commandPrefix: match.prefix } }, layoutOverrides) };
  }
  return {
    ok: false,
    error: cliError(CliErrorCode.UnknownHelpTopic, unknownHelpTopicHint(topic))
  };
}

function unknownCommandHint(args: ReadonlyArray<string>): string {
  return focusedUnknownHint("command", args);
}

function unknownHelpTopicHint(topic: ReadonlyArray<string>): string {
  return focusedUnknownHint("help topic", topic);
}

function focusedUnknownHint(label: string, tokens: ReadonlyArray<string>): string {
  const attempted = tokens.slice(0, 6).join(" ").slice(0, 160) || "<empty>";
  const context = findCommandHelpContext(tokens);
  const helpCommand = context.length > 0 ? `ha ${context.join(" ")} --help` : "ha help";
  return `Unknown ${label}: ${attempted}. Run '${helpCommand}' to inspect the valid command shape.`;
}

function attachLayoutOverrides(
  parsed: { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] },
  layoutOverrides?: HarnessLayoutOverrides
): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!parsed.ok) return parsed;
  return { ok: true, value: commandWithLayoutOverrides(parsed.value, layoutOverrides) };
}

function attachDaemonRepoId(
  parsed: { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] },
  daemonRepoId: string | undefined
): { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!parsed.ok || !daemonRepoId) return parsed;
  return { ok: true, value: { ...parsed.value, daemonRepoId } };
}

function commandWithLayoutOverrides(command: ParsedCommand, layoutOverrides?: HarnessLayoutOverrides): ParsedCommand {
  return layoutOverrides ? { ...command, layoutOverrides } : command;
}

export function actionTaskId(action: ParsedCommand["action"]): string | undefined {
  if ("oldTaskId" in action) return action.oldTaskId;
  if ("sourceTaskId" in action) return action.sourceTaskId;
  return "taskId" in action ? action.taskId : undefined;
}
