import { DAEMON_WORKSPACE_SUMMARY_SCHEMA } from "./daemon-protocol-schema-ids.ts";
import {
  exactRecord,
  integer,
  statusWord,
  stringArray,
  validationEntityId,
  validationError,
  warningArray,
  recordShapeError,
} from "./daemon-protocol-validate-entities.ts";
import { decisionStateWords, taskStatusWords } from "./daemon-protocol-vocabulary.ts";
import { isJsonObject } from "./json-rpc-types.ts";

export function validateDaemonWorkspaceSummary(value: unknown): readonly string[] {
  const entityId = "workspace",
    shapeError = recordShapeError(entityId, value, DAEMON_WORKSPACE_SUMMARY_SCHEMA.required);
  if (shapeError) return [shapeError];
  if (!isJsonObject(value)) return [];
  for (const [field, actual, valid, expectation] of [
    ["schema", value.schema, value.schema === DAEMON_WORKSPACE_SUMMARY_SCHEMA.id, "must match the workspace schema"],
    ["ok", value.ok, value.ok === true, "must be true"],
    ["status", value.status, value.status === "ready" || value.status === "pending", "must be ready or pending"],
    ["watermark", value.watermark, integer(value.watermark), "must be an integer"],
    ["sourceRevision", value.sourceRevision, integer(value.sourceRevision), "must be an integer"],
    ["warnings", value.warnings, warningArray(value.warnings), "must contain valid warnings"],
  ] as const)
    if (!valid) return [validationError(entityId, field, actual, expectation)];
  const taskStatuses = [...taskStatusWords, "unknown"],
    tasks = value.tasks,
    decisions = value.decisions;
  const tasksShapeError = recordShapeError(entityId, tasks, ["total", "byStatus"], undefined, "tasks");
  if (tasksShapeError) return [tasksShapeError];
  if (!isJsonObject(tasks)) return [];
  if (!integer(tasks.total) || Number(tasks.total) < 0)
    return [validationError(entityId, "tasks.total", tasks.total, "must be a non-negative integer")];
  const byStatus = tasks.byStatus;
  const statusShapeError = recordShapeError(entityId, byStatus, taskStatuses, undefined, "tasks.byStatus");
  if (statusShapeError) return [statusShapeError];
  if (!isJsonObject(byStatus)) return [];
  const invalidTaskStatus = taskStatuses.find((status) => !integer(byStatus[status]) || Number(byStatus[status]) < 0);
  if (invalidTaskStatus)
    return [
      validationError(
        entityId,
        `tasks.byStatus.${invalidTaskStatus}`,
        byStatus[invalidTaskStatus],
        "must be a non-negative integer",
      ),
    ];
  if (taskStatuses.reduce((sum, status) => sum + Number(byStatus[status]), 0) !== tasks.total)
    return [validationError(entityId, "tasks.total", tasks.total, "must equal the by-status sum")];
  const decisionsShapeError = recordShapeError(
    entityId,
    decisions,
    ["total", "inboxCount", "byState", "groups"],
    undefined,
    "decisions",
  );
  if (decisionsShapeError) return [decisionsShapeError];
  if (!isJsonObject(decisions)) return [];
  if (!integer(decisions.total) || Number(decisions.total) < 0)
    return [validationError(entityId, "decisions.total", decisions.total, "must be a non-negative integer")];
  if (!integer(decisions.inboxCount) || Number(decisions.inboxCount) < 0)
    return [validationError(entityId, "decisions.inboxCount", decisions.inboxCount, "must be a non-negative integer")];
  if (!Array.isArray(decisions.groups))
    return [validationError(entityId, "decisions.groups", decisions.groups, "must be an array")];
  const byDecisionState = decisions.byState;
  const stateShapeError = recordShapeError(
    entityId,
    byDecisionState,
    decisionStateWords,
    undefined,
    "decisions.byState",
  );
  if (stateShapeError) return [stateShapeError];
  if (!isJsonObject(byDecisionState)) return [];
  const invalidDecisionState = decisionStateWords.find(
    (state) => !integer(byDecisionState[state]) || Number(byDecisionState[state]) < 0,
  );
  if (invalidDecisionState)
    return [
      validationError(
        entityId,
        `decisions.byState.${invalidDecisionState}`,
        byDecisionState[invalidDecisionState],
        "must be a non-negative integer",
      ),
    ];
  if (decisionStateWords.reduce((sum, state) => sum + Number(byDecisionState[state]), 0) !== decisions.total)
    return [validationError(entityId, "decisions.total", decisions.total, "must equal the by-state sum")];
  const groupIds = ["proposed", "in_effect", "rejected", "deferred", "retired"],
    decisionIds: string[] = [],
    states: string[] = [];
  if (decisions.groups.length !== groupIds.length)
    return [
      validationError(entityId, "decisions.groups.length", decisions.groups.length, `must be ${groupIds.length}`),
    ];
  for (const [index, group] of decisions.groups.entries()) {
    if (
      !exactRecord(group, ["id", "states", "count", "decisionIds"]) ||
      group.id !== groupIds[index] ||
      !Array.isArray(group.states) ||
      group.states.some((state) => !statusWord(decisionStateWords, state)) ||
      new Set(group.states).size !== group.states.length ||
      !integer(group.count) ||
      Number(group.count) < 0 ||
      !stringArray(group.decisionIds) ||
      new Set(group.decisionIds).size !== group.decisionIds.length ||
      group.count !== group.decisionIds.length
    )
      return [
        validationError(
          validationEntityId(group, ["id"], `decision-group:${index}`),
          `decisions.groups[${index}]`,
          group,
          "must be a valid decision group",
        ),
      ];
    states.push(...group.states.map(String));
    decisionIds.push(...group.decisionIds.map(String));
  }
  if (
    states.length !== decisionStateWords.length ||
    !decisionStateWords.every((state) => states.includes(state)) ||
    new Set(decisionIds).size !== decisionIds.length ||
    decisions.total !== decisionIds.length ||
    decisions.inboxCount !== decisions.groups[0].count
  )
    return [
      validationError(entityId, "decisions.total", decisions.total, "must match unique grouped decisions and inbox"),
    ];
  return [];
}
