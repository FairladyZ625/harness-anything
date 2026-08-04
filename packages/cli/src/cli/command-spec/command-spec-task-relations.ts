import { defineCommandSpecs } from "./types.ts";
import { readCommandEventPolicy } from "./command-event-policies.ts";
import { parseCoreTaskArgs } from "../parsers/core-task.ts";
import { parseRelationArgs } from "../parsers/relation.ts";
import { runTaskLifecycleWithDemotions as runTaskLifecycleCommand } from "../../commands/core/task-lifecycle-demotions.ts";
import { runTaskQueryCommand } from "../../commands/core/task-query.ts";
import { runTaskViewCommand } from "../../commands/core/task-views.ts";

export const taskRelationCommandSpecs = defineCommandSpecs([
  {
    "kind": "task-show",
    "usage": "task show <id> [--view summary|trace|tree] [--json]",
    "options": [{"flag":"--view","description":"Select the summary, execution trace, or hierarchy tree projection."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "aliases": ["task trace <id> (deprecated, use task show --view trace)", "task tree <id> (deprecated, use task show --view tree)"],
    "aliasDisplay": {"task trace <id> (deprecated, use task show --view trace)":"hidden", "task tree <id> (deprecated, use task show --view tree)":"hidden"},
    "summary": "Show a task summary, execution trace, or hierarchy tree projection.",
    "examples": ["harness-anything task show task_01ABC --view trace --json"],
    "parse": parseCoreTaskArgs,
    "run": runTaskViewCommand,
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"],
      "successNext": { kind: "none" }
    },
    "eventPolicy": readCommandEventPolicy
  },
  {
    "kind": "relation-list",
    "usage": "relation list [--entity <entity-ref>] [--source <entity-ref>] [--target <entity-ref>] [--type <type>] [--state active|retired] [--json]",
    "options": [{"flag":"--entity","description":"Filter relation edges where either endpoint matches the entity ref."},{"flag":"--source","description":"Filter relation edges by source entity ref."},{"flag":"--target","description":"Set the relation target entity ref."},{"flag":"--type","description":"Filter relation edges by relation type."},{"flag":"--state","description":"Filter relation edges by relation state: active or retired."},{"flag":"--json","description":"Emit command-receipt/v2 JSON."}],
    "summary": "List projected relation graph edges with source, target, type, state, owner, and source path filters.",
    "examples": ["harness-anything relation list --entity task/task_01ABC --json", "harness-anything relation list --target decision/dec_LEDGER_E51 --state active --json"],
    "parse": parseRelationArgs,
    "run": runTaskQueryCommand,
    "receiptContract": {
      "data": ["rows", "report"],
      "paths": [],
      "successNext": { kind: "none" }
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
    "parse": parseCoreTaskArgs,
    "run": runTaskLifecycleCommand,
    "receiptContract": {
      "data": ["taskId", "report"],
      "paths": ["primary"],
      "successNext": { kind: "none" }
    },
    "eventPolicy": {
      "conflictMarkerPreflight": true,
      "runtimeEvent": "auto"
    }
  }
]);
