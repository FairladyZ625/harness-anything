import { defineCommandSpecs } from "./types.ts";
import { parseCompletionArgs } from "../parsers/completion.ts";
import { runCompletionCommand } from "../../commands/core/completion.ts";
import { parseCoreTaskArgs } from "../parsers/core-task.ts";
import { runTaskRetireExecution } from "../../commands/core/task-execution-retirement.ts";

export const completionCommandSpecs = defineCommandSpecs([
  {
    "kind": "task-retire-execution",
    "usage": "task retire-execution <id> --execution-id <execution-id> --reason <reason> [--json]",
    "options": [{"flag":"--execution-id","description":"Select the stale active Execution round to retire."},{"flag":"--reason","description":"Record why the abandoned active round is being retired."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "Explicitly retire an active Execution only when the Task has no live holder lease, preserving an actor/time/reason audit entry.",
    "examples": ["harness-anything task retire-execution task_01ABC --execution-id exe_01ABC --reason \"superseded abandoned claim\" --json"],
    "parse": parseCoreTaskArgs,
    "run": runTaskRetireExecution,
    "receiptContract": {
      "data": ["taskId", "executionId", "report"],
      "paths": ["primary"]
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    },
    "admission": {
      "nounOwnership": "Task-owned Execution lifecycle repair; the command adds no parallel top-level noun.",
      "lifecycle": "permanent",
      "decisionRef": "decision/dec_01KY7R5NDVDZ6NFKXGT9Q82DC8"
    }
  },
  {
    "kind": "completion",
    "usage": "completion <bash|zsh> [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON instead of the raw completion script."}],
    "summary": "Generate a shell completion script from the command registry.",
    "examples": ["harness-anything completion zsh", "harness-anything completion bash"],
    "parse": parseCompletionArgs,
    "run": runCompletionCommand,
    "receiptContract": {
      "data": ["shell", "completionScript"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  }
]);
