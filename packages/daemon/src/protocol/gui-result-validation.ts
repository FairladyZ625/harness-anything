import {
  validateAgentRuntimeAttach,
  validateAgentRuntimeAttachEvent,
  type AgentRuntimeAttachEvent,
} from "../agent-runtime-stream.ts";
import {
  validateAgentRuntimeEvents,
  validateAgentRuntimeOverview,
  validateAgentRuntimeSessionGroups,
  validateAgentRuntimeSession,
} from "../agent-runtime-contract.ts";
import { validateSettingsV1 } from "../../../kernel/src/index.ts";
import {
  validateAgentEntityCatalog,
  validateAgentEntityDetail,
  validateAgentSkillCatalog,
  validateSquadEntityCatalog,
  validateSquadEntityDetail,
} from "../agent-entities.contract.ts";
import { validateObserveTailResult } from "./daemon-protocol-gui-types.ts";
import { validateSchedulesList } from "./schedules-gui-contract.ts";
import { isJsonObject } from "./json-rpc-types.ts";
import { validateSquadRunRead, validateSquadRunsList } from "../squad-run-contract.ts";
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
const validateDaemonSettingsRead: ResultValidator = (value) =>
  isJsonObject(value) &&
  Object.keys(value).length === 3 &&
  value.schema === "daemon.settings-read/v1" &&
  value.ok === true &&
  validateSettingsV1(value.settings).length === 0
    ? []
    : ["daemon settings read is invalid"];
const resultValidators = {
  "daemon.gui.system.read": validateSystemStatus,
  "daemon.gui.control.receipt": validateDaemonControlReceipt,
  "observe.tail": validateObserveTailResult,
  "repo.tasks.list": validateDaemonTaskSnapshotList,
  "repo.settings.read": validateDaemonSettingsRead,
  "repo.workspace.summary.read": validateDaemonWorkspaceSummary,
  "repo.agenda.read": validateDaemonAgenda,
  "repo.triadic.relationGraph": validateDaemonRelationGraph,
  "repo.decisions.list": validateDaemonDecisionList,
  "repo.tasks.document.read": validateDaemonDocumentRead,
  "repo.tasks.documents.list": validateDaemonTaskDocumentList,
  "repo.agentRuntime.overview": validateAgentRuntimeOverview,
  "repo.agentRuntime.sessionGroups": validateAgentRuntimeSessionGroups,
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
  "repo.schedules.list": validateSchedulesList,
  "repo.gui.catalog.snapshot": validateCatalogSnapshot,
  "repo.gui.catalog.preset.read": validateCatalogPreset,
  "repo.terminal.sessions.list": validateTerminalSessionList,
} satisfies Record<DaemonGuiRpcReadMethod, ResultValidator>;
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
  const errors =
    isJsonObject(value) && value.ok === false ? validateDaemonProtocolError(value) : resultValidators[method](value);
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
    const errors = validateDaemonProtocolError(value);
    if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
    return value as unknown as DaemonProtocolErrorResult;
  }
  return parseDaemonGuiActionResult(method, value);
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
