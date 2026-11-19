import {
  interactiveRpcDescriptor,
  streamRpcDescriptor,
  isRuntimeKindId,
  isRuntimeMcpPolicy,
  runtimeKindForId,
  runtimeKindIds,
  runtimeSubscriptionMultiAccountIsolation,
  validRuntimeInstanceTier,
} from "@harness-anything/daemon/protocol";
import { validateDaemonRpcCall } from "@harness-anything/daemon/protocol/validation";
import { containsSecretLikeKey } from "../api/entity-payload-hygiene.ts";

export const HARNESS_PRELOAD_API = "harness";
export const RPC_CHANNEL = "harness:rpc";
export const STREAM_OPEN_CHANNEL = "harness:stream:open";
export const STREAM_CLOSE_CHANNEL = "harness:stream:close";
export const streamFrameChannel = (id: string) => `harness:stream:frame:${id}`;
export const preloadApiCapabilities = Object.freeze({
  stream: { status: "available" },
  terminal: { status: "available" },
  nativeFiles: { status: "available" },
  writes: { status: "available" },
});

const update = interactiveRpcDescriptor("daemon.runtimeInstance.update")?.params.fields;
const runtimeInstanceUpdateFields =
  update && "payload" in update && typeof update.payload === "object" && "fields" in update.payload
    ? Object.keys(update.payload.fields)
    : [];
const codexWebSearchChoices = runtimeKindForId("codex").configuration.choices?.webSearch ?? [];
const runtimeInstanceCreateFields = [
  "instanceId",
  "name",
  "kindId",
  "installationId",
  "providerId",
  "models",
  "enabled",
  "defaultModel",
  "permissionMode",
  "mcpPolicy",
  "isolationState",
  "credentialSource",
  "tier",
  ...runtimeKindIds,
  "authMode",
  "apiKey",
] as const;

/** The Electron boundary admits a subset of the daemon contract and enforces local credential hygiene. */
export function assertRendererRpc(method: string, params: unknown, stream = false): true {
  const descriptor = stream ? streamRpcDescriptor(method) : interactiveRpcDescriptor(method);
  if (!descriptor) throw new Error(`Renderer RPC method is not allowed: ${method}`);
  if (!isPreloadPayloadRecord(params) || !closed(params, ["repo", "payload"]))
    throw new Error(`Renderer ${method} params are invalid.`);
  if (
    params.repo !== undefined &&
    (!isPreloadPayloadRecord(params.repo) ||
      !exactStrings(params.repo, ["repoId"]) ||
      !/^[a-z][a-z0-9-]{0,62}$/u.test(String(params.repo.repoId)))
  )
    throw new Error(`Renderer ${method} params require an exact repoId.`);
  const payload = params.payload;
  const canSetApiKey = [
    "daemon.runtimeInstance.create",
    "daemon.runtimeInstance.update",
    "daemon.provider.create",
    "daemon.provider.update",
  ].includes(method);
  if (containsSecretLikeKey(payload, canSetApiKey))
    throw new Error("Renderer params contain a forbidden secret-like key.");
  const errors = validateDaemonRpcCall({ method, params });
  if (errors.length) throw new Error(`Renderer ${method} params are invalid: ${errors.join("; ")}`);
  if (
    method === "daemon.runtimeInstance.list" &&
    (!isPreloadPayloadRecord(payload) || !closed(payload, ["all"]) || payload.all !== true)
  )
    throw new Error("Runtime instance list request is invalid.");
  if (method === "daemon.runtimeInstance.show" && !validRuntimeInstanceShow(payload))
    throw new Error("Preload showRuntimeInstance request is invalid.");
  if (method === "daemon.runtimeInstance.delete" && !exactStrings(payload, ["instanceId"]))
    throw new Error("Preload deleteRuntimeInstance request is invalid.");
  if (method === "daemon.runtimeInstance.update" && !validRuntimeInstanceUpdate(payload))
    throw new Error("Preload updateRuntimeInstance request is invalid.");
  if (
    ["repo.runtimeInstance.auth.login", "repo.runtimeInstance.auth.logout"].includes(method) &&
    !exactStrings(payload, ["instanceId", "idempotencyKey"])
  )
    throw new Error(`Preload ${method} request is invalid.`);
  // Schedule actions carry only their closed declaration or retry-stable claim fields;
  // the renderer cannot smuggle transport or runtime controls into the daemon action.
  if (
    ["repo.schedule.create", "repo.schedule.update"].includes(method) &&
    !validScheduleDefinitionMutation(payload, method === "repo.schedule.update")
  )
    throw new Error(`Preload ${method} request is invalid.`);
  if (method === "repo.schedule.delete" && !validScheduleDelete(payload))
    throw new Error("Preload deleteSchedule request is invalid.");
  if (
    ["repo.schedule.enable", "repo.schedule.disable", "repo.schedule.runNow"].includes(method) &&
    !exactStrings(payload, ["scheduleId", "idempotencyKey"])
  )
    throw new Error(`Preload ${method} request is invalid.`);
  if (method === "daemon.runtimeInstance.create") {
    const problem = runtimeInstanceCreateProblem(payload);
    if (problem !== undefined) throw new Error(`Runtime instance create request is invalid: ${problem}`);
  }
  if (["daemon.provider.create", "daemon.provider.update"].includes(method)) {
    const fields =
        method === "daemon.provider.create"
          ? ["type", "providerId", "name", "model", "baseUrl", "apiKey", "credentialRef", "enabled"]
          : ["providerId", "name", "model", "baseUrl", "apiKey", "credentialRef", "enabled"],
      record = isPreloadPayloadRecord(payload) ? payload : null;
    if (!record || !closed(record, fields)) throw new Error(`Preload ${method} request has unexpected fields.`);
    if (method === "daemon.provider.create" && record.type !== "decisions")
      throw new Error("Only Decisions API providers can be created here.");
    if (typeof record.providerId !== "string" || record.providerId.trim() === "")
      throw new Error(`Preload ${method} requires a providerId.`);
    if (
      method === "daemon.provider.create" &&
      ["name", "model"].some((field) => typeof record[field] !== "string" || !(record[field] as string).trim())
    )
      throw new Error("Preload createDecisionProvider requires a name and model.");
    if (record.enabled !== undefined && typeof record.enabled !== "boolean")
      throw new Error(`Preload ${method} enabled must be boolean.`);
    if (record.apiKey !== undefined && (typeof record.apiKey !== "string" || record.apiKey.trim() === ""))
      throw new Error(`Preload ${method} apiKey must be nonblank text.`);
    if (record.credentialRef !== undefined && typeof record.credentialRef !== "string")
      throw new Error(`Preload ${method} credentialRef must be text.`);
    if (record.apiKey !== undefined && record.credentialRef !== undefined)
      throw new Error(`Preload ${method} accepts an apiKey or credentialRef, not both.`);
  }
  return true;
}
// Only a newly typed top-level apiKey crosses create/update IPC. The selected
// daemon owns vault storage and rejects replacement for subscription instances.
// Nested keys and every other secret-like field remain rejected.
// (containsSecretLikeKey itself lives in api/entity-payload-hygiene.ts, shared with
// the renderer read clients so the credential vocabulary stays out of renderer source.)
function runtimeInstanceCreateProblem(value: unknown): string | undefined {
  if (!isPreloadPayloadRecord(value)) return 'field "payload" must be an object.';
  if (!closed(value, runtimeInstanceCreateFields)) {
    const field = Object.keys(value).find((key) => !runtimeInstanceCreateFields.some((allowed) => allowed === key));
    return `unexpected field "${field}"; expected only ${runtimeInstanceCreateFields.join(", ")}.`;
  }
  for (const field of ["instanceId", "name", "installationId", "providerId"])
    if (typeof value[field] !== "string" || value[field].trim().length === 0)
      return `field "${field}" must be a non-blank string.`;
  if (!isRuntimeKindId(value.kindId)) return `field "kindId" is unknown: ${String(value.kindId)}.`;
  const declaration = runtimeKindForId(value.kindId);
  if (
    !Array.isArray(value.models) ||
    (value.models.length === 0 &&
      !(value.enabled === false && value.credentialSource === "instance" && value.authMode === "subscription")) ||
    value.models.some((model) => typeof model !== "string" || model.trim().length === 0) ||
    new Set(value.models).size !== value.models.length
  )
    return 'field "models" must contain unique non-blank strings; only a disabled independent subscription account can start empty.';
  if (
    value.defaultModel !== undefined &&
    (typeof value.defaultModel !== "string" || !value.models.includes(value.defaultModel))
  )
    return 'field "defaultModel" must be one of the listed models.';
  if (!["subscription", "api-key"].includes(String(value.authMode)))
    return 'field "authMode" must be subscription or api-key.';
  if (!declaration.auth.modes.some((mode) => mode === value.authMode))
    return `field "authMode" is not supported for ${value.kindId}.`;
  if (
    value.permissionMode !== undefined &&
    !["bypass", "workspace-write", "read-only"].includes(String(value.permissionMode))
  )
    return 'field "permissionMode" must be bypass, workspace-write, or read-only.';
  if (!declaration.permissions.available && value.permissionMode !== undefined)
    return `field "permissionMode" must be omitted for ${value.kindId}.`;
  if (value.mcpPolicy !== undefined && !isRuntimeMcpPolicy(value.mcpPolicy))
    return 'field "mcpPolicy" must be disabled or inherit.';
  if (declaration.capabilities.mcp !== "supported" && value.mcpPolicy !== undefined)
    return `field "mcpPolicy" must be omitted for ${value.kindId}.`;
  if (
    value.isolationState !== undefined &&
    !["enforced", "operator-environment"].includes(String(value.isolationState))
  )
    return 'field "isolationState" must be enforced or operator-environment.';
  if (
    value.isolationState !== undefined &&
    !declaration.isolation.states.some((state) => state === value.isolationState)
  )
    return `field "isolationState" is not supported for ${value.kindId}.`;
  if (value.credentialSource !== undefined && !["operator", "instance"].includes(String(value.credentialSource)))
    return 'field "credentialSource" must be operator or instance.';
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return 'field "enabled" must be boolean.';
  if (value.tier !== undefined && !validRuntimeInstanceTier(value.tier))
    return 'field "tier" must be an integer from 1 to 9.';
  if (
    value.credentialSource === "instance" &&
    (value.authMode !== "subscription" ||
      !Object.keys(runtimeSubscriptionMultiAccountIsolation).some((pair) => pair.startsWith(`${value.kindId}@`)) ||
      (value.isolationState !== undefined && value.isolationState !== "enforced"))
  )
    return 'field "credentialSource" requires supported independent subscription isolation.';
  if (value.kindId === "codex" && value.authMode === "api-key" && value.isolationState === "operator-environment")
    return 'field "isolationState" must be enforced for codex API-key auth.';
  if (value.authMode === "api-key" && (typeof value.apiKey !== "string" || value.apiKey.trim().length === 0))
    return 'field "apiKey" must be a non-blank string for api-key auth.';
  if (value.authMode === "subscription" && value.apiKey !== undefined)
    return 'field "apiKey" must be omitted for subscription auth.';
  return runtimeKindConfigProblem(value);
}
function runtimeKindConfigProblem(value: Record<string, unknown>): string | undefined {
  if (!isRuntimeKindId(value.kindId)) return 'field "kindId" is unknown.';
  const field = value.kindId,
    declaration = runtimeKindForId(field),
    other = runtimeKindIds.filter((item) => item !== field),
    config = value[field];
  const wrongKind = other.find((key) => value[key] !== undefined);
  if (wrongKind !== undefined) return `field "${wrongKind}" must be omitted when kindId is ${field}.`;
  if (!isPreloadPayloadRecord(config)) return `field "${field}" must be an object.`;
  const fields = Object.keys(declaration.configuration.fields);
  if (!closed(config, fields)) {
    const nested = Object.keys(config).find((key) => !fields.includes(key));
    return `unexpected field "${field}.${nested}"; expected only ${fields.join(", ")}.`;
  }
  for (const [name, shape] of Object.entries(declaration.configuration.fields)) {
    const item = config[name];
    if (item === undefined) continue;
    if (
      (shape === "boolean" && typeof item !== "boolean") ||
      (shape !== "boolean" && shape !== "headers" && typeof item !== "string")
    )
      return `field "${field}.${name}" has the wrong value type.`;
    if (
      shape === "headers" &&
      (!isPreloadPayloadRecord(item) || Object.values(item).some((entry) => typeof entry !== "string"))
    )
      return `field "${field}.${name}" must be an object with string values.`;
    const choices = declaration.configuration.choices?.[name];
    if (typeof item === "string" && choices !== undefined && !choices.includes(item))
      return `field "${field}.${name}" must be one of ${choices.join(", ")}.`;
  }
  return undefined;
}
function validRuntimeInstanceUpdate(value: unknown): boolean {
  return (
    isPreloadPayloadRecord(value) &&
    closed(value, runtimeInstanceUpdateFields) &&
    typeof value.instanceId === "string" &&
    value.instanceId.length > 0 &&
    runtimeInstanceUpdateFields.some((field) => field !== "instanceId" && value[field] !== undefined) &&
    (value.tier === undefined || validRuntimeInstanceTier(value.tier)) &&
    !(value.credentialSource === "instance" && value.isolationState === "operator-environment") &&
    (value.enabled === undefined || typeof value.enabled === "boolean") &&
    (value.fast === undefined || typeof value.fast === "boolean") &&
    (value.effort === undefined || typeof value.effort === "string") &&
    (value.webSearch === undefined ||
      (typeof value.webSearch === "string" &&
        (value.webSearch === "" || codexWebSearchChoices.includes(value.webSearch)))) &&
    (value.apiKey === undefined || (typeof value.apiKey === "string" && value.apiKey.trim().length > 0)) &&
    (value.permissionMode === undefined ||
      ["bypass", "workspace-write", "read-only"].includes(String(value.permissionMode))) &&
    (value.mcpPolicy === undefined || ["", "disabled", "inherit"].includes(String(value.mcpPolicy))) &&
    (value.isolationState === undefined ||
      ["enforced", "operator-environment"].includes(String(value.isolationState))) &&
    (value.credentialSource === undefined || ["operator", "instance"].includes(String(value.credentialSource))) &&
    [value.name, value.installationId, value.defaultModel].every(
      (field) => field === undefined || (typeof field === "string" && field.length > 0),
    ) &&
    (value.models === undefined ||
      (Array.isArray(value.models) &&
        value.models.length > 0 &&
        value.models.every((model) => typeof model === "string" && model.length > 0)))
  );
}
function validRuntimeInstanceShow(value: unknown): boolean {
  return (
    isPreloadPayloadRecord(value) &&
    closed(value, ["instanceId", "probe"]) &&
    typeof value.instanceId === "string" &&
    value.instanceId.length > 0 &&
    (value.probe === undefined || typeof value.probe === "boolean")
  );
}
function validScheduleDefinitionMutation(value: unknown, nullableOptionals: boolean): boolean {
  const fields = [
    "scheduleId",
    "name",
    "mode",
    "everyMs",
    "cronExpression",
    "timezone",
    "agentId",
    "mission",
    "reasoningEffort",
    "fast",
    "keepDays",
    "keepMonthly",
    "idempotencyKey",
  ];
  if (!isPreloadPayloadRecord(value) || !closed(value, fields)) return false;
  // Trigger is exactly one of interval (`everyMs`) or cron (`cronExpression`+`timezone`):
  // the daemon/kernel contract rejects both-in-one, and a cron payload without a
  // timezone would be stringified by the kernel — so both are refused here.
  const cron = value.cronExpression;
  const triggerOk =
    value.everyMs === undefined
      ? typeof cron === "string" &&
        cron.trim().length > 0 &&
        typeof value.timezone === "string" &&
        value.timezone.trim().length > 0
      : Number.isSafeInteger(value.everyMs) &&
        Number(value.everyMs) >= 60_000 &&
        cron === undefined &&
        value.timezone === undefined;
  // A create is agent-shaped and complete; an update may be partial — a built-in edit sends
  // name, trigger, and retention only, never agent target fields.
  const requiredText = nullableOptionals
    ? ["scheduleId", "idempotencyKey"]
    : ["scheduleId", "name", "agentId", "mission", "idempotencyKey"];
  if (
    !triggerOk ||
    !requiredText.every((field) => typeof value[field] === "string" && String(value[field]).trim().length > 0) ||
    (value.mode !== undefined && value.mode !== "detect" && value.mode !== "remediate") ||
    (!nullableOptionals && value.mode === undefined)
  )
    return false;
  return (
    (value.fast === undefined || typeof value.fast === "boolean") &&
    (value.keepDays === undefined || (Number.isSafeInteger(value.keepDays) && Number(value.keepDays) >= 1)) &&
    (value.keepMonthly === undefined || typeof value.keepMonthly === "boolean") &&
    (nullableOptionals || value.keepDays === undefined) &&
    (nullableOptionals || value.keepMonthly === undefined) &&
    ["name", "agentId", "mission"].every(
      (field) =>
        value[field] === undefined || (typeof value[field] === "string" && String(value[field]).trim().length > 0),
    ) &&
    [value.reasoningEffort].every(
      (field) =>
        field === undefined ||
        (nullableOptionals && field === null) ||
        (typeof field === "string" && field.trim().length > 0),
    )
  );
}
function validScheduleDelete(value: unknown): boolean {
  return (
    isPreloadPayloadRecord(value) &&
    closed(value, ["scheduleId", "reason", "idempotencyKey"]) &&
    [value.scheduleId, value.idempotencyKey].every((field) => typeof field === "string" && field.trim().length > 0) &&
    (value.reason === undefined || (typeof value.reason === "string" && value.reason.trim().length > 0))
  );
}
function exactStrings(value: unknown, fields: readonly string[]): boolean {
  return (
    isPreloadPayloadRecord(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => typeof value[field] === "string" && String(value[field]).length > 0)
  );
}
function closed(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}
function isPreloadPayloadRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
