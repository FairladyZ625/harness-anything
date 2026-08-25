import { daemonGuiActionMethods, daemonGuiStreamFacets } from "./daemon-protocol-gui-actions.ts";
import { daemonGuiReadMethods } from "./daemon-protocol-gui-reads.ts";
import type {
  DaemonGuiActionMethod,
  DaemonGuiRpcReadMethod,
  DaemonGuiStreamMethod,
  RpcEnumRule,
  RpcShape,
} from "./daemon-protocol-gui-types.ts";
import {
  digest,
  exactRecord,
  integer,
  nonEmpty,
  statusWord,
  stringArray,
  validateGuiSubmission,
} from "./daemon-protocol-validate-entities.ts";
import { allDaemonProtocolMethods } from "./daemon-protocol.contract.ts";
import { decisionStateWords, relationStateWords, taskStatusWords } from "./daemon-protocol-vocabulary.ts";
import {
  DaemonProtocolContractError,
  isJsonObject,
  rejectSecretKeys,
  unknownFieldViolation,
  type JsonObject,
} from "./json-rpc-types.ts";

export { DaemonProtocolContractError };

export function isDaemonGuiReadMethod(method: string): method is DaemonGuiRpcReadMethod {
  return daemonGuiReadMethods.some((entry) => entry.method === method);
}

export function isDaemonGuiActionMethod(method: string): method is DaemonGuiActionMethod {
  return daemonGuiActionMethods.some((entry) => entry.method === method);
}

export function isDaemonGuiStreamMethod(method: string): method is DaemonGuiStreamMethod {
  return daemonGuiStreamFacets.some((entry) => entry.method === method);
}

// The executor declaration surface, derived from the same shapes validateDaemonRpcCall enforces — never
// a hand-copied method list. repo.task.run accepts the executor inside its open action envelope; every
// other method accepts payload.executor exactly when its payload shape declares the field (the preset
// methods and repo.agentRuntime.spawn do). The CLI injects on this predicate, so a newly contracted
// command that does not declare executor is simply never injected into.
export function daemonMethodAcceptsPayloadExecutor(method: string): boolean {
  const payload = allDaemonProtocolMethods.find((entry) => entry.method === method)?.params.fields.payload;
  return (
    typeof payload === "object" && payload !== null && "fields" in payload && Object.hasOwn(payload.fields, "executor")
  );
}

export function validateDaemonRpcCall(value: unknown): readonly string[] {
  if (!isJsonObject(value) || typeof value.method !== "string") return ["RPC method is required"];
  const method = allDaemonProtocolMethods.find((entry) => entry.method === value.method);
  if (!method) return ["RPC method is not contracted"];
  const errors = validateShape(value.params === undefined ? {} : value.params, method.params, "params");
  if (!errors.length && value.method === "protocol.hello")
    errors.push(...validateSessionEnvironment((value.params as JsonObject).sessionEnvironment));
  if (!errors.length && (value.method === "repo.tasks.list" || value.method === "repo.triadic.relationGraph"))
    errors.push(...validateDaemonQueryPayload(value.method, (value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.agenda.read")
    errors.push(...validateAgendaQueryPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.task.dispatches")
    errors.push(...validateTaskDispatchesPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.agentRuntime.sessions.read")
    errors.push(...validateRuntimeSessionReadPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.squad.runs.list")
    errors.push(...validateSquadRunListPayload((value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.squad.runs.read")
    errors.push(...validateSquadRunReadPayload((value.params as JsonObject).payload));
  if (!errors.length && isDaemonGuiActionMethod(value.method))
    errors.push(...validateGuiActionPayload(value.method, (value.params as JsonObject).payload));
  if (!errors.length && value.method === "repo.terminal.attach") {
    const afterSeq = ((value.params as JsonObject).payload as JsonObject).afterSeq;
    if (!integer(afterSeq) || Number(afterSeq) < 0) errors.push("terminal attach sequence is invalid");
  }
  return errors;
}

export function validateSessionEnvironment(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) return ["session environment must be an object"];
  const allowed = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"],
    unknown = unknownFieldViolation(value, allowed);
  if (unknown) return [`session environment contains an ${unknown}`];
  return Object.values(value).every((item) => typeof item === "string" && item.trim().length > 0)
    ? []
    : ["session environment values must be non-empty strings"];
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

function validateSquadRunListPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["squad run list payload must be an object"];
  if (
    (value.since !== undefined && !Number.isFinite(Date.parse(String(value.since)))) ||
    (value.limit !== undefined && (!integer(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 1_000))
  )
    return ["squad run list facets are invalid"];
  return [];
}

function validateSquadRunReadPayload(value: unknown): string[] {
  return isJsonObject(value) && /^squad_[a-f0-9]{24}$/u.test(String(value.squadRunId))
    ? []
    : ["squad run read requires a valid squadRunId"];
}

// The wide task reads accept optional narrow/paged facets; absent payload or absent
// fields keep the unparameterized full-result contract, so validation only constrains
// the fields a caller actually supplies.
export function validateDaemonQueryPayload(
  method: "repo.tasks.list" | "repo.triadic.relationGraph",
  value: unknown,
): string[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) return ["query payload must be an object"];
  const errors: string[] = [],
    status = value.status,
    changedAfterRevision = value.changedAfterRevision,
    after = value.updatedAfter,
    before = value.updatedBefore,
    limit = value.limit,
    cursor = value.cursor,
    stateError =
      status !== undefined && !statusWord(method === "repo.tasks.list" ? taskStatusWords : relationStateWords, status)
        ? `${method}.payload.status is invalid`
        : null;
  if (stateError) errors.push(stateError);
  if (
    method === "repo.tasks.list" &&
    changedAfterRevision !== undefined &&
    (!integer(changedAfterRevision) || Number(changedAfterRevision) < 0)
  )
    errors.push(`${method}.payload.changedAfterRevision is invalid`);
  if (
    [after, before].some(
      (item) => item !== undefined && (typeof item !== "string" || !Number.isFinite(Date.parse(item))),
    ) ||
    (typeof after === "string" && typeof before === "string" && after > before)
  )
    errors.push(`${method}.payload time window is invalid`);
  if (limit !== undefined && (!integer(limit) || Number(limit) < 1 || Number(limit) > 500))
    errors.push(`${method}.payload.limit is invalid`);
  if (cursor !== undefined && !nonEmpty(cursor)) errors.push(`${method}.payload.cursor is invalid`);
  return errors;
}

export function validateAgendaQueryPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["agenda query payload must be an object"];
  const errors: string[] = [];
  if (value.limit !== undefined && (!integer(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 500))
    errors.push("repo.agenda.read.payload.limit is invalid");
  if (value.cursor !== undefined && !nonEmpty(value.cursor)) errors.push("repo.agenda.read.payload.cursor is invalid");
  return errors;
}

export function validateTaskDispatchesPayload(value: unknown): string[] {
  if (!isJsonObject(value)) return ["task dispatches payload must be an object"];
  const single =
      nonEmpty(value.taskId) && value.taskIds === undefined && value.limit === undefined && value.cursor === undefined,
    taskIds = value.taskIds;
  if (single) return [];
  if (
    value.taskId !== undefined ||
    !Array.isArray(taskIds) ||
    taskIds.length === 0 ||
    taskIds.length > 500 ||
    taskIds.some((taskId) => !nonEmpty(taskId)) ||
    new Set(taskIds).size !== taskIds.length ||
    (value.limit !== undefined && (!integer(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 500)) ||
    (value.cursor !== undefined && !nonEmpty(value.cursor))
  )
    return ["repo.task.dispatches.payload requires taskId or 1..500 unique taskIds"];
  return [];
}

export function parseDaemonRpcParams(
  method: string,
  params: unknown,
): { readonly ok: true; readonly params: JsonObject } | { readonly ok: false; readonly errors: readonly string[] } {
  const candidateParams = params === undefined ? {} : params,
    errors = validateDaemonRpcCall({ method, params: candidateParams });
  return errors.length ? { ok: false, errors } : { ok: true, params: candidateParams as JsonObject };
}

export function validateShape(value: unknown, expected: RpcShape, prefix: string): string[] {
  if (!isJsonObject(value)) return [`${prefix} must be an object`];
  const errors: string[] = [],
    allowed = Object.keys(expected.fields);
  if (!expected.open)
    for (const field of Object.keys(value)) {
      const unknownField = unknownFieldViolation({ [field]: value[field] }, allowed);
      if (unknownField) errors.push(`${prefix} contains an ${unknownField}`);
    }
  for (const [field, rule] of Object.entries(expected.fields)) {
    const item = value[field],
      enumRule = "values" in Object(rule) ? (rule as RpcEnumRule) : null;
    if (
      ((rule === "string?" ||
        rule === "string-null?" ||
        rule === "json?" ||
        rule === "array?" ||
        rule === "boolean?" ||
        rule === "number?" ||
        enumRule?.optional) &&
        item === undefined) ||
      (rule === "string-null?" && item === null)
    )
      continue;
    if (enumRule) {
      if (!enumRule.values.includes(String(item)))
        errors.push(`${prefix}.${field} must be one of ${enumRule.values.join(", ")}`);
    } else if (rule === "json" || rule === "json?") {
      if (!isJsonObject(item)) errors.push(`${prefix}.${field} must be object`);
    } else if (rule === "array" || rule === "array?") {
      if (!Array.isArray(item)) errors.push(`${prefix}.${field} must be array`);
    } else if (
      rule === "string" ||
      rule === "string?" ||
      rule === "string-null?" ||
      rule === "number" ||
      rule === "number?" ||
      rule === "boolean?"
    ) {
      const type = rule.startsWith("string") ? "string" : rule === "boolean?" ? "boolean" : "number";
      if (typeof item !== type || (type === "string" && !item)) errors.push(`${prefix}.${field} must be ${type}`);
    } else errors.push(...validateShape(item, rule as RpcShape, `${prefix}.${field}`));
  }
  return errors;
}

export function validateGuiActionPayload(method: DaemonGuiActionMethod, value: unknown): string[] {
  if (!isJsonObject(value)) return ["GUI action payload must be an object"];
  const errors: string[] = [...rejectSecretKeys(value)],
    exactItem = (item: unknown, required: readonly string[], optional: readonly string[] = []) =>
      isJsonObject(item) &&
      required.every((field) => nonEmpty(item[field])) &&
      Object.keys(item).every((field) => required.includes(field) || optional.includes(field));
  if (method === "repo.task.submit") errors.push(...validateGuiSubmission(value.submission));
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
      (value.state !== undefined && !statusWord(decisionStateWords, value.state))
    )
      errors.push("decision list filters are invalid");
  }
  if (method === "repo.decision.propose") {
    const scopes = value.appliesTo,
      chosen = value.chosen,
      rejected = value.rejected,
      claims = value.claims,
      fulfillments = value.fulfillments,
      relations = value.relations;
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
      ) ||
      !Array.isArray(relations) ||
      relations.some((item) => !exactItem(item, ["anchor", "type", "target", "rationale"]))
    )
      errors.push("decision proposal is invalid");
  }
  if (["repo.decision.accept", "repo.decision.reject", "repo.decision.defer"].includes(method))
    for (const field of [value.rationale, value.reason, value.judgmentOnlyRationale])
      if (field !== undefined && (typeof field !== "string" || [...field].length > 199))
        errors.push("decision rationale is invalid");
  if (
    method === "daemon.gui.control.request" &&
    (!["refresh", "restart"].includes(String(value.kind)) ||
      (value.reason !== undefined && (typeof value.reason !== "string" || [...value.reason].length > 199)))
  )
    errors.push("daemon control request is invalid");
  if (
    method === "repo.agentRuntime.spawn" &&
    (!Object.hasOwn(value, "taskId") ||
      (value.dispatchId === undefined && !nonEmpty(value.runtimeInstanceId) && !nonEmpty(value.agentId)) ||
      (value.dispatchId !== undefined && !nonEmpty(value.dispatchId)) ||
      (value.agentId !== undefined && !nonEmpty(value.agentId)) ||
      (value.targetAgentId !== undefined && !nonEmpty(value.targetAgentId)) ||
      (value.model !== undefined && !nonEmpty(value.model)) ||
      (value.effort !== undefined && !nonEmpty(value.effort)) ||
      (value.permissionMode !== undefined && !nonEmpty(value.permissionMode)) ||
      (value.prompt !== undefined && !nonEmpty(value.prompt)) ||
      (value.prompt === undefined && !nonEmpty(value.taskId)) ||
      (value.onExitCommand !== undefined && !nonEmpty(value.onExitCommand)) ||
      !exactCwd(value.cwd) ||
      (value.taskId !== null && !nonEmpty(value.taskId)) ||
      (value.providerSessionId !== undefined && !nonEmpty(value.providerSessionId)))
  )
    errors.push("runtime spawn request is invalid");
  if (method === "repo.agentRuntime.cancel" && !nonEmpty(value.runtimeSessionId))
    errors.push("runtime cancel request is invalid");
  if (method === "repo.gui.catalog.reread" && value.expectedDigest !== undefined && !digest(value.expectedDigest))
    errors.push("catalog reread digest is invalid");
  if (
    method === "repo.terminal.spawn" &&
    (!exactCwd(value.cwd) || !["direct-pty", "tmux"].includes(String(value.backend)))
  )
    errors.push("terminal spawn request is invalid");
  if (method === "repo.terminal.input" && (!integer(value.clientSeq) || Number(value.clientSeq) < 0))
    errors.push("terminal input sequence is invalid");
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
