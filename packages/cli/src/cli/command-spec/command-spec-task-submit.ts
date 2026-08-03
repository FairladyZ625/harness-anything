import { defineCommandSpecs } from "./types.ts";
import { writeCommandEventPolicy } from "./command-event-policies.ts";
import { parseCoreTaskArgs } from "../parsers/core-task.ts";
import { runTaskSubmitCommand } from "../../commands/core/task-submit.ts";

export const taskSubmitCommandSpecs = defineCommandSpecs([{
  "kind": "task-submit",
  "usage": "task submit <id> --from-file <submission.json> [--dry-run]",
  "options": [{"flag":"--from-file","description":"Read the schema-derived submission packet described below."},{"flag":"--dry-run","description":"Preview the daemon-planned submission transaction without writing."}],
  "summary": "Finalize/export the bound Session and atomically submit the active Execution into in_review.",
  "examples": ["harness-anything task submit task_01ABC --from-file submission.json"],
  "parse": parseCoreTaskArgs,
  "run": runTaskSubmitCommand,
  "receiptContract": {
    "data": ["taskId", "executionId", "status", "report"],
    "paths": [],
    "dryRun": {
      "data": ["taskId", "status", "report"],
      "optionalData": {
        "executionId": "Only emitted when dry-run can resolve the active Holder V2 execution."
      },
      "paths": []
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
