import { defineCommandSpecs } from "./types.ts";
import { parseCoreTaskArgs } from "../parsers/core-task.ts";
import { parseDocArgs } from "../parsers/doc.ts";
import { parseMaterializerArgs } from "../parsers/materializer.ts";
import { parseRuntimeEventArgs } from "../parsers/runtime-event.ts";
import { parseSessionArgs } from "../parsers/session.ts";
import { parseStatusCheckArgs } from "../parsers/status-check.ts";
import { parseTemplateArgs } from "../parsers/extensions-template.ts";
import { runDocCommand } from "../../commands/core/doc.ts";
import { runExtensionRunnerCommand } from "../../commands/core/extension.ts";
import { runGovernanceCommand } from "../../commands/core/governance.ts";
import { runMaterializerCommand } from "../../commands/core/materializer.ts";
import { runRuntimeEventCommand } from "../../commands/core/runtime-event.ts";
import { runSessionCommand } from "../../commands/core/session.ts";
import { runTaskQueryCommand } from "../../commands/core/task-query.ts";

export const runtimeDocsCommandSpecs = defineCommandSpecs([
  {
    "kind": "runtime-event-append",
    "usage": "event append --session <session-id> --kind session|turn|step|tool|approval|interrupt|result|cost [--from-file <path>|--json-input <json>] [--runtime <runtime>] [--id <event-id>] [--at <iso>] [--task <task-id>] [--turn <turn-id>] [--step <step-id>] [--tool <name>] [--approval approved|rejected|timeout|unknown] [--interrupt pause|cancel|resume|append|branch|unknown] [--result started|succeeded|failed|cancelled|unknown] [--summary <text>] [--total-tokens <n>] [--json]",
    "options": [{"flag":"--session","description":"Set the runtime session id."},{"flag":"--kind","description":"Set the runtime event kind."},{"flag":"--from-file","description":"Read command input JSON from a file; flags remain shortcut overrides."},{"flag":"--json-input","description":"Read command input JSON from an inline string; flags remain shortcut overrides."},{"flag":"--runtime","description":"Set the observed runtime kind."},{"flag":"--id","description":"Set the explicit entity id when the command supports one."},{"flag":"--at","description":"Set the runtime event timestamp."},{"flag":"--task","description":"Set the task id."},{"flag":"--turn","description":"Set the observed runtime turn id."},{"flag":"--step","description":"Set the observed runtime step id."},{"flag":"--tool","description":"Set the observed tool or command name."},{"flag":"--approval","description":"Record a runtime event approval decision."},{"flag":"--interrupt","description":"Record a task-level interrupt or steering action."},{"flag":"--result","description":"Record a runtime event result status."},{"flag":"--summary","description":"Set a short structured summary."},{"flag":"--total-tokens","description":"Set the observed total token count."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["runtime-event append (deprecated, use event append; retires at E77/F6 acceptance)"],
    "summary": "Append one structured runtime event to the local JSONL event ledger.",
    "examples": ["harness-anything event append --session codex-session-1 --kind interrupt --runtime codex --interrupt append --summary \"User appended task guidance\""],
    "parse": parseRuntimeEventArgs,
    "run": runRuntimeEventCommand,
    "receiptContract": {
      "data": ["report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "direct"
    }
  },
  {
    "kind": "runtime-event-list",
    "usage": "event list --session <session-id> [--json]",
    "options": [{"flag":"--session","description":"Set the runtime session id."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["runtime-event list (deprecated, use event list; retires at E77/F6 acceptance)"],
    "summary": "Read structured runtime events for one session from the local JSONL ledger.",
    "examples": ["harness-anything event list --session codex-session-1 --json"],
    "parse": parseRuntimeEventArgs,
    "run": runRuntimeEventCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "materializer-run",
    "usage": "materializer run [--dry-run] [--json]",
    "options": [{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Merge pending per-session ledger branches into master serially.",
    "examples": ["harness-anything materializer run --dry-run --json"],
    "parse": parseMaterializerArgs,
    "run": runMaterializerCommand,
    "receiptContract": {
      "data": ["rows", "warnings", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "session-export",
    "usage": "session export [--session <id> --runtime claude-code|codex|zcode|antigravity] [--source runtime|manual] [--detected-at <iso>] [--user <name>] [--transcript-file <path>] [--json]",
    "options": [{"flag":"--session","description":"Set the runtime session id."},{"flag":"--runtime","description":"Set the observed runtime kind."},{"flag":"--source","description":"Set the observed source label for explicit session export."},{"flag":"--detected-at","description":"Set the detected session timestamp for explicit session export."},{"flag":"--user","description":"Set the user label for explicit session export."},{"flag":"--transcript-file","description":"Read the selected runtime session from an explicit JSONL transcript file."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Export the current or specified runtime session into the managed harness sessions directory.",
    "examples": ["harness-anything session export --json"],
    "parse": parseSessionArgs,
    "run": runSessionCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "session-backfill",
    "usage": "session backfill [--runtime claude-code|codex|zcode|antigravity] [--limit <n>] [--json]",
    "options": [{"flag":"--runtime","description":"Set the observed runtime kind."},{"flag":"--limit","description":"Limit the number of planned items."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Backfill managed session documents from discovered local runtime logs.",
    "examples": ["harness-anything session backfill --runtime codex --limit 20 --json"],
    "parse": parseSessionArgs,
    "run": runSessionCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "session-sync",
    "usage": "session sync [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Synchronize existing managed session markdown files under harness/sessions through the write journal.",
    "examples": ["harness-anything session sync --json"],
    "parse": parseSessionArgs,
    "run": runSessionCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "doc-list",
    "usage": "doc list [--module <key>] [--product-line <key>] [--json]",
    "options": [{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--product-line","description":"Attach a comma-separated product line list to a decision."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List canonical documents declared in the docmap manifest.",
    "examples": ["harness-anything doc list --module m4-loadbearing --json"],
    "parse": parseDocArgs,
    "run": runDocCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "doc-map",
    "usage": "doc map [--module <key>] [--product-line <key>] [--json]",
    "options": [{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--product-line","description":"Attach a comma-separated product line list to a decision."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Compute the docmap minimum read set for a module or product line.",
    "examples": ["harness-anything doc map --module m4-loadbearing --product-line kernel --json"],
    "parse": parseDocArgs,
    "run": runDocCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "doc-generate",
    "usage": "doc generate [--module <key>] [--product-line <key>] [--write] [--json]",
    "options": [{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--product-line","description":"Attach a comma-separated product line list to a decision."},{"flag":"--write","description":"Persist the generated artifact instead of returning a dry-run report."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Derive and optionally persist docmap.json from canonical document declarations and frontmatter.",
    "examples": ["harness-anything doc generate --write --json"],
    "parse": parseDocArgs,
    "run": runDocCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "doc-status",
    "usage": "doc status [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List dirty doc-sync files, forbidden touches, and candidate blobs without writing state.",
    "examples": ["harness-anything doc status --json"],
    "parse": parseDocArgs,
    "run": runDocCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "doc-sync-dry-run",
    "usage": "doc sync --dry-run [--json]",
    "options": [{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Build a doc-sync write-intent preview without submitting it.",
    "examples": ["harness-anything doc sync --dry-run --json"],
    "parse": parseDocArgs,
    "run": runDocCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "template-list",
    "usage": "template list [--catalog <path>] [--json]",
    "options": [{"flag":"--catalog","description":"Use a template catalog file."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List available task and document templates.",
    "examples": ["harness-anything template list --json"],
    "parse": parseTemplateArgs,
    "run": runExtensionRunnerCommand,
    "receiptContract": {
      "data": ["templates", "issues"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "template-render",
    "usage": "template render <template-ref> [--catalog <path>] [--locale zh-CN|en-US] [--json]",
    "options": [{"flag":"--catalog","description":"Use a template catalog file."},{"flag":"--locale","description":"Set generated content locale."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Render a template reference with a selected locale.",
    "examples": ["harness-anything template render template://planning/task@1 --locale zh-CN"],
    "parse": parseTemplateArgs,
    "run": runExtensionRunnerCommand,
    "receiptContract": {
      "data": ["document", "issues"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "task-list",
    "usage": "task list [--state <state>] [--module <key>] [--queue <queue>] [--preset <id>] [--kind feat|fix|refactor|docs|test|chore] [--risk-tier low|medium|high] [--urgency low|medium|high] [--review <state>] [--lesson [present|missing]] [--missing-materials] [--include-archived] [--search <text>] [--json]",
    "options": [{"flag":"--state","description":"Filter task packages by task state: planned, active, blocked, in_review, done, or cancelled."},{"flag":"--module","description":"Select a registered module key; use module list to discover keys."},{"flag":"--queue","description":"Filter by queue."},{"flag":"--preset","description":"Select a preset id; task create defaults to standard-task and preset list shows installed presets."},{"flag":"--kind","description":"Filter task packages by work kind: feat, fix, refactor, docs, test, or chore."},{"flag":"--risk-tier","description":"Filter task packages by risk tier: low, medium, or high."},{"flag":"--urgency","description":"Filter task packages by urgency: low, medium, or high."},{"flag":"--review","description":"Filter by review state."},{"flag":"--lesson","description":"Filter by lesson state."},{"flag":"--missing-materials","description":"Filter tasks missing required materials."},{"flag":"--include-archived","description":"Include archived task packages."},{"flag":"--search","description":"Search task metadata and prose."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List task packages with state, module, review, and search filters.",
    "examples": ["harness-anything task list --state active --module kernel --review missing"],
    "parse": parseCoreTaskArgs,
    "run": runTaskQueryCommand,
    "receiptContract": {
      "data": ["tasks"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "status",
    "usage": "status --json",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Summarize harness state and supported CLI commands.",
    "examples": ["harness-anything status --json"],
    "parse": parseStatusCheckArgs,
    "run": runTaskQueryCommand,
    "receiptContract": {
      "data": ["rows", "summary", "report", "commands"],
      "paths": ["projection"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "check",
    "usage": "check [--profile source-package|private-harness|target-project] [--strict] [--post-merge] [--json]",
    "options": [{"flag":"--profile","description":"Select a check or task profile; task create defaults to baseline."},{"flag":"--strict","description":"Run strict checks."},{"flag":"--post-merge","description":"Run checks intended for post-merge validation."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Run harness health checks for a selected profile.",
    "examples": ["harness-anything check --profile target-project --strict"],
    "parse": parseStatusCheckArgs,
    "run": runGovernanceCommand,
    "receiptContract": {
      "data": ["profile", "rows", "report", "commands"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "governance-rebuild",
    "usage": "governance rebuild [--dry-run|--archive|--apply] [--json]",
    "options": [{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--archive","description":"Archive generated governance output."},{"flag":"--apply","description":"Apply the operation instead of planning it."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Rebuild generated governance projections.",
    "examples": ["harness-anything governance rebuild --dry-run"],
    "parse": parseStatusCheckArgs,
    "run": runGovernanceCommand,
    "receiptContract": {
      "data": ["mode", "rows", "report"],
      "optionalData": {
        "generated": "Only emitted for apply/archive rebuild modes that write generated governance views."
      },
      "paths": ["projection"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "lesson-promote",
    "usage": "lesson promote <task-id> <candidate-id> [--dry-run|--apply] [--json]",
    "options": [{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--apply","description":"Apply the operation instead of planning it."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["lesson-promote <task-id> <candidate-id> (deprecated, use lesson promote; retires at E77/F6 acceptance)"],
    "summary": "Promote a lesson candidate from a completed task.",
    "examples": ["harness-anything lesson promote task_01ABC candidate-1 --apply"],
    "parse": parseStatusCheckArgs,
    "run": runGovernanceCommand,
    "receiptContract": {
      "data": ["taskId", "mode", "generated", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "lesson-sediment",
    "usage": "lesson sediment <task-id> <candidate-id> [--dry-run] [--title <title>] [--json]",
    "options": [{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["lesson-sediment <task-id> <candidate-id> (deprecated, use lesson sediment; retires at E77/F6 acceptance)"],
    "summary": "Record a dry-run sedimentation result for a lesson candidate.",
    "examples": ["harness-anything lesson sediment task_01ABC candidate-1 --title \"CLI help lesson\""],
    "parse": parseStatusCheckArgs,
    "run": runGovernanceCommand,
    "receiptContract": {
      "data": ["taskId", "mode", "generated", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  }
]);
