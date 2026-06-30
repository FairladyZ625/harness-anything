import type { CommandRegistryEntry } from "./types.ts";

export const cliCommandName = "harness-anything";
export const cliCommandAlias = "ha";

interface CommandUsage {
  readonly kind: CommandRegistryEntry["kind"];
  readonly usage: string;
  readonly aliases?: ReadonlyArray<string>;
}

const commandUsages: ReadonlyArray<CommandUsage> = [
  { kind: "help", usage: "help", aliases: ["--help", "-h"] },
  { kind: "init", usage: "init [--add-npm-scripts]" },
  { kind: "new-task", usage: "new-task --title <title> [--vertical software/coding --preset <id> --module <key>] [--register-module <key> --module-title <title> --module-scope <path>] [--long-running] [--dry-run] [--locale zh-CN|en-US] [--from-legacy <legacy-id>] [--json]" },
  { kind: "status-set", usage: "task status set <id> <status> [--force --reason <reason>]" },
  { kind: "progress-append", usage: "task progress append <id> --text <text> [--evidence type:PATH:summary]" },
  { kind: "task-archive", usage: "task archive <id> --reason <reason> [--archived-by <actor>] [--archive-field <field>]" },
  { kind: "task-supersede", usage: "task supersede <old-id> (--title <title> [--slug <slug>] | --by <existing-task-id> --confirm <old-id>) [--allow-open-findings]" },
  { kind: "task-delete", usage: "task delete (--soft <id> | --hard <id> --confirm <id>) --reason <reason> [--deleted-by <actor>]" },
  { kind: "task-reopen", usage: "task reopen <id> --reason <reason>" },
  { kind: "task-review", usage: "task-review <id> [--reviewer <id>]" },
  { kind: "task-complete", usage: "task-complete <id> --ci passed|failed" },
  { kind: "template-list", usage: "template list [--catalog <path>] [--json]" },
  { kind: "template-render", usage: "template render <template-ref> [--catalog <path>] [--locale zh-CN|en-US] [--json]" },
  { kind: "task-list", usage: "task list [--state <state>] [--module <key>] [--queue <queue>] [--preset <id>] [--review <state>] [--lesson [present|missing]] [--missing-materials] [--include-archived] [--search <text>] [--json]" },
  { kind: "status", usage: "status --json" },
  { kind: "check", usage: "check [--profile source-package|private-harness|target-project] [--strict] [--post-merge] [--json]" },
  { kind: "governance-rebuild", usage: "governance rebuild [--dry-run|--archive|--apply] [--json]" },
  { kind: "lesson-promote", usage: "lesson-promote <task-id> <candidate-id> [--dry-run|--apply] [--json]" },
  { kind: "lesson-sediment", usage: "lesson-sediment <task-id> <candidate-id> [--dry-run] [--title <title>] [--json]" },
  { kind: "adopt-multica", usage: "adopt multica <ref> --task <task-id> [--status <status>] [--title <title>] [--json]" },
  { kind: "snapshot-multica", usage: "snapshot multica <ref> [--status <status>] [--title <title>] [--json]" },
  { kind: "migrate-plan", usage: "migrate-plan [--limit n] [--json]" },
  { kind: "migrate-structure", usage: "migrate-structure (--plan|--apply --confirm-plan) [--json]" },
  { kind: "migrate-run", usage: "migrate-run [--plan-only] [--out-dir folder] [--session-dir folder] [--locale zh-CN|en-US] [--assume-locale zh-CN|en-US] [--allow-dirty] [--json]" },
  { kind: "migrate-verify", usage: "migrate-verify <session.json> [--json]" },
  { kind: "legacy-scan", usage: "legacy scan <path> [--json]" },
  { kind: "legacy-intake-plan", usage: "legacy intake-plan <path> [--out file] [--json]" },
  { kind: "legacy-copy-safe-docs", usage: "legacy copy-safe-docs <path> [--apply] [--json]" },
  { kind: "legacy-index", usage: "legacy index <path> [--apply] [--json]" },
  { kind: "legacy-verify", usage: "legacy verify [--json]" },
  { kind: "git-diff", usage: "git-diff [--base <ref>] [--json]" },
  { kind: "doctor", usage: "doctor --json" },
  { kind: "preset-validate", usage: "preset validate <manifest> [--kernel-version <version>] [--json]" },
  { kind: "preset-list", usage: "preset list [--json]" },
  { kind: "preset-inspect", usage: "preset inspect <id> [--json]" },
  { kind: "preset-check", usage: "preset check <id> [--json]" },
  { kind: "preset-install", usage: "preset install <folder> [--project] [--json]" },
  { kind: "preset-seed", usage: "preset seed [--json]" },
  { kind: "preset-audit", usage: "preset audit [--json]" },
  { kind: "preset-uninstall", usage: "preset uninstall <id> [--project] [--json]" },
  { kind: "preset-run", usage: "preset run <id> <plan|scaffold|check> --task <id> [--allow-scripts] [--json]" },
  { kind: "preset-action", usage: "preset action <id> <action> --task <id> [--allow-scripts] [--json]" },
  { kind: "module-list", usage: "module list [--json]" },
  { kind: "module-inspect", usage: "module inspect <key> [--json]" },
  { kind: "module-register", usage: "module register <key> --title <title> --scope <path> [--prefix <prefix>] [--status <status>] [--branch <branch>] [--owner <owner>] [--current-step <step>] [--shared <path>] [--depends-on <module>] [--json]" },
  { kind: "module-scaffold", usage: "module scaffold <key> [--json]" },
  { kind: "module-unregister", usage: "module unregister <key> [--json]" },
  { kind: "module-step", usage: "module-step <key> <step> --state <state> [--json]" },
  { kind: "vertical-validate", usage: "vertical validate [software/coding|<path>] [--json]" },
  { kind: "gui", usage: "gui" }
] as const;

export const commandRegistry = commandUsages.map((entry) => ({
  kind: entry.kind,
  primary: `${cliCommandName} ${entry.usage}`,
  aliases: [
    `${cliCommandAlias} ${entry.usage}`,
    ...(entry.aliases ?? []).map((alias) => `${cliCommandName} ${alias}`),
    ...(entry.aliases ?? []).map((alias) => `${cliCommandAlias} ${alias}`)
  ],
  resultEnvelope: "CliResult/v1"
})) satisfies ReadonlyArray<CommandRegistryEntry>;
