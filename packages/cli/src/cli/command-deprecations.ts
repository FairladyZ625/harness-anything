import type { ParsedCommand } from "./types.ts";

export const compatibilitySunsetDecision = "dec_01KXQKTCKDDZF16QSMP5E5HFG1";

export type CommandDeprecationKind = "alias-grammar" | "migration-command";

export interface DeprecatedCommandInvocation {
  readonly kind: CommandDeprecationKind;
  readonly commandKind: string;
  readonly syntax: string;
  readonly replacement: string;
  readonly sunsetStage: "warning";
  readonly decisionId: typeof compatibilitySunsetDecision;
}

interface DeprecatedCommandDefinition extends DeprecatedCommandInvocation {
  readonly tokens: ReadonlyArray<string>;
}

const legacyIntakeReplacement = "ha legacy scan <path>; ha legacy plan <path>; ha legacy copy-docs <path> [--apply]; ha legacy index <path> [--apply]; ha legacy verify";

const aliasGrammarDeprecations = [
  alias("new-task", "new-task --title <title>", "ha task create --title <title>", "new-task"),
  alias("status-set", "task status set <id> <status>", "ha task transition <id> <status>", "task", "status", "set"),
  alias("task-review", "task-review <id>", "ha task review <id>", "task-review"),
  alias("task-complete", "task-complete <id>", "ha task complete <id>", "task-complete"),
  alias("record-fact", "record fact --task <task-id>", "ha fact record --task <task-id>", "record", "fact"),
  alias("distill-commit", "distill commit --task <task-id>", "ha distill promote --task <task-id>", "distill", "commit"),
  alias("runtime-event-append", "runtime-event append", "ha event append", "runtime-event", "append"),
  alias("runtime-event-list", "runtime-event list", "ha event list", "runtime-event", "list"),
  alias("lesson-promote", "lesson-promote <task-id> <candidate-id>", "ha lesson promote <task-id> <candidate-id>", "lesson-promote"),
  alias("lesson-sediment", "lesson-sediment <task-id> <candidate-id>", "ha lesson sediment <task-id> <candidate-id>", "lesson-sediment"),
  alias("migrate-plan", "migrate-plan", "ha migrate plan", "migrate-plan"),
  alias("migrate-structure", "migrate-structure", "ha migrate structure", "migrate-structure"),
  alias("migrate-anchors", "migrate-anchors", "ha migrate anchors", "migrate-anchors"),
  alias("migrate-provenance", "migrate-provenance", "ha migrate provenance", "migrate-provenance"),
  alias("migrate-run", "migrate-run", "ha migrate run", "migrate-run"),
  alias("migrate-verify", "migrate-verify <session.json>", "ha migrate verify <session.json>", "migrate-verify"),
  alias("legacy-intake-plan", "legacy intake-plan <path>", "ha legacy plan <path>", "legacy", "intake-plan"),
  alias("legacy-copy-safe-docs", "legacy copy-safe-docs <path>", "ha legacy copy-docs <path>", "legacy", "copy-safe-docs"),
  alias("git-diff", "git-diff", "ha git diff", "git-diff"),
  alias("module-step", "module-step <key> <step>", "ha module step <key> <step>", "module-step")
] as const satisfies ReadonlyArray<DeprecatedCommandDefinition>;

const migrationCommandDeprecations = [
  migration("migrate-plan", "migrate plan", "plan"),
  migration("migrate-structure", "migrate structure", "structure"),
  migration("migrate-anchors", "migrate anchors", "anchors"),
  migration("migrate-retired-attribution-fields", "migrate retired-attribution-fields", "retired-attribution-fields"),
  migration("migrate-provenance", "migrate provenance", "provenance"),
  migration("migrate-run", "migrate run", "run"),
  migration("migrate-verify", "migrate verify <session.json>", "verify")
] as const satisfies ReadonlyArray<DeprecatedCommandDefinition>;

export const deprecatedCommandDefinitions = [
  ...aliasGrammarDeprecations,
  ...migrationCommandDeprecations
] as const;

export function deprecatedInvocationForArgs(args: ReadonlyArray<string>, commandKind?: string): DeprecatedCommandInvocation | undefined {
  const topic = args[0] === "help"
    ? args.slice(1)
    : args.filter((arg) => arg !== "--help" && arg !== "-h");
  const definition = deprecatedCommandDefinitions.find((candidate) =>
    (!commandKind || candidate.commandKind === commandKind) && startsWithTokens(topic, candidate.tokens)
  );
  if (!definition) return undefined;
  const { tokens: _tokens, ...invocation } = definition;
  return invocation;
}

export function migrationCommandDeprecation(commandKind: string): DeprecatedCommandInvocation | undefined {
  return migrationCommandDeprecations.find((candidate) => candidate.commandKind === commandKind);
}

export function deprecationWarning(invocation: DeprecatedCommandInvocation): string {
  return `Deprecation warning: 'ha ${invocation.syntax}' is deprecated. Use '${invocation.replacement}' instead. Sunset stage 1/3 (30-day telemetry warning): behavior remains available; stage 2 hides compatibility help and stage 3 removes it. Decision: ${invocation.decisionId}.`;
}

export function withDeprecatedInvocation(command: ParsedCommand, args: ReadonlyArray<string>): ParsedCommand {
  const deprecatedInvocation = deprecatedInvocationForArgs(args, command.action.kind === "help" ? command.action.commandKind : command.action.kind);
  return deprecatedInvocation ? { ...command, deprecatedInvocation } : command;
}

function alias(commandKind: string, syntax: string, replacement: string, ...tokens: ReadonlyArray<string>): DeprecatedCommandDefinition {
  return deprecation("alias-grammar", commandKind, syntax, replacement, tokens);
}

function migration(commandKind: string, syntax: string, subcommand: string): DeprecatedCommandDefinition {
  return deprecation("migration-command", commandKind, syntax, legacyIntakeReplacement, ["migrate", subcommand]);
}

function deprecation(
  kind: CommandDeprecationKind,
  commandKind: string,
  syntax: string,
  replacement: string,
  tokens: ReadonlyArray<string>
): DeprecatedCommandDefinition {
  return { kind, commandKind, syntax, replacement, tokens, sunsetStage: "warning", decisionId: compatibilitySunsetDecision };
}

function startsWithTokens(args: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean {
  return prefix.every((token, index) => args[index] === token);
}
