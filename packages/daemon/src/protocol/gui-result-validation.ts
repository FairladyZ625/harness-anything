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
} from "../agent-entities.contract.ts";
import { validateObserveTailResult } from "./daemon-protocol-gui-types.ts";
import { validationError } from "./daemon-protocol-validate-entities.ts";
import { validateArtifactsList } from "./artifacts-gui-contract.ts";
import { validateDaemonUseCaseProjection } from "./daemon-protocol-use-case-projection.ts";
import { validateEntityRowList } from "../entity-rows-read.ts";
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
export const validateDaemonSettingsRead: ResultValidator = (value) =>
  isJsonObject(value) &&
  Object.keys(value).length === 3 &&
  value.schema === "daemon.settings-read/v1" &&
  value.ok === true &&
  validateSettingsV1(value.settings).length === 0
    ? []
    : [
        validationError(
          "settings",
          isJsonObject(value) && value.schema !== "daemon.settings-read/v1"
            ? "schema"
            : isJsonObject(value) && value.ok !== true
              ? "ok"
              : "settings",
          isJsonObject(value)
            ? value.schema !== "daemon.settings-read/v1"
              ? value.schema
              : value.ok !== true
                ? value.ok
                : value.settings
            : value,
          "must be a valid daemon settings read",
        ),
      ];
const resultValidators = {
  "daemon.gui.system.read": validateSystemStatus,
  "daemon.gui.control.receipt": validateDaemonControlReceipt,
  "observe.tail": validateObserveTailResult,
  "repo.tasks.list": validateDaemonTaskSnapshotList,
  "repo.projection.read": validateDaemonUseCaseProjection,
  "repo.entity.actions.explain": validateEntityActionExplanationSet,
  "repo.entity.kinds.read": validateEntityKindCatalog,
  "repo.vertical.declaration.read": validateVerticalDeclarationRead,
  "repo.entity.rows.read": validateEntityRowList,
  "repo.entity.locator.read": validateEntityLocatorRead,
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
