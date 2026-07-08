import { defineCommandSpecs } from "./types.ts";

export const migrationDiagnosticsCommandSpecs = defineCommandSpecs([
  {
    "kind": "adopt-multica",
    "usage": "adopt multica <ref> --task <task-id> [--status <status>] [--title <title>] [--json]",
    "summary": "Bind a fresh Multica issue snapshot to a new local task package.",
    "examples": ["harness-anything adopt multica EXT-123 --task task_01ABC --status active --title \"External task\""],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "snapshot-multica",
    "usage": "snapshot multica <ref> [--status <status>] [--title <title>] [--json]",
    "summary": "Read and report the current Multica issue snapshot.",
    "examples": ["harness-anything snapshot multica EXT-123 --json"],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "migrate-plan",
    "usage": "migrate plan [--limit n] [--json]",
    "aliases": ["migrate-plan (deprecated, use migrate plan; retires at E77/F6 acceptance)"],
    "summary": "Plan legacy structure migration work.",
    "examples": ["harness-anything migrate plan --limit 20"],
    "parserId": "migration",
    "runnerId": "migration",
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
    "kind": "migrate-structure",
    "usage": "migrate structure (--plan|--apply --confirm-plan) [--json]",
    "aliases": ["migrate-structure (deprecated, use migrate structure; retires at E77/F6 acceptance)"],
    "summary": "Plan or apply legacy directory structure migration.",
    "examples": ["harness-anything migrate structure --plan"],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["migrationMode", "rows", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "migrate-anchors",
    "usage": "migrate anchors [--dry-run|--apply] [--json]",
    "aliases": ["migrate-anchors (deprecated, use migrate anchors; retires at E77/F6 acceptance)"],
    "summary": "Backfill missing required template anchors into existing task documents.",
    "examples": ["harness-anything migrate anchors --dry-run --json"],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["migrationMode", "rows", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "migrate-provenance",
    "usage": "migrate provenance [--dry-run|--apply] [--json]",
    "aliases": ["migrate-provenance (deprecated, use migrate provenance; retires at E77/F6 acceptance)"],
    "summary": "Backfill explicit synthetic provenance into pre-R2 task packages.",
    "examples": ["harness-anything migrate provenance --dry-run"],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["migrationMode", "rows", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "migrate-run",
    "usage": "migrate run [--plan-only] [--out-dir folder] [--session-dir folder] [--locale zh-CN|en-US] [--assume-locale zh-CN|en-US] [--allow-dirty] [--json]",
    "aliases": ["migrate-run (deprecated, use migrate run; retires at E77/F6 acceptance)"],
    "summary": "Run the legacy migration pipeline into a session directory.",
    "examples": ["harness-anything migrate run --plan-only --session-dir migration-session --locale zh-CN"],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary", "session"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "migrate-verify",
    "usage": "migrate verify <session.json> [--json]",
    "aliases": ["migrate-verify <session.json> (deprecated, use migrate verify; retires at E77/F6 acceptance)"],
    "summary": "Verify a legacy migration session file.",
    "examples": ["harness-anything migrate verify migration-session/session.json"],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "legacy-scan",
    "usage": "legacy scan <path> [--json]",
    "summary": "Scan a legacy source tree for migration candidates.",
    "examples": ["harness-anything legacy scan .harness-private/legacy --json"],
    "parserId": "migration",
    "runnerId": "migration",
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
    "kind": "legacy-intake-plan",
    "usage": "legacy plan <path> [--out file] [--json]",
    "aliases": ["legacy intake-plan <path> (deprecated, use legacy plan; retires at E77/F6 acceptance)"],
    "summary": "Create an intake plan for a legacy source tree.",
    "examples": ["harness-anything legacy plan .harness-private/legacy --out intake-plan.json"],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary", "plan"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "legacy-copy-safe-docs",
    "usage": "legacy copy-docs <path> [--apply] [--json]",
    "aliases": ["legacy copy-safe-docs <path> (deprecated, use legacy copy-docs; retires at E77/F6 acceptance)"],
    "summary": "Copy safe legacy documents into the harness workspace.",
    "examples": ["harness-anything legacy copy-docs .harness-private/legacy --apply"],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["migrationMode", "rows", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "legacy-index",
    "usage": "legacy index <path> [--apply] [--json]",
    "summary": "Build or apply the legacy task index.",
    "examples": ["harness-anything legacy index .harness-private/legacy --apply"],
    "parserId": "migration",
    "runnerId": "migration",
    "receiptContract": {
      "data": ["migrationMode", "rows", "report"],
      "paths": ["primary", "index"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "legacy-verify",
    "usage": "legacy verify [--json]",
    "summary": "Verify legacy migration readiness and generated state.",
    "examples": ["harness-anything legacy verify --json"],
    "parserId": "migration",
    "runnerId": "migration",
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
    "kind": "git-diff",
    "usage": "git diff [--base <ref>] [--json]",
    "aliases": ["git-diff (deprecated, use git diff; retires at E77/F6 acceptance)"],
    "summary": "Capture git diff evidence against a base ref.",
    "examples": ["harness-anything git diff --base origin/main --json"],
    "parserId": "git-diff",
    "runnerId": "diagnostics",
    "receiptContract": {
      "data": ["report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "doctor",
    "usage": "doctor --json",
    "summary": "Report read-only local environment and harness diagnostics.",
    "examples": ["harness-anything doctor --json"],
    "parserId": "doctor",
    "runnerId": "diagnostics",
    "receiptContract": {
      "data": ["report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "diagnostics-command-usage",
    "usage": "diagnostics command-usage [--json]",
    "summary": "Analyze runtime-event JSONL command usage, failures, and unused evented command surfaces.",
    "examples": ["harness-anything diagnostics command-usage --json"],
    "parserId": "diagnostics",
    "runnerId": "diagnostics",
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
    "kind": "worktree-create",
    "usage": "worktree create --task <task-id> [--agent <id>|--branch-prefix <prefix>] [--base <ref>] [--path <path>] [--json]",
    "summary": "Create a task-bound public implementation worktree without destructive Git operations.",
    "examples": ["harness-anything worktree create --task task_01ABC --agent codex --base origin/main --json"],
    "parserId": "worktree",
    "runnerId": "worktree",
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "worktree-status",
    "usage": "worktree status --task <task-id> [--json]",
    "summary": "Report the stored binding and current Git status for a task-bound worktree.",
    "examples": ["harness-anything worktree status --task task_01ABC --json"],
    "parserId": "worktree",
    "runnerId": "worktree",
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
    "kind": "graph",
    "usage": "graph [--out <path>] [--focus <entity-ref>] [--projection <path>] [--include-archived] [--json]",
    "summary": "Generate a self-contained relation graph HTML panorama from the SQLite projection, with optional F5 cascade focus.",
    "examples": ["harness-anything graph --focus decision/dec_LEDGER_E51 --out .harness/generated/graph-panorama/index.html --json"],
    "parserId": "graph",
    "runnerId": "diagnostics",
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": ["primary", "projection"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  }
]);
