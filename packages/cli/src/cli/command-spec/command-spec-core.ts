import { defineCommandSpecs, type CommandReceiptContract } from "./types.ts";
import { writeCommandEventPolicy } from "./command-event-policies.ts";
import { parseCapabilitiesArgs } from "../parsers/capabilities.ts";
import { parseCoreTaskArgs } from "../parsers/core-task.ts";
import { parseHelpArgs, parseVersionArgs } from "../parsers/meta.ts";
import { parseNewTaskArgs } from "../parsers/new-task.ts";
import { runCapabilitiesCommand } from "../../commands/core/capabilities.ts";
import { runHelpCommand } from "../../commands/core/help.ts";
import { runInitCommand } from "../../commands/core/init.ts";
import { runNewTaskCommand } from "../../commands/core/new-task.ts";
import { runTaskGatesCommand } from "../../commands/core/task-gates.ts";
import { runDocCommand } from "../../commands/core/doc.ts";
import { runTaskLifecycleWithDemotions as runTaskLifecycleCommand } from "../../commands/core/task-lifecycle-demotions.ts";
import { runTaskContractMigration } from "../../commands/core/task-contract-migrate.ts";
import { runVersionCommand } from "../../commands/core/version.ts";
import { rejectDaemonTaskLifecycleFacade } from "../../commands/core/task-lifecycle-facade.ts";

const taskCompletionReceiptContract = {
  data: ["taskId", "status", "completionGate"],
  optionalData: {
    report: "Only emitted for completion paths that surface a review or gate report; clean completion emits reviewContract and completionGate.",
    executionId: "Only emitted when completion accepts a submitted Execution.",
    completionEvidence: "Only emitted when completion accepts an immutable commit-anchor judgment record.",
    reviewContract: "Compatibility-only legacy review.md gate evidence; it never authorizes completion.",
    authorityOutcome: "Only emitted when the production authority reports an already-satisfied replay.",
    repoWrite: "Only emitted when the production daemon child includes its durable writer outcome."
  },
  paths: [],
  successNext: { kind: "none" },
  dryRun: {
    data: ["taskId", "status", "completionGate", "report"],
    paths: [],
    successNext: { kind: "none" }
  }
} satisfies CommandReceiptContract;

export const coreCommandSpecs = defineCommandSpecs([
  {
    "kind": "help",
    "usage": "help",
    "options": [],
    "aliases": ["--help", "-h"],
    "summary": "Show global help or detailed help for one command.",
    "examples": ["harness-anything help task create"],
    "parse": parseHelpArgs,
    "run": runHelpCommand,
    "receiptContract": {
      "data": ["commands", "report"],
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "version",
    "usage": "version",
    "options": [],
    "aliases": ["--version", "-v"],
    "summary": "Print the installed CLI version.",
    "examples": ["harness-anything version"],
    "parse": parseVersionArgs,
    "run": runVersionCommand,
    "receiptContract": {
      "data": ["version"],
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "entity-list",
    "usage": "entity list [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List entity kinds derived from registered command descriptors.",
    "examples": ["harness-anything entity list --json"],
    "parse": parseCapabilitiesArgs,
    "run": runCapabilitiesCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "capabilities",
    "usage": "capabilities [--kind <entity-kind>] [--json]",
    "options": [{"flag":"--kind","description":"Filter capabilities by entity kind."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Describe entity operations, input schemas, shortcuts, and examples.",
    "examples": ["harness-anything decision capabilities --json"],
    "parse": parseCapabilitiesArgs,
    "run": runCapabilitiesCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "init",
    "usage": "init [--name <name>] [--add-npm-scripts]",
    "options": [{"flag":"--name","description":"Set the project name written to harness.yaml."},{"flag":"--add-npm-scripts","description":"Add npm script shortcuts during initialization."}],
    "summary": "Create the harness directory layout and optional npm shortcuts.",
    "examples": ["harness-anything init --name my-project --add-npm-scripts"],
    "parse": parseCoreTaskArgs,
    "run": runInitCommand,
    "receiptContract": {
      "data": ["generated", "report"],
      "paths": ["primary", "config"],
      "successNext": {
        kind: "actions",
        "actions": [{
          "command": "ha task create --title <title>",
          "description": "The harness layout is ready; create the first task when there is concrete work to track."
        }]
      },
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "new-task",
    "usage": "task create --title <title> [--idempotency-key <key>] [--parent <task-id>] [--kind feat|fix|refactor|docs|test|chore] [--risk-tier low|medium|high] [--urgency low|medium|high] [--from-file <path>|--json-input <json>] [--vertical software/coding --preset <id> --module <key>] [--register-module <key> --module-title <title> --module-scope <path>] [--surface <token>]... [--long-running] [--dry-run] [--locale zh-CN|en-US] [--from-legacy <legacy-id>] [--json]",
    "options": [{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--idempotency-key","description":"Repeat a stable caller key to reuse the existing task package instead of creating another one."},{"flag":"--parent","description":"Bind a new task to an existing parent task id."},{"flag":"--kind","description":"Set task work kind: feat, fix, refactor, docs, test, or chore."},{"flag":"--risk-tier","description":"Set task risk tier: low, medium, or high."},{"flag":"--urgency","description":"Set task urgency: low, medium, or high."},{"flag":"--from-file","description":"Read command input JSON from a file; flags remain shortcut overrides."},{"flag":"--json-input","description":"Read command input JSON from an inline string; flags remain shortcut overrides."},{"flag":"--vertical","description":"Select a vertical definition; task create defaults to software/coding."},{"flag":"--preset","description":"Select a preset id; task create defaults to standard-task and preset list shows installed presets."},{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--register-module","description":"Register a module while creating the task."},{"flag":"--module-title","description":"Set the human-readable title for a registered module."},{"flag":"--module-scope","description":"Set the registered module source scope, such as packages/name/**."},{"flag":"--surface","description":"Declare a command, flag, file path, or identifier to search in existing decisions; repeat as needed and use --surface=--flag for flag-shaped values."},{"flag":"--long-running","description":"Mark the task as long-running."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--locale","description":"Set generated content locale."},{"flag":"--from-legacy","description":"Create from a legacy task id."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["new-task --title <title> (deprecated, use task create; retires at E77/F6 acceptance)"],
    "aliasDisplay": {"new-task --title <title> (deprecated, use task create; retires at E77/F6 acceptance)":"hidden"},
    "summary": "Create a new task package, optionally through a vertical or preset.",
    "examples": ["harness-anything task create --title \"Normalize CLI help\" --parent task_01ABC --vertical software/coding --preset standard-task --surface long-running-task"],
    "parse": parseNewTaskArgs,
    "run": runNewTaskCommand,
    "receiptContract": {
      "data": ["taskId", "slug", "status"],
      "optionalData": {
        "preset": "Only emitted when task creation runs through a selected preset.",
        "module": "Only emitted when --module is supplied or preset/module routing materializes module metadata.",
        "generated": "Only emitted when preset or template materialization produces generated files.",
        "report": "Only emitted when the creation path produces a structured creation report."
      },
      "paths": ["package"],
      "successNext": {
        kind: "actions",
        "actions": [{
          "command": "ha task start {taskId}",
          "description": "Write {packagePath}/task_plan.md with the deliverable, starting points, protected boundaries, stop conditions, and verification; then start the task."
        }]
      },
      "dryRun": {
        "data": ["taskId", "slug", "status"],
        "optionalData": {
          "preset": "Only emitted when task creation runs through a selected preset.",
          "module": "Only emitted when --module is supplied or preset/module routing materializes module metadata.",
          "generated": "Only emitted when preset or template materialization produces generated files.",
          "report": "Only emitted when the creation path produces a structured creation report."
        },
        "paths": ["package"],
        "successNext": { kind: "none" }
      }
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-claim",
    "display": "advanced",
    "usage": "task claim <id> [--execution] [--execution-id <execution-id>] [--ttl-ms <ms>] [--json]",
    "options": [{"flag":"--execution","description":"Use the Execution claim path; the sole active round is reused instead of opening a duplicate."},{"flag":"--execution-id","description":"Select the active Execution to resume when legacy state contains multiple active rounds."},{"flag":"--ttl-ms","description":"Set the task holder lease duration in milliseconds."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Deprecated compatibility spelling for task start; claim activates planned tasks and always uses an Execution lease.",
    "examples": ["harness-anything task claim task_01ABC --ttl-ms 86400000", "harness-anything task claim task_01ABC --execution --json", "harness-anything task claim task_01ABC --execution-id exe_01ABC --json"],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId", "status", "report"],
      "optionalData": { "executionId": "Only emitted when a work claim opens a Holder V2 Execution round." },
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-start",
    "usage": "task start <id> [--execution-id <execution-id>] [--ttl-ms <ms>] [--dry-run] [--json]",
    "options": [{"flag":"--execution-id","description":"Resume a selected active Execution when legacy state is ambiguous."},{"flag":"--ttl-ms","description":"Set the Holder V2 lease duration in milliseconds."},{"flag":"--dry-run","description":"List the separately admitted lifecycle steps without writing."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Claim an Execution lease and move a planned task to active without entering review.",
    "examples": ["harness-anything task start task_01ABC --json"],
    "parse": parseCoreTaskArgs,
    "run": rejectDaemonTaskLifecycleFacade,
    "receiptContract": {
      "data": ["taskId", "executionId", "status", "report"],
      "paths": [],
      "successNext": {
        kind: "actions",
        "actions": [{
          "command": "ha task submit {taskId} --from-file <submission.json>",
          "description": "Do the contracted work and collect output evidence; submit the active Execution when it is ready for review."
        }]
      },
      "dryRun": {
        "data": ["taskId", "report"],
        "paths": [],
        "successNext": { kind: "none" }
      }
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    },
    "admission": {
      "nounOwnership": "Task lifecycle start facade; it adds no top-level noun and cannot enter review.",
      "lifecycle": "permanent",
      "decisionRef": "decision/dec_01KXWRC9CH70HN61B5FYPQP3XV",
      "chain": { "stepCount": 1, "submissionFieldCount": 0, "structuredInput": false }
    }
  },
  {
    "kind": "task-holder",
    "display": "advanced",
    "usage": "task holder <id> [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Read the effective holder lease state for a task.",
    "examples": ["harness-anything task holder task_01ABC --json"],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": [],
      "successNext": { kind: "none" }
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "task-release",
    "display": "advanced",
    "usage": "task release <id> [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Release the authenticated principal's task holder lease.",
    "examples": ["harness-anything task release task_01ABC"],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-closeout",
    "display": "advanced",
    "usage": "task closeout <id> --from-file <closeout.json> [--execution-id <execution-id>] [--lease-token <token>] [--commit <git-ref>] [--reviewer <id>] [--dry-run] [--json]",
    "options": [{"flag":"--from-file","description":"Read the human completion claim, Review judgment and consent, CI result, and optional evidence fields."},{"flag":"--execution-id","description":"Select the active Execution; otherwise use Holder V2 and the sole submitted round."},{"flag":"--lease-token","description":"Authenticate the active Holder V2 lease when it is not available implicitly."},{"flag":"--commit","description":"Resolve this git ref to a full 40-character commit SHA; defaults to HEAD."},{"flag":"--reviewer","description":"Set the completion reviewer id recorded by the existing completion gate."},{"flag":"--dry-run","description":"Run the same canonical task-complete planner without writing."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Compatibility approval entry that translates one closeout packet into the canonical task-complete planner and transaction.",
    "examples": ["harness-anything task closeout task_01ABC --from-file closeout.json --json"],
    "parse": parseCoreTaskArgs,
    "run": rejectDaemonTaskLifecycleFacade,
    "receiptContract": {
      ...taskCompletionReceiptContract
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    },
    "admission": {
      "nounOwnership": "Task lifecycle closeout facade; a human must invoke it after work is active.",
      "lifecycle": "permanent",
      "decisionRef": "decision/dec_01KXWRC9CH70HN61B5FYPQP3XV",
      "chain": { "stepCount": 1, "submissionFieldCount": 6, "structuredInput": true }
    }
  },
  {
    "kind": "status-set",
    "usage": "task transition <id> <planned|active|blocked|in_review|done|cancelled> [--force --reason <reason>]",
    "options": [{"flag":"--force","description":"Force audited cancellation recovery; this never certifies done."},{"flag":"--reason","description":"Record the reason for the lifecycle change."}],
    "aliases": ["task status set <id> <status> (deprecated, use task transition; retires at E77/F6 acceptance)"],
    "aliasDisplay": {"task status set <id> <status> (deprecated, use task transition; retires at E77/F6 acceptance)":"hidden"},
    "summary": "Move a local task to a new lifecycle status.",
    "examples": ["harness-anything task transition task_01ABC active --reason \"work started\""],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId", "status"],
      "optionalData": {
        "forced": "Only emitted for audited cancellation recovery invoked with --force.",
        "forceAudit": "Only emitted for audited cancellation recovery that appends force audit evidence."
      },
      "paths": [],
      "successNext": {kind: "none"},
      "optionalPaths": {
        "primary": "Only emitted for audited cancellation recovery where the audit progress path is returned as the primary path.",
        "forceAudit": "Only emitted for audited cancellation recovery that appends force audit evidence."
      }
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "progress-append",
    "usage": "task progress append <id> --text <text> [--evidence type:PATH:summary]... [--dry-run]",
    "options": [{"flag":"--text","description":"Progress text appended as-is (no Markdown formatting or normalization)."},{"flag":"--evidence","description":"Attach evidence in type:path:summary format; repeat for multiple entries."},{"flag":"--dry-run","description":"Preview the append without entering canonical authority ingress or writing files."}],
    "summary": "Append the provided text as-is to a task package, with optional repeatable evidence; no Markdown formatting or normalization is applied.",
    "examples": ["harness-anything task progress append task_01ABC --text \"Implemented parser guard\" --evidence log:artifacts/check.log:passed"],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId"],
      "optionalData": {
        "report": "Only emitted when --evidence is supplied and the receipt includes the appended evidence payload."
      },
      "paths": ["primary", "progress"],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "artifact-add",
    "usage": "task artifact add <task-id> <path>... [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Copy untracked UTF-8 text evidence into a task package through doc sync so later evidence pointers stay resolvable.",
    "examples": ["harness-anything task artifact add task_01ABC reports/check.txt"],
    "parse": parseCoreTaskArgs,
    "run": runDocCommand,
    "receiptContract": { "data": ["taskId", "report"], "paths": ["primary"],
      "successNext": {kind: "none"}, },
    "eventPolicy": { "conflictMarkerPreflight": true, "runtimeEvent": "auto" }
  },
  {
    "kind": "task-amend",
    "usage": "task amend <id> --set <field>:<value> [--json]",
    "options": [{"flag":"--set","description":"Replace a schema-declared amendable field value."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Amend vertical-declared task field extensions without changing lifecycle state.",
    "examples": ["harness-anything task amend task_01ABC --set taskClass:milestone"],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"],
      "successNext": { kind: "none" }
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-contract-migrate",
    "display": "advanced",
    "usage": "task contract migrate (--dry-run|--apply) [--task <id>] [--json]",
    "options": [{"flag":"--dry-run","description":"Preview deterministic snapshot writes without mutating Task packages."},{"flag":"--apply","description":"Write snapshots for deterministically attributable legacy Tasks."},{"flag":"--task","description":"Limit migration to one Task id."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Backfill immutable Task contract snapshots; ambiguous Tasks remain in a manual queue.",
    "examples": ["harness-anything task contract migrate --dry-run", "harness-anything task contract migrate --apply --task task_01ABC"],
    "parse": parseCoreTaskArgs,
    "run": runTaskContractMigration,
    "receiptContract": {
      "data": ["report"],
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-archive",
    "usage": "task archive (<id> | --ids <id,id> | --filter state:<state> [--before <date>]) --reason <reason> [--archived-by <actor>] [--archive-field <field>]",
    "options": [{"flag":"--ids","description":"Select a comma-separated task id list."},{"flag":"--filter","description":"Select records with a command-specific filter expression."},{"flag":"--before","description":"Select records updated before an ISO-compatible date."},{"flag":"--reason","description":"Record the reason for the lifecycle change."},{"flag":"--archived-by","description":"Record the actor archiving the task."},{"flag":"--archive-field","description":"Set the field used for archive disposition."}],
    "summary": "Archive task packages while preserving audit trails and queuing distill candidates from closeout or facts evidence.",
    "examples": ["harness-anything task archive task_01ABC --reason \"merged\"", "harness-anything task archive --filter state:done --before 2026-07-01 --reason \"stage contained\""],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["report"],
      "optionalData": {
        "taskId": "Present for single-task archive receipts.",
        "status": "Present for single-task archive receipts.",
        "rows": "Present for batch archive receipts.",
        "tasks": "Present for batch archive receipts."
      },
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-supersede",
    "usage": "task supersede <old-id> (--title <title> [--slug <slug>] | --by <existing-task-id> --confirm <old-id>) [--reason <reason>] [--deleted-by <actor>] [--allow-open-findings]",
    "options": [{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--slug","description":"Set the task slug."},{"flag":"--by","description":"Set the replacing task or invalidating fact id."},{"flag":"--confirm","description":"Confirm a destructive or relation-changing action."},{"flag":"--reason","description":"Record the reason for the lifecycle change."},{"flag":"--deleted-by","description":"Record the actor deleting or superseding the task."},{"flag":"--allow-open-findings","description":"Allow superseding work with unresolved findings."}],
    "summary": "Archive old work and optionally create or link replacement work.",
    "examples": ["harness-anything task supersede task_01OLD --title \"Replacement task\" --reason \"scope changed\""],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId"],
      "optionalData": {
        "report": "Only emitted when superseding by an existing replacement task via --by."
      },
      "paths": ["primary", "replacement"],
      "successNext": {kind: "none"},
      "optionalPaths": {
        "package": "Only emitted when supersede creates a new replacement task package."
      }
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-delete",
    "usage": "task delete --soft <id> --reason <reason> [--deleted-by <actor>] (production); local-only compatibility: --hard <id> --confirm <id>",
    "options": [{"flag":"--soft","description":"Soft-delete the selected task through the production typed write path."},{"flag":"--hard","description":"Local-only compatibility mode; production does not offer hard delete. Distill evidence, then use task archive or task supersede."},{"flag":"--confirm","description":"Confirm a local-only hard delete; this does not enable hard delete in production."},{"flag":"--reason","description":"Record the reason for the lifecycle change."},{"flag":"--deleted-by","description":"Record the actor deleting or superseding the task."}],
    "summary": "Soft-delete a task package. Production does not offer hard delete; after distilling evidence, use task archive or task supersede instead.",
    "examples": ["harness-anything task delete --soft task_01ABC --reason \"duplicate\""],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId", "mode"],
      "optionalData": {
        "report": "Only emitted when delete attribution such as --deleted-by is supplied."
      },
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-reopen",
    "usage": "task reopen <id> --reason <reason>",
    "options": [{"flag":"--reason","description":"Record the reason for the lifecycle change."}],
    "summary": "Reopen a non-terminal archived or tombstoned task package.",
    "examples": ["harness-anything task reopen task_01ABC --reason \"follow-up needed\""],
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId", "status"],
      "paths": ["primary"],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-code-doc-reconcile",
    "usage": "task code-doc reconcile <id> --commit <full-sha> [--path <repo-file-path>]... [--pr <url>] [--force]",
    "options": [{"flag":"--commit","description":"Set the required full commit SHA used by every generated ledger record."},{"flag":"--path","description":"Add a repository-relative file path anchor; directory paths and trailing slashes are invalid; repeat for multiple files."},{"flag":"--pr","description":"Add an optional PR reference anchored to the same commit."},{"flag":"--force","description":"Replace an existing code-doc-anchors.json instead of refusing to overwrite it."}],
    "summary": "Generate and validate code-doc-anchors.json from task ledgers without hand-authoring JSON.",
    "examples": ["harness-anything task code-doc reconcile task_01ABC --commit 0123456789abcdef0123456789abcdef01234567 --path packages/cli/src/index.ts"],
    "parse": parseCoreTaskArgs,
    "run": runTaskGatesCommand,
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"],
      "successNext": {
        kind: "actions",
        "actions": [{
          "command": "ha task complete {taskId} --help",
          "description": "The code/document witness is recorded; complete the task with its approved review and CI evidence."
        }]
      }
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-review",
    "display": "advanced",
    "usage": "task review <id> [--reviewer <id>]",
    "options": [{"flag":"--reviewer","description":"Set the reviewer id."}],
    "aliases": ["task-review <id> (deprecated, use task review; retires at E77/F6 acceptance)"],
    "aliasDisplay": {"task-review <id> (deprecated, use task review; retires at E77/F6 acceptance)":"hidden"},
    "summary": "Run the legacy review.md compatibility lint. This command cannot approve an Execution or authorize Task completion.",
    "examples": ["harness-anything task review task_01ABC --reviewer reviewer-id"],
    "parse": parseCoreTaskArgs,
    "run": runTaskGatesCommand,
    "receiptContract": {
      "data": ["taskId", "reviewContract", "report"],
      "optionalData": {
        "completionGate": "Only emitted by completion-oriented task gate results; ordinary task review emits the review contract only."
      },
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-consent-record",
    "display": "advanced",
    "usage": "task consent-record <id> --execution-id <execution-id> (--utterance <text>|--standing-policy <decision-id>|--asserted <rationale>) [--consent-action approve_execution] [--consent-action complete_task]",
    "options": [{"flag":"--execution-id","description":"Bind consent to this exact submitted Execution."},{"flag":"--utterance","description":"Verify the human's exact approval words against a bound user transcript turn."},{"flag":"--standing-policy","description":"Use an existing active decision as standing authorization."},{"flag":"--asserted","description":"Explicitly record unverified external approval with a required rationale."},{"flag":"--consent-action","description":"Grant approve_execution and optionally complete_task; repeat for both. Defaults to both actions."}],
    "summary": "Record a principal-bound, content-pinned human consent as an independent consumable entity.",
    "examples": ["harness-anything task consent-record task_01ABC --execution-id exe_01ABC --utterance \"Approved\""],
    "parse": parseCoreTaskArgs,
    "run": runTaskGatesCommand,
    "receiptContract": {
      "data": ["taskId", "executionId", "consentId", "report"],
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-review-execution",
    "display": "advanced",
    "usage": "task review-execution <id> [--from-file <review.json>] [--execution-id <execution-id>] --verdict approved|changes_requested|dismissed --findings <text> --rationale <text> [--consent <consent-id>|--consent-utterance <text>|--consent-standing-policy <decision-id>|--consent-asserted <rationale>] [--consent-action approve_execution] [--consent-action complete_task] [--evidence-checked <id>]... [--acknowledge-archive-warnings]",
    "options": [{"flag":"--from-file","description":"Read Review fields; executionId may be omitted only when exactly one submitted Execution exists."},{"flag":"--execution-id","description":"Review the exact submitted Execution, or correct an accepted Execution with changes_requested."},{"flag":"--verdict","description":"Set approved, changes_requested, or dismissed."},{"flag":"--findings","description":"Record findings for this Review round."},{"flag":"--consent","description":"Consume an existing open consent for approved verdicts."},{"flag":"--consent-utterance","description":"Verify exact words against a bound user transcript turn, then record and consume consent."},{"flag":"--consent-standing-policy","description":"Record and consume consent authorized by an existing active decision."},{"flag":"--consent-asserted","description":"Record and consume unverified external approval with an explicit rationale."},{"flag":"--consent-action","description":"When creating consent, grant approve_execution and optionally complete_task; defaults to both."},{"flag":"--evidence-checked","description":"Record an inspected OutputEvidence id; repeat as needed."},{"flag":"--rationale","description":"Record the Reviewer's semantic rationale."},{"flag":"--acknowledge-archive-warnings","description":"Explicitly acknowledge partial or unavailable Session archives."}],
    "summary": "Create an immutable Review round; approved verdicts require content-pinned human consent, while executor identity never substitutes for consent.",
    "examples": ["harness-anything task review-execution task_01ABC --execution-id exe_01ABC --verdict approved --findings \"Acceptance checks passed\" --rationale \"Evidence satisfies the Task intent\" --consent-utterance \"Approved\""],
    "parse": parseCoreTaskArgs,
    "run": runTaskGatesCommand,
    "receiptContract": {
      "data": ["taskId", "executionId", "reviewId", "report"],
      "paths": [],
      "successNext": {kind: "none"},
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-complete",
    "usage": "task complete <id> (--approve --from-file <approval.json> | --commit-anchor <anchor-commit> --judgment <reason>) [--ci passed|failed|not-applicable] [--execution-id <execution-id>] [--reviewer <id>] [--commit <git-ref>] [--dry-run]",
    "options": [{"flag":"--approve","description":"Record this invocation as the owner's explicit approval action."},{"flag":"--from-file","description":"Read the schema-derived approval packet described below."},{"flag":"--ci","description":"Override the packet CI result when the resolved contract declares CI."},{"flag":"--execution-id","description":"Select the submitted Execution; inferred when exactly one exists."},{"flag":"--reviewer","description":"Set a compatibility reviewer label; authenticated actor identity remains authoritative."},{"flag":"--commit","description":"Resolve the public workspace commit; defaults to HEAD and must match reconciliation."},{"flag":"--dry-run","description":"Run a read-only preflight that aggregates every current completion requirement and planned internal step."},{"flag":"--commit-anchor","description":"Compatibility owner-judgment mode; requires a pre-reconciled anchor commit and --judgment."},{"flag":"--judgment","description":"Explain why the compatibility commit-anchor completes the task."}],
    "aliases": ["task-complete <id> (deprecated, use task complete; retires at E77/F6 acceptance)"],
    "aliasDisplay": {"task-complete <id> (deprecated, use task complete; retires at E77/F6 acceptance)":"hidden"},
    "summary": "Plan and submit one terminal completion transaction after satisfying the selected mode's reconciliation and lifecycle prerequisites.",
    "examples": ["harness-anything task complete task_01ABC --approve --from-file approval.json", "harness-anything task complete task_01ABC --commit-anchor \"$(git rev-parse HEAD)\" --judgment \"This commit completes and verifies the task\" --ci passed"],
    "parse": parseCoreTaskArgs,
    "run": runTaskGatesCommand,
    "receiptContract": {
      ...taskCompletionReceiptContract
    },
    "eventPolicy": writeCommandEventPolicy
  }
]);
