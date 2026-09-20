import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import type { TaskRow } from "./types.ts";
import type { CadenceFeedEvent } from "./cadence.ts";

export type FleetWorkerStatus = "live" | "idle" | "exited";
export type FleetTimeWindow = "active" | "1h" | "24h" | "7d" | "all";

export const FLEET_TIME_WINDOWS: readonly FleetTimeWindow[] = ["active", "1h", "24h", "7d", "all"] as const;

export interface FleetWorkerMetrics {
  readonly totalTokens: number;
  readonly toolCalls: number;
}

export interface FleetWorkerRow {
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly label: string;
  readonly status: FleetWorkerStatus;
  readonly taskIds: readonly string[];
  readonly facts: number;
  readonly decisions: number;
  readonly touchedFiles: number;
  readonly lastActiveAt: string | null;
  readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown" | null;
  readonly metrics?: FleetWorkerMetrics;
}

export interface FleetPulseSnapshot {
  readonly window: FleetTimeWindow;
  readonly workers: readonly FleetWorkerRow[];
  readonly flow: { readonly claimed: number; readonly inFlight: number; readonly settled: number };
  readonly turnaroundMs: number | null;
  readonly collisions: readonly { readonly taskId: string; readonly workerCount: number }[];
  readonly activeCount: number;
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

const WINDOW_HOURS: Record<Exclude<FleetTimeWindow, "active" | "all">, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 7 * 24,
};

const STATUS_PRIORITY: Record<FleetWorkerStatus, number> = {
  live: 0,
  idle: 1,
  exited: 2,
};

/** 只读舰队投影:session 是存活真相,事件窗口贡献归属产出,支持时间窗口筛选与历史贡献汇总。 */
export function deriveFleetPulse(input: {
  readonly sessions: readonly AgentRuntimeSessionDto[];
  readonly tasks: readonly TaskRow[];
  readonly events: readonly CadenceFeedEvent[];
  readonly window?: FleetTimeWindow;
  readonly now?: string;
}): FleetPulseSnapshot {
  const window = input.window ?? "24h",
    eventsByRuntime = new Map<string, CadenceFeedEvent[]>();
  for (const event of input.events) {
    const runtimeId = runtimeIdOf(event.executorId);
    if (runtimeId === null) continue;
    const rows = eventsByRuntime.get(runtimeId) ?? [];
    rows.push(event);
    eventsByRuntime.set(runtimeId, rows);
  }

  const allWorkers = input.sessions.map((session): FleetWorkerRow => {
    const events = eventsByRuntime.get(session.runtimeSessionId) ?? [],
      touched = new Set(events.flatMap((event) => event.touchedPaths)),
      snapshot = session.definitionSnapshot;

    let latestEventAt: string | null = null;
    for (const ev of events) {
      if (ev.at && (latestEventAt === null || ev.at > latestEventAt)) {
        latestEventAt = ev.at;
      }
    }
    const lastActiveAt = session.activity.lastObservedAt
      ? latestEventAt && latestEventAt > session.activity.lastObservedAt
        ? latestEventAt
        : session.activity.lastObservedAt
      : latestEventAt;

    const metrics: FleetWorkerMetrics | undefined = session.metrics
      ? {
          totalTokens: session.metrics.totalTokens,
          toolCalls: session.metrics.toolCallCount,
        }
      : undefined;

    return {
      runtimeSessionId: session.runtimeSessionId,
      instanceId: session.instanceId,
      label: snapshot === null ? session.kindId : `${snapshot.kindId} · ${snapshot.model}`,
      status: workerStatus(session),
      taskIds: [...new Set(session.associations.map(({ taskId }) => taskId))],
      facts: events.filter(({ type, factId }) => type === "fact_recorded" && factId !== null).length,
      decisions: events.filter(({ decisionId }) => decisionId !== null).length,
      touchedFiles: touched.size,
      lastActiveAt,
      outcome: session.activity.outcome,
      ...(metrics ? { metrics } : {}),
    };
  });

  const activeCount = allWorkers.filter((w) => w.status === "live").length;

  let maxTimestamp: number | null = null;
  for (const s of input.sessions) {
    if (s.activity.lastObservedAt) {
      const ms = Date.parse(s.activity.lastObservedAt);
      if (Number.isFinite(ms) && (maxTimestamp === null || ms > maxTimestamp)) maxTimestamp = ms;
    }
  }
  for (const ev of input.events) {
    if (ev.at) {
      const ms = Date.parse(ev.at);
      if (Number.isFinite(ms) && (maxTimestamp === null || ms > maxTimestamp)) maxTimestamp = ms;
    }
  }
  const nowMs = input.now ? Date.parse(input.now) : (maxTimestamp ?? Date.now());

  const filteredWorkers = allWorkers.filter((worker) => {
    if (window === "all") return true;
    if (window === "active") return worker.status === "live" || worker.status === "idle";
    const hours = WINDOW_HOURS[window];
    if (!worker.lastActiveAt) return false;
    const activeMs = Date.parse(worker.lastActiveAt);
    if (Number.isNaN(activeMs)) return false;
    return nowMs - activeMs <= hours * 3_600_000 && activeMs <= nowMs + 60_000;
  });

  const sortedWorkers = [...filteredWorkers].sort((left, right) => {
    const pDiff = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
    if (pDiff !== 0) return pDiff;
    if (left.lastActiveAt && right.lastActiveAt) {
      const cmp = right.lastActiveAt.localeCompare(left.lastActiveAt);
      if (cmp !== 0) return cmp;
    } else if (left.lastActiveAt && !right.lastActiveAt) {
      return -1;
    } else if (!left.lastActiveAt && right.lastActiveAt) {
      return 1;
    }
    return left.label.localeCompare(right.label);
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
    window,
    workers: sortedWorkers,
    flow: { claimed, inFlight, settled },
    turnaroundMs: samples.length === 0 ? null : samples.reduce((sum, value) => sum + value, 0) / samples.length,
    collisions: [...leaseHolders.entries()]
      .filter(([, holders]) => holders.size > 1)
      .map(([taskId, holders]) => ({ taskId, workerCount: holders.size })),
    activeCount,
  };
}
