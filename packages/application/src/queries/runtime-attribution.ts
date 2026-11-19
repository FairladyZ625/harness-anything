import type { TaskProjection } from "@harness-anything/kernel";
import {
  writeSourceNodeId,
  writeSourceRuntimeSessionId,
} from "@harness-anything/kernel/internal/domain/write-source.ts";

/** Resolve attributed dispatches and other historical events via the indexed session launch read. */
export function sourceNodeReader(projection: Pick<TaskProjection, "readRuntimeSessionEventsByType">) {
  const launchNodes = new Map<string, string | null>();
  return (source: unknown): string | null => {
    const sessionId = writeSourceRuntimeSessionId(source);
    if (sessionId === null) return writeSourceNodeId(source);
    if (!launchNodes.has(sessionId)) {
      const launch = projection.readRuntimeSessionEventsByType(sessionId, ["runtime_session_started"]).at(-1);
      launchNodes.set(sessionId, writeSourceNodeId(launch?.source));
    }
    return launchNodes.get(sessionId) ?? null;
  };
}
export function runtimeDispatchStartedAt(dispatch: {
  readonly occurredAt: string;
  readonly payload: { readonly startedAt?: string };
}): string {
  return dispatch.payload.startedAt ?? dispatch.occurredAt;
}
