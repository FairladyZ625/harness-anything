import type { AgentRuntimeSessionStatus } from "../../agent-runtime-data.ts";

export function shortId(runtimeSessionId: string): string {
  if (runtimeSessionId.length <= 18) return runtimeSessionId;
  return `${runtimeSessionId.slice(0, 12)}…${runtimeSessionId.slice(-4)}`;
}

export type SessionDisplayState = "alive" | "completed" | "failed" | "unknown";

export function sessionDisplayState(session: AgentRuntimeSessionStatus): SessionDisplayState {
  const state = session.process.state;
  if (state === "alive") return "alive";
  if (state === "exited") {
    if (session.process.exitCode === 0) return "completed";
    return "failed";
  }
  return "unknown";
}

export function timeOfDay(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour12: false });
}

export function fullTimestamp(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString();
}
