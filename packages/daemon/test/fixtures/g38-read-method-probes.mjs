import { READ_TASK_ID } from "./g38-read-ledger.mjs";
// Named RPC selectors are kept separate from CLI actions: otherwise measuring task-list's
// GUI handler could miss work added only to the CLI receipt path (and conversely).
const selectors = {
  "repo.entity.locator.read": { locatorKind: "repository-path", locatorValue: "harness/harness.yaml" },
  "repo.settings.read": {},
  "repo.agent.entity.read": { agentId: "g38-agent" },
  "repo.squad.entity.read": { squadId: "g38-squad" },
  "repo.squad.run.read": { squadRunId: "squad_aaaaaaaaaaaaaaaaaaaaaaaa" },
  "repo.agent.history.read": { agentId: "g38-agent", limit: 1 },
  "repo.artifacts.list": { kind: "html" },
  "repo.entity.content.read": { entityKind: "agent", entityId: "g38-agent" },
  "repo.tasks.wip": {},
  "repo.works.index": {},
  "repo.works.briefs.read": {},
  "repo.work.topology.read": { workRootTaskId: READ_TASK_ID },
  "repo.workspace.scope.read": { rootTaskId: READ_TASK_ID, limit: 1 },
  "repo.tasks.runtimeContext.read": { taskId: READ_TASK_ID },
  "repo.tasks.completion.read": { taskId: READ_TASK_ID },
  "repo.tasks.deliveryDiff.read": { taskId: READ_TASK_ID },
  "repo.vertical.declaration.read": {},
  "repo.entity.kinds.read": {},
  "repo.entity.rows.read": {},
  "repo.decisions.list": { projection: "summary" },
  "repo.agent.entities.list": {},
  "repo.squad.entities.list": {},
  "repo.squad.runs.list": { limit: 1 },
  "repo.agentRuntime.tokenUsage": { range: "today" },
  "repo.agentRuntime.tokenUsageDetail": { range: "today", agentId: "parity-agent" },
  "repo.reckoning.signals.read": { generatedAt: "2026-11-05T00:00:00Z", windowHours: 24 },
};
function resultSize(value) {
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
    "signals",
  ])
    if (Array.isArray(value?.[key])) return value[key].length;
  return 1;
}
export const METHOD_READ_PROBES = Object.fromEntries(
  Object.entries(selectors).map(([method, payload]) => [
    method,
    {
      reads: [`method:${method}`],
      run: ({ runtime }) => runtime.read(method, payload),
      size: resultSize,
    },
  ]),
);
export const PROJECTION_READ_PROBES = Object.fromEntries(
  [
    ["schedule-plane", "plane", {}],
    ["schedule-run-history", "runs", { scheduleId: "g38-schedule", limit: 1 }],
    ["runtime-session-groups", "groups", { since: "2026-11-01T00:00:00Z", limit: 1 }],
  ].map(([name, facet, selector]) => [
    `projection:${name}`,
    {
      reads: ["method:repo.projection.read"],
      run: ({ runtime }) => runtime.read("repo.projection.read", { name, facet, ...selector }),
      size: (value) => resultSize(value.projection),
    },
  ]),
);
