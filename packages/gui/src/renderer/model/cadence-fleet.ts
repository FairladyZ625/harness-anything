import type { AgentRuntimeSessionDto } from "../../../../daemon/src/agent-runtime-contract.ts";
import type { TaskRow } from "./types.ts";
import type { CadenceFeedEvent } from "./cadence.ts";

export type FleetWorkerStatus = "live" | "idle" | "exited";

export interface FleetWorkerRow {
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly label: string;
  readonly status: FleetWorkerStatus;
  readonly taskIds: readonly string[];
  readonly facts: number;
  readonly decisions: number;
  readonly touchedFiles: number;
}

export interface FleetPulseSnapshot {
  readonly workers: readonly FleetWorkerRow[];
  readonly flow: { readonly claimed: number; readonly inFlight: number; readonly settled: number };
  readonly turnaroundMs: number | null;
  readonly collisions: readonly { readonly taskId: string; readonly workerCount: number }[];
}

const terminal = (task: TaskRow): boolean =>
  task.coordinationStatus === "done" || task.coordinationStatus === "cancelled";

const runtimeIdOf = (executorId: string | null): string | null => {
  if (executorId === null || !executorId.startsWith("runtime-session:")) return null;
  return executorId.slice("runtime-session:".length);
};

const workerStatus = (session: AgentRuntimeSessionDto): FleetWorkerStatus => {
  if (session.liveness === "live") return "live";
  if (session.liveness === "exited") return "exited";
  return "idle";
};

/** 只读舰队投影:session 是存活真相,事件窗口只贡献归属产出,不从文本猜 Worker。 */
export function deriveFleetPulse(input: {
  readonly sessions: readonly AgentRuntimeSessionDto[];
  readonly tasks: readonly TaskRow[];
  readonly events: readonly CadenceFeedEvent[];
}): FleetPulseSnapshot {
  const eventsByRuntime = new Map<string, CadenceFeedEvent[]>();
  for (const event of input.events) {
    const runtimeId = runtimeIdOf(event.executorId);
    if (runtimeId === null) continue;
    const rows = eventsByRuntime.get(runtimeId) ?? [];
    rows.push(event);
    eventsByRuntime.set(runtimeId, rows);
  }

  const workers = input.sessions.map((session): FleetWorkerRow => {
    const events = eventsByRuntime.get(session.runtimeSessionId) ?? [],
      touched = new Set(events.flatMap((event) => event.touchedPaths)),
      snapshot = session.definitionSnapshot;
    return {
      runtimeSessionId: session.runtimeSessionId,
      instanceId: session.instanceId,
      label: snapshot === null ? session.kindId : `${snapshot.kindId} · ${snapshot.model}`,
      status: workerStatus(session),
      taskIds: [...new Set(session.associations.map(({ taskId }) => taskId))],
      facts: events.filter(({ type, factId }) => type === "fact_recorded" && factId !== null).length,
      decisions: events.filter(({ decisionId }) => decisionId !== null).length,
      touchedFiles: touched.size,
    };
  });

  const activeTasks = new Set(
      input.sessions
        .filter((session) => session.liveness !== "exited")
        .flatMap((session) => session.associations.map(({ taskId }) => taskId)),
    ),
    settled = input.tasks.filter(terminal).length,
    inFlight = input.tasks.filter((task) => !terminal(task) && activeTasks.has(task.taskId)).length,
    claimed = input.tasks.filter((task) => !terminal(task) && !activeTasks.has(task.taskId)).length,
    delivery = new Map<string, { start: string | null; end: string | null }>();
  for (const event of input.events) {
    if (event.taskId === null || event.at === null) continue;
    const sample = delivery.get(event.taskId) ?? { start: null, end: null };
    if (event.type === "execution_started" && (sample.start === null || event.at < sample.start))
      sample.start = event.at;
    if (event.type === "task_completed" && (sample.end === null || event.at > sample.end)) sample.end = event.at;
    delivery.set(event.taskId, sample);
  }
  const samples = [...delivery.values()].flatMap(({ start, end }) => {
    if (start === null || end === null) return [];
    const value = Date.parse(end) - Date.parse(start);
    return Number.isFinite(value) && value >= 0 ? [value] : [];
  });

  const leaseHolders = new Map<string, Set<string>>();
  for (const session of input.sessions) {
    if (session.liveness === "exited") continue;
    for (const association of session.associations) {
      if (association.lease?.phase !== "held" && association.lease?.phase !== "reserving") continue;
      const holders = leaseHolders.get(association.taskId) ?? new Set<string>();
      holders.add(session.runtimeSessionId);
      leaseHolders.set(association.taskId, holders);
    }
  }
  return {
    workers: [...workers].sort(
      (left, right) => left.status.localeCompare(right.status) || left.label.localeCompare(right.label),
    ),
    flow: { claimed, inFlight, settled },
    turnaroundMs: samples.length === 0 ? null : samples.reduce((sum, value) => sum + value, 0) / samples.length,
    collisions: [...leaseHolders.entries()]
      .filter(([, holders]) => holders.size > 1)
      .map(([taskId, holders]) => ({ taskId, workerCount: holders.size })),
  };
}
