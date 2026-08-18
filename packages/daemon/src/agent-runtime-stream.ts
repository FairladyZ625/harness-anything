import { randomUUID } from "node:crypto";
import type { ActorIdentity, RuntimeSession, WriteSource } from "../../kernel/src/index.ts";
import { serialize } from "./agent-runtime-contract.ts";

export type AgentRuntimeActivity = "thinking" | "tool" | "message";
export type AgentRuntimeNativeSignal =
  | { readonly type: "activity"; readonly activity: AgentRuntimeActivity; readonly content?: string }
  | { readonly type: "heartbeat" }
  | { readonly type: "exit"; readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" }
  | { readonly type: "error"; readonly code: "provider_disconnected" | "provider_protocol_error" };
type RuntimeStreamBase = { readonly schema: "agent-runtime-attach-event/v1"; readonly runtimeSessionId: string; readonly cursor: string; readonly occurredAt: string };
export type AgentRuntimeAttachEvent = RuntimeStreamBase & (
  | { readonly type: "activity"; readonly activity: AgentRuntimeActivity; readonly content?: string }
  | { readonly type: "heartbeat" }
  | { readonly type: "exit"; readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" }
  | { readonly type: "error"; readonly code: "provider_disconnected" | "provider_protocol_error" }
  | { readonly type: "gap"; readonly required: "snapshot" }
);
export type AgentRuntimeAttachResult =
  | { readonly ok: false; readonly code: "unsupported"; readonly runtimeSessionId: string; readonly hint: string }
  | { readonly ok: true; readonly status: "attached" | "gap"; readonly runtimeSessionId: string; readonly cursor: string; readonly events: readonly AgentRuntimeAttachEvent[] };
export interface AgentRuntimeAttachSubscription { readonly initial: AgentRuntimeAttachResult; readonly next: () => Promise<AgentRuntimeAttachEvent | null>; readonly detach: () => void }
export interface AgentRuntimeWitnessToken { readonly token: string; readonly runtimeSessionId: string; readonly expiresAt: string }
export interface AgentRuntimeWitnessBinding { readonly runtimeSessionId: string; readonly actor: ActorIdentity; readonly source: WriteSource }
export interface AgentRuntimeStreamHub {
  readonly attach: (runtimeSessionId: string, afterCursor: string) => AgentRuntimeAttachSubscription;
  readonly publish: (runtimeSessionId: string, signal: AgentRuntimeNativeSignal) => AgentRuntimeAttachEvent;
  readonly latestCursor: (runtimeSessionId: string) => string;
  readonly issueWitnessToken: (runtimeSessionId: string, binding: { readonly principalId: string; readonly source: WriteSource }) => AgentRuntimeWitnessToken;
  readonly bindWitness: (token: string) => AgentRuntimeWitnessBinding;
  readonly close: () => void;
}

const BUFFER_LIMIT = 32, WITNESS_TTL_MS = 5 * 60_000;
type StreamState = { sequence: number; events: AgentRuntimeAttachEvent[]; subscribers: Set<Subscriber> };
type Subscriber = { runtimeSessionId: string; cursor: number; detached: boolean; wake: (() => void) | null };

export function makeAgentRuntimeStreamHub(input: { readonly readSession: (runtimeSessionId: string) => RuntimeSession | null; readonly canAttach: (session: RuntimeSession) => boolean; readonly now?: () => Date }): AgentRuntimeStreamHub {
  const streams = new Map<string, StreamState>(), tokens = new Map<string, { runtimeSessionId: string; principalId: string; source: WriteSource; expiresAt: number }>();
  const now = input.now ?? (() => new Date());
  const stateFor = (runtimeSessionId: string): StreamState => { let state = streams.get(runtimeSessionId); if (!state) { state = { sequence: 0, events: [], subscribers: new Set() }; streams.set(runtimeSessionId, state); } return state; };
  const latestCursor = (runtimeSessionId: string) => cursor(stateFor(runtimeSessionId).sequence);
  return {
    attach: (runtimeSessionId, afterCursor) => {
      const session = input.readSession(runtimeSessionId);
      if (session === null || !input.canAttach(session)) return unsupported(runtimeSessionId);
      const state = stateFor(runtimeSessionId), after = parseCursor(afterCursor);
      const oldest = state.events[0] ? parseCursor(state.events[0].cursor) : state.sequence + 1, gap = after > state.sequence || after < oldest - 1;
      const initialEvents = gap ? [gapEvent(runtimeSessionId, state.sequence, now())] : state.events.filter((event) => parseCursor(event.cursor) > after);
      const subscriber: Subscriber = { runtimeSessionId, cursor: state.sequence, detached: false, wake: null }; state.subscribers.add(subscriber);
      const detach = () => { if (subscriber.detached) return; subscriber.detached = true; state.subscribers.delete(subscriber); subscriber.wake?.(); subscriber.wake = null; };
      return { initial: { ok: true, status: gap ? "gap" : "attached", runtimeSessionId, cursor: cursor(state.sequence), events: initialEvents },
        next: () => nextEvent(state, subscriber, now), detach };
    },
    publish: (runtimeSessionId, signal) => {
      const session = input.readSession(runtimeSessionId); if (session === null || !input.canAttach(session)) throw runtimeStreamError("unsupported", `Runtime session ${runtimeSessionId} has no live attach capability.`);
      const state = stateFor(runtimeSessionId), event = signalEvent(runtimeSessionId, ++state.sequence, now(), signal); if (validateAgentRuntimeAttachEvent(event).length) { state.sequence -= 1; throw runtimeStreamError("invalid_provider_frame", "Provider frame is outside the safe attach contract."); } state.events.push(event);
      if (state.events.length > BUFFER_LIMIT) state.events.splice(0, state.events.length - BUFFER_LIMIT);
      for (const subscriber of state.subscribers) subscriber.wake?.(); return event;
    },
    latestCursor,
    issueWitnessToken: (runtimeSessionId, binding) => {
      if (input.readSession(runtimeSessionId) === null) throw runtimeStreamError("runtime_session_not_found", `Runtime session ${runtimeSessionId} was not found.`);
      const token = randomUUID(), expiresAt = now().getTime() + WITNESS_TTL_MS; tokens.set(token, { runtimeSessionId, ...binding, expiresAt });
      return { token, runtimeSessionId, expiresAt: new Date(expiresAt).toISOString() };
    },
    bindWitness: (token) => { const binding = tokens.get(token); if (!binding || binding.expiresAt <= now().getTime()) { tokens.delete(token); throw runtimeStreamError("witness_binding_invalid", "Runtime witness binding is missing or expired."); }
      return { runtimeSessionId: binding.runtimeSessionId, actor: { principal: { personId: binding.principalId }, executor: { kind: "agent", id: `runtime-session:${binding.runtimeSessionId}` } }, source: binding.source }; },
    close: () => { for (const state of streams.values()) for (const subscriber of [...state.subscribers]) { subscriber.detached = true; subscriber.wake?.(); } streams.clear(); tokens.clear(); }
  };
}

async function nextEvent(state: StreamState, subscriber: Subscriber, now: () => Date): Promise<AgentRuntimeAttachEvent | null> {
  for (;;) { if (subscriber.detached) return null; const oldest = state.events[0] ? parseCursor(state.events[0].cursor) : state.sequence + 1;
    if (subscriber.cursor < oldest - 1) { subscriber.cursor = state.sequence; return gapEvent(subscriber.runtimeSessionId, state.sequence, now()); }
    const event = state.events.find((item) => parseCursor(item.cursor) > subscriber.cursor); if (event) { subscriber.cursor = parseCursor(event.cursor); return event; }
    await new Promise<void>((resolve) => { subscriber.wake = resolve; }); subscriber.wake = null; }
}
const cursor = (sequence: number) => `stream:${sequence}`;
function parseCursor(value: string): number { const match = /^stream:(\d+)$/u.exec(value), sequence = match ? Number(match[1]) : Number.NaN; if (!Number.isSafeInteger(sequence)) throw runtimeStreamError("invalid_cursor", `Invalid attach cursor: ${value}.`); return sequence; }
function unsupported(runtimeSessionId: string): AgentRuntimeAttachSubscription { return { initial: { ok: false, code: "unsupported", runtimeSessionId, hint: "This provider session does not expose read-only live frames." }, next: async () => null, detach: () => undefined }; }
function gapEvent(runtimeSessionId: string, sequence: number, occurredAt: Date): AgentRuntimeAttachEvent { return { schema: "agent-runtime-attach-event/v1", type: "gap", runtimeSessionId, cursor: cursor(sequence), occurredAt: occurredAt.toISOString(), required: "snapshot" }; }
function signalEvent(runtimeSessionId: string, sequence: number, occurredAt: Date, signal: AgentRuntimeNativeSignal): AgentRuntimeAttachEvent { return { schema: "agent-runtime-attach-event/v1", runtimeSessionId, cursor: cursor(sequence), occurredAt: occurredAt.toISOString(), ...signal }; }
function runtimeStreamError(code: string, message: string): Error { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
export function validateAgentRuntimeAttach(value: unknown): readonly string[] { if (!isRuntimeStreamRecord(value) || typeof value.ok !== "boolean" || typeof value.runtimeSessionId !== "string") return ["agent runtime attach result is invalid"]; if (!value.ok) return hasExactRuntimeStreamFields(value, ["ok", "code", "runtimeSessionId", "hint"]) && value.code === "unsupported" && typeof value.hint === "string" ? [] : ["agent runtime unsupported result is invalid"]; return hasExactRuntimeStreamFields(value, ["ok", "status", "runtimeSessionId", "cursor", "events"]) && ["attached", "gap"].includes(String(value.status)) && /^stream:\d+$/u.test(String(value.cursor)) && Array.isArray(value.events) && value.events.every((event) => validateAgentRuntimeAttachEvent(event).length === 0) ? [] : ["agent runtime attach result is invalid"]; }
export function validateAgentRuntimeAttachEvent(value: unknown): readonly string[] { if (!isRuntimeStreamRecord(value) || value.schema !== "agent-runtime-attach-event/v1" || typeof value.runtimeSessionId !== "string" || !/^stream:\d+$/u.test(String(value.cursor)) || typeof value.occurredAt !== "string" || !["activity", "heartbeat", "exit", "error", "gap"].includes(String(value.type))) return ["agent runtime attach event is invalid"]; const hasContent = value.type === "activity" && Object.hasOwn(value, "content"), fields = value.type === "activity" ? ["activity", ...(hasContent ? ["content"] : [])] : value.type === "exit" ? ["outcome"] : value.type === "error" ? ["code"] : value.type === "gap" ? ["required"] : [], allowed = value.type === "activity" ? ["thinking", "tool", "message"].includes(String(value.activity)) && (!hasContent || typeof value.content === "string") : value.type === "exit" ? ["succeeded", "failed", "unknown", "cancelled"].includes(String(value.outcome)) : value.type === "error" ? ["provider_disconnected", "provider_protocol_error"].includes(String(value.code)) : value.type === "gap" ? value.required === "snapshot" : true; return allowed && hasExactRuntimeStreamFields(value, ["schema", "type", "runtimeSessionId", "cursor", "occurredAt", ...fields]) ? [] : ["agent runtime attach event is invalid"]; }
export const serializeAgentRuntimeAttach = (value: unknown): string => serialize(value, validateAgentRuntimeAttach), serializeAgentRuntimeAttachEvent = (value: unknown): string => serialize(value, validateAgentRuntimeAttachEvent);
function isRuntimeStreamRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasExactRuntimeStreamFields(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)); }
