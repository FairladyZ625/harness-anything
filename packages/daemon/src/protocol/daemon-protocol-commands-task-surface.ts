import {
  defineCenterForwardWriteCommand,
  cliInput,
  defineLedgerWriteCommand,
  defineRepoReadCommand,
} from "../../../preset/src/preset-command-contract.ts";

export const taskSurfaceProtocolCommands = Object.freeze([
  defineRepoReadCommand({
    id: "task-dispatches",
    phase: "Runtime-B",
    path: ["task", "dispatches", "<task-id>"],
    summary: "List current and historical runtime dispatches associated with a Task.",
    method: "repo.task.dispatches",
    inputs: [],
  }),
  defineCenterForwardWriteCommand({
    id: "task-release",
    actionAliases: ["task-fallback-exhausted"],
    phase: "W3",
    path: ["task", "release", "<task-id>"],
    summary: "Release the authenticated holder lease and preserve the Execution audit trail.",
    method: "repo.task.run",
    inputs: [
      cliInput("--reason", "single", false, {
        code: "invalid_field",
        nextAction: "Use one non-empty --reason, or omit it for the standard release audit.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-declare-executor",
    phase: "W3",
    path: ["task", "declare-executor", "<task-id>"],
    summary: "Auditably declare the agent executor omitted from a submitted Execution at the review node.",
    method: "repo.task.run",
    inputs: [
      cliInput("--execution-id", "single", false, {
        code: "invalid_field",
        nextAction: "Pass --execution-id <execution-id> only when the daemon cannot derive a unique candidate.",
      }),
      cliInput("--reason", "single", true, {
        code: "missing_field",
        nextAction: "Add --reason <auditable-recovery-reason>.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-transition",
    phase: "W3",
    path: ["task", "transition", "<task-id>", "<planned|active|blocked|in_review|done|cancelled>"],
    summary: "Move lifecycle status; done and in_review remain reserved for complete and submit.",
    method: "repo.task.run",
    inputs: [
      cliInput("--force", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --force only for audited cancellation.",
      }),
      cliInput("--reason", "single", false, {
        code: "missing_field",
        nextAction:
          "Forced cancellation requires --reason <auditable-reason>; direct done still requires task complete.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-amend",
    phase: "W3",
    path: ["task", "amend", "<task-id>"],
    summary: "Amend declared task prose or metadata without changing lifecycle authority.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--set",
        "repeated",
        true,
        {
          code: "invalid_field",
          nextAction: "Use --set <title|parentTaskId|workKind|riskTier|urgency|moduleKey|taskClass|pinned>:<value>.",
        },
        { regex: "^[A-Za-z][A-Za-z0-9]*:.+$" },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-pin",
    phase: "W3",
    path: ["task", "pin", "<task-id>"],
    summary: "Pin a task to the front of its agenda group.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "task-unpin",
    phase: "W3",
    path: ["task", "unpin", "<task-id>"],
    summary: "Remove a task pin so its agenda group uses the standard order.",
    method: "repo.task.run",
    inputs: [],
  }),
  defineLedgerWriteCommand({
    id: "task-contract-migrate",
    phase: "W3",
    path: ["task", "contract", "migrate"],
    summary: "Plan or apply deterministic Task contract backfills; ambiguous Tasks remain manual.",
    method: "repo.task.run",
    inputs: [
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
        nextAction: "Choose exactly one of --dry-run or --apply.",
      }),
      cliInput("--apply", "boolean", false, {
        code: "invalid_field",
        nextAction: "Choose exactly one of --dry-run or --apply.",
      }),
      cliInput("--task", "single", false, {
        code: "invalid_field",
        nextAction: "Use one existing task id with --task.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-archive",
    phase: "W3",
    path: ["task", "archive", "[<task-id>]"],
    summary: "Archive selected Task packages while retaining their evidence and lifecycle history.",
    method: "repo.task.run",
    inputs: [
      cliInput("--ids", "single", false, {
        code: "invalid_field",
        nextAction: "Use comma-separated task ids, or select one positional id.",
      }),
      cliInput(
        "--filter",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use --filter state:<status>." },
        {
          regex: "^state:(?:planned|active|blocked|in_review|done|cancelled)$",
        },
      ),
      cliInput("--before", "single", false, {
        code: "invalid_field",
        nextAction: "Use an ISO-compatible date with --before.",
      }),
      cliInput("--reason", "single", true, {
        code: "missing_field",
        nextAction: "Add --reason <auditable-reason>.",
      }),
      cliInput("--archived-by", "single", false, {
        code: "invalid_field",
        nextAction: "Use one non-empty actor id for --archived-by.",
      }),
      cliInput("--archive-field", "single", false, {
        code: "invalid_field",
        nextAction: "Use one declared archive field.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-supersede",
    phase: "W3",
    path: ["task", "supersede", "<old-task-id>"],
    summary: "Archive old work and preserve an explicit replacement lineage.",
    method: "repo.task.run",
    inputs: [
      cliInput("--title", "single", false, {
        code: "invalid_field",
        nextAction: "Choose --title for new work or --by for an existing replacement, not both.",
      }),
      cliInput(
        "--slug",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use a lowercase kebab-case slug with --title.",
        },
        { regex: "^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$" },
      ),
      cliInput("--by", "single", false, {
        code: "invalid_field",
        nextAction: "Choose --title or --by; existing replacements also require matching --confirm.",
      }),
      cliInput("--confirm", "single", false, {
        code: "invalid_field",
        nextAction: "With --by, pass --confirm <old-task-id>.",
      }),
      cliInput("--reason", "single", false, {
        code: "invalid_field",
        nextAction: "Use one non-empty auditable reason.",
      }),
      cliInput("--deleted-by", "single", false, {
        code: "invalid_field",
        nextAction: "Use one non-empty actor id for --deleted-by.",
      }),
      cliInput("--allow-open-findings", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --allow-open-findings once after reviewing unresolved findings.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-delete",
    phase: "W3",
    path: ["task", "delete"],
    summary: "Soft-delete through production authority; hard delete remains rejected with a repair path.",
    method: "repo.task.run",
    inputs: [
      cliInput("--soft", "single", false, {
        code: "invalid_field",
        nextAction: "Choose exactly one of --soft <task-id> or --hard <task-id>.",
      }),
      cliInput("--hard", "single", false, {
        code: "invalid_field",
        nextAction: "Production rejects hard delete; select the exact task only to receive the governed repair.",
      }),
      cliInput("--confirm", "single", false, {
        code: "invalid_field",
        nextAction: "Local hard-delete compatibility requires matching --confirm, but production will still reject it.",
      }),
      cliInput("--reason", "single", false, {
        code: "missing_field",
        nextAction: "Soft delete requires --reason <auditable-reason>.",
      }),
      cliInput("--deleted-by", "single", false, {
        code: "invalid_field",
        nextAction: "Use one non-empty actor id for --deleted-by.",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-reopen",
    phase: "W3",
    path: ["task", "reopen", "<task-id>"],
    summary: "Reopen a nonterminal archived or tombstoned Task package.",
    method: "repo.task.run",
    inputs: [
      cliInput("--reason", "single", true, {
        code: "missing_field",
        nextAction: "Add --reason <auditable-reason>; terminal Tasks require supersede.",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "task-review",
    phase: "W3",
    path: ["task", "review", "<task-id>"],
    summary: "Lint the legacy review contract without approving completion.",
    method: "repo.task.run",
    inputs: [
      cliInput("--reviewer", "single", false, {
        code: "invalid_field",
        nextAction: "Use one non-empty reviewer id.",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "task-list",
    phase: "W3",
    path: ["task", "list"],
    summary: "List Task projection rows with canonical lifecycle and metadata filters.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--status",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use planned, active, blocked, in_review, done, or cancelled.",
        },
        {
          enum: ["planned", "active", "blocked", "in_review", "done", "cancelled"],
        },
      ),
      cliInput("--module", "single", false, {
        code: "invalid_field",
        nextAction: "Use one module key.",
      }),
      cliInput("--search", "single", false, {
        code: "invalid_field",
        nextAction: "Use a non-empty title or task-id search.",
      }),
      cliInput(
        "--kind",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use feat, fix, refactor, docs, test, or chore.",
        },
        { enum: ["feat", "fix", "refactor", "docs", "test", "chore"] },
      ),
      cliInput(
        "--risk-tier",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use low, medium, or high." },
        { enum: ["low", "medium", "high"] },
      ),
      cliInput(
        "--urgency",
        "single",
        false,
        { code: "invalid_field", nextAction: "Use low, medium, or high." },
        { enum: ["low", "medium", "high"] },
      ),
      cliInput("--parent", "single", false, {
        code: "invalid_field",
        nextAction: "Use one parent task id.",
      }),
    ],
  }),
  defineRepoReadCommand({
    id: "relation-list",
    phase: "W3",
    path: ["relation", "list"],
    summary: "Query Task, Decision, and Fact relation edges from the converged projection.",
    method: "repo.task.run",
    inputs: [
      cliInput("--entity", "single", false, {
        code: "invalid_field",
        nextAction: "Use task/<id>, decision/<id>, or fact/<task>/<id>.",
      }),
      cliInput("--source", "single", false, {
        code: "invalid_field",
        nextAction: "Use a canonical entity ref for --source.",
      }),
      cliInput("--target", "single", false, {
        code: "invalid_field",
        nextAction: "Use a canonical entity ref for --target.",
      }),
      cliInput("--type", "single", false, {
        code: "invalid_field",
        nextAction: "Use a declared relation type.",
      }),
      cliInput(
        "--state",
        "single",
        false,
        {
          code: "invalid_field",
          nextAction: "Use active, edge_retired, or deleted.",
        },
        { enum: ["active", "edge_retired", "deleted"] },
      ),
    ],
  }),
  defineLedgerWriteCommand({
    id: "task-relate",
    phase: "W3",
    path: ["task", "relate", "<source-task-id>", "depends-on", "<target-task-id>"],
    summary: "Declare a cycle-checked depends-on edge owned by the source Task.",
    method: "repo.task.run",
    inputs: [
      cliInput("--rationale", "single", true, {
        code: "missing_field",
        nextAction: "Add --rationale <why-this-dependency-is-required>.",
      }),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
        nextAction: "Use --dry-run once to preview the edge.",
      }),
    ],
  }),
] as const);
