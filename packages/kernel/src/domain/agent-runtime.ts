import { hasOnlyFields, isNonEmptyString, isRecord, serializeEventEnvelope, type ActorIdentity, type EventEnvelope } from "./write-chain.contract.ts";

export const runtimeProtocolFamilies = ["claude-compatible", "codex"] as const;
export const runtimeCapabilities = ["structured_witness", "resume", "attach"] as const;
export const runtimeLivenessStates = ["live", "stale", "unknown", "exited"] as const;
export const agentRuntimeEventTypes = ["runtime_installation_observed", "runtime_dispatch_requested", "runtime_session_started", "runtime_session_provider_bound", "runtime_session_task_bound", "runtime_session_liveness_changed", "runtime_session_exited", "runtime_session_outcome_observed", "runtime_dispatch_outcome_unknown"] as const;
export type RuntimeProtocolFamily = typeof runtimeProtocolFamilies[number]; export type RuntimeCapability = typeof runtimeCapabilities[number]; export type RuntimeLiveness = typeof runtimeLivenessStates[number]; export type AgentRuntimeEventType = typeof agentRuntimeEventTypes[number];
export interface RuntimeKind { readonly kindId: string; readonly protocolFamily: RuntimeProtocolFamily; readonly profileKinds: readonly string[]; readonly declaredCapabilities: readonly RuntimeCapability[] }
export interface RuntimeInstallation { readonly installationId: string; readonly kindId: string; readonly protocolFamily: RuntimeProtocolFamily; readonly hostRef: string; readonly version: string; readonly discoverySource: "wrapper" | "hook"; readonly effectiveCapabilities: readonly RuntimeCapability[]; readonly authState: "configured" | "not_configured" | "invalid"; readonly lastObservedAt: string }
export interface RuntimeTaskSessionLink { readonly taskId: string; readonly executionId: string; readonly providerSessionId: string; readonly transcriptRef: string; readonly boundAt: string }
export interface RuntimeSession { readonly runtimeSessionId: string; readonly installationId: string; readonly kindId: string; readonly providerSessionId: string | null; readonly transcriptRef: string | null; readonly launchGeneration: number; readonly liveness: RuntimeLiveness; readonly attachable: boolean; readonly taskBindings: readonly RuntimeTaskSessionLink[]; readonly outcome: "succeeded" | "failed" | "unknown" | null; readonly resultRef: string | null; readonly lastObservedAt: string }
interface RuntimePayloads {
  readonly runtime_installation_observed: { readonly installationId: string; readonly kindId: string; readonly protocolFamily: RuntimeProtocolFamily; readonly hostRef: string; readonly version: string; readonly discoverySource: "wrapper" | "hook"; readonly capabilities: readonly RuntimeCapability[]; readonly authState: RuntimeInstallation["authState"] };
  readonly runtime_dispatch_requested: { readonly dispatchId: string; readonly runtimeSessionId: string; readonly kindId: string; readonly idempotencyKey: string; readonly definitionSnapshotRef: string };
  readonly runtime_session_started: { readonly runtimeSessionId: string; readonly installationId: string; readonly kindId: string; readonly launchGeneration: number; readonly attachable: boolean };
  readonly runtime_session_provider_bound: { readonly runtimeSessionId: string; readonly providerSessionId: string; readonly transcriptRef: string };
  readonly runtime_session_task_bound: { readonly runtimeSessionId: string; readonly taskId: string; readonly executionId: string; readonly providerSessionId: string; readonly transcriptRef: string };
  readonly runtime_session_liveness_changed: { readonly runtimeSessionId: string; readonly liveness: Exclude<RuntimeLiveness, "exited"> };
  readonly runtime_session_exited: { readonly runtimeSessionId: string };
  readonly runtime_session_outcome_observed: { readonly runtimeSessionId: string; readonly outcome: "succeeded" | "failed" | "unknown"; readonly resultRef: string };
  readonly runtime_dispatch_outcome_unknown: { readonly dispatchId: string; readonly runtimeSessionId: string };
}
export type AgentRuntimeEventV1 = { [T in AgentRuntimeEventType]: EventEnvelope<"agent-runtime-event/v1", T, ActorIdentity, RuntimePayloads[T]> }[AgentRuntimeEventType];
const envelopeFields = ["schema", "eventId", "workspaceRevision", "opId", "type", "actor", "source", "occurredAt", "payload"] as const;
const payloadFields: Record<AgentRuntimeEventType, readonly string[]> = {
  runtime_installation_observed: ["installationId", "kindId", "protocolFamily", "hostRef", "version", "discoverySource", "capabilities", "authState"], runtime_dispatch_requested: ["dispatchId", "runtimeSessionId", "kindId", "idempotencyKey", "definitionSnapshotRef"],
  runtime_session_started: ["runtimeSessionId", "installationId", "kindId", "launchGeneration", "attachable"], runtime_session_provider_bound: ["runtimeSessionId", "providerSessionId", "transcriptRef"], runtime_session_task_bound: ["runtimeSessionId", "taskId", "executionId", "providerSessionId", "transcriptRef"],
  runtime_session_liveness_changed: ["runtimeSessionId", "liveness"], runtime_session_exited: ["runtimeSessionId"], runtime_session_outcome_observed: ["runtimeSessionId", "outcome", "resultRef"], runtime_dispatch_outcome_unknown: ["dispatchId", "runtimeSessionId"]
};
export function validateAgentRuntimePayload(type: AgentRuntimeEventType, value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, payloadFields[type])) return ["agent runtime payload fields are incomplete or unknown"];
  const ids = payloadFields[type].filter((field) => /(?:Id|Key)$/u.test(field)); if (ids.some((field) => !isNonEmptyString(value[field]))) return ["agent runtime payload identity is invalid"];
  if (type === "runtime_installation_observed" && (!runtimeProtocolFamilies.includes(value.protocolFamily as RuntimeProtocolFamily) || !["wrapper", "hook"].includes(String(value.discoverySource)) || !validCapabilities(value.capabilities) || !["configured", "not_configured", "invalid"].includes(String(value.authState)) || !isNonEmptyString(value.hostRef) || !isNonEmptyString(value.version))) return ["runtime installation observation is invalid"];
  if (type === "runtime_dispatch_requested" && !validRef(value.definitionSnapshotRef)) return ["runtime definition snapshot ref is invalid"];
  if (type === "runtime_session_started" && (!Number.isInteger(value.launchGeneration) || (value.launchGeneration as number) < 0 || typeof value.attachable !== "boolean")) return ["runtime session start is invalid"];
  if ((type === "runtime_session_provider_bound" || type === "runtime_session_task_bound") && !validRef(value.transcriptRef)) return ["runtime transcript ref is invalid"];
  if (type === "runtime_session_liveness_changed" && !["live", "stale", "unknown"].includes(String(value.liveness))) return ["runtime liveness transition is invalid"];
  if (type === "runtime_session_outcome_observed" && (!["succeeded", "failed", "unknown"].includes(String(value.outcome)) || !validRef(value.resultRef))) return ["runtime outcome observation is invalid"];
  return [];
}
export function validateAgentRuntimeEvent(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, envelopeFields) || value.schema !== "agent-runtime-event/v1" || !agentRuntimeEventTypes.includes(value.type as AgentRuntimeEventType)) return ["agent runtime event envelope is invalid"];
  const errors = validateAgentRuntimePayload(value.type as AgentRuntimeEventType, value.payload); if (errors.length) return errors;
  try { serializeEventEnvelope(value as unknown as AgentRuntimeEventV1); } catch { return ["agent runtime event envelope identity is invalid"]; } return [];
}
export function isAgentRuntimeEvent(event: { readonly schema: string }): event is AgentRuntimeEventV1 { return event.schema === "agent-runtime-event/v1"; }
export function runtimeSessionId(event: AgentRuntimeEventV1): string | null { return "runtimeSessionId" in event.payload ? event.payload.runtimeSessionId : null; }
export function reduceRuntimeInstallation(current: RuntimeInstallation | null, event: AgentRuntimeEventV1): RuntimeInstallation | null { if (event.type !== "runtime_installation_observed") return current; const value = event.payload; return { installationId: value.installationId, kindId: value.kindId, protocolFamily: value.protocolFamily, hostRef: value.hostRef, version: value.version, discoverySource: value.discoverySource, effectiveCapabilities: value.capabilities, authState: value.authState, lastObservedAt: event.occurredAt }; }
export function reduceRuntimeSession(current: RuntimeSession | null, event: AgentRuntimeEventV1): RuntimeSession | null {
  if (event.type === "runtime_session_started") { const value = event.payload; if (current !== null && value.launchGeneration <= current.launchGeneration) throw new Error(`runtime session ${value.runtimeSessionId} launch generation is stale`); return { runtimeSessionId: value.runtimeSessionId, installationId: value.installationId, kindId: value.kindId, providerSessionId: current?.providerSessionId ?? null, transcriptRef: current?.transcriptRef ?? null, launchGeneration: value.launchGeneration, liveness: "live", attachable: value.attachable, taskBindings: current?.taskBindings ?? [], outcome: current?.outcome ?? null, resultRef: current?.resultRef ?? null, lastObservedAt: event.occurredAt }; }
  if (event.type === "runtime_dispatch_requested" || event.type === "runtime_dispatch_outcome_unknown" || event.type === "runtime_installation_observed") return current;
  const sessionId = runtimeSessionId(event); if (sessionId === null) return current; if (current === null || current.runtimeSessionId !== sessionId) throw new Error(`runtime session ${sessionId} has not started`);
  if (event.type === "runtime_session_provider_bound") { if (current.providerSessionId !== null && current.providerSessionId !== event.payload.providerSessionId) throw new Error(`runtime session ${sessionId} provider binding changed`); return { ...current, providerSessionId: event.payload.providerSessionId, transcriptRef: event.payload.transcriptRef, lastObservedAt: event.occurredAt }; }
  if (event.type === "runtime_session_task_bound") { if (current.providerSessionId !== null && current.providerSessionId !== event.payload.providerSessionId) throw new Error(`runtime session ${sessionId} task binding changed provider session`); const binding = { taskId: event.payload.taskId, executionId: event.payload.executionId, providerSessionId: event.payload.providerSessionId, transcriptRef: event.payload.transcriptRef, boundAt: event.occurredAt }, taskBindings = [...current.taskBindings.filter((value) => value.taskId !== binding.taskId || value.executionId !== binding.executionId), binding]; return { ...current, providerSessionId: binding.providerSessionId, transcriptRef: binding.transcriptRef, taskBindings, lastObservedAt: event.occurredAt }; }
  if (event.type === "runtime_session_liveness_changed") { if (current.liveness === "exited") throw new Error(`runtime session ${sessionId} already exited`); return { ...current, liveness: event.payload.liveness, lastObservedAt: event.occurredAt }; }
  if (event.type === "runtime_session_exited") return { ...current, liveness: "exited", attachable: false, lastObservedAt: event.occurredAt };
  if (event.type === "runtime_session_outcome_observed") return { ...current, outcome: event.payload.outcome, resultRef: event.payload.resultRef, lastObservedAt: event.occurredAt };
  return current;
}
export function markRuntimeSessionUnknown(session: RuntimeSession): RuntimeSession { return session.liveness === "exited" || session.liveness === "unknown" && !session.attachable ? session : { ...session, liveness: "unknown", attachable: false }; }
function validCapabilities(value: unknown): boolean { return Array.isArray(value) && value.every((item) => runtimeCapabilities.includes(item as RuntimeCapability)) && new Set(value).size === value.length; }
function validRef(value: unknown): boolean { return typeof value === "string" && /^(?:artifact|file|provider):[^\r\n]{1,512}$/u.test(value); }
