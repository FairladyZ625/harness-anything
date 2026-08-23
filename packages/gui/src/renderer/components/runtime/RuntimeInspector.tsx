import type { ReactNode } from "react";
import type { AgentRuntimeSessionDto } from "../../../../../daemon/src/agent-runtime-contract.ts";
import type { RuntimeInstanceSummary } from "../../../../../daemon/src/agent-runtime-instances.ts";
import type { AgentEntityRow, SquadEntityRow } from "../../agent-entity-client.ts";
import { sessionSiblingRows, sessionTaskTarget, type RuntimeDockRow } from "../../runtime-panorama.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { runtimeAuthPresentation } from "../../runtime-auth-presentation.ts";
import { Avatar, CapDot, Empty, KindDot, KV, KVRow, LiveDot } from "./parts.tsx";
import type { RuntimeSelection } from "./useRuntimeWorkspace.ts";

// W6 IA 拆分:原四类通吃的 RuntimeInspector 拆成三个页级 inspector——右栏仍是
// "同一个选中,从会话侧看过去:这东西最近在干什么",但跨页跳转(session/<id>、
// agent/<id>)改走可寻址路由;同页的互跳(agent↔squad、sibling session)保持页内选择。
// Provider 页的相关会话行取 overview 的 session DTO(liveness 投影),不为此读
// dispatch 台账——agent/task 归属在会话详情里,点行直达。

type OpenSession = (runtimeSessionId: string) => void;

// Liveness maps, not point comparisons (dec_8DCD52E98BAB268B0194B1E399): the daemon's
// liveness word decides the dot through a table lookup alone.
const LIVENESS_DOT: Record<string, "live" | "idle"> = { live: "live" };

export function ProviderInspector({ instance, probeError, sessions, onOpenSession }: {
  readonly instance: RuntimeInstanceSummary | null; readonly probeError: string | null; readonly sessions:
  readonly AgentRuntimeSessionDto[]; readonly onOpenSession: OpenSession }) {
  return <aside data-testid="runtime-inspector" aria-label={t("agentRuntime.inspectorRuntime")}
    className="w-[300px] shrink-0 overflow-y-auto border-l border-border bg-surface">
    <h2
      className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-[10.5px] font-bold uppercase
        tracking-[0.09em] text-text-faint">{t("agentRuntime.inspectorRuntime")}</h2>
    <RuntimeFacts instance={instance} probeError={probeError} />
    <Section title={t("agentRuntime.inspectorSessions", { count: sessions.length })}>
      {sessions.length === 0 ? <Empty>{t("agentRuntime.noSessions")}</Empty> : sessions.slice(0,
        8).map((session) => <LiveSessionRow key={session.runtimeSessionId} session={session}
        onOpenSession={onOpenSession} />)}
    </Section>
  </aside>;
}

export function IdentityInspector({ selection, agents, squads, rows, onSelect, onOpenSession }: {
  readonly selection: RuntimeSelection; readonly agents: readonly AgentEntityRow[]; readonly squads:
  readonly SquadEntityRow[]; readonly rows: readonly RuntimeDockRow[]; readonly onSelect: (selection:
  RuntimeSelection) => void; readonly onOpenSession: OpenSession }) {
  const related = rows.filter((row) => selection.type === "agent" ? row.agentId === selection.id :
    row.squadId === selection.id);
  return <aside data-testid="runtime-inspector" aria-label={t(selection.type === "agent" ?
    "agentRuntime.inspectorAgent" : "agentRuntime.inspectorSquad")}
    className="w-[300px] shrink-0 overflow-y-auto border-l border-border bg-surface">
    <h2
      className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-[10.5px] font-bold uppercase
        tracking-[0.09em] text-text-faint">{t(selection.type === "agent" ? "agentRuntime.inspectorAgent" :
          "agentRuntime.inspectorSquad")}</h2>
    {selection.type === "agent"
      ? <AgentFacts agent={agents.find((agent) => agent.id === selection.id) ?? null} squads={squads}
        onSelect={onSelect} />
      : <SquadFacts squad={squads.find((squad) => squad.id === selection.id) ?? null} onSelect={onSelect} />}
    <Section title={t("agentRuntime.inspectorSessions", { count: related.length })}>
      {related.length === 0 ? <Empty>{t("agentRuntime.noSessions")}</Empty> : related.slice(0, 8).map((row) => <DispatchSessionRow key={row.runtimeSessionId} row={row} onOpenSession={onOpenSession} />)}
    </Section>
  </aside>;
}

export function SessionInspector({ row, rows, onSelectSession, onOpenTask, onSelectEntity }: { readonly onSelectEntity: (ref: string) => void; readonly row:
  RuntimeDockRow | null; readonly rows: readonly RuntimeDockRow[]; readonly onSelectSession:
  OpenSession; readonly onOpenTask: (taskId: string) => void }) {
  const siblings = sessionSiblingRows(rows, row?.runtimeSessionId ?? "");
  return <aside data-testid="runtime-inspector" aria-label={t("agentRuntime.inspectorSession")}
    className="w-[300px] shrink-0 overflow-y-auto border-l border-border bg-surface">
    <h2
      className="sticky top-0 border-b border-border bg-surface px-3 py-2 text-[10.5px] font-bold uppercase
        tracking-[0.09em] text-text-faint">{t("agentRuntime.inspectorSession")}</h2>
    <SessionFacts row={row} onOpenTask={onOpenTask} onSelectEntity={onSelectEntity} />
    <Section title={t("agentRuntime.inspectorSessions", { count: siblings.length })}>
      {siblings.length === 0 ? <Empty>{t("agentRuntime.noSessions")}</Empty> : siblings.slice(0,
        8).map((sibling) => <DispatchSessionRow key={sibling.runtimeSessionId} row={sibling}
        onOpenSession={onSelectSession} />)}
    </Section>
  </aside>;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) { return <section className="border-b border-border px-3 py-2 last:border-b-0"><h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">{title}</h3>{children}</section>; }
function LiveSessionRow({ session, onOpenSession }: { readonly session: AgentRuntimeSessionDto;
  readonly onOpenSession: OpenSession }) {
  return <button type="button" onClick={() => onOpenSession(session.runtimeSessionId)}
    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised">
    <LiveDot state={LIVENESS_DOT[session.liveness] ?? "idle"} tip={session.liveness} />
    <span className="min-w-0 flex-1"><span
      className="block truncate text-[11.5px]">{session.instanceId}</span><span
      className="block truncate font-mono text-[10px] text-text-faint">{session.runtimeSessionId}</span></span>
    <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{session.activity.lastObservedAt.slice(11,
      16)}</span>
  </button>;
}
function DispatchSessionRow({ row, onOpenSession }: { readonly row: RuntimeDockRow;
  readonly onOpenSession: OpenSession }) {
  return <button type="button" onClick={() => onOpenSession(row.runtimeSessionId)}
    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised">
    <LiveDot state={row.status === "running" ? "live" : row.status === "failed" ? "failed" : "idle"} tip={row.status} />
    <span className="min-w-0 flex-1"><span className="block truncate text-[11.5px]">{row.agentName ??
      row.instanceId}</span><span
      className="block truncate font-mono text-[10px] text-text-faint">{row.taskTitle ??
      row.runtimeSessionId}</span></span>
    <span className="shrink-0 font-mono text-[9.5px] text-text-faint">{row.startedAt.slice(11, 16)}</span>
  </button>;
}
function RuntimeFacts({ instance, probeError }: { readonly instance: RuntimeInstanceSummary | null; readonly probeError: string | null }) {
  if (!instance) return <Section title={t("agentRuntime.inspectorHealth")}><Empty>{t("agentRuntime.notFound")}</Empty></Section>;
  const auth = runtimeAuthPresentation(instance, probeError), authText = auth.state === "ready" ? t("agentRuntime.authVerified") : auth.state === "not-checked" ? t("agentRuntime.authNotChecked") : auth.state === "probe-error" ? t("agentRuntime.authProbeFailed", { error: auth.error ?? "" }) : `${instance.authReadiness.code}: ${instance.authReadiness.hint}`;
  return <Section title={t("agentRuntime.inspectorHealth")}>
    <div data-auth-status={auth.state} className="mb-2 flex items-center gap-1.5 text-[11px]"><CapDot state={auth.cap} tip={authText} /><span>{authText}</span></div>
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
// A selected session seen from the side: whose it is and which task holds it, with the
// reverse jump into that task's detail (W5:派工链归 Task 详情「派工」页签). Facts come
// from the ledger row the workspace already read; the jump target is the same
// sessionTaskTarget as the main panel.
function SessionFacts({ row, onOpenTask, onSelectEntity }: { readonly row: RuntimeDockRow | null; readonly onOpenTask: (taskId: string) => void; readonly onSelectEntity: (ref: string) => void }) {
  const target = sessionTaskTarget(row, []);
  return <Section title={t("agentRuntime.inspectorSessionFacts")}>
    {row === null ? <Empty>{t("agentRuntime.notFound")}</Empty> : <>
      <KV>{row.agentId ? <KVRow name="agent"><EntityRefLink entityRef={`agent/${row.agentId}`} onNavigate={onSelectEntity} title={row.agentId} className="text-accent hover:underline" /></KVRow> : <KVRow name="agent">{t("agentRuntime.unattributed")}</KVRow>}{row.squadId ? <KVRow name="squad"><EntityRefLink entityRef={`squad/${row.squadId}`} onNavigate={onSelectEntity} title={row.squadId} className="text-accent hover:underline" /></KVRow> : <KVRow name="squad">{row.squadName ?? "—"}</KVRow>}<KVRow name="instance"><EntityRefLink entityRef={`provider/${row.instanceId}`} onNavigate={onSelectEntity} title={row.instanceId} className="text-accent hover:underline" /></KVRow><KVRow name="dispatch">{row.dispatchId ?? "—"}</KVRow><KVRow name="status">{row.status}</KVRow></KV>
      {target !== null && <button type="button" data-testid="inspector-open-task" data-task={target.taskId} title={t("agentRuntime.openTask")} onClick={() => onOpenTask(target.taskId)} className="mt-2 flex w-full items-center gap-1.5 rounded border border-border px-2 py-1 text-left hover:border-accent hover:text-accent">
        <span className="min-w-0 flex-1 truncate text-[11px]">{target.taskTitle ?? target.taskId}</span><span className="shrink-0 font-mono text-[9.5px] text-text-faint">{target.taskId}</span><span aria-hidden className="shrink-0 text-[9.5px] text-text-faint">↗</span>
      </button>}
    </>}
  </Section>;
}
