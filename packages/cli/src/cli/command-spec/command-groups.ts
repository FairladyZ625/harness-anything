import type { CommandDisplayTier, CommandOptionDefinition } from "./types.ts";

export interface CommandGroupDefinition {
  readonly name: string;
  readonly summary: string;
  readonly display: CommandDisplayTier;
}

export const globalCommandOptions = [
  { flag: "--json", description: "Emit machine-readable JSON." }
] as const satisfies ReadonlyArray<CommandOptionDefinition>;

export const commandGroups = [
  group("adopt", "Bind external snapshots to local tasks."),
  group("audit", "Inspect execution provenance coverage."),
  group("authority", "Manage authority cutover controls."),
  group("capabilities", "Describe machine-readable command schemas."),
  group("check", "Run harness health checks."),
  group("completion", "Generate shell completion scripts."),
  group("daemon", "Manage the persistent local daemon."),
  group("decision", "Read and govern decisions."),
  group("diagnostics", "Analyze command usage and failures."),
  group("distill", "Distill task evidence into facts."),
  group("doc", "Inspect and synchronize governed prose."),
  group("doctor", "Diagnose the local environment."),
  group("entity", "List registered entity kinds."),
  group("event", "Record and inspect runtime events."),
  group("execution", "Inspect task execution rounds."),
  group("fact", "Read and record factual evidence."),
  group("git", "Capture Git diff evidence."),
  group("governance", "Rebuild governance projections."),
  group("graph", "Generate relation graph panoramas."),
  group("gui", "Launch the desktop controller."),
  group("help", "Show CLI discovery help."),
  group("init", "Initialize a harness workspace."),
  group("legacy", "Intake legacy harness content."),
  group("lesson", "Promote and sediment lessons."),
  group("list", "List external issue snapshots."),
  group("materializer", "Merge session ledger branches."),
  group("migrate", "Run compatibility migrations."),
  group("module", "Manage project modules."),
  group("preset", "Manage executable presets."),
  group("relation", "Inspect projected relations."),
  group("review", "Inspect execution reviews."),
  group("script", "Discover and run extension scripts."),
  group("session", "Inspect and export sessions."),
  group("snapshot", "Read external issue snapshots."),
  group("status", "Summarize harness state."),
  group("task", "Manage task lifecycle and evidence."),
  group("template", "List and render templates."),
  group("version", "Print the CLI version."),
  group("vertical", "Validate vertical definitions."),
  group("worktree", "Manage task implementation worktrees.")
] as const satisfies ReadonlyArray<CommandGroupDefinition>;

function group(name: string, summary: string): CommandGroupDefinition {
  return { name, summary, display: "default" };
}
