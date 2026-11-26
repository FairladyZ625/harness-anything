import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { generatedSettingsFieldProtocolProjection } from "@harness-anything/preset/internal/preset-command-contract";
import {
  allDaemonProtocolMethods,
  daemonRpcByMethod,
  daemonMethodAcceptsPayload,
  daemonMethodAcceptsPayloadExecutor,
  daemonMethodNameSets,
} from "./daemon-protocol-commands.ts";
import {
  admitUseCaseProjectionSelector,
  validateShape,
  shape,
  isRuntimeStreamCursor,
  validateObserveTailPayload,
  type DaemonGuiActionMethod,
  type DaemonGuiRpcReadMethod,
  type DaemonStreamMethod,
} from "./daemon-protocol-results.ts";
import { daemonCollaboratorScopeFields } from "./daemon-protocol-schema-ids.ts";
import {
  digest,
  exactRecord,
  integer,
  nonEmpty,
  statusWord,
  stringArray,
} from "./daemon-protocol-validate-entities.ts";
import { validateCatalogActionPayload, validateSessionEnvironment } from "./daemon-protocol-validate-task.ts";
import { validateDaemonQueryPayload } from "./daemon-protocol-validate-relation-query.ts";
import { type DaemonRpcCall, type DaemonRpcMethod, type DaemonRpcWireParams } from "./daemon-protocol.contract.ts";
import {
  agentRuntimeUnattributedGroupKeyWords,
  decisionStateWords,
  isRuntimeMcpPolicy,
} from "./daemon-protocol-vocabulary.ts";
import { DaemonProtocolContractError, isJsonObject, rejectSecretKeys, type JsonObject } from "./json-rpc-types.ts";

export {
  DaemonProtocolContractError,
  daemonMethodAcceptsPayload,
  daemonMethodAcceptsPayloadExecutor,
  validateSessionEnvironment,
};

const TASK_ID = /^[A-Za-z0-9_-]{1,96}$/u,
  catalogActionMethods = new Set(["repo.task.run", "repo.task.read", "repo.trace.read"]);

function validateDaemonWorkTopologyPayload(value: unknown): string[] {
  if (!isJsonObject(value) || Object.keys(value).length !== 1 || typeof value.workRootTaskId !== "string")
    return ["work topology requires only workRootTaskId"];
  return TASK_ID.test(value.workRootTaskId) ? [] : ["work topology workRootTaskId is invalid"];
}

export function isDaemonReadRoute(method: string): method is DaemonGuiRpcReadMethod {
  return daemonMethodNameSets.guiRead.has(method);
}

export function isDaemonActionRoute(method: string): method is DaemonGuiActionMethod {
  return daemonMethodNameSets.guiAction.has(method);
}

/** Shared preset RPCs keep their existing validation contract when also exposed to the GUI. */
export function isNamedActionRoute(method: string): method is DaemonGuiActionMethod {
  return daemonMethodNameSets.guiAction.has(method) && !daemonMethodNameSets.preset.has(method);
}

export function isDaemonStreamMethod(method: string): method is DaemonStreamMethod {
  return daemonMethodNameSets.stream.has(method);
}

export function validateDaemonRpcCall(value: unknown): readonly string[] {
  if (!isJsonObject(value) || typeof value.method !== "string") return ["RPC method is required"];
  const method = daemonRpcByMethod.get(value.method);
  if (!method) return ["RPC method is not contracted"];
  const errors = validateShape(value.params === undefined ? {} : value.params, method.params, "params");
  if (
    !errors.length &&
    ["repo.works.index", "repo.works.briefs.read", "repo.entity.rows.read"].includes(value.method)
  ) {
    const payload = (value.params as JsonObject).payload;
    if (payload !== undefined)
      errors.push(...validateShape(payload, shape(daemonCollaboratorScopeFields), "params.payload"));
  }
  if (!errors.length && value.method === "protocol.hello")
    errors.push(...validateSessionEnvironment((value.params as JsonObject).sessionEnvironment));
  if (!errors.length && value.method === "repo.agentRuntime.quote")
    errors.push(...validateAgentRuntimeQuoteParams(value.params));
  if (
    !errors.length &&
    (value.method === "repo.tasks.list" ||
      value.method === "repo.triadic.relationGraph" ||
      value.method === "repo.artifacts.list")
  )
    errors.push(...validateDaemonQueryPayload(value.method, (value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.reckoning.signals.read")
    errors.push(...validateReckoningQuery((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.agenda.read")
    errors.push(...validateAgendaQueryPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.work.topology.read")
    errors.push(...validateDaemonWorkTopologyPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.task.dispatches")
    errors.push(...validateTaskDispatchesPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.agentRuntime.sessions.read")
    errors.push(...validateRuntimeSessionReadPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.agentRuntime.steer")
    errors.push(...validateRuntimeSteerPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.projection.read")
    errors.push(...validateUseCaseProjectionPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.squad.runs.list")
    errors.push(...validateSquadRunListPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.squad.run.read")
    errors.push(...validateSquadRunReadPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "observe.tail")
    errors.push(...validateObserveTailPayload((value.params as JsonObject).payload));
  if (!errors.length && catalogActionMethods.has(value.method))
    errors.push(...validateCatalogActionPayload(value.params as JsonObject));
  if (!errors.length && value.method === "repo.task.run") {
    const payload = (value.params as JsonObject).payload as JsonObject,
      action = payload.action;
    if (
      payload.pathCoordinate !== undefined &&
      (!isJsonObject(action) ||
        action.kind !== "task-artifact-add" ||
        !["workspace", "task-artifact"].includes(String(payload.pathCoordinate)))
    )
      errors.push("params.payload.pathCoordinate is only declared for task-artifact-add");
  }
  if (!errors.length && value.method === "repo.task.run") {
    const action = ((value.params as JsonObject).payload as JsonObject).action;
    if (isJsonObject(action) && action.kind === "settings-update") {
      const { kind: _kind, executor: _executor, ...settings } = action;
      // The CLI facade has the same closed Settings input as the GUI; its retry key is optional.
      const settingsMethod = allDaemonProtocolMethods.find((entry) => entry.method === "repo.settings.update")!;
      errors.push(
        ...validateShape(
          { idempotencyKey: "settings-input-validation", ...settings },
          settingsMethod.params.fields.payload!,
          "params.payload.action",
        ),
      );
    }
  }
  if (!errors.length && isNamedActionRoute(value.method))
    errors.push(...validateNamedActionPayload(value.method, (value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.terminal.attach") {
    const { afterSeq, daemonGeneration } = (value.params as JsonObject).payload as JsonObject;
    if (!integer(afterSeq) || Number(afterSeq) < 0) errors.push("terminal attach sequence is invalid");
    if (daemonGeneration !== undefined && (!integer(daemonGeneration) || Number(daemonGeneration) < 0))
      errors.push("terminal attach generation is invalid");
  }
  if (!errors.length && value.method === "repo.agentRuntime.attach") {
    const after = ((value.params as JsonObject).payload as JsonObject).afterCursor;
    if (after !== undefined && !isRuntimeStreamCursor(after)) errors.push("runtime attach cursor is invalid");
  }
  return errors;
}

function validateReckoningQuery(value: unknown): readonly string[] {
  if (!isJsonObject(value)) return ["reckoning query must be an object"];
  if (value.generatedAt !== undefined && !Number.isFinite(Date.parse(String(value.generatedAt))))
    return ["reckoning generatedAt must be a timestamp"];
  if (
    value.windowHours !== undefined &&
    (typeof value.windowHours !== "number" ||
      !Number.isFinite(value.windowHours) ||
      value.windowHours <= 0 ||
      value.windowHours > 24 * 366)
  )
    return ["reckoning windowHours must be in (0, 8784]"];
  return [];
}

function validateAgentRuntimeQuoteParams(value: unknown): string[] {
  if (!isJsonObject(value)) return ["runtime quote params must be an object"];
  const hasTokens = value.inputTokens !== undefined,
    hasBytes = value.inputBytes !== undefined,
    errors: string[] = [];
  if (hasTokens === hasBytes) errors.push("runtime quote requires exactly one of inputTokens or inputBytes");
  const estimate = hasTokens ? value.inputTokens : value.inputBytes;
  if (estimate !== undefined && (!Number.isSafeInteger(estimate) || Number(estimate) < 0))
    errors.push("runtime quote input estimate must be a non-negative safe integer");
  if (
    value.outputCapTokens !== undefined &&
    (!Number.isSafeInteger(value.outputCapTokens) ||
      Number(value.outputCapTokens) < 1 ||
      Number(value.outputCapTokens) > 32_768)
  )
    errors.push("runtime quote outputCapTokens must be an integer from 1 to 32768");
  return errors;
}

function validateRuntimeSessionReadPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["runtime session read payload must be an object"];
  const runtimeSessionId = value.runtimeSessionId,
    taskId = value.taskId,
    dispatchId = value.dispatchId;
  if (runtimeSessionId === undefined && (taskId === undefined || dispatchId === undefined))
    return ["runtime session read requires runtimeSessionId or taskId plus dispatchId"];
  if (runtimeSessionId !== undefined && (taskId !== undefined || dispatchId !== undefined))
    return ["runtime session read cannot mix runtimeSessionId with taskId or dispatchId"];
  return [];
}

function validateRuntimeSteerPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["runtime steer request is invalid"];
  const { runtimeSessionId, dispatchId, taskId, prompt, mode, idempotencyKey } = value;
  const targets = (nonEmpty(runtimeSessionId) ? 1 : 0) + (nonEmpty(dispatchId) ? 1 : 0) + (nonEmpty(taskId) ? 1 : 0);
  return !nonEmpty(prompt) ||
    targets !== 1 ||
    (runtimeSessionId !== undefined && !nonEmpty(runtimeSessionId)) ||
    (dispatchId !== undefined && !nonEmpty(dispatchId)) ||
    (taskId !== undefined && !nonEmpty(taskId)) ||
    (mode !== undefined && mode !== "auto" && mode !== "queue" && mode !== "interrupt") ||
    (idempotencyKey !== undefined && (!nonEmpty(idempotencyKey) || !idempotencyKey.trim()))
    ? ["runtime steer request is invalid"]
    : [];
}

// Request-side half of the single selector boundary; only facet-specific value rules live here.
function validateUseCaseProjectionPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["use-case projection payload must be an object"];
  const admitted = admitUseCaseProjectionSelector(value);
  if (typeof admitted === "string") return [admitted];
  if (admitted.name === "schedule-run-history" && !nonEmpty(value.scheduleId))
    return ["schedule run history requires a scheduleId"];
  if (admitted.facet === "members") {
    if (!(agentRuntimeUnattributedGroupKeyWords as readonly string[]).includes(String(value.groupKey)))
      return ["runtime session group members requires a valid unattributed groupKey"];
    return validateRuntimeSessionGroupsPayload(value);
  }
  return admitted.facet === "groups" ? validateRuntimeSessionGroupsPayload(value) : [];
}

function validateRuntimeSessionGroupsPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["runtime session groups payload must be an object"];
  if (
    (value.since !== undefined && !Number.isFinite(Date.parse(String(value.since)))) ||
    (value.agentId !== undefined && !nonEmpty(value.agentId)) ||
    (value.squadId !== undefined && !nonEmpty(value.squadId)) ||
    (value.personId !== undefined && !nonEmpty(value.personId)) ||
    (value.nodeId !== undefined && !nonEmpty(value.nodeId)) ||
    (value.limit !== undefined &&
      (!integer(value.limit) ||
        Number(value.limit) < 1 ||
        Number(value.limit) > daemonProtocolFleetPolicy.defaultValue.protocol.runtimeListLimitMaximum))
  )
    return ["runtime session group facets are invalid"];
  return [];
}

function validateSquadRunListPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["squad run list payload must be an object"];
  if (
    (value.since !== undefined && !Number.isFinite(Date.parse(String(value.since)))) ||
    (value.limit !== undefined &&
      (!integer(value.limit) ||
        Number(value.limit) < 1 ||
        Number(value.limit) > daemonProtocolFleetPolicy.defaultValue.protocol.runtimeListLimitMaximum))
  )
    return ["squad run list facets are invalid"];
  return [];
}

function validateSquadRunReadPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["squad run read payload must be an object"];
  if (!nonEmpty(value.squadRunId) || !/^squad_[a-f0-9]{24}$/u.test(String(value.squadRunId)))
    return ["squad run read requires the squad_<24 lowercase hex characters> handle"];
  return [];
}

/* Browser-safe query validation lives in daemon-protocol-query-validation.ts. */
export { validateDaemonQueryPayload };

export function validateAgendaQueryPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["agenda query payload must be an object"];
  const errors: string[] = [];
  if (
    value.limit !== undefined &&
    (!integer(value.limit) ||
      Number(value.limit) < 1 ||
      Number(value.limit) > daemonProtocolFleetPolicy.defaultValue.protocol.listLimitMaximum)
  )
    errors.push("repo.agenda.read.payload.limit is invalid");
  if (value.cursor !== undefined && !nonEmpty(value.cursor)) errors.push("repo.agenda.read.payload.cursor is invalid");
  if (value.work !== undefined && !nonEmpty(value.work)) errors.push("repo.agenda.read.payload.work is invalid");
  if (value.attentionOnly !== undefined && typeof value.attentionOnly !== "boolean")
    errors.push("repo.agenda.read.payload.attentionOnly is invalid");
  if (value.scopePersonId !== undefined && !nonEmpty(value.scopePersonId))
    errors.push("repo.agenda.read.payload.scopePersonId is invalid");
  if (value.filterNodeId !== undefined && !nonEmpty(value.filterNodeId))
    errors.push("repo.agenda.read.payload.filterNodeId is invalid");
  return errors;
}

export function validateTaskDispatchesPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["task dispatches payload must be an object"];
  if (value.floor !== undefined || value.runtimeSessionIds !== undefined) {
    const { floor, limit, runtimeSessionIds } = value;
    const maxRows = daemonProtocolFleetPolicy.defaultValue.fleet.overviewPageLimit;
    const validWidth = typeof limit === "number" && integer(limit) && limit >= 1 && limit <= maxRows;
    const hasOtherSelector = [
      value.taskId,
      value.taskIds,
      value.agentId,
      value.squadId,
      value.latestOnly,
      value.cursor,
    ].some((item) => item !== undefined);
    const validScope = [value.personId, value.nodeId].every((item) => item === undefined || nonEmpty(item));
    const selector =
      floor === "ended"
        ? runtimeSessionIds === undefined
        : floor === "active" &&
          Array.isArray(runtimeSessionIds) &&
          runtimeSessionIds.length > 0 &&
          runtimeSessionIds.length <= Number(limit) &&
          runtimeSessionIds.every((id) => nonEmpty(id)) &&
          new Set(runtimeSessionIds).size === runtimeSessionIds.length;
    return selector && validWidth && !hasOtherSelector && validScope
      ? []
      : ["repo.task.dispatches.payload has an invalid live-floor dispatch selector"];
  }
  if (value.agentId !== undefined || value.squadId !== undefined) {
    const member =
      nonEmpty(value.agentId) !== nonEmpty(value.squadId) &&
      value.taskId === undefined &&
      value.taskIds === undefined &&
      value.cursor === undefined &&
      integer(value.limit) &&
      Number(value.limit) >= 1 &&
      Number(value.limit) <= daemonProtocolFleetPolicy.defaultValue.protocol.listLimitMaximum;
    if (!member)
      return ["repo.task.dispatches.payload member reads require one agent or squad id and a limit of 1..500"];
    return ["personId", "nodeId"].flatMap((field) => {
      const filter = value[field];
      return filter === undefined || (typeof filter === "string" && filter.trim())
        ? []
        : [`repo.task.dispatches.payload.${field} must be non-empty text`];
    });
  }
  if (value.personId !== undefined || value.nodeId !== undefined)
    return ["repo.task.dispatches.payload attribution filters require a member read"];
  const single =
      nonEmpty(value.taskId) && value.taskIds === undefined && value.limit === undefined && value.cursor === undefined,
    taskIds = value.taskIds;
  if (value.latestOnly !== undefined && (typeof value.latestOnly !== "boolean" || taskIds === undefined))
    return ["repo.task.dispatches.payload.latestOnly requires taskIds and a boolean"];
  if (single) return [];
  if (
    value.taskId !== undefined ||
    !Array.isArray(taskIds) ||
    taskIds.length === 0 ||
    taskIds.length > 500 ||
    taskIds.some((taskId) => !nonEmpty(taskId)) ||
    new Set(taskIds).size !== taskIds.length ||
    (value.limit !== undefined &&
      (!integer(value.limit) ||
        Number(value.limit) < 1 ||
        Number(value.limit) > daemonProtocolFleetPolicy.defaultValue.protocol.listLimitMaximum)) ||
    (value.cursor !== undefined && !nonEmpty(value.cursor))
  )
    return ["repo.task.dispatches.payload requires taskId or 1..500 unique taskIds"];
  return [];
}

export type ParsedDaemonRpcParams<Method extends DaemonRpcMethod> =
  | {
      readonly ok: true;
      readonly params: DaemonRpcWireParams<Method>;
      readonly call: DaemonRpcCall<Method>;
    }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface ParseDaemonRpcParams {
  <Method extends DaemonRpcMethod>(method: Method, params: unknown): ParsedDaemonRpcParams<Method>;
  (
    method: string,
    params: unknown,
  ):
    | { readonly ok: true; readonly params: JsonObject; readonly call: DaemonRpcCall }
    | { readonly ok: false; readonly errors: readonly string[] };
}

export const parseDaemonRpcParams = ((method: string, params: unknown) => {
  const candidateParams = params === undefined ? {} : params,
    errors = validateDaemonRpcCall({ method, params: candidateParams });
  if (errors.length) return { ok: false, errors };
  const typedParams = candidateParams as DaemonRpcWireParams<DaemonRpcMethod>;
  return {
    ok: true,
    params: typedParams,
    call: { method, params: typedParams } as DaemonRpcCall,
  };
}) as ParseDaemonRpcParams;

export function validateNamedActionPayload(method: DaemonGuiActionMethod, value: unknown): string[] {
  if (!isJsonObject(value)) return ["GUI action payload must be an object"];
  const errors: string[] = [...rejectSecretKeys(value)],
    exactItem = (item: unknown, required: readonly string[], optional: readonly string[] = []) =>
      isJsonObject(item) &&
      required.every((field) => nonEmpty(item[field])) &&
      Object.keys(item).every((field) => required.includes(field) || optional.includes(field));
  if (method === "repo.settings.update") {
    const changed = generatedSettingsFieldProtocolProjection.actionInputs.filter(
      ({ field }) => field !== "expectedVersion" && field !== "idempotencyKey" && value[field] !== undefined,
    );
    if (
      changed.length === 0 ||
      !validProjectedSettingsAction(value) ||
      (value.gatesDraft !== undefined &&
        (!Array.isArray(value.gatesDraft) || value.gatesDraft.some((mapping) => !isJsonObject(mapping))))
    )
      errors.push("settings update is invalid");
  }
  if (
    method === "repo.task.progress.append" &&
    value.evidence !== undefined &&
    (!Array.isArray(value.evidence) || value.evidence.some((item) => !exactItem(item, ["type", "path", "summary"])))
  )
    errors.push("progress evidence is invalid");
  if (method === "repo.decision.list") {
    const range = value.legacyRange;
    if (
      (range !== undefined &&
        (!exactRecord(range, ["start", "end"]) ||
          !integer(range.start) ||
          !integer(range.end) ||
          Number(range.start) < 1 ||
          Number(range.end) < Number(range.start))) ||
      (value.legacyId !== undefined && !/^E[1-9][0-9]*$/u.test(String(value.legacyId))) ||
      (value.state !== undefined && !statusWord(decisionStateWords, value.state)) ||
      (value.limit !== undefined &&
        (!integer(value.limit) ||
          Number(value.limit) < 1 ||
          Number(value.limit) > daemonProtocolFleetPolicy.defaultValue.protocol.listLimitMaximum)) ||
      (value.cursor !== undefined && !nonEmpty(value.cursor))
    )
      errors.push("decision list filters are invalid");
  }
  if (method === "repo.decision.propose") {
    const scopes = value.appliesTo,
      chosen = value.chosen,
      rejected = value.rejected,
      claims = value.claims,
      fulfillments = value.fulfillments;
    if (
      ![value.riskTier, value.urgency].every((field) => ["low", "medium", "high"].includes(String(field))) ||
      !["ordinary", "standing_policy"].includes(String(value.decisionClass)) ||
      !exactRecord(scopes, ["modules", "productLines"]) ||
      !stringArray(scopes.modules) ||
      !stringArray(scopes.productLines) ||
      !Array.isArray(chosen) ||
      !chosen.length ||
      chosen.some(
        (item) =>
          !exactItem(item, ["id", "text"], ["rationale"]) ||
          (isJsonObject(item) && item.rationale !== undefined && !nonEmpty(item.rationale)),
      ) ||
      !Array.isArray(rejected) ||
      !rejected.length ||
      rejected.some((item) => !exactItem(item, ["id", "text", "whyNot"])) ||
      !Array.isArray(claims) ||
      claims.some(
        (item) =>
          !isJsonObject(item) ||
          !exactRecord(item, ["id", "text", "loadBearing"]) ||
          !nonEmpty(item.id) ||
          !nonEmpty(item.text) ||
          typeof item.loadBearing !== "boolean",
      ) ||
      !Array.isArray(fulfillments) ||
      fulfillments.some(
        (item) =>
          !exactItem(item, ["claimId", "mode"]) ||
          (isJsonObject(item) && !["evidenced", "delivered", "standing_policy"].includes(String(item.mode))),
      )
    )
      errors.push("decision proposal is invalid");
  }
  if (["repo.decision.accept", "repo.decision.reject", "repo.decision.defer"].includes(method))
    for (const field of [value.rationale, value.reason, value.judgmentOnlyRationale])
      if (field !== undefined && (typeof field !== "string" || [...field].length > 199))
        errors.push("decision rationale is invalid");
  if (
    method === "repo.decision.respondReview" &&
    (!Array.isArray(value.responses) ||
      !value.responses.length ||
      value.responses.some(
        (item) =>
          !exactItem(item, ["reviewId", "findingId", "disposition", "rationale"], ["amendmentRef"]) ||
          (isJsonObject(item) &&
            (!["adopt", "rebut"].includes(String(item.disposition)) ||
              (item.amendmentRef !== null && !nonEmpty(item.amendmentRef)))),
      ))
  )
    errors.push("decision review responses are invalid");
  if (method === "repo.decision.overrideReview" && (!stringArray(value.reviewIds) || !value.reviewIds.length))
    errors.push("decision review override is invalid");
  if (
    method === "daemon.gui.control.request" &&
    (!["refresh", "restart"].includes(String(value.kind)) ||
      (value.reason !== undefined && (typeof value.reason !== "string" || [...value.reason].length > 199)))
  )
    errors.push("daemon control request is invalid");
  if (
    method === "repo.agentRuntime.spawn" &&
    ((value.dispatchId === undefined && !Object.hasOwn(value, "taskId")) ||
      (value.dispatchId === undefined && !nonEmpty(value.runtimeInstanceId) && !nonEmpty(value.agentId)) ||
      (value.dispatchId !== undefined && !nonEmpty(value.dispatchId)) ||
      (value.agentId !== undefined && !nonEmpty(value.agentId)) ||
      (value.targetAgentId !== undefined && !nonEmpty(value.targetAgentId)) ||
      (value.squadId !== undefined && !nonEmpty(value.squadId)) ||
      (value.role !== undefined && value.role !== "reviewer") ||
      (value.model !== undefined && !nonEmpty(value.model)) ||
      (value.effort !== undefined && !nonEmpty(value.effort)) ||
      (value.fast !== undefined && typeof value.fast !== "boolean") ||
      (value.permissionMode !== undefined && !nonEmpty(value.permissionMode)) ||
      (value.mcpPolicy !== undefined && !isRuntimeMcpPolicy(value.mcpPolicy)) ||
      (value.prompt !== undefined && !nonEmpty(value.prompt)) ||
      (value.prompt === undefined && value.dispatchId === undefined && !nonEmpty(value.taskId)) ||
      (value.onExitCommand !== undefined && !nonEmpty(value.onExitCommand)) ||
      // Without a cwd a resumed dispatch inherits its own and a task dispatch runs in the task's worktree.
      (value.cwd === undefined ? value.dispatchId === undefined && !nonEmpty(value.taskId) : !exactCwd(value.cwd)) ||
      (value.taskId !== undefined && value.taskId !== null && !nonEmpty(value.taskId)) ||
      (value.providerSessionId !== undefined && !nonEmpty(value.providerSessionId)) ||
      (value.expectedAgentDeclarationDigest !== undefined && !digest(value.expectedAgentDeclarationDigest)) ||
      (value.expectedSkillSnapshotDigest !== undefined && !digest(value.expectedSkillSnapshotDigest)) ||
      (value.dryRun !== undefined && typeof value.dryRun !== "boolean") ||
      !nonEmpty(value.dispatchKey))
  )
    errors.push("runtime spawn request is invalid");
  if (
    method === "repo.agentRuntime.cancel" &&
    (!nonEmpty(value.runtimeSessionId) ||
      (value.ruling !== undefined && !nonEmpty(value.ruling)) ||
      (value.reason !== undefined && (!nonEmpty(value.reason) || !value.reason.trim())) ||
      (value.idempotencyKey !== undefined && (!nonEmpty(value.idempotencyKey) || !value.idempotencyKey.trim())))
  )
    errors.push("runtime cancel request is invalid");
  if (method === "repo.gui.catalog.reread" && value.expectedDigest !== undefined && !digest(value.expectedDigest))
    errors.push("catalog reread digest is invalid");
  if (
    method === "repo.terminal.spawn" &&
    (!exactCwd(value.cwd) || !["direct-pty", "tmux"].includes(String(value.backend)))
  )
    errors.push("terminal spawn request is invalid");
  if (
    method === "repo.terminal.input" &&
    ![value.clientSeq, value.daemonGeneration].every((field) => Number.isSafeInteger(field) && Number(field) >= 0)
  )
    errors.push("terminal input sequence and daemon generation must be nonnegative safe integers");
  if (
    method === "repo.terminal.resize" &&
    (![value.cols, value.rows].every(integer) ||
      Number(value.cols) < 2 ||
      Number(value.cols) > 500 ||
      Number(value.rows) < 2 ||
      Number(value.rows) > 500)
  )
    errors.push("terminal dimensions are invalid");
  if (method === "repo.terminal.terminate" && value.confirmed !== true)
    errors.push("terminal termination requires confirmation");
  return errors;
}

function validProjectedSettingsAction(value: Readonly<JsonObject>): boolean {
  return generatedSettingsFieldProtocolProjection.actionInputs.every(({ field, type }) => {
    if (!Object.hasOwn(value, field)) return true;
    const candidate = value[field];
    switch (type) {
      case "number":
        return typeof candidate === "number";
      case "boolean":
        return typeof candidate === "boolean";
      case "string-array":
      case "fact-hold-array":
      case "json-object-array":
        return Array.isArray(candidate);
      case "json-object":
        return isJsonObject(candidate);
      default:
        return typeof candidate === "string";
    }
  });
}

export function exactCwd(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    ((value.scope === "repo-root" && exactRecord(value, ["scope"])) ||
      (value.scope === "repo-relative" && exactRecord(value, ["scope", "path"]) && nonEmpty(value.path)))
  );
}

export function serializeDaemonRpcCall(value: unknown): string {
  const errors = validateDaemonRpcCall(value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_rpc", errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}
