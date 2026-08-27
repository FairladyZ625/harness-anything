import {
  validateAgentRuntimeEvents,
  validateAgentRuntimeOverview,
  validateAgentRuntimeSessionGroups,
  validateAgentRuntimeSession,
} from "../agent-runtime-contract.ts";
import {
  validateAgentEntityCatalog,
  validateAgentEntityDetail,
  validateAgentSkillCatalog,
  validateSquadEntityCatalog,
  validateSquadEntityDetail,
} from "../agent-entities.contract.ts";
import { validateObserveTailResult } from "./daemon-protocol-gui-types.ts";
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
  validateDaemonSettingsRead,
  type DaemonGuiActionMethod,
  type DaemonGuiActionResult,
  type DaemonGuiReadResultMap,
  type DaemonGuiRpcReadMethod,
  type DaemonGuiStreamMethod,
  type DaemonGuiStreamResultMap,
  type DaemonProtocolErrorResult,
} from "./daemon-protocol.contract.ts";
type ResultValidator = (value: unknown) => readonly string[];
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
export function parseDaemonGuiStreamResult<M extends DaemonGuiStreamMethod>(
  _method: M,
  value: unknown,
): DaemonGuiStreamResultMap[M] {
  const errors = validateTerminalAttach(value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return value as DaemonGuiStreamResultMap[M];
}
export function parseDaemonGuiStreamEvent(value: unknown): import("./json-rpc-types.ts").JsonObject {
  const errors = validateTerminalAttachEvent(value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return value as import("./json-rpc-types.ts").JsonObject;
}
