import { defineCommandSpecs } from "./types.ts";
import { writeCommandEventPolicy } from "./command-event-policies.ts";
import { parseCoreTaskArgs } from "../parsers/core-task.ts";
import { runTaskSubmitCommand } from "../../commands/core/task-submit.ts";

export const taskSubmitCommandSpecs = defineCommandSpecs([{
  "kind": "task-submit",
  "usage": "task submit <id> (--from-file <submission.json>|--json-input <json>) [--dry-run]",
  "options": [{"flag":"--from-file","description":"Read the schema-derived submission packet described below."},{"flag":"--json-input","description":"Read command input JSON from an inline string; flags remain shortcut overrides."},{"flag":"--dry-run","description":"Preview the daemon-planned submission transaction without writing."}],
  "summary": "Finalize/export the bound Session and atomically submit the active Execution into in_review.",
  "examples": ["harness-anything task submit task_01ABC --from-file submission.json"],
  "parse": parseCoreTaskArgs,
  "run": runTaskSubmitCommand,
  "receiptContract": {
    "data": ["taskId", "executionId", "status", "report"],
    "paths": [],
    "successNext": {
      kind: "actions",
      "actions": [{
        "command": "ha task review-execution {taskId} --help",
        "description": "The Execution is submitted; an authorized reviewer should record the verdict and checked evidence before completion."
      }]
    },
    "dryRun": {
      "data": ["taskId", "status", "report"],
      "optionalData": {
        "executionId": "Only emitted when dry-run can resolve the active Holder V2 execution."
      },
      "paths": [],
      "successNext": { kind: "none" }
    }
  },
  "eventPolicy": writeCommandEventPolicy,
  "admission": {
    "nounOwnership": "Typed Task lifecycle submission command; it does not introduce a new top-level noun.",
    "lifecycle": "permanent",
    "decisionRef": "decision/dec_01KXQM6Y74WG8XERXKQS6QKPHH",
    "chain": { "stepCount": 1, "submissionFieldCount": 6, "structuredInput": true }
  }
}]);
