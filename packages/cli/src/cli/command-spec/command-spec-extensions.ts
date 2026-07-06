import { defineCommandSpecs } from "./types.ts";

export const extensionsCommandSpecs = defineCommandSpecs([
  {
    "kind": "preset-validate",
    "usage": "preset validate <manifest> [--kernel-version <version>] [--json]",
    "summary": "Validate a preset manifest against the preset schema.",
    "examples": ["harness-anything preset validate preset.json --kernel-version 1.0.0"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["preset", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "preset-list",
    "usage": "preset list [--json]",
    "summary": "List installed presets from project and user layers.",
    "examples": ["harness-anything preset list --json"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["presets", "issues"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "preset-inspect",
    "usage": "preset inspect <id> [--json]",
    "summary": "Inspect one preset manifest and public summary.",
    "examples": ["harness-anything preset inspect standard-task"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["preset", "issues"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "preset-check",
    "usage": "preset check <id> [--json]",
    "summary": "Check one preset for validity and materialization readiness.",
    "examples": ["harness-anything preset check standard-task"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["preset", "issues"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "preset-install",
    "usage": "preset install <folder> [--project] [--json]",
    "summary": "Install a preset folder into the project or user layer.",
    "examples": ["harness-anything preset install ./preset-dir --project"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["preset"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "preset-seed",
    "usage": "preset seed [--json]",
    "summary": "Seed built-in presets into the harness workspace.",
    "examples": ["harness-anything preset seed"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["presets", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "preset-audit",
    "usage": "preset audit [--json]",
    "summary": "Audit installed presets for validity and drift.",
    "examples": ["harness-anything preset audit --json"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["presets", "issues", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "preset-uninstall",
    "usage": "preset uninstall <id> [--project] [--json]",
    "summary": "Remove a preset from the project or user layer.",
    "examples": ["harness-anything preset uninstall standard-task --project"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["preset"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "preset-run",
    "usage": "preset run <id> <plan|scaffold|check> --task <id> [--allow-scripts] [--json]",
    "summary": "Run a preset entrypoint for a task package.",
    "examples": ["harness-anything preset run standard-task plan --task task_01ABC"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["taskId", "preset", "evidenceBundle", "generated", "rows", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "preset-action",
    "usage": "preset action <id> <action> --task <id> [--allow-scripts] [--json]",
    "summary": "Run a named preset action for a task package.",
    "examples": ["harness-anything preset action standard-task scaffold --task task_01ABC"],
    "parserId": "preset",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["preset", "evidenceBundle", "generated", "report"],
      "optionalData": {
        "taskId": "Only emitted by scripted preset actions that echo the task id in their script result.",
        "rows": "Only emitted when a scripted preset action writes a numeric rows value in its result."
      },
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "script-list",
    "usage": "script list [--source user|vertical|preset] [--purpose scaffold|generate|transform|audit] [--json]",
    "summary": "List script-entry/v1 entries exposed by installed extensions.",
    "examples": ["harness-anything script list --source preset"],
    "parserId": "script",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["scripts", "rows"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "script-inspect",
    "usage": "script inspect <id> [--json]",
    "summary": "Inspect one script-entry/v1 contract.",
    "examples": ["harness-anything script inspect preset:publish-standard:scaffold"],
    "parserId": "script",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["script"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "script-run",
    "usage": "script run <id> [--task <id>] [--input key=value] [--dry-run] [--json]",
    "summary": "Run one script-entry/v1 entry through the ScriptHost permission boundary.",
    "examples": ["harness-anything script run preset:publish-standard:scaffold --task task_01ABC --input mode=smoke"],
    "parserId": "script",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["script", "runId", "evidenceBundle", "generated", "report"],
      "optionalData": {
        "rows": "Only emitted when a script writes a numeric rows value in its script-result/v1 payload."
      },
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "module-list",
    "usage": "module list [--json]",
    "summary": "List registered project modules.",
    "examples": ["harness-anything module list --json"],
    "parserId": "module",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["modules"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "module-inspect",
    "usage": "module inspect <key> [--json]",
    "summary": "Inspect one registered module.",
    "examples": ["harness-anything module inspect kernel"],
    "parserId": "module",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["module"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "module-register",
    "usage": "module register <key> --title <title> --scope <path> [--prefix <prefix>] [--status <status>] [--branch <branch>] [--owner <owner>] [--current-step <step>] [--shared <path>] [--depends-on <module>] [--json]",
    "summary": "Register or update a project module definition.",
    "examples": ["harness-anything module register kernel --title \"Kernel\" --scope \"packages/kernel/**\""],
    "parserId": "module",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["module"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "module-scaffold",
    "usage": "module scaffold <key> [--json]",
    "summary": "Create the standard files for a registered module.",
    "examples": ["harness-anything module scaffold kernel"],
    "parserId": "module",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["module"],
      "paths": ["primary", "modulePlan"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "module-unregister",
    "usage": "module unregister <key> [--json]",
    "summary": "Mark a module as unregistered.",
    "examples": ["harness-anything module unregister kernel"],
    "parserId": "module",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["module"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "module-step",
    "usage": "module step <key> <step> --state <state> [--json]",
    "aliases": ["module-step <key> <step> (deprecated, use module step; retires at E77/F6 acceptance)"],
    "summary": "Update a module step state.",
    "examples": ["harness-anything module step kernel KR-01 --state done"],
    "parserId": "module",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["module"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  },
  {
    "kind": "vertical-validate",
    "usage": "vertical validate [software/coding|<path>] [--json]",
    "summary": "Validate a vertical definition file or built-in vertical.",
    "examples": ["harness-anything vertical validate software/coding"],
    "parserId": "vertical",
    "runnerId": "extension",
    "receiptContract": {
      "data": ["issues"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  },
  {
    "kind": "gui",
    "usage": "gui",
    "summary": "Launch the local desktop GUI controller.",
    "examples": ["harness-anything gui"],
    "parserId": "gui",
    "runnerId": "gui",
    "receiptContract": {
      "data": ["launchPlan"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  }
]);
