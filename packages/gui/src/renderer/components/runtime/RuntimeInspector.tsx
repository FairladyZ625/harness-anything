import type { ReactNode } from "react";
import type { RuntimeInstanceSummary } from "../../../../../daemon/src/agent-runtime-instances.ts";
import type { AgentEntityRow, SquadEntityRow } from "../../agent-entity-client.ts";
import type { RuntimeDockRow } from "../../runtime-panorama.ts";
import { t } from "../../i18n/index.tsx";
import { Avatar, CapDot, Empty, KindDot, KV, KVRow, LiveDot } from "./parts.tsx";
import type { RuntimeSelection } from "./useRuntimeWorkspace.ts";

type Props = { readonly selection: RuntimeSelection | null; readonly instances: readonly RuntimeInstanceSummary[]; readonly agents: readonly AgentEntityRow[]; readonly squads: readonly SquadEntityRow[]; readonly rows: readonly RuntimeDockRow[]; readonly onSelect: (selection: RuntimeSelection) => void; readonly onSelectSession: (runtimeSessionId: string) => void };
// Right-hand inspector: the same selection seen from the sessions side. It never repeats
// the main card's configuration; it answers "what has this thing actually been doing".
export function RuntimeInspector({ selection, instances, agents, squads, rows, onSelect, onSelectSession }: Props) {
  if (!selection) return null;
  const title = t(`agentRuntime.inspector${selection.type[0]!.toUpperCase()}${selection.type.slice(1)}` as never);
  const related = rows.filter((row) => selection.type === "runtime" ? row.instanceId === selection.id : selection.type === "agent" ? row.agentId === selection.id : selection.type === "squad" ? row.squadId === selection.id : row.taskId === selection.id);
  return <aside data-testid="runtime-inspector" aria-label={title} className="w-[300px] shrink-0 overflow-y-auto border-l border-border bg-surface">
    <h2 className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-[10.5px] font-bold uppercase tracking-[0.09em] text-text-faint">{title}</h2>
    {selection.type === "runtime" && <RuntimeFacts instance={instances.find((instance) => instance.instanceId === selection.id) ?? null} />}
    {selection.type === "agent" && <AgentFacts agent={agents.find((agent) => agent.id === selection.id) ?? null} squads={squads} onSelect={onSelect} />}
    {selection.type === "squad" && <SquadFacts squad={squads.find((squad) => squad.id === selection.id) ?? null} onSelect={onSelect} />}
    {selection.type === "orchestration" && <Section title={t("agentRuntime.inspectorTask")}><KV><KVRow name="task">{selection.id}</KVRow><KVRow name="dispatches">{related.length}</KVRow><KVRow name="running">{related.filter((row) => row.status === "running").length}</KVRow></KV></Section>}
    <Section title={t("agentRuntime.inspectorSessions", { count: related.length })}>
      {related.length === 0 ? <Empty>{t("agentRuntime.noSessions")}</Empty> : related.slice(0, 8).map((row) => <button key={row.runtimeSessionId} type="button" onClick={() => onSelectSession(row.runtimeSessionId)} className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised">
        <LiveDot state={row.status === "running" ? "live" : row.status === "failed" ? "failed" : "idle"} tip={row.status} />
        <span className="min-w-0 flex-1"><span className="block truncate text-[11.5px]">{row.agentName ?? row.instanceId}</span><span className="block truncate font-mono text-[10px] text-text-faint">{row.taskTitle ?? row.runtimeSessionId}</span></span>
        <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{row.startedAt.slice(11, 16)}</span>
      </button>)}
    </Section>
  </aside>;
}
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) { return <section className="border-b border-border px-3 py-2 last:border-b-0"><h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">{title}</h3>{children}</section>; }
function RuntimeFacts({ instance }: { readonly instance: RuntimeInstanceSummary | null }) {
  if (!instance) return <Section title={t("agentRuntime.inspectorHealth")}><Empty>{t("agentRuntime.notFound")}</Empty></Section>;
  return <Section title={t("agentRuntime.inspectorHealth")}>
    <div className="mb-2 flex items-center gap-1.5 text-[11px]"><CapDot state={instance.authReadiness.status === "ready" ? "full" : "none"} tip={instance.authReadiness.hint ?? t("agentRuntime.authVerified")} /><span>{instance.authReadiness.status === "ready" ? t("agentRuntime.authVerified") : instance.authReadiness.code ?? t("agentRuntime.authNotReady")}</span></div>
    <KV><KVRow name="kind"><span className="inline-flex items-center gap-1"><KindDot kind={instance.kindId} />{instance.kindId}</span></KVRow><KVRow name="auth">{instance.authMode} · {instance.authState}</KVRow><KVRow name="enabled">{String(instance.enabled)}</KVRow><KVRow name="isolation">{instance.isolationState}</KVRow><KVRow name="permission">{instance.permissionMode ?? t("agentRuntime.providerDefault")}</KVRow></KV>
  </Section>;
}
function AgentFacts({ agent, squads, onSelect }: { readonly agent: AgentEntityRow | null; readonly squads: readonly SquadEntityRow[]; readonly onSelect: (selection: RuntimeSelection) => void }) {
  if (!agent) return <Section title={t("agentRuntime.inspectorDefinition")}><Empty>{t("agentRuntime.notFound")}</Empty></Section>;
  const referencing = squads.filter((squad) => squad.leader === agent.id || squad.workers.includes(agent.id));
  return <><Section title={t("agentRuntime.inspectorDefinition")}><KV><KVRow name="role">{agent.role}</KVRow><KVRow name="runtime_type">{agent.runtimeType || "—"}</KVRow><KVRow name="layer">{agent.layer}</KVRow><KVRow name="validity">{agent.validity}</KVRow></KV>{agent.issues.map((issue) => <p key={issue.code} className="mt-1 text-[10.5px] text-status-blocked">{issue.code}: {issue.message}</p>)}</Section>
    <Section title={t("agentRuntime.inspectorReferencedBy", { count: referencing.length })}>{referencing.length === 0 ? <Empty>{t("agentRuntime.notReferenced")}</Empty> : referencing.map((squad) => <button key={squad.id} type="button" onClick={() => onSelect({ type: "squad", id: squad.id })} className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised"><KindDot kind="any" /><span className="min-w-0 flex-1"><span className="block truncate text-[11.5px]">{squad.name}</span><span className="block font-mono text-[10px] text-text-faint">{squad.leader === agent.id ? t("agentRuntime.roleCommander") : t("agentRuntime.roleWorker")}</span></span></button>)}</Section></>;
}
function SquadFacts({ squad, onSelect }: { readonly squad: SquadEntityRow | null; readonly onSelect: (selection: RuntimeSelection) => void }) {
  if (!squad) return <Section title={t("agentRuntime.inspectorMembers")}><Empty>{t("agentRuntime.notFound")}</Empty></Section>;
  return <Section title={t("agentRuntime.inspectorMembers")}>
    <button type="button" onClick={() => onSelect({ type: "agent", id: squad.leader })} className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised"><Avatar id={squad.leader} /><span className="min-w-0 flex-1 truncate text-[11.5px]">{squad.leader}</span><span className="font-mono text-[10px] text-text-faint">{t("agentRuntime.roleCommander")}</span></button>
    {squad.workers.map((worker) => <button key={worker} type="button" onClick={() => onSelect({ type: "agent", id: worker })} className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised"><Avatar id={worker} /><span className="min-w-0 flex-1 truncate text-[11.5px]">{worker}</span><span className="font-mono text-[10px] text-text-faint">{t("agentRuntime.roleWorker")}</span></button>)}
  </Section>;
}
