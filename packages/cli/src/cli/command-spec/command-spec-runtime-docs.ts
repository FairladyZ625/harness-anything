import { defineCommandSpecs } from "./types.ts";

export const runtimeDocsCommandSpecs = defineCommandSpecs([
  {
    "kind": "runtime-event-append",
    "usage": "event append --session <session-id> --kind session|turn|step|tool|approval|interrupt|result|cost [--from-file <path>|--json-input <json>] [--runtime <runtime>] [--id <event-id>] [--at <iso>] [--task <task-id>] [--turn <turn-id>] [--step <step-id>] [--tool <name>] [--approval approved|rejected|timeout|unknown] [--interrupt pause|cancel|resume|append|branch|unknown] [--result started|succeeded|failed|cancelled|unknown] [--summary <text>] [--total-tokens <n>] [--json]",
    "aliases": ["runtime-event append (deprecated, use event append; retires at E77/F6 acceptance)"],
    "summary": "Append one structured runtime event to the local JSONL event ledger.",
    "examples": ["harness-anything event append --session codex-session-1 --kind interrupt --runtime codex --interrupt append --summary \"User appended task guidance\""],
    "parserId": "runtime-event",
    "runnerId": "runtime-event",
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
    "aliases": ["runtime-event list (deprecated, use event list; retires at E77/F6 acceptance)"],
    "summary": "Read structured runtime events for one session from the local JSONL ledger.",
    "examples": ["harness-anything event list --session codex-session-1 --json"],
    "parserId": "runtime-event",
    "runnerId": "runtime-event",
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
    "summary": "Merge pending per-session ledger branches into master serially.",
    "examples": ["harness-anything materializer run --dry-run --json"],
    "parserId": "materializer",
    "runnerId": "materializer",
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
    "usage": "session export [--session <id> --runtime claude-code|codex|zcode|antigravity] [--source runtime|manual] [--detected-at <iso>] [--user <name>] [--json]",
    "summary": "Export the current or specified runtime session into the managed harness sessions directory.",
    "examples": ["harness-anything session export --json"],
    "parserId": "session",
    "runnerId": "session",
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
    "summary": "Backfill managed session documents from discovered local runtime logs.",
    "examples": ["harness-anything session backfill --runtime codex --limit 20 --json"],
    "parserId": "session",
    "runnerId": "session",
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
    "summary": "Synchronize existing managed session markdown files under harness/sessions through the write journal.",
    "examples": ["harness-anything session sync --json"],
    "parserId": "session",
    "runnerId": "session",
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
    "summary": "List canonical documents declared in the docmap manifest.",
    "examples": ["harness-anything doc list --module m4-loadbearing --json"],
    "parserId": "doc",
    "runnerId": "doc",
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
    "summary": "Compute the docmap minimum read set for a module or product line.",
    "examples": ["harness-anything doc map --module m4-loadbearing --product-line kernel --json"],
    "parserId": "doc",
    "runnerId": "doc",
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
    "summary": "Derive and optionally persist docmap.json from canonical document declarations and frontmatter.",
    "examples": ["harness-anything doc generate --write --json"],
    "parserId": "doc",
    "runnerId": "doc",
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
    "summary": "List dirty doc-sync files, forbidden touches, and candidate blobs without writing state.",
    "examples": ["harness-anything doc status --json"],
    "parserId": "doc",
    "runnerId": "doc",
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
    "summary": "Build a doc-sync write-intent preview without submitting it.",
    "examples": ["harness-anything doc sync --dry-run --json"],
    "parserId": "doc",
    "runnerId": "doc",
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
    "summary": "List available task and document templates.",
    "examples": ["harness-anything template list --json"],
    "parserId": "template",
    "runnerId": "extension",
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
    "summary": "Render a template reference with a selected locale.",
    "examples": ["harness-anything template render template://planning/task@1 --locale zh-CN"],
    "parserId": "template",
    "runnerId": "extension",
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
    "summary": "List task packages with state, module, review, and search filters.",
    "examples": ["harness-anything task list --state active --module kernel --review missing"],
    "parserId": "core-task",
    "runnerId": "task-query",
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
    "summary": "Summarize harness state and supported CLI commands.",
    "examples": ["harness-anything status --json"],
    "parserId": "status-check",
    "runnerId": "task-query",
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
    "summary": "Run harness health checks for a selected profile.",
    "examples": ["harness-anything check --profile target-project --strict"],
    "parserId": "status-check",
    "runnerId": "governance",
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
    "summary": "Rebuild generated governance projections.",
    "examples": ["harness-anything governance rebuild --dry-run"],
    "parserId": "status-check",
    "runnerId": "governance",
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
    "aliases": ["lesson-promote <task-id> <candidate-id> (deprecated, use lesson promote; retires at E77/F6 acceptance)"],
    "summary": "Promote a lesson candidate from a completed task.",
    "examples": ["harness-anything lesson promote task_01ABC candidate-1 --apply"],
    "parserId": "status-check",
    "runnerId": "governance",
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
    "aliases": ["lesson-sediment <task-id> <candidate-id> (deprecated, use lesson sediment; retires at E77/F6 acceptance)"],
    "summary": "Record a dry-run sedimentation result for a lesson candidate.",
    "examples": ["harness-anything lesson sediment task_01ABC candidate-1 --title \"CLI help lesson\""],
    "parserId": "status-check",
    "runnerId": "governance",
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
