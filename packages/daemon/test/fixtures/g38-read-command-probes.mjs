// Selectors for the actual production CLI read actions. The inventory is still derived
// from daemonProtocolCommands; these are fixture inputs, not another command registry.
import {
  daemonProtocolCommands,
  allDaemonProtocolMethods,
  actionForDaemonMethod,
} from "../../src/protocol/daemon-protocol-commands.ts";
import { READ_DOCUMENT, READ_TASK_ID } from "./g38-read-ledger.mjs";

const agentVersion = ({ projection }) => ({
  agentId: "g38-agent",
  revision: projection.getEntity("agent", "g38-agent").workspaceRevision,
});
const selectors = {
  "task-list": { limit: 1 },
  "task-show": { taskId: READ_TASK_ID },
  "task-read-set": { taskId: READ_TASK_ID },
  "task-review": { taskId: READ_TASK_ID },
  "work-list": { limit: 1 },
  "work-show": { taskId: READ_TASK_ID },
  "relation-list": { source: `task/${READ_TASK_ID}`, limit: 1 },
  "relation-triples": {},
  graph: { ref: `task/${READ_TASK_ID}` },
  "doctor-health": {},
  "todo-list": {},
  "todo-show": { todoId: "todo_222222222222222222222222" },
  "entity-get": { entityKind: "agent", entityId: "g38-agent" },
  "agent-inspect": { agentId: "g38-agent" },
  "agent-history": { agentId: "g38-agent", limit: 1 },
  "agent-version-read": agentVersion,
  "agent-diff": (fixture) => {
    const value = agentVersion(fixture);
    return { agentId: value.agentId, from: value.revision, to: value.revision };
  },
  "squad-inspect": { squadId: "g38-squad" },
  "squad-status": { squadRunId: "squad_aaaaaaaaaaaaaaaaaaaaaaaa" },
  "schedule-show": { scheduleId: "g38-schedule" },
  "receipt-show": { opId: "read-agent" },
  "vertical-kind-list": {},
  "vertical-kind-show": { kindId: "research" },
  "entity-list": { entityKind: "agent" },
  "agent-list": {},
  "squad-list": {},
  "settings-read": {},
  "settings-show": {},
  "doc-status": { paths: [READ_DOCUMENT] },
  "doc-sync-dry-run": { paths: [READ_DOCUMENT] },
  "doc-show": { path: READ_DOCUMENT },
  "fact-type-list": {},
  "fact-show": { factId: "F-11111111" },
  "decision-validate": { decisionId: "dec_E2" },
  "decision-verify": { decisionId: "dec_E2" },
  "decision-list": {},
  "decision-show": { decisionId: "dec_E2" },
  "schedule-list": {},
  "schedule-reckon": { scheduleId: "g38-schedule" },
  "schedule-runs": { scheduleId: "g38-schedule", limit: 1 },
  "event-list": { limit: 1, entity: `task/${READ_TASK_ID}` },
  "event-show": { opId: "read-vertical" },
};
const binding = { actor: { principal: { personId: "person-g38" }, executor: null }, source: "local" };
function resultSize(value) {
  if (value?.evidence) {
    // CLI projections use the receipt evidence envelope. Text is a single selected object.
    if (!/^[{[]/u.test(value.evidence)) return 1;
    return resultSize(JSON.parse(value.evidence));
  }
  if (Array.isArray(value)) return value.length;
  for (const key of [
    "rows",
    "tasks",
    "entities",
    "decisions",
    "facts",
    "documents",
    "events",
    "items",
    "groups",
    "agents",
    "squads",
    "todos",
    "works",
    "runs",
    "schedules",
    "domainTypes",
  ])
    if (Array.isArray(value?.[key])) return value[key].length;
  return 1;
}
export const COMMAND_READ_PROBES = Object.fromEntries(
  daemonProtocolCommands
    .filter(({ id }) => Object.hasOwn(selectors, id))
    .map((command) => [
      `cli-${command.id}`,
      {
        reads: [`command:${command.id}`],
        run: (fixture) =>
          fixture.runtime.run(
            {
              kind: command.actionKind ?? command.id,
              ...(typeof selectors[command.id] === "function" ? selectors[command.id](fixture) : selectors[command.id]),
            },
            binding,
          ),
        size: resultSize,
      },
    ]),
);

export const ACTION_METHOD_READ_PROBES = Object.fromEntries(
  allDaemonProtocolMethods
    .filter((method) => method.commandClass === "repo-read" && Object.hasOwn(selectors, method.actionKind))
    .map((descriptor) => [
      descriptor.method,
      {
        reads: [`method:${descriptor.method}`],
        run: (fixture) => {
          const choice = selectors[descriptor.actionKind],
            payload = typeof choice === "function" ? choice(fixture) : choice;
          return fixture.runtime.run(actionForDaemonMethod(descriptor.method, payload), binding);
        },
        size: resultSize,
      },
    ]),
);
