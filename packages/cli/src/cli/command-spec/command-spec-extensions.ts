import { defineCommandSpecs } from "./types.ts";
import { parseModuleArgs } from "../parsers/extensions-module.ts";
import { parsePresetArgs } from "../parsers/extensions-preset.ts";
import { parseScriptArgs } from "../parsers/extensions-script.ts";
import { parseVerticalArgs } from "../parsers/extensions-vertical.ts";
import { parseGuiArgs } from "../parsers/gui.ts";
import { runExtensionRunnerCommand } from "../../commands/core/extension.ts";
import { runGuiCommand } from "../../commands/core/gui.ts";

export const extensionsCommandSpecs = defineCommandSpecs([
  {
    "kind": "preset-validate",
    "usage": "preset validate <manifest> [--kernel-version <version>] [--json]",
    "options": [{"flag":"--kernel-version","description":"Validate against a kernel version."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Validate a preset manifest and its executable package readiness.",
    "examples": ["harness-anything preset validate preset.json --kernel-version 1.0.0"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List installed presets from project and user layers.",
    "examples": ["harness-anything preset list --json"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Inspect one preset manifest and public summary.",
    "examples": ["harness-anything preset inspect standard-task"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Check one preset for validity and materialization readiness.",
    "examples": ["harness-anything preset check standard-task"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
    "receiptContract": {
      "data": ["preset", "issues", "report"],
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
    "options": [{"flag":"--project","description":"Use the project preset layer."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Install a preset folder into the project or user layer.",
    "examples": ["harness-anything preset install ./preset-dir --project"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
    "receiptContract": {
      "data": ["preset", "report"],
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Seed built-in presets into the harness workspace.",
    "examples": ["harness-anything preset seed"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Audit installed presets for validity and drift.",
    "examples": ["harness-anything preset audit --json"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
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
    "usage": "preset uninstall <id> [--project] [--dry-run] [--json]",
    "options": [{"flag":"--project","description":"Use the project preset layer."},{"flag":"--dry-run","description":"Preview inbound Task impact without removing the preset."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Remove a preset from the project or user layer.",
    "examples": ["harness-anything preset uninstall standard-task --project --dry-run"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
    "receiptContract": {
      "data": ["preset", "report"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "preset-run",
    "usage": "preset run <id> <plan|scaffold|check|audit|gather|render-html> --task <id> [--allow-scripts] [--input key=value] [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--allow-scripts","description":"Allow preset script execution."},{"flag":"--input","description":"Provide an input path or one script input as key=value; repeat for script inputs."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Run a preset entrypoint for a task package.",
    "examples": ["harness-anything preset run standard-task plan --task task_01ABC --input mode=smoke"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
    "receiptContract": {
      "data": ["taskId", "preset", "evidenceBundle", "generated", "report"],
      "optionalData": {
        "rows": "Only emitted when a scripted preset run writes a numeric rows value in its result.",
        "runId": "Only emitted by the semantic script host for an executable v3 entrypoint.",
        "capabilityReceipt": "Only emitted by v3 semantic execution with its exact provider bindings."
      },
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "deferred"
    }
  },
  {
    "kind": "preset-action",
    "usage": "preset action <id> <action> --task <id> [--allow-scripts] [--input key=value] [--json]",
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--allow-scripts","description":"Allow preset script execution."},{"flag":"--input","description":"Provide an input path or one script input as key=value; repeat for script inputs."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Run a named preset action for a task package.",
    "examples": ["harness-anything preset action standard-task scaffold --task task_01ABC --input mode=smoke"],
    "parse": parsePresetArgs,
    "run": runExtensionRunnerCommand,
    "receiptContract": {
      "data": ["taskId", "preset", "evidenceBundle", "generated", "report"],
      "optionalData": {
        "rows": "Only emitted when a scripted preset action writes a numeric rows value in its result.",
        "runId": "Only emitted by the semantic script host for an executable v3 entrypoint.",
        "capabilityReceipt": "Only emitted by v3 semantic execution with its exact provider bindings."
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
    "usage": "script list [--source user|vertical|preset] [--purpose scaffold|generate|transform|audit] [--kind action|check] [--json]",
    "options": [{"flag":"--source","description":"Filter script entries by extension source: user, vertical, or preset."},{"flag":"--purpose","description":"Filter script entries by declared purpose."},{"flag":"--kind","description":"Filter script entries by script kind: action or check."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List script-entry/v1 entries exposed by installed extensions.",
    "examples": ["harness-anything script list --source preset"],
    "parse": parseScriptArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Inspect one script-entry/v1 contract.",
    "examples": ["harness-anything script inspect vertical:software-coding:architecture-check"],
    "parse": parseScriptArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--task","description":"Set the task id."},{"flag":"--input","description":"Provide an input path or one script input as key=value; repeat for script inputs."},{"flag":"--dry-run","description":"Preview the operation without writing changes."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Run one script-entry/v1 entry through the ScriptHost permission boundary.",
    "examples": ["harness-anything script run vertical:software-coding:architecture-check --task task_01ABC --dry-run"],
    "parse": parseScriptArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List registered project modules.",
    "examples": ["harness-anything module list --json"],
    "parse": parseModuleArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Inspect one registered module.",
    "examples": ["harness-anything module inspect kernel"],
    "parse": parseModuleArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--title","description":"Set the required task title used for generated package metadata and slug."},{"flag":"--scope","description":"Set the module scope."},{"flag":"--prefix","description":"Set the module id prefix."},{"flag":"--status","description":"Set the external or module status."},{"flag":"--branch","description":"Set the module branch."},{"flag":"--owner","description":"Set the module owner."},{"flag":"--current-step","description":"Set the current module step."},{"flag":"--shared","description":"Register a shared path for the module."},{"flag":"--depends-on","description":"Register a module dependency."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Register or update a project module definition.",
    "examples": ["harness-anything module register kernel --title \"Kernel\" --scope \"packages/kernel/**\""],
    "parse": parseModuleArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Create the standard files for a registered module.",
    "examples": ["harness-anything module scaffold kernel"],
    "parse": parseModuleArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Mark a module as unregistered.",
    "examples": ["harness-anything module unregister kernel"],
    "parse": parseModuleArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--state","description":"Set the module step state."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["module-step <key> <step> (deprecated, use module step; retires at E77/F6 acceptance)"],
    "aliasDisplay": {"module-step <key> <step> (deprecated, use module step; retires at E77/F6 acceptance)":"hidden"},
    "summary": "Update a module step state.",
    "examples": ["harness-anything module step kernel KR-01 --state done"],
    "parse": parseModuleArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Validate a vertical definition file or built-in vertical.",
    "examples": ["harness-anything vertical validate software/coding"],
    "parse": parseVerticalArgs,
    "run": runExtensionRunnerCommand,
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
    "options": [],
    "summary": "Launch the local desktop GUI controller.",
    "examples": ["harness-anything gui"],
    "parse": parseGuiArgs,
    "run": runGuiCommand,
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
