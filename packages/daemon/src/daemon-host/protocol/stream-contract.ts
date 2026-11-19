import type { DispatchAttemptOutcome } from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";

import type { StreamAttachStatus } from "@harness-anything/kernel/internal/domain/client-view-status.ts";
import { validateTerminalAttach, validateTerminalAttachEvent } from "../gui-s3-control.ts";
import {
  isRuntimeStreamCursor,
  type DaemonStreamMethod,
  type DaemonStreamResultMap,
  type RuntimeStreamCursor,
} from "./daemon-protocol-results.ts";
import { DaemonProtocolContractError, type JsonObject } from "./json-rpc-types.ts";
export type { RuntimeStreamCursor } from "./daemon-protocol-results.ts";

export const runtimeStreamKind = "agent-runtime";

export type AgentRuntimeActivity = "thinking" | "tool" | "message";
export type AgentRuntimeNativeSignal =
  | { readonly type: "activity"; readonly activity: AgentRuntimeActivity; readonly content?: string }
  | { readonly type: "heartbeat" }
  | { readonly type: "exit"; readonly outcome: DispatchAttemptOutcome }
  | { readonly type: "error"; readonly code: "provider_disconnected" | "provider_protocol_error" };

/** Complete current native activity state. Past log lines are a separate durable read. */
export type RuntimeStreamSnapshot = {
  readonly activity: (Extract<AgentRuntimeNativeSignal, { type: "activity" }> & { readonly occurredAt: string }) | null;
  readonly heartbeatAt: string | null;
  readonly outcome: DispatchAttemptOutcome | null;
  readonly error: Extract<AgentRuntimeNativeSignal, { type: "error" }>["code"] | null;
};

export type AgentRuntimeAttachEvent = {
  readonly schema: "agent-runtime-attach-event/v2";
  readonly runtimeSessionId: string;
  readonly cursor: RuntimeStreamCursor;
  readonly occurredAt: string;
} & (
  | AgentRuntimeNativeSignal
  | { readonly type: "gap"; readonly snapshotSeq: number; readonly snapshot: RuntimeStreamSnapshot }
);

export type AgentRuntimeAttachResult =
  | { readonly ok: false; readonly code: "unsupported"; readonly runtimeSessionId: string; readonly hint: string }
  | {
      readonly ok: true;
      readonly status: StreamAttachStatus;
      readonly runtimeSessionId: string;
      readonly cursor: RuntimeStreamCursor;
      readonly events: readonly AgentRuntimeAttachEvent[];
    };

export function sameRuntimeStream(left: RuntimeStreamCursor, right: RuntimeStreamCursor): boolean {
  return left.repoId === right.repoId && left.streamKind === right.streamKind && left.streamEpoch === right.streamEpoch;
}

export function validateAgentRuntimeAttach(value: unknown): readonly string[] {
  const invalid = ["agent runtime attach result is invalid"];
  if (!record(value) || typeof value.runtimeSessionId !== "string") return invalid;
  if (value.ok === false)
    return exact(value, ["ok", "code", "runtimeSessionId", "hint"]) &&
      value.code === "unsupported" &&
      typeof value.hint === "string"
      ? []
      : invalid;
  if (
    value.ok !== true ||
    !exact(value, ["ok", "status", "runtimeSessionId", "cursor", "events"]) ||
    !isRuntimeStreamCursor(value.cursor) ||
    value.cursor.streamKind !== runtimeStreamKind ||
    !Array.isArray(value.events)
  )
    return invalid;
  const { cursor, events } = value;
  if (value.status === "gap" && (events.length !== 1 || events[0]?.type !== "gap")) return invalid;
  if (value.status !== "gap" && value.status !== "attached") return invalid;
  let previous = -1;
  for (const event of events) {
    if (
      validateAgentRuntimeAttachEvent(event).length ||
      event.runtimeSessionId !== value.runtimeSessionId ||
      !sameRuntimeStream(event.cursor, cursor) ||
      event.cursor.seq <= previous ||
      event.cursor.seq > cursor.seq ||
      (event.type === "gap" && (value.status !== "gap" || event.cursor.seq !== cursor.seq))
    )
      return invalid;
    previous = event.cursor.seq;
  }
  return [];
}

export function validateAgentRuntimeAttachEvent(value: unknown): readonly string[] {
  const invalid = ["agent runtime attach event is invalid"];
  const base = ["schema", "type", "runtimeSessionId", "cursor", "occurredAt"];
  if (
    !record(value) ||
    value.schema !== "agent-runtime-attach-event/v2" ||
    typeof value.runtimeSessionId !== "string" ||
    !isRuntimeStreamCursor(value.cursor) ||
    value.cursor.streamKind !== runtimeStreamKind ||
    typeof value.occurredAt !== "string"
  )
    return invalid;
  if (value.type === "gap")
    return exact(value, [...base, "snapshotSeq", "snapshot"]) &&
      value.snapshotSeq === value.cursor.seq &&
      validSnapshot(value.snapshot)
      ? []
      : invalid;
  return validSignal(value, base) ? [] : invalid;
}

function validSnapshot(value: unknown): boolean {
  return (
    record(value) &&
    exact(value, ["activity", "heartbeatAt", "outcome", "error"]) &&
    (value.activity === null ||
      (record(value.activity) &&
        value.activity.type === "activity" &&
        typeof value.activity.occurredAt === "string" &&
        validSignal(value.activity, ["type", "occurredAt"]))) &&
    (value.heartbeatAt === null || typeof value.heartbeatAt === "string") &&
    (value.outcome === null || validOutcome(value.outcome)) &&
    (value.error === null || validError(value.error))
  );
}

function validSignal(value: Record<string, unknown>, base: readonly string[]): boolean {
  switch (value.type) {
    case "activity":
      return (
        ["thinking", "tool", "message"].includes(String(value.activity)) &&
        (Object.hasOwn(value, "content")
          ? typeof value.content === "string" && exact(value, [...base, "activity", "content"])
          : exact(value, [...base, "activity"]))
      );
    case "heartbeat":
      return exact(value, base);
    case "exit":
      return exact(value, [...base, "outcome"]) && validOutcome(value.outcome);
    case "error":
      return exact(value, [...base, "code"]) && validError(value.code);
    default:
      return false;
  }
}

const validOutcome = (value: unknown) =>
  ["succeeded", "failed", "unknown", "cancelled", "stopped"].includes(String(value));
const validError = (value: unknown) => value === "provider_disconnected" || value === "provider_protocol_error";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

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
): AgentRuntimeAttachEvent | JsonObject {
  const errors =
    method === "repo.agentRuntime.attach" ? validateAgentRuntimeAttachEvent(value) : validateTerminalAttachEvent(value);
  if (errors.length) throw new DaemonProtocolContractError("invalid_result", errors.join("; "));
  return value as AgentRuntimeAttachEvent | JsonObject;
}
