import type { SquadEntityRow } from "./agent-entity-client.ts";
import type { TaskDispatchRow } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";

export type RuntimePanoramaTask = { readonly taskId: string; readonly title: string };
export type RuntimePanoramaRow = TaskDispatchRow & { readonly taskTitle: string; readonly squad: SquadEntityRow | null };
export function joinRuntimePanorama(tasks: readonly RuntimePanoramaTask[], dispatches: readonly TaskDispatchRow[], squads: ReadonlyMap<string, SquadEntityRow>): readonly RuntimePanoramaRow[] { const titles = new Map(tasks.map((task) => [task.taskId, task.title])); return [...dispatches].map((dispatch) => ({ ...dispatch, taskTitle: titles.get(dispatch.taskId) ?? dispatch.taskId, squad: dispatch.squadId ? (squads.get(dispatch.squadId) ?? null) : null })).sort((left, right) => { if (left.status === "running" && right.status !== "running") return -1; if (right.status === "running" && left.status !== "running") return 1; return right.startedAt.localeCompare(left.startedAt); }); }
export function runtimePanoramaDelegation(row: RuntimePanoramaRow): string | null { if (!row.delegatedByAgentId || !row.agentId) return null; const leader = row.delegatedByAgentName ?? row.delegatedByAgentId, worker = row.agentName ?? row.agentId; return `${leader} → ${worker}`; }

// The prototype's sessions dock groups by Agent or Squad, never by runtime instance:
// the dock answers "who is running", and the instance is only the carrier. A runtime
// session the dispatch ledger does not know about still belongs in the dock, so it is
// carried under an unattributed group rather than dropped.
export type RuntimeDockRow = { readonly runtimeSessionId: string; readonly agentId: string | null; readonly agentName: string | null; readonly squadId: string | null; readonly squadName: string | null; readonly instanceId: string; readonly taskId: string | null; readonly taskTitle: string | null; readonly startedAt: string; readonly status: TaskDispatchRow["status"]; readonly liveness: "live" | "stale" | "unknown" | "exited" | null; readonly dispatchId: string | null; readonly delegation: string | null };
export type RuntimeDockGroup = { readonly key: string; readonly kind: "squad" | "agent" | "unattributed"; readonly label: string; readonly rows: readonly RuntimeDockRow[] };
type DockSession = { readonly runtimeSessionId: string; readonly instanceId: string; readonly liveness: "live" | "stale" | "unknown" | "exited"; readonly activity: { readonly lastObservedAt: string } };

export function runtimeDockRows(panorama: readonly RuntimePanoramaRow[], sessions: readonly DockSession[]): readonly RuntimeDockRow[] {
  const liveness = new Map(sessions.map((session) => [session.runtimeSessionId, session])), seen = new Set<string>();
  const dispatched = panorama.map((row): RuntimeDockRow => { seen.add(row.runtimeSessionId); return { runtimeSessionId: row.runtimeSessionId, agentId: row.agentId ?? null, agentName: row.agentName ?? row.agentId ?? null, squadId: row.squadId ?? null, squadName: row.squad?.name ?? row.squadId ?? null, instanceId: row.instanceId, taskId: row.taskId, taskTitle: row.taskTitle, startedAt: row.startedAt, status: row.status, liveness: liveness.get(row.runtimeSessionId)?.liveness ?? null, dispatchId: row.dispatchId, delegation: runtimePanoramaDelegation(row) }; });
  const orphans = sessions.filter((session) => !seen.has(session.runtimeSessionId)).map((session): RuntimeDockRow => ({ runtimeSessionId: session.runtimeSessionId, agentId: null, agentName: null, squadId: null, squadName: null, instanceId: session.instanceId, taskId: null, taskTitle: null, startedAt: session.activity.lastObservedAt, status:
    /* @gate-identity check-gui-status-judgments/gui-status-041 */
    session.liveness === "live" ? "running" : "unknown",
    liveness: session.liveness, dispatchId: null, delegation: null }));
  return [...dispatched, ...orphans];
}

// The Session → Task jump target, resolved from the two backend read faces the workspace
// already holds: the dispatch ledger row first (it carries the title), the daemon session
// association as fallback. Presentation only — no second truth is kept here.
export type SessionTaskTarget = { readonly taskId: string; readonly taskTitle: string | null };
export function sessionTaskTarget(row: RuntimeDockRow | null, associations: readonly { readonly taskId: string }[]): SessionTaskTarget | null {
  if (row?.taskId) return { taskId: row.taskId, taskTitle: row.taskTitle };
  const association = associations[0];
  return association ? { taskId: association.taskId, taskTitle: null } : null;
}

// The sibling sessions the inspector lists under a selected session: same agent, or same
// squad when the row carries no agent — a filter over backend rows, never a second store.
export function sessionSiblingRows(rows: readonly RuntimeDockRow[], runtimeSessionId: string): readonly RuntimeDockRow[] {
  const selected = rows.find((row) => row.runtimeSessionId === runtimeSessionId) ?? null;
  if (selected === null) return [];
  return rows.filter((row) => row.runtimeSessionId !== runtimeSessionId && (selected.agentId !== null && row.agentId === selected.agentId || selected.squadId !== null && row.squadId === selected.squadId));
}

export function runtimeDockGroups(rows: readonly RuntimeDockRow[]): readonly RuntimeDockGroup[] {
  const groups = new Map<string, { kind: RuntimeDockGroup["kind"]; label: string; rows: RuntimeDockRow[] }>();
  for (const row of rows) {
    const kind = row.squadId ? "squad" as const : row.agentId ? "agent" as const : "unattributed" as const;
    const key = `${kind}:${row.squadId ?? row.agentId ?? ""}`, label = row.squadName ?? row.agentName ?? "";
    const existing = groups.get(key) ?? { kind, label, rows: [] };
    existing.rows.push(row); groups.set(key, existing);
  }
  return [...groups].map(([key, value]) => ({ key, kind: value.kind, label: value.label, rows: value.rows }));
}
export const runtimeDockLiveCount = (rows: readonly RuntimeDockRow[]): number => rows.filter((row) => row.status === "running").length;
