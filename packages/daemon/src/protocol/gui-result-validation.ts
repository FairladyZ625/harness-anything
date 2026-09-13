import {
  validateAgentRuntimeAttach,
  validateAgentRuntimeAttachEvent,
  type AgentRuntimeAttachEvent,
} from "../agent-runtime-stream.ts";
import {
  validateAgentRuntimeEvents,
  validateAgentRuntimeOverview,
  validateAgentRuntimeSession,
} from "../agent-runtime-contract.ts";
import {
  validateEntityActionExplanationSet,
  validateEntityKindCatalog,
  validateSettingsV1,
  validateVerticalDeclarationRead,
} from "../../../kernel/src/index.ts";
import {
  validateAgentEntityCatalog,
  validateAgentEntityDetail,
  validateAgentSkillCatalog,
  validateSquadEntityCatalog,
  validateSquadEntityDetail,
} from "./agent-entity-gui-contract.ts";
import { validateDaemonTaskCompletion, validateObserveTailResult } from "./daemon-protocol-gui-types.ts";
import { validateDaemonTaskSnapshotListServed } from "./daemon-protocol-validate-task.ts";
import { validationError } from "./daemon-protocol-validate-entities.ts";
import { validateArtifactsList } from "./artifacts-gui-contract.ts";
import { validateDaemonUseCaseProjection } from "./daemon-protocol-use-case-projection.ts";
import { validateEntityRowList } from "../entity-rows-read.ts";
import { validateEntityContentRead } from "../entity-content-read.ts";
import { validateEntityLocatorRead } from "../entity-locator-read.ts";
import { isJsonObject } from "./json-rpc-types.ts";
import { validateSquadRunRead, validateSquadRunsList } from "../squad-run-contract.ts";
import { validateCiObservatoryRead } from "../ci-observatory-read.ts";
import {
  validateCatalogPreset,
  validateCatalogRereadReceipt,
  validateCatalogSnapshot,
  validateDaemonControlReceipt,
  validateRuntimeSpawnReceipt,
  validateSystemStatus,
  validateTerminalAttach,
  validateTerminalAttachEvent,
  validateTerminalControlReceipt,
  validateTerminalDetachAck,
  validateTerminalInputAck,
  validateTerminalSessionList,
} from "../gui-s3-control.ts";
import {
  DaemonProtocolContractError,
  validateDaemonAgenda,
  validateDaemonDecisionList,
  validateDaemonDocumentRead,
  validateDaemonGuiCommandReceipt,
  validateDaemonProtocolError,
  validateDaemonRelationGraph,
  validateDaemonTaskDispatches,
  validateDaemonTaskDocumentList,
  validateDaemonTaskSnapshotList,
  validateDaemonWorkspaceSummary,
  type DaemonGuiActionMethod,
  type DaemonGuiActionResult,
  type DaemonGuiReadResultMap,
  type DaemonGuiRpcReadMethod,
  type DaemonStreamMethod,
  type DaemonStreamResultMap,
  type DaemonProtocolErrorResult,
} from "./daemon-protocol.contract.ts";
type ResultValidator = (value: unknown) => readonly string[];
const flatSettingsValue = (item: unknown): boolean =>
  typeof item === "string" ||
  typeof item === "number" ||
  typeof item === "boolean" ||
  (Array.isArray(item) && item.every((entry) => typeof entry === "string"));
export const validateDaemonSettingsRead: ResultValidator = (value) =>
  isJsonObject(value) &&
  Object.keys(value).length === 4 &&
  value.schema === "daemon.settings-read/v1" &&
  value.ok === true &&
  validateSettingsV1(value.settings).length === 0 &&
  isJsonObject(value.values) &&
  Object.values(value.values).every(flatSettingsValue)
    ? []
    : [
        validationError(
          "settings",
          isJsonObject(value) && value.schema !== "daemon.settings-read/v1"
            ? "schema"
            : isJsonObject(value) && value.ok !== true
              ? "ok"
              : isJsonObject(value) && validateSettingsV1(value.settings).length > 0
                ? "settings"
                : "values",
          isJsonObject(value)
            ? value.schema !== "daemon.settings-read/v1"
              ? value.schema
              : value.ok !== true
                ? value.ok
                : validateSettingsV1(value.settings).length > 0
                  ? value.settings
                  : value.values
            : value,
          "must be a valid daemon settings read",
        ),
      ];
const resultValidators = {
  "daemon.gui.system.read": validateSystemStatus,
  "daemon.gui.control.receipt": validateDaemonControlReceipt,
  "observe.tail": validateObserveTailResult,
  "repo.tasks.list": validateDaemonTaskSnapshotListServed,
  "repo.tasks.completion.read": validateDaemonTaskCompletion,
  "repo.tasks.wip": validateDaemonTaskWip,
  "repo.projection.read": validateDaemonUseCaseProjection,
  "repo.entity.actions.explain": validateEntityActionExplanationSet,
  "repo.entity.kinds.read": validateEntityKindCatalog,
  "repo.vertical.declaration.read": validateVerticalDeclarationRead,
  "repo.entity.rows.read": validateEntityRowList,
  "repo.entity.locator.read": validateEntityLocatorRead,
  "repo.entity.content.read": validateEntityContentRead,
  "repo.settings.read": validateDaemonSettingsRead,
  "repo.ci.observatory.read": validateCiObservatoryRead,
  "repo.workspace.summary.read": validateDaemonWorkspaceSummary,
  "repo.agenda.read": validateDaemonAgenda,
  "repo.triadic.relationGraph": validateDaemonRelationGraph,
  "repo.decisions.list": validateDaemonDecisionList,
  "repo.tasks.document.read": validateDaemonDocumentRead,
  "repo.tasks.documents.list": validateDaemonTaskDocumentList,
  "repo.artifacts.list": validateArtifactsList,
  "repo.agentRuntime.overview": validateAgentRuntimeOverview,
  "repo.agentRuntime.sessions.read": validateAgentRuntimeSession,
  "repo.agentRuntime.events.read": validateAgentRuntimeEvents,
  "repo.task.dispatches": validateDaemonTaskDispatches,
  "repo.agent.entities.list": validateAgentEntityCatalog,
  "repo.agent.entity.read": validateAgentEntityDetail,
  "repo.agent.skills.list": validateAgentSkillCatalog,
  "repo.squad.entities.list": validateSquadEntityCatalog,
  "repo.squad.entity.read": validateSquadEntityDetail,
  "repo.squad.runs.list": validateSquadRunsList,
  "repo.squad.run.read": validateSquadRunRead,
  "repo.gui.catalog.snapshot": validateCatalogSnapshot,
  "repo.gui.catalog.preset.read": validateCatalogPreset,
  "repo.terminal.sessions.list": validateTerminalSessionList,
} satisfies Record<DaemonGuiRpcReadMethod, ResultValidator>;

export function validateDaemonTaskWip(value: unknown): readonly string[] {
  if (!isJsonObject(value)) return [validationError("task-wip", "result", value, "must be an object")];
  const fields = ["ok", "limit", "limitLabel", "counted", "roots", "threshold"];
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)))
    return [validationError("task-wip", "result", value, "must have the exact task WIP fields")];
  const positive = (item: unknown) => Number.isSafeInteger(item) && Number(item) > 0,
    nonNegative = (item: unknown) => Number.isSafeInteger(item) && Number(item) >= 0,
    counted =
      Array.isArray(value.counted) &&
      value.counted.every(
        (row) =>
          isJsonObject(row) &&
          Object.keys(row).length === 3 &&
          typeof row.taskId === "string" &&
          row.taskId.length > 0 &&
          typeof row.title === "string" &&
          ["active", "blocked", "in_review"].includes(String(row.status)),
      ),
    roots =
      Array.isArray(value.roots) &&
      value.roots.every(
        (row) =>
          isJsonObject(row) &&
          Object.keys(row).length === 5 &&
          typeof row.taskId === "string" &&
          row.taskId.length > 0 &&
          ["declared", "derived"].includes(String(row.reason)) &&
          nonNegative(row.directChildCount) &&
          positive(row.threshold),
      );
  return value.ok === true &&
    positive(value.limit) &&
    typeof value.limitLabel === "string" &&
    value.limitLabel.length > 0 &&
    positive(value.threshold) &&
    counted &&
    roots
    ? []
    : [validationError("task-wip", "result", value, "must be a valid task WIP snapshot")];
}
export function parseDaemonGuiReadResult<M extends DaemonGuiRpcReadMethod>(
  method: M,
  value: unknown,
): DaemonGuiReadResultMap[M] {
  const errors = resultValidators[method](value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return value as DaemonGuiReadResultMap[M];
}
export function parseDaemonGuiReadResponse<M extends DaemonGuiRpcReadMethod>(
  method: M,
  value: unknown,
): DaemonGuiReadResultMap[M] | DaemonProtocolErrorResult {
  // Client inbound: rows are re-judged here because they crossed a process boundary; the
  // same-process exit (resultValidators) only re-checks the served shape.
  const errors =
    isJsonObject(value) && value.ok === false
      ? validateDaemonProtocolError(value)
      : method === "repo.tasks.list"
        ? validateDaemonTaskSnapshotList(value)
        : resultValidators[method](value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return value as DaemonGuiReadResultMap[M] | DaemonProtocolErrorResult;
}
export function parseDaemonGuiActionResult(method: DaemonGuiActionMethod, value: unknown): DaemonGuiActionResult {
  const errors =
    method === "daemon.gui.control.request"
      ? validateDaemonControlReceipt(value)
      : method === "repo.gui.catalog.reread"
        ? validateCatalogRereadReceipt(value)
        : method === "repo.agentRuntime.spawn"
          ? validateRuntimeSpawnReceipt(value)
          : method === "repo.terminal.input"
            ? validateTerminalInputAck(value)
            : method === "repo.terminal.detach"
              ? validateTerminalDetachAck(value)
              : method.startsWith("repo.terminal.") || method.startsWith("repo.runtimeInstance.auth.")
                ? validateTerminalControlReceipt(value)
                : validateDaemonGuiCommandReceipt(value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return value as DaemonGuiActionResult;
}
export function parseDaemonGuiActionResponse(
  method: DaemonGuiActionMethod,
  value: unknown,
): DaemonGuiActionResult | DaemonProtocolErrorResult {
  if (isJsonObject(value) && value.opId === "N/A") {
    if (!isDaemonProtocolErrorResult(value))
      throw new DaemonProtocolContractError("invalid_result", validateDaemonProtocolError(value).join("; "));
    return value;
  }
  return parseDaemonGuiActionResult(method, value);
}
function isDaemonProtocolErrorResult(value: unknown): value is DaemonProtocolErrorResult {
  return validateDaemonProtocolError(value).length === 0;
}
export function parseDaemonStreamResult<M extends DaemonStreamMethod>(
  method: M,
  value: unknown,
): DaemonStreamResultMap[M] {
  const errors =
    method === "repo.agentRuntime.attach" ? validateAgentRuntimeAttach(value) : validateTerminalAttach(value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return value as DaemonStreamResultMap[M];
}
export function parseDaemonStreamEvent(
  method: DaemonStreamMethod,
  value: unknown,
): AgentRuntimeAttachEvent | import("./json-rpc-types.ts").JsonObject {
  const errors =
    method === "repo.agentRuntime.attach" ? validateAgentRuntimeAttachEvent(value) : validateTerminalAttachEvent(value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return value as AgentRuntimeAttachEvent | import("./json-rpc-types.ts").JsonObject;
}
