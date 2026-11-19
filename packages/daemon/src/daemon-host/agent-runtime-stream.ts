import { randomUUID } from "node:crypto";
import type { ActorIdentity, RuntimeSession, WriteSource } from "@harness-anything/kernel";
import { serialize } from "./agent-runtime-contract.ts";
import {
  runtimeStreamKind,
  emptyRuntimeStreamSnapshot,
  applyRuntimeStreamSignal,
  sameRuntimeStream,
  validateAgentRuntimeAttach,
  validateAgentRuntimeAttachEvent,
  type AgentRuntimeAttachEvent,
  type AgentRuntimeAttachResult,
  type AgentRuntimeNativeSignal,
  type RuntimeStreamCursor,
  type RuntimeStreamSnapshot,
} from "./protocol/stream-contract.ts";
export type {
  AgentRuntimeActivity,
  AgentRuntimeAttachEvent,
  AgentRuntimeAttachResult,
  AgentRuntimeNativeSignal,
} from "./protocol/stream-contract.ts";
export interface AgentRuntimeAttachSubscription {
  readonly initial: AgentRuntimeAttachResult;
  readonly next: () => Promise<AgentRuntimeAttachEvent | null>;
  readonly detach: () => void;
}
export interface AgentRuntimeWitnessToken {
  readonly token: string;
  readonly runtimeSessionId: string;
  readonly expiresAt: string;
}
export interface AgentRuntimeWitnessBinding {
  readonly runtimeSessionId: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
}
export interface AgentRuntimeStreamHub {
  readonly attach: (
    runtimeSessionId: string,
    afterCursor?: RuntimeStreamCursor,
    signal?: AbortSignal,
  ) => Promise<AgentRuntimeAttachSubscription>;
  readonly publish: (runtimeSessionId: string, signal: AgentRuntimeNativeSignal) => AgentRuntimeAttachEvent;
  readonly issueWitnessToken: (
    runtimeSessionId: string,
    binding: { readonly principalId: string; readonly source: WriteSource },
  ) => Promise<AgentRuntimeWitnessToken>;
  readonly bindWitness: (token: string) => AgentRuntimeWitnessBinding;
  readonly close: () => void;
}

const BUFFER_LIMIT = 32,
  WITNESS_TTL_MS = 5 * 60_000;
type StreamState = {
  cursor: RuntimeStreamCursor;
  snapshot: RuntimeStreamSnapshot;
  readonly events: AgentRuntimeAttachEvent[];
  readonly subscribers: Set<Subscriber>;
};
type Subscriber = { cursor: number; signal: AbortSignal; wake: (() => void) | null; detach: () => void };

export function makeAgentRuntimeStreamHub(input: {
  readonly repoId: string;
  readonly readSession: (runtimeSessionId: string) => RuntimeSession | null | Promise<RuntimeSession | null>;
  readonly canAttach: (session: RuntimeSession) => boolean | Promise<boolean>;
  readonly now?: () => Date;
}): AgentRuntimeStreamHub {
  const streams = new Map<string, StreamState>(),
    tokens = new Map<
      string,
      { runtimeSessionId: string; principalId: string; source: WriteSource; expiresAt: number }
    >();
  const now = input.now ?? (() => new Date());
  let closed = false;
  const stateFor = (runtimeSessionId: string): StreamState => {
    let state = streams.get(runtimeSessionId);
    if (!state) {
      state = {
        cursor: { repoId: input.repoId, streamKind: runtimeStreamKind, streamEpoch: randomUUID(), seq: 0 },
        snapshot: emptyRuntimeStreamSnapshot,
        events: [],
        subscribers: new Set(),
      };
      streams.set(runtimeSessionId, state);
    }
    return state;
  };
  return {
    attach: async (runtimeSessionId, afterCursor, signal) => {
      const session = await input.readSession(runtimeSessionId);
      if (session === null) return unsupported(runtimeSessionId);
      const live =
        session.outcome == null &&
        streams.get(runtimeSessionId)?.snapshot.outcome == null &&
        (await input.canAttach(session));
      const retained = streams.get(runtimeSessionId);
      const outcome = retained?.snapshot.outcome ?? session.outcome ?? null;
      // Repository authorization already ran. Liveness admits fresh listeners, while a cursor
      // can finish a stream whose process exited during the disconnect.
      if (closed || signal?.aborted || (outcome === null ? !live : afterCursor === undefined))
        return unsupported(runtimeSessionId);
      const state = retained ?? stateFor(runtimeSessionId);
      const { cursor } = state,
        oldest = state.events[0]?.cursor.seq ?? cursor.seq,
        gap =
          outcome !== state.snapshot.outcome ||
          (afterCursor
            ? !sameRuntimeStream(afterCursor, cursor) || afterCursor.seq < oldest || afterCursor.seq > cursor.seq
            : oldest > 1);
      const initialEvents = gap
        ? [gapEvent(runtimeSessionId, state, now(), outcome)]
        : state.events.filter((event) => event.cursor.seq > (afterCursor?.seq ?? 0));
      const initial = {
        ok: true,
        status: gap ? "gap" : "attached",
        runtimeSessionId,
        cursor,
        events: initialEvents,
      } as const;
      if (outcome !== null) return { initial, next: async () => null, detach: () => undefined };
      const controller = new AbortController();
      const detach = () => {
        controller.abort();
        signal?.removeEventListener("abort", detach);
        state.subscribers.delete(subscriber);
        subscriber.wake?.();
      };
      const subscriber: Subscriber = { cursor: cursor.seq, signal: controller.signal, wake: null, detach };
      state.subscribers.add(subscriber);
      signal?.addEventListener("abort", detach, { once: true });
      return {
        initial,
        next: () => nextEvent(runtimeSessionId, state, subscriber, now),
        detach,
      };
    },
    publish: (runtimeSessionId, signal) => {
      const state = stateFor(runtimeSessionId);
      state.cursor = { ...state.cursor, seq: state.cursor.seq + 1 };
      const occurredAt = now().toISOString(),
        event = {
          schema: "agent-runtime-attach-event/v2",
          runtimeSessionId,
          cursor: state.cursor,
          occurredAt,
          ...signal,
        } as const;
      state.snapshot = applyRuntimeStreamSignal(state.snapshot, signal, occurredAt);
      state.events.push(event);
      if (state.events.length > BUFFER_LIMIT) state.events.shift();
      for (const subscriber of state.subscribers) subscriber.wake?.();
      return event;
    },
    issueWitnessToken: async (runtimeSessionId, binding) => {
      if ((await input.readSession(runtimeSessionId)) === null)
        throw runtimeStreamError("runtime_session_not_found", `Runtime session ${runtimeSessionId} was not found.`);
      const token = randomUUID(),
        expiresAt = now().getTime() + WITNESS_TTL_MS;
      tokens.set(token, { runtimeSessionId, ...binding, expiresAt });
      return { token, runtimeSessionId, expiresAt: new Date(expiresAt).toISOString() };
    },
    bindWitness: (token) => {
      const binding = tokens.get(token);
      if (!binding || binding.expiresAt <= now().getTime()) {
        tokens.delete(token);
        throw runtimeStreamError("witness_binding_invalid", "Runtime witness binding is missing or expired.");
      }
      return {
        runtimeSessionId: binding.runtimeSessionId,
        actor: {
          principal: { personId: binding.principalId },
          executor: { kind: "agent", id: `runtime-session:${binding.runtimeSessionId}` },
        },
        source: binding.source,
      };
    },
    close: () => {
      closed = true;
      for (const state of streams.values()) for (const subscriber of state.subscribers) subscriber.detach();
      streams.clear();
      tokens.clear();
    },
  };
}

async function nextEvent(
  runtimeSessionId: string,
  state: StreamState,
  subscriber: Subscriber,
  now: () => Date,
): Promise<AgentRuntimeAttachEvent | null> {
  for (;;) {
    if (subscriber.signal.aborted) return null;
    const oldest = state.events[0]?.cursor.seq ?? state.cursor.seq;
    if (subscriber.cursor + 1 < oldest) {
      subscriber.cursor = state.cursor.seq;
      return gapEvent(runtimeSessionId, state, now());
    }
    const next = state.events.find((event) => event.cursor.seq > subscriber.cursor);
    if (next) {
      subscriber.cursor = next.cursor.seq;
      return next;
    }
    if (state.snapshot.outcome !== null) return null;
    await new Promise<void>((resolve) => {
      subscriber.wake = resolve;
    });
    subscriber.wake = null;
  }
}
function unsupported(runtimeSessionId: string): AgentRuntimeAttachSubscription {
  return {
    initial: {
      ok: false,
      code: "unsupported",
      runtimeSessionId,
      hint: "This provider session does not expose read-only live frames.",
    },
    next: async () => null,
    detach: () => undefined,
  };
}
function gapEvent(
  runtimeSessionId: string,
  state: StreamState,
  occurredAt: Date,
  outcome = state.snapshot.outcome,
): AgentRuntimeAttachEvent {
  return {
    schema: "agent-runtime-attach-event/v2",
    type: "gap",
    runtimeSessionId,
    cursor: state.cursor,
    occurredAt: occurredAt.toISOString(),
    snapshotSeq: state.cursor.seq,
    snapshot: { ...state.snapshot, outcome },
  };
}
function runtimeStreamError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
export const serializeAgentRuntimeAttach = (value: unknown): string => serialize(value, validateAgentRuntimeAttach),
  serializeAgentRuntimeAttachEvent = (value: unknown): string => serialize(value, validateAgentRuntimeAttachEvent);
