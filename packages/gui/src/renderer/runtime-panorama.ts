import type { SquadEntityDetail } from "./agent-entity-client.ts";
import type { TaskDispatchRow } from "@harness-anything/daemon/protocol/daemon-protocol.contract";

export type RuntimePanoramaTask = { readonly taskId: string; readonly title: string };
export type RuntimePanoramaRow = TaskDispatchRow & { readonly taskTitle: string; readonly squad: SquadEntityDetail | null };
export function joinRuntimePanorama(tasks: readonly RuntimePanoramaTask[], dispatches: readonly TaskDispatchRow[], squads: ReadonlyMap<string, SquadEntityDetail>): readonly RuntimePanoramaRow[] { const titles = new Map(tasks.map((task) => [task.taskId, task.title])); return [...dispatches].map((dispatch) => ({ ...dispatch, taskTitle: titles.get(dispatch.taskId) ?? dispatch.taskId, squad: dispatch.squadId ? (squads.get(dispatch.squadId) ?? null) : null })).sort((left, right) => { if (left.status === "running" && right.status !== "running") return -1; if (right.status === "running" && left.status !== "running") return 1; return right.startedAt.localeCompare(left.startedAt); }); }
export function runtimePanoramaDelegation(row: RuntimePanoramaRow): string | null { if (!row.delegatedByAgentId || !row.agentId) return null; const leader = row.delegatedByAgentName ?? row.delegatedByAgentId, worker = row.agentName ?? row.agentId; return `${leader} → ${worker}`; }
