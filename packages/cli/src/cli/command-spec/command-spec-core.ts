import { defineCommandSpecs } from "./types.ts";

export const coreCommandSpecs = defineCommandSpecs([
  {
    "kind": "help",
    "usage": "help",
    "options": [],
    "aliases": ["--help", "-h"],
    "summary": "Show global help or detailed help for one command.",
    "examples": ["harness-anything help task create"],
    "parserId": "help",
    "runnerId": "help",
    "receiptContract": {
      "data": ["commands", "report"],
      "paths": []
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
    "parserId": "version",
    "runnerId": "version",
    "receiptContract": {
      "data": ["version"],
      "paths": []
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
    "parserId": "capabilities",
    "runnerId": "capabilities",
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": []
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
    "parserId": "capabilities",
    "runnerId": "capabilities",
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": []
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
    "parserId": "core-task",
    "runnerId": "init",
    "receiptContract": {
      "data": ["generated", "report"],
      "paths": ["primary", "config"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "new-task",
    "usage": "task create --title <title> [--parent <task-id>] [--kind feat|fix|refactor|docs|test|chore] [--risk-tier low|medium|high] [--urgency low|medium|high] [--from-file <path>|--json-input <json>] [--vertical software/coding --preset <id> --module <key>] [--register-module <key> --module-title <title> --module-scope <path>] [--long-running] [--dry-run] [--locale zh-CN|en-US] [--from-legacy <legacy-id>] [--json]",
    "options": [{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--parent","description":"Bind a new task to an existing parent task id."},{"flag":"--kind","description":"Set task work kind: feat, fix, refactor, docs, test, or chore."},{"flag":"--risk-tier","description":"Set task risk tier: low, medium, or high."},{"flag":"--urgency","description":"Set task urgency: low, medium, or high."},{"flag":"--from-file","description":"Read command input JSON from a file; flags remain shortcut overrides."},{"flag":"--json-input","description":"Read command input JSON from an inline string; flags remain shortcut overrides."},{"flag":"--vertical","description":"Select a vertical definition; task create defaults to software/coding."},{"flag":"--preset","description":"Select a preset id; task create defaults to standard-task and preset list shows installed presets."},{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--register-module","description":"Register a module while creating the task."},{"flag":"--module-title","description":"Set the human-readable title for a registered module."},{"flag":"--module-scope","description":"Set the registered module source scope, such as packages/name/**."},{"flag":"--long-running","description":"Mark the task as long-running."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--locale","description":"Set generated content locale."},{"flag":"--from-legacy","description":"Create from a legacy task id."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["new-task --title <title> (deprecated, use task create; retires at E77/F6 acceptance)"],
    "summary": "Create a new task package, optionally through a vertical or preset.",
    "examples": ["harness-anything task create --title \"Normalize CLI help\" --parent task_01ABC --vertical software/coding --preset standard-task"],
    "parserId": "new-task",
    "runnerId": "new-task",
    "receiptContract": {
      "data": ["taskId", "slug", "status"],
      "optionalData": {
        "preset": "Only emitted when task creation runs through a selected preset.",
        "module": "Only emitted when --module is supplied or preset/module routing materializes module metadata.",
        "generated": "Only emitted when preset or template materialization produces generated files.",
        "report": "Only emitted when the creation path produces a structured creation report."
      },
      "paths": ["package"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-claim",
    "usage": "task claim <id> [--ttl-ms <ms>] [--json]",
    "options": [{"flag":"--ttl-ms","description":"Set the task holder lease duration in milliseconds."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Claim a task holder lease for the authenticated principal.",
    "examples": ["harness-anything task claim task_01ABC --ttl-ms 1800000"],
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-holder",
    "usage": "task holder <id> [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Read the effective holder lease state for a task.",
    "examples": ["harness-anything task holder task_01ABC --json"],
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "task-release",
    "usage": "task release <id> [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Release the authenticated principal's task holder lease.",
    "examples": ["harness-anything task release task_01ABC"],
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "status-set",
    "usage": "task transition <id> <planned|active|blocked|in_review|done|cancelled> [--force --reason <reason>]",
    "options": [{"flag":"--force","description":"Force the lifecycle transition with audit metadata."},{"flag":"--reason","description":"Record the reason for the lifecycle change."}],
    "aliases": ["task status set <id> <status> (deprecated, use task transition; retires at E77/F6 acceptance)"],
    "summary": "Move a local task to a new lifecycle status.",
    "examples": ["harness-anything task transition task_01ABC active --reason \"work started\""],
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId", "status"],
      "optionalData": {
        "forced": "Only emitted for audited terminal recovery transitions invoked with --force.",
        "forceAudit": "Only emitted for audited terminal recovery transitions that append force audit evidence."
      },
      "paths": [],
      "optionalPaths": {
        "primary": "Only emitted for audited terminal recovery transitions where the audit progress path is returned as the primary path.",
        "forceAudit": "Only emitted for audited terminal recovery transitions that append force audit evidence."
      }
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "progress-append",
    "usage": "task progress append <id> --text <text> [--evidence type:PATH:summary]",
    "options": [{"flag":"--text","description":"Progress text appended as-is (no Markdown formatting or normalization)."},{"flag":"--evidence","description":"Attach evidence in type:path:summary format."}],
    "summary": "Append the provided text as-is to a task package, with optional evidence; no Markdown formatting or normalization is applied.",
    "examples": ["harness-anything task progress append task_01ABC --text \"Implemented parser guard\" --evidence log:artifacts/check.log:passed"],
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId"],
      "optionalData": {
        "report": "Only emitted when --evidence is supplied and the receipt includes the appended evidence payload."
      },
      "paths": ["primary", "progress"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-amend",
    "usage": "task amend <id> --set <field>:<value> [--json]",
    "options": [{"flag":"--set","description":"Replace a schema-declared amendable field value."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Amend vertical-declared task field extensions without changing lifecycle state.",
    "examples": ["harness-anything task amend task_01ABC --set taskClass:milestone"],
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"]
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
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["report"],
      "optionalData": {
        "taskId": "Present for single-task archive receipts.",
        "status": "Present for single-task archive receipts.",
        "rows": "Present for batch archive receipts.",
        "tasks": "Present for batch archive receipts."
      },
      "paths": []
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
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId"],
      "optionalData": {
        "report": "Only emitted when superseding by an existing replacement task via --by."
      },
      "paths": ["primary", "replacement"],
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
    "usage": "task delete (--soft <id> | --hard <id> --confirm <id>) --reason <reason> [--deleted-by <actor>]",
    "options": [{"flag":"--soft","description":"Soft-delete the selected task."},{"flag":"--hard","description":"Hard-delete the selected task."},{"flag":"--confirm","description":"Confirm a destructive or relation-changing action."},{"flag":"--reason","description":"Record the reason for the lifecycle change."},{"flag":"--deleted-by","description":"Record the actor deleting or superseding the task."}],
    "summary": "Soft-delete or guarded hard-delete a task package. E79 makes hard delete rare: anchored facts or incoming relations block it; use task archive after distilling evidence into an anchor task.",
    "examples": ["harness-anything task delete --soft task_01ABC --reason \"duplicate\""],
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId", "mode"],
      "optionalData": {
        "report": "Only emitted when delete attribution such as --deleted-by is supplied."
      },
      "paths": []
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
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId", "status"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-review",
    "usage": "task review <id> [--reviewer <id>]",
    "options": [{"flag":"--reviewer","description":"Set the reviewer id."}],
    "aliases": ["task-review <id> (deprecated, use task review; retires at E77/F6 acceptance)"],
    "summary": "Evaluate the review gate for a task package.",
    "examples": ["harness-anything task review task_01ABC --reviewer reviewer-id"],
    "parserId": "core-task",
    "runnerId": "task-gates",
    "receiptContract": {
      "data": ["taskId", "reviewContract", "report"],
      "optionalData": {
        "completionGate": "Only emitted by completion-oriented task gate results; ordinary task review emits the review contract only."
      },
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-complete",
    "usage": "task complete <id> --ci passed|failed [--reviewer <id>]",
    "options": [{"flag":"--ci","description":"Set the completion CI gate result."},{"flag":"--reviewer","description":"Set the reviewer id."}],
    "aliases": ["task-complete <id> (deprecated, use task complete; retires at E77/F6 acceptance)"],
    "summary": "Evaluate the completion gate after CI has passed or failed. To make closeoutReadiness ready/passed, run task transition <id> in_review, replace closeout.md placeholder content, record a real fact, run task review, then run task complete --ci passed.",
    "examples": ["harness-anything task complete task_01ABC --ci passed --reviewer reviewer-id"],
    "parserId": "core-task",
    "runnerId": "task-gates",
    "receiptContract": {
      "data": ["taskId", "status", "reviewContract", "completionGate"],
      "optionalData": {
        "report": "Only emitted for completion paths that surface a review or gate report; clean completion emits reviewContract and completionGate."
      },
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "task-show",
    "usage": "task show <id> [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Show one task from the task projection with status, metadata, hierarchy, relation edges, and fact anchors.",
    "examples": ["harness-anything task show task_01ABC --json"],
    "parserId": "core-task",
    "runnerId": "task-query",
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "task-tree",
    "usage": "task tree <id> [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Show a task subtree derived from the parent field projection.",
    "examples": ["harness-anything task tree task_01ABC --json"],
    "parserId": "core-task",
    "runnerId": "task-query",
    "receiptContract": {
      "data": ["taskId", "tasks", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "relation-list",
    "usage": "relation list [--entity <entity-ref>] [--source <entity-ref>] [--target <entity-ref>] [--type <type>] [--state active|retired] [--json]",
    "options": [{"flag":"--entity","description":"Filter relation edges where either endpoint matches the entity ref."},{"flag":"--source","description":"Filter relation edges by source entity ref."},{"flag":"--target","description":"Set the relation target entity ref."},{"flag":"--type","description":"Filter relation edges by relation type."},{"flag":"--state","description":"Filter relation edges by relation state: active or retired."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List projected relation graph edges with source, target, type, state, owner, and source path filters.",
    "examples": ["harness-anything relation list --entity task/task_01ABC --json", "harness-anything relation list --target decision/dec_LEDGER_E51 --state active --json"],
    "parserId": "relation",
    "runnerId": "task-query",
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "task-relate",
    "usage": "task relate <source-task-id> depends-on <target-task-id> --rationale <text> [--dry-run] [--json]",
    "options": [{"flag":"--rationale","description":"Record the rationale for a relation or generated decision."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Append a task->task depends-on relation without scheduling or status side effects.",
    "examples": ["harness-anything task relate task_01ABC depends-on task_01DEF --rationale \"ABC waits for DEF\""],
    "parserId": "core-task",
    "runnerId": "task-lifecycle",
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  }
]);
