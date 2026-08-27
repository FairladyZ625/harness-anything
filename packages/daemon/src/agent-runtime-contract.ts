import type {
  AgentDefinitionSnapshot,
  AgentRuntimeEventV1,
  RuntimeSessionSemanticState,
} from "../../kernel/src/index.ts";
export interface AgentRuntimeInstallationDto {
  readonly installationId: string;
  readonly kindId: "claude" | "codex" | "agy";
  readonly protocolFamily: "claude-compatible" | "codex" | "agy";
  readonly version: string;
  readonly attachCapability: "supported" | "unsupported";
  readonly lastObservedAt: string;
}
interface AgentRuntimeInstanceCommonDto {
  readonly schemaVersion: 2;
  readonly instanceId: string;
  readonly name: string;
  readonly installationId: string;
  readonly providerId: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly enabled: boolean;
  readonly permissionMode: "bypass" | "workspace-write" | "read-only" | null;
  readonly authMode: "subscription" | "api-key";
  readonly authState: "configured" | "authenticated" | "unauthenticated" | "unknown";
  readonly authReadiness: {
    readonly status: "ready" | "not-ready";
    readonly code: string | null;
    readonly hint: string | null;
  };
  readonly githubCredentialState?: "configured";
  readonly isolationState: "enforced" | "operator-environment";
}
export type AgentRuntimeInstanceDto = AgentRuntimeInstanceCommonDto &
  (
    | {
        readonly kindId: "claude";
        readonly claude: { readonly baseUrl: string | null; readonly baseUrlConfigured: boolean };
      }
    | {
        readonly kindId: "codex";
        readonly codex: {
          readonly reasoningEffort: string | null;
          readonly baseUrl: string | null;
          readonly baseUrlConfigured: boolean;
          readonly wire_api: string | null;
          readonly requires_openai_auth: boolean | null;
          readonly http_headers: Readonly<Record<string, string>> | null;
        };
      }
    | { readonly kindId: "agy"; readonly agy: { readonly effort: "low" | "medium" | "high" | null } }
  );
export interface AgentRuntimeAssociationDto {
  readonly taskId: string;
  readonly executionId: string;
  readonly holder: { readonly personId: string; readonly executorId: string | null } | null;
  readonly lease: { readonly phase: "reserving" | "held" | "released" | "orphaned"; readonly expiresAt: string } | null;
}
export interface AgentRuntimeAttemptChainDto {
  readonly attemptGroupId: string;
  readonly attempts: readonly {
    readonly dispatchId: string;
    readonly runtimeSessionId: string;
    readonly attemptIndex: number;
    readonly provider: { readonly instance: string; readonly model: string | null };
    readonly classification: "provider_fault" | "worker_stop" | "gate_red" | null;
    readonly reason: string | null;
    readonly fallbackState: "scheduled" | "dispatched" | "exhausted" | null;
    readonly nextDispatchId: string | null;
  }[];
}
export const runtimeTypeMatchesKind = (runtimeType: string, kindId: AgentRuntimeInstanceDto["kindId"]): boolean =>
  runtimeType === "any" || runtimeType === kindId;
export interface AgentRuntimeSessionDto {
  readonly runtimeSessionId: string;
  readonly providerSessionId: string | null;
  readonly instanceId: string;
  readonly installationId: string;
  readonly kindId: "claude" | "codex" | "agy";
  readonly definitionSnapshotRef: string;
  readonly definitionSnapshot: AgentDefinitionSnapshot;
  readonly liveness: "live" | "stale" | "unknown" | "exited";
  readonly semanticState?: RuntimeSessionSemanticState;
  readonly attachCapability: "supported" | "unsupported";
  readonly streamCursor: string;
  readonly associations: readonly AgentRuntimeAssociationDto[];
  readonly attemptChain?: AgentRuntimeAttemptChainDto;
  readonly activity: {
    readonly lastObservedAt: string;
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | null;
    readonly exitCode: number | null;
    readonly resultRef: string | null;
    readonly reasonCode?: string;
  };
}
export interface AgentRuntimeLifecycleDto {
  readonly cursor: string;
  readonly runtimeSessionId: string;
  readonly type: AgentRuntimeEventV1["type"];
  readonly occurredAt: string;
}
export type AgentRuntimeOverviewResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly installations: readonly AgentRuntimeInstallationDto[];
  readonly instances: readonly AgentRuntimeInstanceDto[];
  readonly sessions: readonly AgentRuntimeSessionDto[];
  readonly page?: {
    readonly limit: number;
    readonly cursor: string | null;
    readonly nextCursor: string | null;
    readonly remainingCount: number;
  };
  readonly watermark: number;
  readonly sourceRevision: number;
};
export type AgentRuntimeSessionResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly session: AgentRuntimeSessionDto;
  readonly result: { readonly ref: string; readonly text: string } | null;
  readonly watermark: number;
  readonly sourceRevision: number;
};
export type AgentRuntimeEventsResult = {
  readonly ok: true;
  readonly runtimeSessionId: string;
  readonly events: readonly AgentRuntimeLifecycleDto[];
  readonly cursor: string;
  readonly sourceCursor: string;
  readonly done: boolean;
};
export type AgentRuntimeSessionGroupBy = "task" | "squad" | "agent" | "day";
export type AgentRuntimeSessionGroupKind = AgentRuntimeSessionGroupBy | "unattributed";
export type AgentRuntimeSessionGroupStatus = RuntimeSessionSemanticState | "unknown" | "lost";
export interface AgentRuntimeSessionGroupRoundDto {
  readonly runtimeSessionId: string;
  readonly dispatchId: string | null;
  readonly agentName: string | null;
  readonly instanceId: string;
  readonly status: AgentRuntimeSessionGroupStatus;
  readonly classification?: "provider_fault" | "worker_stop" | "gate_red" | null;
  readonly reason?: string | null;
  readonly startedAt: string;
}
export interface AgentRuntimeSessionGroupDto {
  readonly key: string;
  readonly kind: AgentRuntimeSessionGroupKind;
  readonly label: string;
  readonly taskId?: string;
  readonly squadId?: string;
  readonly agentId?: string;
  readonly day?: string;
  readonly latestStatus: AgentRuntimeSessionGroupStatus;
  readonly latestActivityAt: string;
  readonly runningCount: number;
  readonly sessionCount: number;
  readonly roundCount: number;
  readonly latestRound: AgentRuntimeSessionGroupRoundDto | null;
}
export type AgentRuntimeSessionGroupsResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly groups: readonly AgentRuntimeSessionGroupDto[];
  readonly totals: { readonly groups: number; readonly sessions: number };
  readonly truncated: boolean;
  readonly watermark: number;
  readonly sourceRevision: number;
};
export function successfulAgentRuntimeResult(value: AgentRuntimeSessionResult): string | null {
  return value.session.activity.outcome === "succeeded" && value.result?.text ? value.result.text : null;
}
export function coded(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
const liveness = ["live", "stale", "unknown", "exited"];
const semanticStates = ["running", "succeeded", "failed", "cancelled", "ended-indeterminate", "unavailable"];
const attachCapabilities = ["supported", "unsupported"];
export function validateAgentRuntimeOverview(value: unknown): readonly string[] {
  return isAgentRuntimeContractRecord(value) &&
    hasAgentRuntimeContractFields(
      value,
      ["ok", "status", "installations", "instances", "sessions", "watermark", "sourceRevision"],
      ["page"],
    ) &&
    value.ok === true &&
    ["ready", "pending"].includes(String(value.status)) &&
    Array.isArray(value.installations) &&
    value.installations.every(validInstallation) &&
    Array.isArray(value.instances) &&
    value.instances.every(validInstance) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(validSession) &&
    (value.page === undefined || validPage(value.page)) &&
    Number.isInteger(value.watermark) &&
    Number.isInteger(value.sourceRevision) &&
    safeKeys(value)
    ? []
    : ["agent runtime overview is invalid"];
}
export function validateAgentRuntimeSession(value: unknown): readonly string[] {
  return isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, ["ok", "status", "session", "result", "watermark", "sourceRevision"]) &&
    value.ok === true &&
    ["ready", "pending"].includes(String(value.status)) &&
    validSession(value.session) &&
    (value.result === null ||
      (isAgentRuntimeContractRecord(value.result) &&
        hasExactAgentRuntimeContractFields(value.result, ["ref", "text"]) &&
        typeof value.result.ref === "string" &&
        typeof value.result.text === "string")) &&
    Number.isInteger(value.watermark) &&
    Number.isInteger(value.sourceRevision) &&
    safeKeys(value)
    ? []
    : ["agent runtime session is invalid"];
}
export function validateAgentRuntimeEvents(value: unknown): readonly string[] {
  return isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, ["ok", "runtimeSessionId", "events", "cursor", "sourceCursor", "done"]) &&
    value.ok === true &&
    typeof value.runtimeSessionId === "string" &&
    Array.isArray(value.events) &&
    value.events.every(
      (event) =>
        isAgentRuntimeContractRecord(event) &&
        hasExactAgentRuntimeContractFields(event, ["cursor", "runtimeSessionId", "type", "occurredAt"]) &&
        /^lifecycle:\d+$/u.test(String(event.cursor)) &&
        event.runtimeSessionId === value.runtimeSessionId &&
        typeof event.type === "string" &&
        typeof event.occurredAt === "string",
    ) &&
    /^lifecycle:\d+$/u.test(String(value.cursor)) &&
    /^lifecycle:\d+$/u.test(String(value.sourceCursor)) &&
    typeof value.done === "boolean" &&
    safeKeys(value)
    ? []
    : ["agent runtime lifecycle events are invalid"];
}
export function validateAgentRuntimeSessionGroups(value: unknown): readonly string[] {
  return isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, [
      "ok",
      "status",
      "groups",
      "totals",
      "truncated",
      "watermark",
      "sourceRevision",
    ]) &&
    value.ok === true &&
    ["ready", "pending"].includes(String(value.status)) &&
    Array.isArray(value.groups) &&
    value.groups.every(validSessionGroup) &&
    isAgentRuntimeContractRecord(value.totals) &&
    hasExactAgentRuntimeContractFields(value.totals, ["groups", "sessions"]) &&
    [value.totals.groups, value.totals.sessions].every(sessionGroupCount) &&
    typeof value.truncated === "boolean" &&
    sessionGroupCount(value.watermark) &&
    sessionGroupCount(value.sourceRevision) &&
    safeKeys(value)
    ? []
    : ["agent runtime session groups are invalid"];
}
function validInstallation(value: unknown): value is AgentRuntimeInstallationDto {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, [
      "installationId",
      "kindId",
      "protocolFamily",
      "version",
      "attachCapability",
      "lastObservedAt",
    ]) &&
    typeof value.installationId === "string" &&
    ["claude", "codex", "agy"].includes(String(value.kindId)) &&
    ["claude-compatible", "codex", "agy"].includes(String(value.protocolFamily)) &&
    typeof value.version === "string" &&
    attachCapabilities.includes(String(value.attachCapability)) &&
    typeof value.lastObservedAt === "string"
  );
}
function validInstance(value: unknown): value is AgentRuntimeInstanceDto {
  if (!isAgentRuntimeContractRecord(value)) return false;
  const field = value.kindId === "codex" ? "codex" : value.kindId === "agy" ? "agy" : "claude",
    common =
      hasAgentRuntimeContractFields(
        value,
        [
          "schemaVersion",
          "instanceId",
          "name",
          "kindId",
          "installationId",
          "providerId",
          "models",
          "defaultModel",
          "enabled",
          "permissionMode",
          field,
          "authMode",
          "authState",
          "authReadiness",
          "isolationState",
        ],
        ["githubCredentialState"],
      ) &&
      value.schemaVersion === 2 &&
      Array.isArray(value.models) &&
      value.models.length > 0 &&
      value.models.every((item) => typeof item === "string" && item.length > 0) &&
      typeof value.defaultModel === "string" &&
      value.models.includes(value.defaultModel) &&
      typeof value.enabled === "boolean" &&
      (value.permissionMode === null ||
        ["bypass", "workspace-write", "read-only"].includes(String(value.permissionMode))) &&
      [value.instanceId, value.name, value.installationId, value.providerId].every(
        (item) => typeof item === "string" && item.length > 0,
      ) &&
      ["subscription", "api-key"].includes(String(value.authMode)) &&
      ["configured", "authenticated", "unauthenticated", "unknown"].includes(String(value.authState)) &&
      (value.githubCredentialState === undefined || value.githubCredentialState === "configured") &&
      ["enforced", "operator-environment"].includes(String(value.isolationState)) &&
      validReadiness(value.authReadiness);
  if (!common) return false;
  return value.kindId === "claude"
    ? validClaudeInstanceConfig(value.claude)
    : value.kindId === "codex"
      ? validCodexInstanceConfig(value.codex)
      : validAgyInstanceConfig(value.agy);
}
function validClaudeInstanceConfig(value: unknown): boolean {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, ["baseUrl", "baseUrlConfigured"]) &&
    (value.baseUrl === null || typeof value.baseUrl === "string") &&
    typeof value.baseUrlConfigured === "boolean"
  );
}
function validCodexInstanceConfig(value: unknown): boolean {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, [
      "reasoningEffort",
      "baseUrl",
      "baseUrlConfigured",
      "wire_api",
      "requires_openai_auth",
      "http_headers",
    ]) &&
    (value.reasoningEffort === null || typeof value.reasoningEffort === "string") &&
    (value.baseUrl === null || typeof value.baseUrl === "string") &&
    typeof value.baseUrlConfigured === "boolean" &&
    (value.wire_api === null || typeof value.wire_api === "string") &&
    (value.requires_openai_auth === null || typeof value.requires_openai_auth === "boolean") &&
    (value.http_headers === null ||
      (isAgentRuntimeContractRecord(value.http_headers) &&
        Object.entries(value.http_headers).every(
          ([name, header]) =>
            !/(?:authorization|api[-_]?key|cookie|credential|password|secret|token)/iu.test(name) &&
            typeof header === "string",
        )))
  );
}
function validAgyInstanceConfig(value: unknown): boolean {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, ["effort"]) &&
    (value.effort === null || ["low", "medium", "high"].includes(String(value.effort)))
  );
}
function validReadiness(value: unknown): boolean {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, ["status", "code", "hint"]) &&
    ["ready", "not-ready"].includes(String(value.status)) &&
    (value.code === null || typeof value.code === "string") &&
    (value.hint === null || typeof value.hint === "string") &&
    (value.status === "ready"
      ? value.code === null && value.hint === null
      : typeof value.code === "string" && typeof value.hint === "string")
  );
}
function validSession(value: unknown): value is AgentRuntimeSessionDto {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasAgentRuntimeContractFields(
      value,
      [
        "runtimeSessionId",
        "providerSessionId",
        "instanceId",
        "installationId",
        "kindId",
        "definitionSnapshotRef",
        "definitionSnapshot",
        "liveness",
        "attachCapability",
        "streamCursor",
        "associations",
        "activity",
      ],
      ["semanticState", "attemptChain"],
    ) &&
    typeof value.runtimeSessionId === "string" &&
    (value.providerSessionId === null || typeof value.providerSessionId === "string") &&
    [value.instanceId, value.installationId, value.definitionSnapshotRef].every(
      (item) => typeof item === "string" && item.length > 0,
    ) &&
    ["claude", "codex", "agy"].includes(String(value.kindId)) &&
    validDefinitionSnapshot(value.definitionSnapshot) &&
    value.definitionSnapshot.instanceId === value.instanceId &&
    value.definitionSnapshot.installationId === value.installationId &&
    liveness.includes(String(value.liveness)) &&
    (value.semanticState === undefined || semanticStates.includes(String(value.semanticState))) &&
    attachCapabilities.includes(String(value.attachCapability)) &&
    /^stream:\d+$/u.test(String(value.streamCursor)) &&
    Array.isArray(value.associations) &&
    value.associations.every(validAssociation) &&
    (value.attemptChain === undefined || validAttemptChain(value.attemptChain)) &&
    isAgentRuntimeContractRecord(value.activity) &&
    hasAgentRuntimeContractFields(
      value.activity,
      ["lastObservedAt", "outcome", "exitCode", "resultRef"],
      ["reasonCode"],
    ) &&
    typeof value.activity.lastObservedAt === "string" &&
    (value.activity.outcome === null ||
      ["succeeded", "failed", "unknown", "cancelled"].includes(String(value.activity.outcome))) &&
    (value.activity.exitCode === null ||
      (Number.isInteger(value.activity.exitCode) && (value.activity.exitCode as number) >= 0)) &&
    (value.activity.resultRef === null || typeof value.activity.resultRef === "string") &&
    (value.activity.reasonCode === undefined ||
      (typeof value.activity.reasonCode === "string" && value.activity.reasonCode.length > 0))
  );
}
function validAttemptChain(value: unknown): value is AgentRuntimeAttemptChainDto {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, ["attemptGroupId", "attempts"]) &&
    typeof value.attemptGroupId === "string" &&
    value.attemptGroupId.length > 0 &&
    Array.isArray(value.attempts) &&
    value.attempts.length > 0 &&
    value.attempts.every(
      (attempt) =>
        isAgentRuntimeContractRecord(attempt) &&
        hasExactAgentRuntimeContractFields(attempt, [
          "dispatchId",
          "runtimeSessionId",
          "attemptIndex",
          "provider",
          "classification",
          "reason",
          "fallbackState",
          "nextDispatchId",
        ]) &&
        typeof attempt.dispatchId === "string" &&
        typeof attempt.runtimeSessionId === "string" &&
        Number.isInteger(attempt.attemptIndex) &&
        (attempt.attemptIndex as number) >= 0 &&
        isAgentRuntimeContractRecord(attempt.provider) &&
        hasExactAgentRuntimeContractFields(attempt.provider, ["instance", "model"]) &&
        typeof attempt.provider.instance === "string" &&
        (attempt.provider.model === null || typeof attempt.provider.model === "string") &&
        (attempt.classification === null ||
          ["provider_fault", "worker_stop", "gate_red"].includes(String(attempt.classification))) &&
        (attempt.reason === null || typeof attempt.reason === "string") &&
        (attempt.fallbackState === null ||
          ["scheduled", "dispatched", "exhausted"].includes(String(attempt.fallbackState))) &&
        (attempt.nextDispatchId === null || typeof attempt.nextDispatchId === "string"),
    )
  );
}
function validPage(value: unknown): boolean {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, ["limit", "cursor", "nextCursor", "remainingCount"]) &&
    Number.isInteger(value.limit) &&
    (value.limit as number) >= 1 &&
    (value.limit as number) <= 64 &&
    (value.cursor === null || typeof value.cursor === "string") &&
    (value.nextCursor === null || typeof value.nextCursor === "string") &&
    Number.isInteger(value.remainingCount) &&
    (value.remainingCount as number) >= 0
  );
}
function validDefinitionSnapshot(value: unknown): value is AgentDefinitionSnapshot {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, [
      "schema",
      "configVersion",
      "instanceId",
      "installationId",
      "kindId",
      "providerId",
      "model",
      "reasoningEffort",
      "baseUrl",
      "authMode",
    ]) &&
    value.schema === "agent-definition-snapshot/v1" &&
    value.configVersion === 1 &&
    [value.instanceId, value.installationId, value.providerId, value.model].every(
      (item) => typeof item === "string" && item.length > 0,
    ) &&
    ["claude", "codex", "agy"].includes(String(value.kindId)) &&
    (value.reasoningEffort === null || typeof value.reasoningEffort === "string") &&
    (value.baseUrl === null || typeof value.baseUrl === "string") &&
    ["subscription", "api-key"].includes(String(value.authMode))
  );
}
function validAssociation(value: unknown): value is AgentRuntimeAssociationDto {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasExactAgentRuntimeContractFields(value, ["taskId", "executionId", "holder", "lease"]) &&
    typeof value.taskId === "string" &&
    typeof value.executionId === "string" &&
    (value.holder === null ||
      (isAgentRuntimeContractRecord(value.holder) &&
        hasExactAgentRuntimeContractFields(value.holder, ["personId", "executorId"]) &&
        typeof value.holder.personId === "string" &&
        (value.holder.executorId === null || typeof value.holder.executorId === "string"))) &&
    (value.lease === null ||
      (isAgentRuntimeContractRecord(value.lease) &&
        hasExactAgentRuntimeContractFields(value.lease, ["phase", "expiresAt"]) &&
        ["reserving", "held", "released", "orphaned"].includes(String(value.lease.phase)) &&
        typeof value.lease.expiresAt === "string"))
  );
}
function safeKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(safeKeys);
  if (!isAgentRuntimeContractRecord(value)) return true;
  for (const [key, nested] of Object.entries(value)) {
    if (
      [
        "credential",
        "credentialValue",
        "secret",
        "token",
        "environment",
        "argv",
        "transcript",
        "stdout",
        "stderr",
      ].includes(key) ||
      !safeKeys(nested)
    )
      return false;
  }
  return true;
}
export const serializeAgentRuntimeOverview = (value: unknown): string => serialize(value, validateAgentRuntimeOverview),
  serializeAgentRuntimeSession = (value: unknown): string => serialize(value, validateAgentRuntimeSession),
  serializeAgentRuntimeEvents = (value: unknown): string => serialize(value, validateAgentRuntimeEvents),
  serializeAgentRuntimeSessionGroups = (value: unknown): string => serialize(value, validateAgentRuntimeSessionGroups);
export function serialize(value: unknown, validate: (candidate: unknown) => readonly string[]): string {
  const errors = validate(value);
  if (errors.length) throw coded("invalid_result", errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}
function isAgentRuntimeContractRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactAgentRuntimeContractFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function hasAgentRuntimeContractFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => required.includes(field) || optional.includes(field))
  );
}

const sessionGroupKinds: readonly AgentRuntimeSessionGroupKind[] = ["task", "squad", "agent", "day", "unattributed"],
  sessionGroupStatuses: readonly AgentRuntimeSessionGroupStatus[] = [
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
    "lost",
    "ended-indeterminate",
    "unavailable",
  ];

function validSessionGroup(value: unknown): value is AgentRuntimeSessionGroupDto {
  if (!isAgentRuntimeContractRecord(value)) return false;
  const identityFields = ["taskId", "squadId", "agentId", "day"].filter((field) => value[field] !== undefined),
    required = [
      "key",
      "kind",
      "label",
      "latestStatus",
      "latestActivityAt",
      "runningCount",
      "sessionCount",
      "roundCount",
      "latestRound",
    ];
  return (
    hasAgentRuntimeContractFields(value, required, ["taskId", "squadId", "agentId", "day"]) &&
    [value.key, value.label].every(sessionGroupText) &&
    sessionGroupKinds.includes(value.kind as AgentRuntimeSessionGroupKind) &&
    validSessionGroupIdentity(value, identityFields) &&
    sessionGroupStatuses.includes(value.latestStatus as AgentRuntimeSessionGroupStatus) &&
    sessionGroupIso(value.latestActivityAt) &&
    [value.runningCount, value.sessionCount, value.roundCount].every(sessionGroupCount) &&
    (value.latestRound === null || validSessionGroupRound(value.latestRound))
  );
}

function validSessionGroupIdentity(value: Record<string, unknown>, fields: readonly string[]): boolean {
  if (value.kind === "task") return fields.length === 1 && fields[0] === "taskId" && sessionGroupText(value.taskId);
  if (value.kind === "squad") return fields.length === 1 && fields[0] === "squadId" && sessionGroupText(value.squadId);
  if (value.kind === "day")
    return fields.length === 1 && fields[0] === "day" && /^\d{4}-\d{2}-\d{2}$/u.test(String(value.day));
  if (value.kind === "agent")
    return fields.length === 0 || (fields.length === 1 && fields[0] === "agentId" && sessionGroupText(value.agentId));
  return value.kind === "unattributed" && fields.length === 0;
}

function validSessionGroupRound(value: unknown): value is AgentRuntimeSessionGroupRoundDto {
  return (
    isAgentRuntimeContractRecord(value) &&
    hasAgentRuntimeContractFields(
      value,
      ["runtimeSessionId", "dispatchId", "agentName", "instanceId", "status", "startedAt"],
      ["classification", "reason"],
    ) &&
    [value.runtimeSessionId, value.instanceId].every(sessionGroupText) &&
    (value.dispatchId === null || sessionGroupText(value.dispatchId)) &&
    (value.agentName === null || sessionGroupText(value.agentName)) &&
    sessionGroupStatuses.includes(value.status as AgentRuntimeSessionGroupStatus) &&
    (value.classification === undefined ||
      value.classification === null ||
      ["provider_fault", "worker_stop", "gate_red"].includes(String(value.classification))) &&
    (value.reason === undefined || value.reason === null || sessionGroupText(value.reason)) &&
    sessionGroupIso(value.startedAt)
  );
}

function sessionGroupText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function sessionGroupIso(value: unknown): value is string {
  return sessionGroupText(value) && Number.isFinite(Date.parse(value));
}
function sessionGroupCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
