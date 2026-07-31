import type { CommandDisplayTier, CommandOptionDefinition } from "./types.ts";

export interface CommandGroupDefinition {
  readonly name: string;
  readonly summary: string;
  readonly display: CommandDisplayTier;
  readonly primaryWorkflow?: ReadonlyArray<string>;
}

export const globalCommandOptions = [
  { flag: "--root DIR", description: "Use DIR as the harness repository root." },
  { flag: "--json", description: "Emit machine-readable JSON." }
] as const satisfies ReadonlyArray<CommandOptionDefinition>;

export const commandGroups = [
  group("adopt", "Bind external snapshots to local tasks.", [
    "ha external snapshot multica <ref> --json",
    "ha adopt multica <ref> --task <task-id>"
  ]),
  group("audit", "Inspect execution provenance coverage.", [
    "ha audit provenance --task <task-id> --json"
  ]),
  group("authority", "Manage authority cutover controls.", [
    "ha authority cutover status --json",
    "ha authority cutover drain --json",
    "ha authority cutover scan --json",
    "ha authority cutover confirm --first-scan <id> --second-scan <id> --json",
    "ha authority cutover boundary --id <id> --equality <receipt-id> --expected-v2-tuple-digest <sha256> --json"
  ]),
  group("capabilities", "Describe machine-readable command schemas."),
  group("cas", "Inspect and reclaim content-addressed objects.", [
    "ha cas gc --json",
    "ha cas gc --apply --json"
  ]),
  group("check", "Run harness health checks."),
  group("completion", "Generate shell completion scripts.", [
    "ha completion <bash|zsh>"
  ]),
  group("daemon", "Manage the persistent local daemon."),
  group("decision", "Read and govern decisions.", [
    "ha decision list --compact --json",
    "ha decision propose --from-file decision.json",
    "ha decision transition active <decision-id>",
    "ha decision show <decision-id> --json"
  ]),
  group("diagnostics", "Analyze command usage and failures.", [
    "ha diagnostics command-usage --json"
  ]),
  group("distill", "Distill task evidence into facts.", [
    "ha distill candidate --task <task-id> --input <path>",
    "ha distill promote --task <task-id> --candidate <path> --claim <text>"
  ]),
  group("doc", "Inspect and synchronize governed prose.", [
    "ha doc status --json",
    "ha doc sync --dry-run --json",
    "ha doc sync --submit --json"
  ]),
  group("doctor", "Diagnose the local environment."),
  group("entity", "List registered entity kinds.", [
    "ha entity list --json"
  ]),
  group("event", "Record and inspect runtime events.", [
    "ha event append --session <session-id> --kind <kind> --from-file event.json",
    "ha event list --session <session-id> --json"
  ]),
  group("execution", "Inspect task execution rounds.", [
    "ha execution list --task <task-id> --json",
    "ha execution show <execution-id> --json"
  ]),
  group("external", "Read external provider snapshots.", [
    "ha external list github <owner/repo> --json",
    "ha external snapshot <github|multica> <ref> --json"
  ]),
  group("fact", "Read and record factual evidence.", [
    "ha fact record --task <task-id> --statement <text>",
    "ha fact list --task <task-id> --json",
    "ha fact show --task <task-id> --id <fact-id> --json"
  ]),
  group("git", "Capture Git diff evidence.", [
    "ha git diff --json"
  ]),
  group("governance", "Rebuild governance projections.", [
    "ha governance rebuild --dry-run --json",
    "ha governance rebuild --apply --json"
  ]),
  group("graph", "Generate relation graph panoramas.", [
    "ha graph --json"
  ]),
  group("gui", "Launch the desktop controller."),
  group("help", "Show CLI discovery help."),
  group("init", "Initialize a harness workspace."),
  group("legacy", "Intake legacy harness content.", [
    "ha legacy scan <path> --json",
    "ha legacy plan <path> --json",
    "ha legacy index <path> --apply --json",
    "ha legacy copy-docs <path> --apply --json",
    "ha legacy verify --json"
  ]),
  group("materializer", "Merge session ledger branches.", [
    "ha materializer run --dry-run --json",
    "ha materializer run --json"
  ]),
  group("migrate", "Run compatibility migrations.", [
    "ha migrate plan --json",
    "ha migrate run --plan-only --json",
    "ha migrate run --json",
    "ha migrate verify <session.json> --json"
  ]),
  group("module", "Manage project modules.", [
    "ha module list --json",
    "ha module inspect <key> --json",
    "ha module register <key> --title <title> --scope <path>",
    "ha module scaffold <key>"
  ]),
  group("preset", "Manage executable presets.", [
    "ha preset list --json",
    "ha preset inspect <id> --json",
    "ha preset check <id> --json",
    "ha preset entrypoint <id> <name> --task <task-id>"
  ]),
  group("relation", "Inspect projected relations.", [
    "ha relation list --entity <entity-ref> --json"
  ]),
  group("review", "Inspect execution reviews.", [
    "ha review show <review-id> --json"
  ]),
  group("script", "Discover and run extension scripts.", [
    "ha script list --json",
    "ha script inspect <id> --json",
    "ha script run <id> --dry-run --json",
    "ha script run <id> --json"
  ]),
  group("session", "Inspect and export sessions.", [
    "ha session show <session-id> --view summary --json",
    "ha session export --session <session-id> --runtime <runtime> --json"
  ]),
  group("status", "Summarize harness state."),
  group("task", "Manage task lifecycle and evidence.", [
    "ha task create --title \"<title>\"",
    "ha task start <task-id>",
    "ha task progress append <task-id> --text \"<update>\"",
    "ha task submit <task-id> --from-file submission.json",
    "ha task complete <task-id> --approve --from-file approval.json"
  ]),
  group("template", "List and render templates.", [
    "ha template list --json",
    "ha template render <template-ref> --json"
  ]),
  group("version", "Print the CLI version."),
  group("vertical", "Validate vertical definitions.", [
    "ha vertical validate [software/coding|<path>] --json"
  ]),
  group("worktree", "Manage task implementation worktrees.", [
    "ha worktree create --task <task-id> --json",
    "ha worktree status --task <task-id> --json"
  ])
] as const satisfies ReadonlyArray<CommandGroupDefinition>;

function group(name: string, summary: string, primaryWorkflow?: ReadonlyArray<string>): CommandGroupDefinition {
  return { name, summary, display: "default", ...(primaryWorkflow ? { primaryWorkflow } : {}) };
}
