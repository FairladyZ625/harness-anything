import type { CommandRegistryEntry, ParsedCommand } from "./types.ts";
import { commandReceiptEnvelope } from "./receipt.ts";
import { commandReceiptContractsByKind, type CommandReceiptContract } from "./receipt-contracts.ts";
import { optionDescription } from "./command-option-descriptions.ts";

export const cliCommandName = "harness-anything";
export const cliCommandAlias = "ha";

export type CommandKind = ParsedCommand["action"]["kind"];
export type CommandParserId =
  | "help"
  | "version"
  | "core-task"
  | "new-task"
  | "decision"
  | "distill"
  | "record"
  | "runtime-event"
  | "doc"
  | "status-check"
  | "migration"
  | "git-diff"
  | "doctor"
  | "graph"
  | "capabilities"
  | "gui"
  | "template"
  | "preset"
  | "script"
  | "module"
  | "vertical";
export type CommandRunnerId =
  | "help"
  | "version"
  | "init"
  | "new-task"
  | "decision"
  | "distill"
  | "fact"
  | "runtime-event"
  | "doc"
  | "task-lifecycle"
  | "task-gates"
  | "task-query"
  | "governance"
  | "migration"
  | "diagnostics"
  | "extension"
  | "capabilities"
  | "gui";

export interface CommandUsage {
  readonly kind: CommandKind;
  readonly usage: string;
  readonly aliases?: ReadonlyArray<string>;
}

const aliasRetirement = "deprecated, use {replacement}; retires at E77/F6 acceptance";
const deprecatedAlias = (alias: string, replacement: string) => `${alias} (${aliasRetirement.replace("{replacement}", replacement)})`;

const commandUsages = [
  { kind: "help", usage: "help", aliases: ["--help", "-h"] },
  { kind: "version", usage: "version", aliases: ["--version", "-v"] },
  { kind: "entity-list", usage: "entity list [--json]" },
  { kind: "capabilities", usage: "capabilities [--kind <entity-kind>] [--json]" },
  { kind: "init", usage: "init [--name <name>] [--add-npm-scripts]" },
  { kind: "new-task", usage: "task create --title <title> [--from-file <path>|--json-input <json>] [--vertical software/coding --preset <id> --module <key>] [--register-module <key> --module-title <title> --module-scope <path>] [--long-running] [--dry-run] [--locale zh-CN|en-US] [--from-legacy <legacy-id>] [--json]", aliases: [deprecatedAlias("new-task --title <title>", "task create")] },
  { kind: "status-set", usage: "task transition <id> <status> [--force --reason <reason>]", aliases: [deprecatedAlias("task status set <id> <status>", "task transition")] },
  { kind: "progress-append", usage: "task progress append <id> --text <text> [--evidence type:PATH:summary]" },
  { kind: "task-archive", usage: "task archive <id> --reason <reason> [--archived-by <actor>] [--archive-field <field>]" },
  { kind: "task-supersede", usage: "task supersede <old-id> (--title <title> [--slug <slug>] | --by <existing-task-id> --confirm <old-id>) [--reason <reason>] [--deleted-by <actor>] [--allow-open-findings]" },
  { kind: "task-delete", usage: "task delete (--soft <id> | --hard <id> --confirm <id>) --reason <reason> [--deleted-by <actor>]" },
  { kind: "task-reopen", usage: "task reopen <id> --reason <reason>" },
  { kind: "task-review", usage: "task review <id> [--reviewer <id>]", aliases: [deprecatedAlias("task-review <id>", "task review")] },
  { kind: "task-complete", usage: "task complete <id> --ci passed|failed [--reviewer <id>]", aliases: [deprecatedAlias("task-complete <id>", "task complete")] },
  { kind: "decision-list", usage: "decision list [--search <text>] [--legacy-id E<n>] [--legacy-range E<n>-E<n>] [--state <state>] [--module <key>] [--product-line <key>] [--compact] [--json]" },
  { kind: "decision-show", usage: "decision show <decision-id|E<n>> [--json]" },
  { kind: "decision-propose", usage: "decision propose --title <title> --question <text> --chosen <text> --rejected <text> --why-not <text> [--from-file <path>|--json-input <json>] [--id dec_x] [--risk-tier low|medium|high] [--urgency low|medium|high] [--module <key[,key]>] [--product-line <key[,key]>] [--proposed-by kind:id] [--arbiter kind:id] [--claim <text>] [--evidence-relation <anchor>:<type>:<task|fact-ref>:<rationale>] [--body <text>] [--dry-run] [--json]" },
  { kind: "decision-accept", usage: "decision accept <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--dry-run] [--json]" },
  { kind: "decision-reject", usage: "decision reject <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--dry-run] [--json]" },
  { kind: "decision-defer", usage: "decision defer <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--dry-run] [--json]" },
  { kind: "decision-supersede", usage: "decision supersede <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--dry-run] [--json]" },
  { kind: "decision-amend", usage: "decision amend <decision-id> [--title <title>] [--set <field>:<value>] [--append <field>:<json>] [--body <text>] [--dry-run] [--json]" },
  { kind: "decision-relate", usage: "decision relate <decision-id> --anchor <CH1|RJ1|C1> --type <relation-type> --target <entity-ref> --rationale <text> [--body <text>] [--dry-run] [--json]" },
  { kind: "decision-retire", usage: "decision retire <decision-id> [--arbiter kind:id] [--decided-at <iso>] [--dry-run] [--json]" },
  { kind: "record-fact", usage: "fact record --task <task-id> --statement <text> --source <text> [--from-file <path>|--json-input <json>] [--id F-DEADBEEF] [--confidence low|medium|high] [--memory-class semantic|episodic|procedural] [--memory-tag <tag>] [--observed-at <iso>] [--dry-run] [--json]", aliases: [deprecatedAlias("record fact --task <task-id>", "fact record")] },
  { kind: "distill-candidate", usage: "distill candidate --task <task-id> --input <path> [--json]" },
  { kind: "distill-commit", usage: "distill promote --task <task-id> --candidate <path> --claim <text> [--id F-DEADBEEF] [--confidence low|medium|high] [--memory-class semantic|episodic|procedural] [--memory-tag <tag>] [--observed-at <iso>] [--json]", aliases: [deprecatedAlias("distill commit --task <task-id>", "distill promote")] },
  { kind: "runtime-event-append", usage: "event append --session <session-id> --kind session|turn|step|tool|approval|interrupt|result|cost [--from-file <path>|--json-input <json>] [--runtime <runtime>] [--id <event-id>] [--at <iso>] [--task <task-id>] [--turn <turn-id>] [--step <step-id>] [--tool <name>] [--approval approved|rejected|timeout|unknown] [--interrupt pause|cancel|resume|append|branch|unknown] [--result started|succeeded|failed|cancelled|unknown] [--summary <text>] [--total-tokens <n>] [--json]", aliases: [deprecatedAlias("runtime-event append", "event append")] },
  { kind: "runtime-event-list", usage: "event list --session <session-id> [--json]", aliases: [deprecatedAlias("runtime-event list", "event list")] },
  { kind: "doc-list", usage: "doc list [--module <key>] [--product-line <key>] [--json]" },
  { kind: "doc-map", usage: "doc map [--module <key>] [--product-line <key>] [--json]" },
  { kind: "template-list", usage: "template list [--catalog <path>] [--json]" },
  { kind: "template-render", usage: "template render <template-ref> [--catalog <path>] [--locale zh-CN|en-US] [--json]" },
  { kind: "task-list", usage: "task list [--state <state>] [--module <key>] [--queue <queue>] [--preset <id>] [--review <state>] [--lesson [present|missing]] [--missing-materials] [--include-archived] [--search <text>] [--json]" },
  { kind: "status", usage: "status --json" },
  { kind: "check", usage: "check [--profile source-package|private-harness|target-project] [--strict] [--post-merge] [--json]" },
  { kind: "governance-rebuild", usage: "governance rebuild [--dry-run|--archive|--apply] [--json]" },
  { kind: "lesson-promote", usage: "lesson promote <task-id> <candidate-id> [--dry-run|--apply] [--json]", aliases: [deprecatedAlias("lesson-promote <task-id> <candidate-id>", "lesson promote")] },
  { kind: "lesson-sediment", usage: "lesson sediment <task-id> <candidate-id> [--dry-run] [--title <title>] [--json]", aliases: [deprecatedAlias("lesson-sediment <task-id> <candidate-id>", "lesson sediment")] },
  { kind: "adopt-multica", usage: "adopt multica <ref> --task <task-id> [--status <status>] [--title <title>] [--json]" },
  { kind: "snapshot-multica", usage: "snapshot multica <ref> [--status <status>] [--title <title>] [--json]" },
  { kind: "migrate-plan", usage: "migrate plan [--limit n] [--json]", aliases: [deprecatedAlias("migrate-plan", "migrate plan")] },
  { kind: "migrate-structure", usage: "migrate structure (--plan|--apply --confirm-plan) [--json]", aliases: [deprecatedAlias("migrate-structure", "migrate structure")] },
  { kind: "migrate-provenance", usage: "migrate provenance [--dry-run|--apply] [--json]", aliases: [deprecatedAlias("migrate-provenance", "migrate provenance")] },
  { kind: "migrate-run", usage: "migrate run [--plan-only] [--out-dir folder] [--session-dir folder] [--locale zh-CN|en-US] [--assume-locale zh-CN|en-US] [--allow-dirty] [--json]", aliases: [deprecatedAlias("migrate-run", "migrate run")] },
  { kind: "migrate-verify", usage: "migrate verify <session.json> [--json]", aliases: [deprecatedAlias("migrate-verify <session.json>", "migrate verify")] },
  { kind: "legacy-scan", usage: "legacy scan <path> [--json]" },
  { kind: "legacy-intake-plan", usage: "legacy plan <path> [--out file] [--json]", aliases: [deprecatedAlias("legacy intake-plan <path>", "legacy plan")] },
  { kind: "legacy-copy-safe-docs", usage: "legacy copy-docs <path> [--apply] [--json]", aliases: [deprecatedAlias("legacy copy-safe-docs <path>", "legacy copy-docs")] },
  { kind: "legacy-index", usage: "legacy index <path> [--apply] [--json]" },
  { kind: "legacy-verify", usage: "legacy verify [--json]" },
  { kind: "git-diff", usage: "git diff [--base <ref>] [--json]", aliases: [deprecatedAlias("git-diff", "git diff")] },
  { kind: "doctor", usage: "doctor --json" },
  { kind: "graph", usage: "graph [--out <path>] [--focus <entity-ref>] [--projection <path>] [--json]" },
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
  { kind: "script-list", usage: "script list [--source user|vertical|preset] [--purpose scaffold|generate|transform|audit] [--json]" },
  { kind: "script-inspect", usage: "script inspect <id> [--json]" },
  { kind: "script-run", usage: "script run <id> [--task <id>] [--input key=value] [--dry-run] [--json]" },
  { kind: "module-list", usage: "module list [--json]" },
  { kind: "module-inspect", usage: "module inspect <key> [--json]" },
  { kind: "module-register", usage: "module register <key> --title <title> --scope <path> [--prefix <prefix>] [--status <status>] [--branch <branch>] [--owner <owner>] [--current-step <step>] [--shared <path>] [--depends-on <module>] [--json]" },
  { kind: "module-scaffold", usage: "module scaffold <key> [--json]" },
  { kind: "module-unregister", usage: "module unregister <key> [--json]" },
  { kind: "module-step", usage: "module step <key> <step> --state <state> [--json]", aliases: [deprecatedAlias("module-step <key> <step>", "module step")] },
  { kind: "vertical-validate", usage: "vertical validate [software/coding|<path>] [--json]" },
  { kind: "gui", usage: "gui" }
] as const satisfies ReadonlyArray<CommandUsage>;

type RegisteredCommandKind = (typeof commandUsages)[number]["kind"];

const commandParserIds = {
  "help": "help",
  "version": "version",
  "entity-list": "capabilities",
  "capabilities": "capabilities",
  "init": "core-task",
  "new-task": "new-task",
  "decision-list": "decision",
  "decision-show": "decision",
  "decision-propose": "decision",
  "decision-accept": "decision",
  "decision-reject": "decision",
  "decision-defer": "decision",
  "decision-supersede": "decision",
  "decision-amend": "decision",
  "decision-relate": "decision",
  "decision-retire": "decision",
  "record-fact": "record",
  "distill-candidate": "distill",
  "distill-commit": "distill",
  "runtime-event-append": "runtime-event",
  "runtime-event-list": "runtime-event",
  "doc-list": "doc",
  "doc-map": "doc",
  "status-set": "core-task",
  "progress-append": "core-task",
  "task-archive": "core-task",
  "task-supersede": "core-task",
  "task-delete": "core-task",
  "task-reopen": "core-task",
  "task-review": "core-task",
  "task-complete": "core-task",
  "template-list": "template",
  "template-render": "template",
  "task-list": "core-task",
  "status": "status-check",
  "check": "status-check",
  "governance-rebuild": "status-check",
  "lesson-promote": "status-check",
  "lesson-sediment": "status-check",
  "adopt-multica": "migration",
  "snapshot-multica": "migration",
  "migrate-plan": "migration",
  "migrate-structure": "migration",
  "migrate-provenance": "migration",
  "migrate-run": "migration",
  "migrate-verify": "migration",
  "legacy-scan": "migration",
  "legacy-intake-plan": "migration",
  "legacy-copy-safe-docs": "migration",
  "legacy-index": "migration",
  "legacy-verify": "migration",
  "git-diff": "git-diff",
  "doctor": "doctor",
  "graph": "graph",
  "preset-validate": "preset",
  "preset-list": "preset",
  "preset-inspect": "preset",
  "preset-check": "preset",
  "preset-install": "preset",
  "preset-seed": "preset",
  "preset-audit": "preset",
  "preset-uninstall": "preset",
  "preset-run": "preset",
  "preset-action": "preset",
  "script-list": "script",
  "script-inspect": "script",
  "script-run": "script",
  "module-list": "module",
  "module-inspect": "module",
  "module-register": "module",
  "module-scaffold": "module",
  "module-unregister": "module",
  "module-step": "module",
  "vertical-validate": "vertical",
  "gui": "gui"
} as const satisfies Record<CommandKind, CommandParserId>;

const commandRunnerIds = {
  "help": "help",
  "version": "version",
  "entity-list": "capabilities",
  "capabilities": "capabilities",
  "init": "init",
  "new-task": "new-task",
  "decision-list": "decision",
  "decision-show": "decision",
  "decision-propose": "decision",
  "decision-accept": "decision",
  "decision-reject": "decision",
  "decision-defer": "decision",
  "decision-supersede": "decision",
  "decision-amend": "decision",
  "decision-relate": "decision",
  "decision-retire": "decision",
  "record-fact": "fact",
  "distill-candidate": "distill",
  "distill-commit": "distill",
  "runtime-event-append": "runtime-event",
  "runtime-event-list": "runtime-event",
  "doc-list": "doc",
  "doc-map": "doc",
  "status-set": "task-lifecycle",
  "progress-append": "task-lifecycle",
  "task-archive": "task-lifecycle",
  "task-supersede": "task-lifecycle",
  "task-delete": "task-lifecycle",
  "task-reopen": "task-lifecycle",
  "task-review": "task-gates",
  "task-complete": "task-gates",
  "template-list": "extension",
  "template-render": "extension",
  "task-list": "task-query",
  "status": "task-query",
  "check": "governance",
  "governance-rebuild": "governance",
  "lesson-promote": "governance",
  "lesson-sediment": "governance",
  "adopt-multica": "migration",
  "snapshot-multica": "migration",
  "migrate-plan": "migration",
  "migrate-structure": "migration",
  "migrate-provenance": "migration",
  "migrate-run": "migration",
  "migrate-verify": "migration",
  "legacy-scan": "migration",
  "legacy-intake-plan": "migration",
  "legacy-copy-safe-docs": "migration",
  "legacy-index": "migration",
  "legacy-verify": "migration",
  "git-diff": "diagnostics",
  "doctor": "diagnostics",
  "graph": "diagnostics",
  "preset-validate": "extension",
  "preset-list": "extension",
  "preset-inspect": "extension",
  "preset-check": "extension",
  "preset-install": "extension",
  "preset-seed": "extension",
  "preset-audit": "extension",
  "preset-uninstall": "extension",
  "preset-run": "extension",
  "preset-action": "extension",
  "script-list": "extension",
  "script-inspect": "extension",
  "script-run": "extension",
  "module-list": "extension",
  "module-inspect": "extension",
  "module-register": "extension",
  "module-scaffold": "extension",
  "module-unregister": "extension",
  "module-step": "extension",
  "vertical-validate": "extension",
  "gui": "gui"
} as const satisfies Record<CommandKind, CommandRunnerId>;

const commandSummaries = {
  "help": "Show global help or detailed help for one command.",
  "version": "Print the installed CLI version.",
  "entity-list": "List entity kinds derived from registered command descriptors.",
  "capabilities": "Describe entity operations, input schemas, shortcuts, and examples.",
  "init": "Create the harness directory layout and optional npm shortcuts.",
  "new-task": "Create a new task package, optionally through a vertical or preset.",
  "status-set": "Move a local task to a new lifecycle status.",
  "progress-append": "Append the provided text as-is to a task package, with optional evidence; no Markdown formatting or normalization is applied.",
  "task-archive": "Archive a task package while preserving its audit trail.",
  "task-supersede": "Archive old work and optionally create or link replacement work.",
  "task-delete": "Soft-delete or guarded hard-delete a task package.",
  "task-reopen": "Reopen a non-terminal archived or tombstoned task package.",
  "task-review": "Evaluate the review gate for a task package.",
  "task-complete": "Evaluate the completion gate after CI has passed or failed.",
  "decision-list": "List decision question/chosen/rejected summaries for cold-start review.",
  "decision-show": "Show one decision summary by decision id or legacy E number.",
  "decision-propose": "Create a proposed decision with optional typed evidence relations through the decision write service.",
  "decision-accept": "Accept a proposed decision through the decision write service.",
  "decision-reject": "Reject a proposed decision through the decision write service.",
  "decision-defer": "Defer a proposed decision through the decision write service.",
  "decision-supersede": "Supersede a decision through the decision write service.",
  "decision-amend": "Amend a decision without changing its lifecycle state.",
  "decision-relate": "Append a typed relation record to a decision through the relation-specific write surface.",
  "decision-retire": "Retire a decision through the decision write service.",
  "record-fact": "Record a stable task-local fact anchor through the fact write service.",
  "distill-candidate": "Create a generated distill candidate artifact without recording a fact.",
  "distill-commit": "Commit an explicit distill candidate claim through the fact write service.",
  "runtime-event-append": "Append one structured runtime event to the local JSONL event ledger.",
  "runtime-event-list": "Read structured runtime events for one session from the local JSONL ledger.",
  "doc-list": "List canonical documents declared in the docmap manifest.",
  "doc-map": "Compute the docmap minimum read set for a module or product line.",
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
  "migrate-provenance": "Backfill explicit synthetic provenance into pre-R2 task packages.",
  "migrate-run": "Run the legacy migration pipeline into a session directory.",
  "migrate-verify": "Verify a legacy migration session file.",
  "legacy-scan": "Scan a legacy source tree for migration candidates.",
  "legacy-intake-plan": "Create an intake plan for a legacy source tree.",
  "legacy-copy-safe-docs": "Copy safe legacy documents into the harness workspace.",
  "legacy-index": "Build or apply the legacy task index.",
  "legacy-verify": "Verify legacy migration readiness and generated state.",
  "git-diff": "Capture git diff evidence against a base ref.",
  "doctor": "Report read-only local environment and harness diagnostics.",
  "graph": "Generate a self-contained relation graph HTML panorama from the SQLite projection, with optional F5 cascade focus.",
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
  "script-list": "List script-entry/v1 entries exposed by installed extensions.",
  "script-inspect": "Inspect one script-entry/v1 contract.",
  "script-run": "Run one script-entry/v1 entry through the ScriptHost permission boundary.",
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
  "help": [`${cliCommandName} help task create`],
  "version": [`${cliCommandName} version`],
  "entity-list": [`${cliCommandName} entity list --json`],
  "capabilities": [`${cliCommandName} decision capabilities --json`],
  "init": [`${cliCommandName} init --name my-project --add-npm-scripts`],
  "new-task": [`${cliCommandName} task create --title "Normalize CLI help" --vertical software/coding --preset standard-task`],
  "status-set": [`${cliCommandName} task transition task_01ABC active --reason "work started"`],
  "progress-append": [`${cliCommandName} task progress append task_01ABC --text "Implemented parser guard" --evidence log:artifacts/check.log:passed`],
  "task-archive": [`${cliCommandName} task archive task_01ABC --reason "merged"`],
  "task-supersede": [`${cliCommandName} task supersede task_01OLD --title "Replacement task" --reason "scope changed"`],
  "task-delete": [`${cliCommandName} task delete --soft task_01ABC --reason "duplicate"`],
  "task-reopen": [`${cliCommandName} task reopen task_01ABC --reason "follow-up needed"`],
  "task-review": [`${cliCommandName} task review task_01ABC --reviewer reviewer-id`],
  "task-complete": [`${cliCommandName} task complete task_01ABC --ci passed --reviewer reviewer-id`],
  "decision-list": [`${cliCommandName} decision list --state active --module m5-circulation --legacy-range E1-E71 --compact --json`],
  "decision-show": [`${cliCommandName} decision show E72 --json`],
  "decision-propose": [`${cliCommandName} decision propose --title "Adopt CLI decision loop" --question "Should M3 expose decision CLI?" --chosen "Expose it" --rejected "Keep write API only" --why-not "No human fallback path" --evidence-relation C1:supports:fact/task_01ABC/F-1234ABCD:"Evidence covers C1."`],
  "decision-accept": [`${cliCommandName} decision accept dec_01ABC --arbiter human:ZeyuLi`],
  "decision-reject": [`${cliCommandName} decision reject dec_01ABC --arbiter human:ZeyuLi`],
  "decision-defer": [`${cliCommandName} decision defer dec_01ABC --arbiter human:ZeyuLi`],
  "decision-supersede": [`${cliCommandName} decision supersede dec_01ABC --arbiter human:ZeyuLi`],
  "decision-amend": [`${cliCommandName} decision amend dec_01ABC --set title:"Updated title"`],
  "decision-relate": [`${cliCommandName} decision relate dec_01ABC --anchor CH1 --type supersedes --target decision/dec_00XYZ --rationale "Newer decision supersedes the old storage claim."`],
  "decision-retire": [`${cliCommandName} decision retire dec_01ABC --arbiter human:ZeyuLi`],
  "record-fact": [`${cliCommandName} fact record --task task_01ABC --statement "CLI fallback passed" --source "manual verification" --confidence high`],
  "distill-candidate": [`${cliCommandName} distill candidate --task task_01ABC --input artifacts/transcript.md --json`],
  "distill-commit": [`${cliCommandName} distill promote --task task_01ABC --candidate .harness/generated/distill/task_01ABC/distill_123.json --claim "Distilled claim" --memory-class semantic`],
  "runtime-event-append": [`${cliCommandName} event append --session codex-session-1 --kind interrupt --runtime codex --interrupt append --summary "User appended task guidance"`],
  "runtime-event-list": [`${cliCommandName} event list --session codex-session-1 --json`],
  "doc-list": [`${cliCommandName} doc list --module m4-loadbearing --json`],
  "doc-map": [`${cliCommandName} doc map --module m4-loadbearing --product-line kernel --json`],
  "template-list": [`${cliCommandName} template list --json`],
  "template-render": [`${cliCommandName} template render template://planning/task@1 --locale zh-CN`],
  "task-list": [`${cliCommandName} task list --state active --module kernel --review missing`],
  "status": [`${cliCommandName} status --json`],
  "check": [`${cliCommandName} check --profile target-project --strict`],
  "governance-rebuild": [`${cliCommandName} governance rebuild --dry-run`],
  "lesson-promote": [`${cliCommandName} lesson promote task_01ABC candidate-1 --apply`],
  "lesson-sediment": [`${cliCommandName} lesson sediment task_01ABC candidate-1 --title "CLI help lesson"`],
  "adopt-multica": [`${cliCommandName} adopt multica EXT-123 --task task_01ABC --status active --title "External task"`],
  "snapshot-multica": [`${cliCommandName} snapshot multica EXT-123 --json`],
  "migrate-plan": [`${cliCommandName} migrate plan --limit 20`],
  "migrate-structure": [`${cliCommandName} migrate structure --plan`],
  "migrate-provenance": [`${cliCommandName} migrate provenance --dry-run`],
  "migrate-run": [`${cliCommandName} migrate run --plan-only --session-dir migration-session --locale zh-CN`],
  "migrate-verify": [`${cliCommandName} migrate verify migration-session/session.json`],
  "legacy-scan": [`${cliCommandName} legacy scan .harness-private/legacy --json`],
  "legacy-intake-plan": [`${cliCommandName} legacy plan .harness-private/legacy --out intake-plan.json`],
  "legacy-copy-safe-docs": [`${cliCommandName} legacy copy-docs .harness-private/legacy --apply`],
  "legacy-index": [`${cliCommandName} legacy index .harness-private/legacy --apply`],
  "legacy-verify": [`${cliCommandName} legacy verify --json`],
  "git-diff": [`${cliCommandName} git diff --base origin/main --json`],
  "doctor": [`${cliCommandName} doctor --json`],
  "graph": [`${cliCommandName} graph --focus decision/dec_LEDGER_E51 --out .harness/generated/graph-panorama/index.html --json`],
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
  "script-list": [`${cliCommandName} script list --source preset`],
  "script-inspect": [`${cliCommandName} script inspect preset:publish-standard:scaffold`],
  "script-run": [`${cliCommandName} script run preset:publish-standard:scaffold --task task_01ABC --input mode=smoke`],
  "module-list": [`${cliCommandName} module list --json`],
  "module-inspect": [`${cliCommandName} module inspect kernel`],
  "module-register": [`${cliCommandName} module register kernel --title "Kernel" --scope "packages/kernel/**"`],
  "module-scaffold": [`${cliCommandName} module scaffold kernel`],
  "module-unregister": [`${cliCommandName} module unregister kernel`],
  "module-step": [`${cliCommandName} module step kernel KR-01 --state done`],
  "vertical-validate": [`${cliCommandName} vertical validate software/coding`],
  "gui": [`${cliCommandName} gui`]
} satisfies Record<CommandKind, ReadonlyArray<string>>;


export interface CommandDescriptor extends CommandUsage {
  readonly parserId: CommandParserId;
  readonly runnerId: CommandRunnerId;
  readonly summary: string;
  readonly examples: ReadonlyArray<string>;
  readonly receiptContract: CommandReceiptContract;
}

export const commandDescriptors = commandUsages.map((entry) => ({
  ...entry,
  parserId: commandParserIds[entry.kind],
  runnerId: commandRunnerIds[entry.kind],
  summary: commandSummaries[entry.kind],
  examples: commandExamples[entry.kind],
  receiptContract: commandReceiptContractsByKind[entry.kind]
})) satisfies ReadonlyArray<CommandDescriptor>;

export const commandReceiptContracts = commandDescriptors.map((entry) => ({
  kind: entry.kind,
  ...entry.receiptContract
}));

export const commandRegistry = commandDescriptors.map((entry) => {
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
    summary: entry.summary,
    options: optionsFromUsage(entry.usage),
    examples: entry.examples,
    resultEnvelope: commandReceiptEnvelope
  };
}) satisfies ReadonlyArray<CommandRegistryEntry>;

export function commandKindsForParser(parserId: CommandParserId): ReadonlyArray<RegisteredCommandKind> {
  return commandDescriptors
    .filter((entry) => entry.parserId === parserId)
    .map((entry) => entry.kind);
}

export function findCommandDescriptorByKind(kind: string): CommandDescriptor | undefined {
  return commandDescriptors.find((entry) => entry.kind === kind);
}

export function runnerIdForAction(kind: CommandKind): CommandRunnerId {
  const descriptor = findCommandDescriptorByKind(kind);
  if (!descriptor) {
    throw new Error(`missing command descriptor for action kind: ${kind}`);
  }
  return descriptor.runnerId;
}

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
  const aliasExact = commandRegistry.find((entry) => entry.aliases.some((alias) => samePath(aliasPathFromDisplay(alias), tokens)));
  if (aliasExact) return { kind: "command", entry: aliasExact };

  const prefixMatches = commandRegistry.filter((entry) => isPrefix(tokens, entry.commandPath) || entry.aliases.some((alias) => isPrefix(tokens, aliasPathFromDisplay(alias))));
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

function aliasPathFromDisplay(alias: string): ReadonlyArray<string> {
  const withoutBinary = alias
    .replace(/^harness-anything\s+/u, "")
    .replace(/^ha\s+/u, "");
  const withoutDeprecation = withoutBinary.replace(/\s+\(deprecated,.*$/u, "");
  return commandPathFromUsage(withoutDeprecation);
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
