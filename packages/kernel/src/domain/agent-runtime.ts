import {
  hasOnlyFields,
  hasRequiredFields,
  isNonEmptyString,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
} from "./write-chain.contract.ts";
import type { EntityDocumentJsonSchema } from "./entity-json-schema.ts";
import { deriveRelationId, type EntityRelationRecord } from "./entity-relation.ts";
import { timestamp } from "./timestamp.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";

export class RuntimeSessionAdoptionStaleError extends Error {}

export const runtimeCapabilities = ["structured_witness", "resume", "attach", "session_identity"] as const;
export const runtimeLivenessStates = ["live", "stale", "unknown", "exited"] as const;
export const transcriptReachabilityStates = ["by_session_id", "dispatch_stream_only", "unavailable"] as const;
export const agentRuntimeEventTypes = [
  "runtime_installation_observed",
  "runtime_dispatch_requested",
  "runtime_session_started",
  "runtime_session_provider_bound",
  "runtime_session_task_bound",
  "runtime_session_liveness_changed",
  "runtime_session_cancelled",
  "runtime_session_exited",
  "runtime_session_outcome_observed",
  "runtime_dispatch_outcome_unknown",
] as const;

export function runtimeTaskExecutionRelation(runtimeSessionId: string, taskId: string): EntityRelationRecord {
  const identity = {
    source: `runtime-session/${runtimeSessionId}`,
    target: `task/${taskId}`,
    type: "executes" as const,
    direction: "directed" as const,
  };
  return {
    relation_id: deriveRelationId(identity),
    ...identity,
    strength: "strong",
    origin: "generated",
    state: "active",
    rationale: "Runtime session is bound to the task execution.",
  };
}
export type RuntimeProtocolFamily = string;
export type RuntimeCapability = (typeof runtimeCapabilities)[number];
export type RuntimeLiveness = (typeof runtimeLivenessStates)[number];
export type AgentRuntimeEventType = (typeof agentRuntimeEventTypes)[number];
export type TranscriptReachability = (typeof transcriptReachabilityStates)[number];
export interface SessionIdentity {
  readonly runtime: string;
  readonly sessionId: string | null;
  readonly transcriptReachability: TranscriptReachability;
}
export interface SessionProvenanceV1 extends SessionIdentity {
  readonly boundAt: string;
}
export interface SessionIdentityResolverInput {
  readonly runtime: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dispatchEvents?: readonly unknown[];
  readonly providerBinding?: { readonly sessionId: string; readonly transcriptRef: string };
}
export interface SessionIdentityResolver {
  readonly resolve: (input: SessionIdentityResolverInput) => SessionIdentity;
}
export interface AgentDefinitionSnapshot {
  readonly schema: "agent-definition-snapshot/v1";
  readonly configVersion: 1;
  readonly instanceId: string;
  readonly installationId: string;
  readonly kindId: string;
  readonly providerId: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly fast?: boolean;
  readonly baseUrl: string | null;
  readonly authMode: "subscription" | "api-key";
}
export interface RuntimeKind {
  readonly kindId: string;
  readonly protocolFamily: RuntimeProtocolFamily;
  readonly declaredCapabilities: readonly RuntimeCapability[];
}
export interface RuntimeResultClaim {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/plain; charset=utf-8";
}

export function runtimeArchiveText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

interface RuntimeDefinitionSnapshotClaim {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "application/vnd.harness.agent-definition-snapshot+json";
}
export interface RuntimeInstallation {
  readonly installationId: string;
  readonly kindId: string;
  readonly protocolFamily: RuntimeProtocolFamily;
  readonly hostRef: string;
  readonly version: string;
  readonly discoverySource: "wrapper" | "hook";
  readonly effectiveCapabilities: readonly RuntimeCapability[];
  readonly lastObservedAt: string;
}
export interface RuntimeTaskSessionLink {
  readonly taskId: string;
  readonly executionId: string;
  readonly providerSessionId: string;
  readonly transcriptRef: string;
  readonly boundAt: string;
}
export interface RuntimeSession {
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly installationId: string;
  readonly kindId: string;
  readonly definitionSnapshotRef: string;
  readonly providerSessionId: string | null;
  readonly transcriptRef: string | null;
  readonly launchGeneration: number;
  readonly liveness: RuntimeLiveness;
  readonly attachable: boolean;
  readonly taskBindings: readonly RuntimeTaskSessionLink[];
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | null;
  readonly exitCode: number | null;
  readonly resultRef: string | null;
  readonly reasonCode?: string;
  readonly lastObservedAt: string;
}
export type RuntimeInstallationState = "present" | "missing";
export type RuntimeSessionSemanticState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "ended-indeterminate"
  | "unavailable";

const runtimeSessionSemanticStates = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "ended-indeterminate",
  "unavailable",
] as const;

const runtimeSessionTaskLinkSchema = {
  type: "object" as const,
  additionalProperties: false as const,
  required: ["taskId", "executionId"] as const,
  properties: {
    taskId: { type: "string" as const, minLength: 1, description: "Task bound during runtime handoff." },
    executionId: { type: "string" as const, minLength: 1, description: "Execution opened by the task lease." },
  },
  description: "Task handoffs represented by the runtime-session executes edge.",
};

export const runtimeSessionEntityV1Schema = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "runtime-session/v1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "runtimeSessionId", "taskBindings", "liveness", "outcome", "semanticState"],
  properties: {
    schema: { type: "string", const: "runtime-session/v1", description: "Schema discriminator." },
    runtimeSessionId: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
      minLength: 1,
      description: "Stable runtime session identity.",
    },
    taskBindings: {
      type: "array",
      items: runtimeSessionTaskLinkSchema,
      description: "Tasks this session executes after authenticated handoff.",
    },
    liveness: {
      type: "string",
      enum: runtimeLivenessStates,
      description: "Provider/process liveness vocabulary.",
    },
    outcome: {
      type: "string",
      enum: ["succeeded", "failed", "unknown", "cancelled"],
      "x-nullable": true,
      description: "Provider outcome, null before settlement.",
    },
    semanticState: {
      type: "string",
      enum: runtimeSessionSemanticStates,
      description: "Derived semantic state from liveness and outcome.",
    },
  },
}) as EntityDocumentJsonSchema;
/** The terminal verdict evidenced by the canonical outcome declaration, or by
 * the exit/result pair written by settlement when an older declaration said
 * only `unknown`. An absent exit or result remains genuinely indeterminate. */
export function runtimeSessionOutcomeFromEvidence(
  session: Pick<RuntimeSession, "outcome"> & Partial<Pick<RuntimeSession, "exitCode" | "resultRef" | "reasonCode">>,
): RuntimeSession["outcome"] {
  if (session.outcome === "succeeded" || session.outcome === "failed" || session.outcome === "cancelled")
    return session.outcome;
  if (session.reasonCode) return "failed";
  if (session.exitCode === undefined || session.exitCode === null || !session.resultRef) return session.outcome;
  return session.exitCode === 0 ? "succeeded" : "failed";
}

export function runtimeSessionMissingOutcomeEvidence(
  session: Pick<RuntimeSession, "outcome"> & Partial<Pick<RuntimeSession, "exitCode" | "resultRef" | "reasonCode">>,
): "exit-code-and-result" | "exit-code" | "result" | null {
  if (runtimeSessionOutcomeFromEvidence(session) !== "unknown") return null;
  if (session.exitCode === undefined || session.exitCode === null)
    return session.resultRef ? "exit-code" : "exit-code-and-result";
  return "result";
}

/** A domain judgment over independent liveness and outcome evidence. */
export function runtimeSessionSemanticState(
  session: Pick<RuntimeSession, "liveness" | "outcome"> &
    Partial<Pick<RuntimeSession, "exitCode" | "resultRef" | "reasonCode">>,
): RuntimeSessionSemanticState {
  const outcome = runtimeSessionOutcomeFromEvidence(session);
  if (outcome === "succeeded" || outcome === "failed" || outcome === "cancelled") return outcome;
  if (outcome === "unknown") return "ended-indeterminate";
  return session.liveness === "live" ? "running" : "unavailable";
}

export function runtimeSessionEntityV1(session: RuntimeSession): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: "runtime-session/v1",
    runtimeSessionId: session.runtimeSessionId,
    taskBindings: Object.freeze(
      session.taskBindings.map(({ taskId, executionId }) => Object.freeze({ taskId, executionId })),
    ),
    liveness: session.liveness,
    outcome: session.outcome,
    semanticState: runtimeSessionSemanticState(session),
  });
}

export function runtimeSessionIsRunning(
  session: Pick<RuntimeSession, "liveness" | "outcome"> &
    Partial<Pick<RuntimeSession, "exitCode" | "resultRef" | "reasonCode">>,
): boolean {
  return runtimeSessionSemanticState(session) === "running";
}

/** The session-list range judgment: active work is never hidden by a historical cutoff. */
export function runtimeSessionInActivityWindow(
  session: Pick<RuntimeSession, "liveness" | "outcome" | "lastObservedAt">,
  since: string,
): boolean {
  const sinceTime = Date.parse(since);
  if (!Number.isFinite(sinceTime)) throw new Error("runtime session activity window requires an ISO timestamp");
  return (
    session.liveness === "live" || runtimeSessionIsRunning(session) || Date.parse(session.lastObservedAt) >= sinceTime
  );
}

/** 活动时间派生的唯一实现(取最新 + 排序比较)。语义与上面的 runtimeSessionInActivityWindow
 * 一致:比时间瞬值而非字符串,不同毫秒精度/秒精度的 ISO 戳不会因字典序错判先后或进出窗口。
 * timestamp() 只要求以 `Z` 结尾的合法 ISO,小数秒可选且位数不限,所以同一条流上会共存
 * `...:00Z` 与 `...:00.001Z`;字典序下 `"Z"(0x5A) > "."(0x2E)`,更早的那条会被判成更晚。
 * 跨节点聚合读尤其吃这个:一次聚合的成员会话可以散在不同边缘节点,每条 lastObservedAt 来自
 * 各自事件的 occurredAt,精度并不统一。非法 ISO 直接抛错(fail-closed),与 since 的处置相同。 */
export function compareRuntimeActivity(left: string, right: string): number {
  return runtimeActivityTime(left) - runtimeActivityTime(right);
}

/** 一组已落盘观测时间按瞬值取 max。epoch 仅是空集的 max 恒等元,不是读取兜底:它出现在结果里
 * 只意味着这一组确实一条已落盘观测都没有。 */
export function latestRuntimeActivityAt(stamps: Iterable<string>): string {
  let latest = "1970-01-01T00:00:00.000Z";
  for (const stamp of stamps) if (compareRuntimeActivity(stamp, latest) > 0) latest = stamp;
  return latest;
}

function runtimeActivityTime(stamp: string): number {
  const time = Date.parse(stamp);
  if (!Number.isFinite(time)) throw new Error("runtime activity derivation requires an ISO timestamp");
  return time;
}

interface RuntimePayloads {
  readonly runtime_installation_observed: {
    readonly installationId: string;
    readonly kindId: string;
    readonly protocolFamily: RuntimeProtocolFamily;
    readonly hostRef: string;
    readonly version: string;
    readonly discoverySource: "wrapper" | "hook";
    readonly capabilities: readonly RuntimeCapability[];
  };
  readonly runtime_dispatch_requested: {
    readonly dispatchId: string;
    readonly runtimeSessionId: string;
    readonly instanceId: string;
    readonly installationId: string;
    readonly kindId: string;
    readonly idempotencyKey: string;
    readonly definitionSnapshotRef: string;
    readonly definitionSnapshot: AgentDefinitionSnapshot;
  };
  readonly runtime_session_started: {
    readonly runtimeSessionId: string;
    readonly instanceId: string;
    readonly installationId: string;
    readonly kindId: string;
    readonly definitionSnapshotRef: string;
    readonly launchGeneration: number;
    readonly attachable: boolean;
  };
  readonly runtime_session_provider_bound: {
    readonly runtimeSessionId: string;
    readonly providerSessionId: string;
    readonly transcriptRef: string;
  };
  readonly runtime_session_task_bound: {
    readonly runtimeSessionId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly providerSessionId: string;
    readonly transcriptRef: string;
  };
  readonly runtime_session_liveness_changed: {
    readonly runtimeSessionId: string;
    readonly liveness: Exclude<RuntimeLiveness, "exited">;
  };
  readonly runtime_session_cancelled: { readonly runtimeSessionId: string };
  readonly runtime_session_exited: { readonly runtimeSessionId: string };
  readonly runtime_session_outcome_observed: {
    readonly runtimeSessionId: string;
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled";
    readonly exitCode: number | null;
    readonly resultRef: string;
    readonly result: RuntimeResultClaim | null;
    readonly reasonCode?: string;
  };
  readonly runtime_dispatch_outcome_unknown: { readonly dispatchId: string; readonly runtimeSessionId: string };
}
export type AgentRuntimeEventV1 = {
  [T in AgentRuntimeEventType]: EventEnvelope<"agent-runtime-event/v1", T, ActorIdentity, RuntimePayloads[T]>;
}[AgentRuntimeEventType];
const envelopeFields = [
  "schema",
  "eventId",
  "workspaceRevision",
  "opId",
  "type",
  "actor",
  "source",
  "occurredAt",
  "payload",
] as const;
const payloadFields: Record<AgentRuntimeEventType, readonly string[]> = {
  runtime_installation_observed: [
    "installationId",
    "kindId",
    "protocolFamily",
    "hostRef",
    "version",
    "discoverySource",
    "capabilities",
  ],
  runtime_dispatch_requested: [
    "dispatchId",
    "runtimeSessionId",
    "instanceId",
    "installationId",
    "kindId",
    "idempotencyKey",
    "definitionSnapshotRef",
    "definitionSnapshot",
  ],
  runtime_session_started: [
    "runtimeSessionId",
    "instanceId",
    "installationId",
    "kindId",
    "definitionSnapshotRef",
    "launchGeneration",
    "attachable",
  ],
  runtime_session_provider_bound: ["runtimeSessionId", "providerSessionId", "transcriptRef"],
  runtime_session_task_bound: ["runtimeSessionId", "taskId", "executionId", "providerSessionId", "transcriptRef"],
  runtime_session_liveness_changed: ["runtimeSessionId", "liveness"],
  runtime_session_cancelled: ["runtimeSessionId"],
  runtime_session_exited: ["runtimeSessionId"],
  runtime_session_outcome_observed: ["runtimeSessionId", "outcome", "exitCode", "resultRef", "result"],
  runtime_dispatch_outcome_unknown: ["dispatchId", "runtimeSessionId"],
};
export function validateAgentRuntimePayload(type: AgentRuntimeEventType, value: unknown): readonly string[] {
  return validateAgentRuntimePayloadFields(type, value, false);
}
function validateAgentRuntimePayloadFields(
  type: AgentRuntimeEventType,
  value: unknown,
  allowUnknownFields: boolean,
): readonly string[] {
  const optionalFields = type === "runtime_session_outcome_observed" ? ["reasonCode"] : [];
  if (
    !isRecord(value) ||
    !hasRequiredFields(value, payloadFields[type]) ||
    (!allowUnknownFields &&
      Object.keys(value).some((field) => !payloadFields[type].includes(field) && !optionalFields.includes(field)))
  )
    return ["agent runtime payload fields are incomplete or unknown"];
  const ids = payloadFields[type].filter((field) => /(?:Id|Key)$/u.test(field));
  if (ids.some((field) => !isNonEmptyString(value[field]))) return ["agent runtime payload identity is invalid"];
  if (
    type === "runtime_installation_observed" &&
    (!isNonEmptyString(value.protocolFamily) ||
      !["wrapper", "hook"].includes(String(value.discoverySource)) ||
      !validCapabilities(value.capabilities) ||
      !isNonEmptyString(value.hostRef) ||
      !isNonEmptyString(value.version))
  )
    return ["runtime installation observation is invalid"];
  if (
    type === "runtime_dispatch_requested" &&
    (!validRef(value.definitionSnapshotRef) ||
      !validDefinitionSnapshot(value.definitionSnapshot, allowUnknownFields) ||
      value.instanceId !== value.definitionSnapshot.instanceId ||
      value.installationId !== value.definitionSnapshot.installationId ||
      value.kindId !== value.definitionSnapshot.kindId ||
      (/^artifact:runtime-definition\/sha256\/[0-9a-f]{64}$/u.test(String(value.definitionSnapshotRef)) &&
        value.definitionSnapshotRef !== runtimeDefinitionSnapshotArtifact(value.definitionSnapshot).ref))
  )
    return ["runtime definition snapshot is invalid"];
  if (
    type === "runtime_session_started" &&
    (!validRef(value.definitionSnapshotRef) ||
      !Number.isInteger(value.launchGeneration) ||
      (value.launchGeneration as number) < 0 ||
      typeof value.attachable !== "boolean")
  )
    return ["runtime session start is invalid"];
  if (
    (type === "runtime_session_provider_bound" || type === "runtime_session_task_bound") &&
    !validRef(value.transcriptRef)
  )
    return ["runtime transcript ref is invalid"];
  if (type === "runtime_session_liveness_changed" && !["live", "stale", "unknown"].includes(String(value.liveness)))
    return ["runtime liveness transition is invalid"];
  if (
    type === "runtime_session_outcome_observed" &&
    (!["succeeded", "failed", "unknown", "cancelled"].includes(String(value.outcome)) ||
      (value.exitCode !== null && (!Number.isInteger(value.exitCode) || (value.exitCode as number) < 0)) ||
      (value.reasonCode !== undefined && !isNonEmptyString(value.reasonCode)) ||
      !validResult(value.resultRef, value.result, allowUnknownFields))
  )
    return ["runtime outcome observation is invalid"];
  return [];
}
export function validateAgentRuntimeEvent(value: unknown): readonly string[] {
  return validateAgentRuntimeEventFields(value, true);
}
export function validateCurrentAgentRuntimeEvent(value: unknown): readonly string[] {
  return validateAgentRuntimeEventFields(value, false);
}
function validateAgentRuntimeEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, envelopeFields) ||
    value.schema !== "agent-runtime-event/v1" ||
    !agentRuntimeEventTypes.includes(value.type as AgentRuntimeEventType)
  )
    return ["agent runtime event envelope is invalid"];
  const errors = validateAgentRuntimePayloadFields(
    value.type as AgentRuntimeEventType,
    value.payload,
    allowUnknownFields,
  );
  if (errors.length) return errors;
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["agent runtime event envelope identity is invalid"]
    : [];
}
export function isAgentRuntimeEvent(event: { readonly schema: string }): event is AgentRuntimeEventV1 {
  return event.schema === "agent-runtime-event/v1";
}
export function runtimeEventContentClaims(
  event: AgentRuntimeEventV1,
): readonly (RuntimeResultClaim | RuntimeDefinitionSnapshotClaim)[] {
  if (event.type === "runtime_session_outcome_observed")
    return event.payload.result === null ? [] : [event.payload.result];
  if (
    event.type === "runtime_dispatch_requested" &&
    /^artifact:runtime-definition\/sha256\/[0-9a-f]{64}$/u.test(event.payload.definitionSnapshotRef)
  )
    return [runtimeDefinitionSnapshotArtifact(event.payload.definitionSnapshot).claim];
  return [];
}

export function runtimeDefinitionSnapshotArtifact(definition: AgentDefinitionSnapshot): {
  readonly ref: string;
  readonly body: string;
  readonly claim: RuntimeDefinitionSnapshotClaim;
} {
  const body = stableStringify(definition),
    sha256 = sha256Text(body),
    claim = {
      sha256,
      size: Buffer.byteLength(body),
      mediaType: "application/vnd.harness.agent-definition-snapshot+json" as const,
    };
  return { ref: `artifact:runtime-definition/sha256/${sha256}`, body, claim };
}
export function runtimeSessionId(event: AgentRuntimeEventV1): string | null {
  return "runtimeSessionId" in event.payload ? event.payload.runtimeSessionId : null;
}
export function reduceRuntimeInstallation(
  current: RuntimeInstallation | null,
  event: AgentRuntimeEventV1,
): RuntimeInstallation | null {
  if (event.type !== "runtime_installation_observed") return current;
  const value = event.payload;
  return {
    installationId: value.installationId,
    kindId: value.kindId,
    protocolFamily: value.protocolFamily,
    hostRef: value.hostRef,
    version: value.version,
    discoverySource: value.discoverySource,
    effectiveCapabilities: value.capabilities,
    lastObservedAt: event.occurredAt,
  };
}
export function reduceRuntimeSession(
  current: RuntimeSession | null,
  event: AgentRuntimeEventV1,
): RuntimeSession | null {
  if (event.type === "runtime_session_started") {
    const value = event.payload;
    if (current !== null && value.launchGeneration <= current.launchGeneration)
      throw new RuntimeSessionAdoptionStaleError(
        `runtime session ${value.runtimeSessionId} launch generation is stale`,
      );
    return {
      runtimeSessionId: value.runtimeSessionId,
      instanceId: value.instanceId,
      installationId: value.installationId,
      kindId: value.kindId,
      definitionSnapshotRef: value.definitionSnapshotRef,
      providerSessionId: current?.providerSessionId ?? null,
      transcriptRef: current?.transcriptRef ?? null,
      launchGeneration: value.launchGeneration,
      liveness: "live",
      attachable: value.attachable,
      taskBindings: current?.taskBindings ?? [],
      outcome: current?.outcome ?? null,
      exitCode: current?.exitCode ?? null,
      resultRef: current?.resultRef ?? null,
      lastObservedAt: event.occurredAt,
    };
  }
  if (
    event.type === "runtime_dispatch_requested" ||
    event.type === "runtime_dispatch_outcome_unknown" ||
    event.type === "runtime_installation_observed"
  )
    return current;
  const sessionId = runtimeSessionId(event);
  if (sessionId === null) return current;
  if (current === null || current.runtimeSessionId !== sessionId)
    throw new Error(`runtime session ${sessionId} has not started`);
  if (event.type === "runtime_session_provider_bound") {
    if (current.providerSessionId !== null && current.providerSessionId !== event.payload.providerSessionId)
      throw new Error(`runtime session ${sessionId} provider binding changed`);
    return {
      ...current,
      providerSessionId: event.payload.providerSessionId,
      transcriptRef: event.payload.transcriptRef,
      lastObservedAt: event.occurredAt,
    };
  }
  if (event.type === "runtime_session_task_bound") {
    if (current.providerSessionId !== null && current.providerSessionId !== event.payload.providerSessionId)
      throw new Error(`runtime session ${sessionId} task binding changed provider session`);
    const binding = {
        taskId: event.payload.taskId,
        executionId: event.payload.executionId,
        providerSessionId: event.payload.providerSessionId,
        transcriptRef: event.payload.transcriptRef,
        boundAt: event.occurredAt,
      },
      taskBindings = [
        ...current.taskBindings.filter(
          (value) => value.taskId !== binding.taskId || value.executionId !== binding.executionId,
        ),
        binding,
      ];
    return {
      ...current,
      providerSessionId: binding.providerSessionId,
      transcriptRef: binding.transcriptRef,
      taskBindings,
      lastObservedAt: event.occurredAt,
    };
  }
  if (event.type === "runtime_session_liveness_changed") {
    if (current.liveness === "exited") throw new Error(`runtime session ${sessionId} already exited`);
    return {
      ...current,
      liveness: event.payload.liveness,
      attachable: event.payload.liveness === "live" ? true : current.attachable,
      lastObservedAt: event.occurredAt,
    };
  }
  if (event.type === "runtime_session_cancelled")
    return {
      ...current,
      liveness: "exited",
      attachable: false,
      outcome: "cancelled",
      exitCode: null,
      lastObservedAt: event.occurredAt,
    };
  if (event.type === "runtime_session_exited")
    return { ...current, liveness: "exited", attachable: false, lastObservedAt: event.occurredAt };
  if (event.type === "runtime_session_outcome_observed")
    return {
      ...current,
      outcome: event.payload.outcome,
      exitCode: event.payload.exitCode,
      resultRef: event.payload.resultRef,
      ...(event.payload.reasonCode ? { reasonCode: event.payload.reasonCode } : {}),
      lastObservedAt: event.occurredAt,
    };
  return current;
}
export function markRuntimeSessionUnknown(session: RuntimeSession): RuntimeSession {
  return session.liveness === "exited" || (session.liveness === "unknown" && !session.attachable)
    ? session
    : { ...session, liveness: "unknown", attachable: false };
}
export function unavailableSessionIdentity(runtime = "unavailable"): SessionIdentity {
  return { runtime, sessionId: null, transcriptReachability: "unavailable" };
}
export function sessionProvenance(identity: SessionIdentity, boundAt: string): SessionProvenanceV1 {
  return { ...identity, boundAt };
}
export function validateSessionIdentity(value: unknown): value is SessionIdentity {
  return (
    isRecord(value) &&
    hasOnlyFields(value, ["runtime", "sessionId", "transcriptReachability"]) &&
    isNonEmptyString(value.runtime) &&
    transcriptReachabilityStates.includes(value.transcriptReachability as TranscriptReachability) &&
    (value.sessionId === null
      ? value.transcriptReachability === "unavailable"
      : isNonEmptyString(value.sessionId) && value.transcriptReachability !== "unavailable")
  );
}
export function validateSessionProvenance(value: unknown, allowUnknownFields = false): value is SessionProvenanceV1 {
  const fields = ["runtime", "sessionId", "transcriptReachability", "boundAt"];
  return (
    isRecord(value) &&
    (allowUnknownFields ? hasRequiredFields(value, fields) : hasOnlyFields(value, fields)) &&
    validateSessionIdentity({
      runtime: value.runtime,
      sessionId: value.sessionId,
      transcriptReachability: value.transcriptReachability,
    }) &&
    timestamp(value.boundAt)
  );
}
function validCapabilities(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => runtimeCapabilities.includes(item as RuntimeCapability)) &&
    new Set(value).size === value.length
  );
}
function validDefinitionSnapshot(value: unknown, allowUnknownFields: boolean): value is AgentDefinitionSnapshot {
  const required = [
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
    ],
    allowed = [...required, "fast"];
  return (
    isRecord(value) &&
    required.every((field) => Object.hasOwn(value, field)) &&
    (allowUnknownFields || Object.keys(value).every((field) => allowed.includes(field))) &&
    value.schema === "agent-definition-snapshot/v1" &&
    value.configVersion === 1 &&
    [value.instanceId, value.installationId, value.providerId, value.model].every(isNonEmptyString) &&
    isNonEmptyString(value.kindId) &&
    (value.reasoningEffort === null || isNonEmptyString(value.reasoningEffort)) &&
    (value.fast === undefined || typeof value.fast === "boolean") &&
    (value.baseUrl === null || isNonEmptyString(value.baseUrl)) &&
    ["subscription", "api-key"].includes(String(value.authMode))
  );
}
function validResult(ref: unknown, value: unknown, allowUnknownFields: boolean): value is RuntimeResultClaim | null {
  if (value === null) return /^artifact:runtime-result\/sha256\/[0-9a-f]{64}$/u.test(String(ref));
  return (
    isRecord(value) &&
    (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, ["sha256", "size", "mediaType"]) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    Number.isInteger(value.size) &&
    (value.size as number) >= 0 &&
    value.mediaType === "text/plain; charset=utf-8" &&
    ref === `artifact:runtime-result/sha256/${value.sha256}`
  );
}
function validRef(value: unknown): boolean {
  return typeof value === "string" && /^(?:artifact|file|provider):[^\r\n]{1,512}$/u.test(value);
}
