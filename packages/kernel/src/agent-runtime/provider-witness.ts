import { agentRuntimeEventTypes, validateCurrentAgentRuntimeEvent, validateAgentRuntimePayload, type AgentRuntimeEventType, type AgentRuntimeEventV1, type RuntimeProtocolFamily } from "../domain/agent-runtime.ts";
import { hasOnlyFields, isNonEmptyString, isRecord, type ActorIdentity, type WriteSource } from "../domain/write-chain.contract.ts";

export interface ProviderWitnessV1 { readonly schema: "agent-runtime-witness/v1"; readonly protocolFamily: RuntimeProtocolFamily; readonly channel: "wrapper" | "hook"; readonly type: AgentRuntimeEventType | "heartbeat"; readonly payload: Readonly<Record<string, unknown>> }
export interface ProviderWitnessBinding { readonly eventId: string; readonly workspaceRevision: number; readonly opId: string; readonly actor: ActorIdentity; readonly source: WriteSource; readonly occurredAt: string; readonly hostRef: string }
const fields = ["schema", "protocolFamily", "channel", "type", "payload"] as const;
export function parseProviderWitness(value: unknown): ProviderWitnessV1 {
  if (!isRecord(value) || !hasOnlyFields(value, fields) || value.schema !== "agent-runtime-witness/v1" || !["claude-compatible", "codex", "agy"].includes(String(value.protocolFamily)) || !["wrapper", "hook"].includes(String(value.channel)) || ![...agentRuntimeEventTypes, "heartbeat"].includes(value.type as AgentRuntimeEventType | "heartbeat") || !isRecord(value.payload)) throw new Error("provider witness envelope is invalid");
  const type = value.type as AgentRuntimeEventType | "heartbeat", payload = value.payload;
  if (type === "heartbeat") { if (!hasOnlyFields(payload, ["runtimeSessionId"]) || !isNonEmptyString(payload.runtimeSessionId)) throw new Error("provider heartbeat payload is invalid"); }
  else if (type === "runtime_installation_observed") { const candidate = { ...payload, protocolFamily: value.protocolFamily, discoverySource: value.channel, hostRef: "host:server-bound" }; if (validateAgentRuntimePayload(type, candidate).length) throw new Error("provider installation payload is invalid"); }
  else if (validateAgentRuntimePayload(type, payload).length) throw new Error("provider witness payload is invalid");
  return value as unknown as ProviderWitnessV1;
}
export function eventFromProviderWitness(value: unknown, binding: ProviderWitnessBinding): AgentRuntimeEventV1 | null {
  const witness = parseProviderWitness(value); if (witness.type === "heartbeat") return null;
  const payload = witness.type === "runtime_installation_observed" ? { ...witness.payload, protocolFamily: witness.protocolFamily, discoverySource: witness.channel, hostRef: binding.hostRef } : witness.payload;
  const event = { schema: "agent-runtime-event/v1", eventId: binding.eventId, workspaceRevision: binding.workspaceRevision, opId: binding.opId, type: witness.type, actor: binding.actor, source: binding.source, occurredAt: binding.occurredAt, payload } as AgentRuntimeEventV1;
  const errors = validateCurrentAgentRuntimeEvent(event); if (errors.length) throw new Error(errors.join("; ")); return event;
}
