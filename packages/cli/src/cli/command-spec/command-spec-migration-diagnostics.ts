import { defineCommandSpecs } from "./types.ts";
import { parseDoctorArgs } from "../parse-doctor-args.ts";
import { parseGitDiffArgs } from "../parse-git-diff-args.ts";
import { parseMigrationArgs } from "../parse-migration-args.ts";
import { parseDiagnosticsArgs } from "../parsers/diagnostics.ts";
import { parseGraphArgs } from "../parsers/graph.ts";
import { parseWorktreeArgs } from "../parsers/worktree.ts";
import { runDiagnosticsCommand } from "../../commands/core/diagnostics.ts";
import { runMigrationCommand } from "../../commands/core/migration.ts";
import { runWorktreeCommand } from "../../commands/core/worktree.ts";

export const migrationDiagnosticsCommandSpecs = defineCommandSpecs([
  {
    "kind": "adopt-multica",
    "usage": "adopt multica <ref> --task <task-id> [--status <status>] [--title <title>] [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--status","description":"Set the external or module status."},{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Bind a fresh Multica issue snapshot to a new local task package.",
    "examples": ["harness-anything adopt multica EXT-123 --task task_01ABC --status active --title \"External task\""],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--status","description":"Set the external or module status."},{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Read and report the current Multica issue snapshot.",
    "examples": ["harness-anything snapshot multica EXT-123 --json"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--limit","description":"Limit the number of planned items."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["migrate-plan (deprecated, use migrate plan; retires at E77/F6 acceptance)"],
    "summary": "Plan legacy structure migration work.",
    "examples": ["harness-anything migrate plan --limit 20"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--plan","description":"Plan without applying changes."},{"flag":"--apply","description":"Apply the operation instead of planning it."},{"flag":"--confirm-plan","description":"Confirm a migration plan before applying it."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["migrate-structure (deprecated, use migrate structure; retires at E77/F6 acceptance)"],
    "summary": "Plan or apply legacy directory structure migration.",
    "examples": ["harness-anything migrate structure --plan"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--apply","description":"Apply the operation instead of planning it."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["migrate-anchors (deprecated, use migrate anchors; retires at E77/F6 acceptance)"],
    "summary": "Backfill missing required template anchors into existing task documents.",
    "examples": ["harness-anything migrate anchors --dry-run --json"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "kind": "migrate-attribution",
    "usage": "migrate attribution [--dry-run|--apply --confirm-plan <id>] [--json]",
    "options": [{"flag":"--dry-run","description":"Produce a deterministic attribution backfill report without writing; this is the default."},{"flag":"--apply","description":"Append only the exact-match migration events from the confirmed plan."},{"flag":"--confirm-plan","description":"Confirm the exact plan id returned by dry-run before applying."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Plan or apply immutable synthetic attribution events for honest legacy matches.",
    "examples": ["harness-anything migrate attribution --dry-run --json", "harness-anything migrate attribution --apply --confirm-plan abf_0123456789abcdef"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "kind": "migrate-fact-execution",
    "usage": "migrate fact-execution [--dry-run|--apply --confirm-plan <id>] [--apply-manual <fact-ref-list>] [--batch-size <n>] [--batch <n>] [--sample-size <n>] [--json]",
    "options": [{"flag":"--dry-run","description":"Classify and preview without writing; this is the default."},{"flag":"--apply","description":"Apply the selected automatic or manual-list candidates in the selected batch."},{"flag":"--apply-manual","description":"Select exact fact/<task-id>/<fact-id> refs from a root-relative list file, bypassing three-signal classification."},{"flag":"--confirm-plan","description":"Confirm the exact plan id returned by dry-run before applying."},{"flag":"--batch-size","description":"Limit each coordinated batch to 1-200 selected candidates."},{"flag":"--batch","description":"Select the one-based batch number."},{"flag":"--sample-size","description":"Set samples per classification bucket."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Migrate automatic three-signal Facts or an exact manually confirmed Fact list into execution outputs.",
    "examples": ["harness-anything migrate fact-execution --dry-run --json", "harness-anything migrate fact-execution --dry-run --apply-manual artifacts/facts.txt --json", "harness-anything migrate fact-execution --apply --confirm-plan fxm_0123456789abcdef --batch 1"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--apply","description":"Apply the operation instead of planning it."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["migrate-provenance (deprecated, use migrate provenance; retires at E77/F6 acceptance)"],
    "summary": "Backfill explicit synthetic provenance into pre-R2 task packages.",
    "examples": ["harness-anything migrate provenance --dry-run"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--plan-only","description":"Create a migration plan without applying it."},{"flag":"--out-dir","description":"Set the output directory."},{"flag":"--session-dir","description":"Set the migration session directory."},{"flag":"--locale","description":"Set generated content locale."},{"flag":"--assume-locale","description":"Set the assumed locale for migrated content."},{"flag":"--allow-dirty","description":"Allow running while the working tree has changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["migrate-run (deprecated, use migrate run; retires at E77/F6 acceptance)"],
    "summary": "Run the legacy migration pipeline into a session directory.",
    "examples": ["harness-anything migrate run --plan-only --session-dir migration-session --locale zh-CN"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["migrate-verify <session.json> (deprecated, use migrate verify; retires at E77/F6 acceptance)"],
    "summary": "Verify a legacy migration session file.",
    "examples": ["harness-anything migrate verify migration-session/session.json"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Scan a legacy source tree for migration candidates.",
    "examples": ["harness-anything legacy scan .harness-private/legacy --json"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--out","description":"Write the generated plan to a file."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["legacy intake-plan <path> (deprecated, use legacy plan; retires at E77/F6 acceptance)"],
    "summary": "Create an intake plan for a legacy source tree.",
    "examples": ["harness-anything legacy plan .harness-private/legacy --out intake-plan.json"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--apply","description":"Apply the operation instead of planning it."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["legacy copy-safe-docs <path> (deprecated, use legacy copy-docs; retires at E77/F6 acceptance)"],
    "summary": "Copy safe legacy documents into the harness workspace.",
    "examples": ["harness-anything legacy copy-docs .harness-private/legacy --apply"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--apply","description":"Apply the operation instead of planning it."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Build or apply the legacy task index.",
    "examples": ["harness-anything legacy index .harness-private/legacy --apply"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Verify legacy migration readiness and generated state.",
    "examples": ["harness-anything legacy verify --json"],
    "parse": parseMigrationArgs,
    "run": runMigrationCommand,
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
    "options": [{"flag":"--base","description":"Set the git base ref."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["git-diff (deprecated, use git diff; retires at E77/F6 acceptance)"],
    "summary": "Capture git diff evidence against a base ref.",
    "examples": ["harness-anything git diff --base origin/main --json"],
    "parse": parseGitDiffArgs,
    "run": runDiagnosticsCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Report read-only local environment and harness diagnostics.",
    "examples": ["harness-anything doctor --json"],
    "parse": parseDoctorArgs,
    "run": runDiagnosticsCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Analyze runtime-event JSONL command usage, failures, and unused evented command surfaces.",
    "examples": ["harness-anything diagnostics command-usage --json"],
    "parse": parseDiagnosticsArgs,
    "run": runDiagnosticsCommand,
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
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--agent","description":"Set the agent namespace used for task worktree branch names."},{"flag":"--branch-prefix","description":"Set the branch namespace prefix used before the task worktree slug."},{"flag":"--base","description":"Set the git base ref."},{"flag":"--path","description":"Set an explicit filesystem path."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Create a task-bound public implementation worktree without destructive Git operations.",
    "examples": ["harness-anything worktree create --task task_01ABC --agent codex --base origin/main --json"],
    "parse": parseWorktreeArgs,
    "run": runWorktreeCommand,
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
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Report the stored binding and current Git status for a task-bound worktree.",
    "examples": ["harness-anything worktree status --task task_01ABC --json"],
    "parse": parseWorktreeArgs,
    "run": runWorktreeCommand,
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
    "options": [{"flag":"--out","description":"Write the generated plan to a file."},{"flag":"--focus","description":"Focus graph output on one entity ref and include F5 cascade impact."},{"flag":"--projection","description":"Read a specific SQLite projection file instead of the default harness projection cache."},{"flag":"--include-archived","description":"Include archived task packages."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Generate a self-contained relation graph HTML panorama from the SQLite projection, with optional F5 cascade focus.",
    "examples": ["harness-anything graph --focus decision/dec_LEDGER_E51 --out .harness/generated/graph-panorama/index.html --json"],
    "parse": parseGraphArgs,
    "run": runDiagnosticsCommand,
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
