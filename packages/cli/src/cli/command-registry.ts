import type { CommandRegistryEntry } from "./types.ts";

export const cliCommandName = "harness-anything";
export const cliCommandAlias = "ha";

interface CommandUsage {
  readonly kind: CommandRegistryEntry["kind"];
  readonly usage: string;
  readonly aliases?: ReadonlyArray<string>;
}

const commandUsages = [
  { kind: "help", usage: "help", aliases: ["--help", "-h"] },
  { kind: "init", usage: "init [--add-npm-scripts]" },
  { kind: "new-task", usage: "new-task --title <title> [--vertical software/coding --preset <id> --module <key>] [--register-module <key> --module-title <title> --module-scope <path>] [--long-running] [--dry-run] [--locale zh-CN|en-US] [--from-legacy <legacy-id>] [--json]" },
  { kind: "status-set", usage: "task status set <id> <status> [--force --reason <reason>]" },
  { kind: "progress-append", usage: "task progress append <id> --text <text> [--evidence type:PATH:summary]" },
  { kind: "task-archive", usage: "task archive <id> --reason <reason> [--archived-by <actor>] [--archive-field <field>]" },
  { kind: "task-supersede", usage: "task supersede <old-id> (--title <title> [--slug <slug>] | --by <existing-task-id> --confirm <old-id>) [--reason <reason>] [--deleted-by <actor>] [--allow-open-findings]" },
  { kind: "task-delete", usage: "task delete (--soft <id> | --hard <id> --confirm <id>) --reason <reason> [--deleted-by <actor>]" },
  { kind: "task-reopen", usage: "task reopen <id> --reason <reason>" },
  { kind: "task-review", usage: "task-review <id> [--reviewer <id>]" },
  { kind: "task-complete", usage: "task-complete <id> --ci passed|failed [--reviewer <id>]" },
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
] as const satisfies ReadonlyArray<CommandUsage>;

type CommandKind = (typeof commandUsages)[number]["kind"];

const commandSummaries = {
  "help": "Show global help or detailed help for one command.",
  "init": "Create the harness directory layout and optional npm shortcuts.",
  "new-task": "Create a new task package, optionally through a vertical or preset.",
  "status-set": "Move a local task to a new lifecycle status.",
  "progress-append": "Append progress text, with optional evidence, to a task package.",
  "task-archive": "Archive a task package while preserving its audit trail.",
  "task-supersede": "Archive old work and optionally create or link replacement work.",
  "task-delete": "Soft-delete or guarded hard-delete a task package.",
  "task-reopen": "Reopen a non-terminal archived or tombstoned task package.",
  "task-review": "Evaluate the review gate for a task package.",
  "task-complete": "Evaluate the completion gate after CI has passed or failed.",
  "template-list": "List available task and document templates.",
  "template-render": "Render a template reference with a selected locale.",
  "task-list": "List task packages with state, module, review, and search filters.",
  "status": "Summarize harness state and supported CLI commands.",
  "check": "Run harness health checks for a selected profile.",
  "governance-rebuild": "Rebuild generated governance projections.",
  "lesson-promote": "Promote a lesson candidate from a completed task.",
  "lesson-sediment": "Record a dry-run sedimentation result for a lesson candidate.",
  "adopt-multica": "Bind a fresh Multica issue snapshot to a new local task package.",
  "snapshot-multica": "Read and report the current Multica issue snapshot.",
  "migrate-plan": "Plan legacy structure migration work.",
  "migrate-structure": "Plan or apply legacy directory structure migration.",
  "migrate-run": "Run the legacy migration pipeline into a session directory.",
  "migrate-verify": "Verify a legacy migration session file.",
  "legacy-scan": "Scan a legacy source tree for migration candidates.",
  "legacy-intake-plan": "Create an intake plan for a legacy source tree.",
  "legacy-copy-safe-docs": "Copy safe legacy documents into the harness workspace.",
  "legacy-index": "Build or apply the legacy task index.",
  "legacy-verify": "Verify legacy migration readiness and generated state.",
  "git-diff": "Capture git diff evidence against a base ref.",
  "doctor": "Report read-only local environment and harness diagnostics.",
  "preset-validate": "Validate a preset manifest against the preset schema.",
  "preset-list": "List installed presets from project and user layers.",
  "preset-inspect": "Inspect one preset manifest and public summary.",
  "preset-check": "Check one preset for validity and materialization readiness.",
  "preset-install": "Install a preset folder into the project or user layer.",
  "preset-seed": "Seed built-in presets into the harness workspace.",
  "preset-audit": "Audit installed presets for validity and drift.",
  "preset-uninstall": "Remove a preset from the project or user layer.",
  "preset-run": "Run a preset entrypoint for a task package.",
  "preset-action": "Run a named preset action for a task package.",
  "module-list": "List registered project modules.",
  "module-inspect": "Inspect one registered module.",
  "module-register": "Register or update a project module definition.",
  "module-scaffold": "Create the standard files for a registered module.",
  "module-unregister": "Mark a module as unregistered.",
  "module-step": "Update a module step state.",
  "vertical-validate": "Validate a vertical definition file or built-in vertical.",
  "gui": "Launch the local desktop GUI controller."
} satisfies Record<CommandKind, string>;

const commandExamples = {
  "help": [`${cliCommandName} help new-task`],
  "init": [`${cliCommandName} init --add-npm-scripts`],
  "new-task": [`${cliCommandName} new-task --title "Normalize CLI help" --vertical software/coding --preset standard-task`],
  "status-set": [`${cliCommandName} task status set task_01ABC active --reason "work started"`],
  "progress-append": [`${cliCommandName} task progress append task_01ABC --text "Implemented parser guard" --evidence log:artifacts/check.log:passed`],
  "task-archive": [`${cliCommandName} task archive task_01ABC --reason "merged"`],
  "task-supersede": [`${cliCommandName} task supersede task_01OLD --title "Replacement task" --reason "scope changed"`],
  "task-delete": [`${cliCommandName} task delete --soft task_01ABC --reason "duplicate"`],
  "task-reopen": [`${cliCommandName} task reopen task_01ABC --reason "follow-up needed"`],
  "task-review": [`${cliCommandName} task-review task_01ABC --reviewer reviewer-id`],
  "task-complete": [`${cliCommandName} task-complete task_01ABC --ci passed --reviewer reviewer-id`],
  "template-list": [`${cliCommandName} template list --json`],
  "template-render": [`${cliCommandName} template render template://planning/task@1 --locale zh-CN`],
  "task-list": [`${cliCommandName} task list --state active --module kernel --review missing`],
  "status": [`${cliCommandName} status --json`],
  "check": [`${cliCommandName} check --profile target-project --strict`],
  "governance-rebuild": [`${cliCommandName} governance rebuild --dry-run`],
  "lesson-promote": [`${cliCommandName} lesson-promote task_01ABC candidate-1 --apply`],
  "lesson-sediment": [`${cliCommandName} lesson-sediment task_01ABC candidate-1 --title "CLI help lesson"`],
  "adopt-multica": [`${cliCommandName} adopt multica EXT-123 --task task_01ABC --status active --title "External task"`],
  "snapshot-multica": [`${cliCommandName} snapshot multica EXT-123 --json`],
  "migrate-plan": [`${cliCommandName} migrate-plan --limit 20`],
  "migrate-structure": [`${cliCommandName} migrate-structure --plan`],
  "migrate-run": [`${cliCommandName} migrate-run --plan-only --session-dir migration-session --locale zh-CN`],
  "migrate-verify": [`${cliCommandName} migrate-verify migration-session/session.json`],
  "legacy-scan": [`${cliCommandName} legacy scan .harness-private/legacy --json`],
  "legacy-intake-plan": [`${cliCommandName} legacy intake-plan .harness-private/legacy --out intake-plan.json`],
  "legacy-copy-safe-docs": [`${cliCommandName} legacy copy-safe-docs .harness-private/legacy --apply`],
  "legacy-index": [`${cliCommandName} legacy index .harness-private/legacy --apply`],
  "legacy-verify": [`${cliCommandName} legacy verify --json`],
  "git-diff": [`${cliCommandName} git-diff --base origin/main --json`],
  "doctor": [`${cliCommandName} doctor --json`],
  "preset-validate": [`${cliCommandName} preset validate preset.json --kernel-version 1.0.0`],
  "preset-list": [`${cliCommandName} preset list --json`],
  "preset-inspect": [`${cliCommandName} preset inspect standard-task`],
  "preset-check": [`${cliCommandName} preset check standard-task`],
  "preset-install": [`${cliCommandName} preset install ./preset-dir --project`],
  "preset-seed": [`${cliCommandName} preset seed`],
  "preset-audit": [`${cliCommandName} preset audit --json`],
  "preset-uninstall": [`${cliCommandName} preset uninstall standard-task --project`],
  "preset-run": [`${cliCommandName} preset run standard-task plan --task task_01ABC`],
  "preset-action": [`${cliCommandName} preset action standard-task scaffold --task task_01ABC`],
  "module-list": [`${cliCommandName} module list --json`],
  "module-inspect": [`${cliCommandName} module inspect kernel`],
  "module-register": [`${cliCommandName} module register kernel --title "Kernel" --scope "packages/kernel/**"`],
  "module-scaffold": [`${cliCommandName} module scaffold kernel`],
  "module-unregister": [`${cliCommandName} module unregister kernel`],
  "module-step": [`${cliCommandName} module-step kernel KR-01 --state done`],
  "vertical-validate": [`${cliCommandName} vertical validate software/coding`],
  "gui": [`${cliCommandName} gui`]
} satisfies Record<CommandKind, ReadonlyArray<string>>;

export const commandRegistry = commandUsages.map((entry) => {
  const shortAliases = "aliases" in entry ? entry.aliases : [];
  return {
    kind: entry.kind,
    primary: `${cliCommandName} ${entry.usage}`,
    aliases: [
      `${cliCommandAlias} ${entry.usage}`,
      ...shortAliases.map((alias) => `${cliCommandName} ${alias}`),
      ...shortAliases.map((alias) => `${cliCommandAlias} ${alias}`)
    ],
    commandPath: commandPathFromUsage(entry.usage),
    summary: commandSummaries[entry.kind],
    options: optionsFromUsage(entry.usage),
    examples: commandExamples[entry.kind],
    resultEnvelope: "CliResult/v1"
  };
}) satisfies ReadonlyArray<CommandRegistryEntry>;

export function findCommandByKind(kind: string): CommandRegistryEntry | undefined {
  return commandRegistry.find((entry) => entry.kind === kind);
}

export function findCommandHelpMatch(tokens: ReadonlyArray<string>):
  | { readonly kind: "global" }
  | { readonly kind: "command"; readonly entry: CommandRegistryEntry }
  | { readonly kind: "prefix"; readonly prefix: ReadonlyArray<string>; readonly entries: ReadonlyArray<CommandRegistryEntry> }
  | { readonly kind: "unknown" } {
  if (tokens.length === 0) return { kind: "global" };

  const exact = commandRegistry.find((entry) => samePath(entry.commandPath, tokens));
  if (exact) return { kind: "command", entry: exact };

  const prefixMatches = commandRegistry.filter((entry) => isPrefix(tokens, entry.commandPath));
  if (prefixMatches.length > 0) return { kind: "prefix", prefix: tokens, entries: prefixMatches };
  return { kind: "unknown" };
}

function commandPathFromUsage(usage: string): ReadonlyArray<string> {
  const tokens = usage.split(/\s+/u);
  const pathTokens: string[] = [];
  for (const token of tokens) {
    if (!token || token.startsWith("[") || token.startsWith("(") || token.startsWith("<") || token.startsWith("--") || token.includes("|")) break;
    pathTokens.push(token);
  }
  return pathTokens;
}

function optionsFromUsage(usage: string): ReadonlyArray<{ readonly flag: string; readonly description: string }> {
  const flags = [...new Set([...usage.matchAll(/--[a-z0-9-]+/gu)].map((match) => match[0]))];
  return flags.map((flag) => ({ flag, description: optionDescription(flag) }));
}

function samePath(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function isPrefix(prefix: ReadonlyArray<string>, pathTokens: ReadonlyArray<string>): boolean {
  return prefix.length < pathTokens.length && prefix.every((token, index) => token === pathTokens[index]);
}

function optionDescription(flag: string): string {
  const descriptions: Record<string, string> = {
    "--add-npm-scripts": "Add npm script shortcuts during initialization.",
    "--allow-dirty": "Allow running while the working tree has changes.",
    "--allow-open-findings": "Allow superseding work with unresolved findings.",
    "--allow-scripts": "Allow preset script execution.",
    "--apply": "Apply the operation instead of planning it.",
    "--archive": "Archive generated governance output.",
    "--archive-field": "Set the field used for archive disposition.",
    "--archived-by": "Record the actor archiving the task.",
    "--assume-locale": "Set the assumed locale for migrated content.",
    "--base": "Set the git base ref.",
    "--branch": "Set the module branch.",
    "--by": "Supersede by an existing task id.",
    "--catalog": "Use a template catalog file.",
    "--ci": "Set the completion CI gate result.",
    "--confirm": "Confirm a destructive or relation-changing action.",
    "--confirm-plan": "Confirm a migration plan before applying it.",
    "--current-step": "Set the current module step.",
    "--deleted-by": "Record the actor deleting or superseding the task.",
    "--depends-on": "Register a module dependency.",
    "--dry-run": "Preview the operation without writing changes.",
    "--evidence": "Attach evidence in type:path:summary format.",
    "--force": "Force the lifecycle transition with audit metadata.",
    "--from-legacy": "Create from a legacy task id.",
    "--hard": "Hard-delete the selected task.",
    "--help": "Show help output.",
    "--include-archived": "Include archived task packages.",
    "--json": "Emit CliResult/v1 JSON.",
    "--kernel-version": "Validate against a kernel version.",
    "--lesson": "Filter by lesson state.",
    "--limit": "Limit the number of planned items.",
    "--locale": "Set generated content locale.",
    "--long-running": "Mark the task as long-running.",
    "--missing-materials": "Filter tasks missing required materials.",
    "--module": "Select a registered module key; use module list to discover keys.",
    "--module-scope": "Set the registered module source scope, such as packages/name/**.",
    "--module-title": "Set the human-readable title for a registered module.",
    "--out": "Write the generated plan to a file.",
    "--out-dir": "Set the output directory.",
    "--owner": "Set the module owner.",
    "--plan": "Plan without applying changes.",
    "--plan-only": "Create a migration plan without applying it.",
    "--post-merge": "Run checks intended for post-merge validation.",
    "--prefix": "Set the module id prefix.",
    "--preset": "Select a preset id; new-task defaults to standard-task and preset list shows installed presets.",
    "--profile": "Select a check or task profile; new-task defaults to baseline.",
    "--project": "Use the project preset layer.",
    "--queue": "Filter by queue.",
    "--reason": "Record the reason for the lifecycle change.",
    "--register-module": "Register a module while creating the task.",
    "--review": "Filter by review state.",
    "--reviewer": "Set the reviewer id.",
    "--search": "Search task metadata and prose.",
    "--session-dir": "Set the migration session directory.",
    "--shared": "Register a shared path for the module.",
    "--slug": "Set the task slug.",
    "--scope": "Set the module scope.",
    "--soft": "Soft-delete the selected task.",
    "--state": "Set or filter by state.",
    "--status": "Set the external or module status.",
    "--strict": "Run strict checks.",
    "--task": "Set the task id.",
    "--text": "Set appended progress text.",
    "--title": "Set the required task title used for generated package metadata and slug.",
    "--vertical": "Select a vertical definition; new-task defaults to software/coding."
  };
  const description = descriptions[flag];
  if (!description) {
    throw new Error(`missing CLI help option description: ${flag}`);
  }
  return description;
}
