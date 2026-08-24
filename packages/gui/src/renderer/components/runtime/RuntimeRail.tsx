import { useState, type ReactNode } from "react";
import type { RuntimeInstanceSummary } from "../../../../../daemon/src/agent-runtime-instances.ts";
import type { AgentEntityRow, SquadEntityRow } from "../../agent-entity-client.ts";
import {
  runtimeDockGroups, runtimeDockStatusDot, runtimeDockStatusKey, type RuntimeDockRow,
} from "../../runtime-panorama.ts";
import { t } from "../../i18n/index.tsx";
import {
  runtimeAuthPresentation, runtimeAuthPresentationText, type RuntimeAuthProbeState,
} from "../../runtime-auth-presentation.ts";
import { Avatar, CapDot, KindDot, LiveDot } from "./parts.tsx";
import type { RuntimeSelection } from "./useRuntimeWorkspace.ts";

const OUTCOME_TONE: Record<RuntimeDockRow["status"], string> = {
  succeeded: "text-status-done", failed: "text-status-blocked", cancelled: "text-status-cancelled",
  running: "text-status-active", unknown: "text-status-unknown",
  "ended-indeterminate": "text-status-unknown", unavailable: "text-text-faint",
};
const ROW_BATCH_SIZE = 12;

// W6 IA 拆分:原四段聚合 rail 随「Agent 运行时」入口撤销,拆成三条页级 rail——
// ProviderRail(承运者)/ IdentityRail(身份 + 组织,Squad 是 Agent 页内的面)/
// SessionRail(执行)。行渲染与 testid(rail-runtime-*/rail-agent-*/rail-squad-*/
// rail-session-*/runtime-new-*)原样保留,只是各回各页;跨页不再共享选中态,
// 互跳走可寻址路由。
export function ProviderRail({ instances, authProbeStates, selectedId, liveByInstance, onSelect, onNew
  }: { readonly instances: readonly RuntimeInstanceSummary[]; readonly authProbeStates?:
  ReadonlyMap<string, RuntimeAuthProbeState>; readonly selectedId: string | null; readonly liveByInstance:
  ReadonlyMap<string, number>; readonly onSelect: (instanceId: string) => void; readonly onNew: () => void }) {
  const [open, setOpen] = useState(true);
  return <nav data-testid="runtime-rail" aria-label={t("agentRuntime.railLabel")} className="flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-border bg-surface">
    <Segment segment="runtimes" title={t("agentRuntime.segRuntimes")} sub={t("agentRuntime.segRuntimesSub")} count={instances.length} open={open} onToggle={() => setOpen(!open)} onNew={onNew}>
      {instances.map((instance) => { const auth = runtimeAuthPresentation(instance,
        authProbeStates?.get(instance.instanceId)), authTip = runtimeAuthPresentationText(instance, auth);
        return <Row key={instance.instanceId} tip={instance.instanceId}
          testId={`rail-runtime-${instance.instanceId}`} selected={selectedId === instance.instanceId}
          onSelect={() => onSelect(instance.instanceId)}>
        <KindDot kind={instance.kindId} /><span className="min-w-0 flex-1 truncate text-[12px]">{instance.name}</span><span className="shrink-0 font-mono text-[10px] text-text-faint">{instance.defaultModel}</span>
        <CapDot state={auth.cap} tip={authTip} size={9} />
        <LiveDot state={(liveByInstance.get(instance.instanceId) ?? 0) > 0 ? "live" : instance.enabled ? "idle" : "failed"} tip={instance.enabled ? t("agentRuntime.instanceEnabled") : t("agentRuntime.instanceDisabled")} />
      </Row>; })}
    </Segment>
  </nav>;
}

// The identity rail: Agents and Squads share one page because a Squad has no lifecycle
// apart from its agents (proposal P2) — organisation is a facet of identity here, not a
// fourth entry. The design-thesis note stays at this rail's foot: dispatch is authored
// from this page, and the formula it explains (Agent × Runtime × Task → Session) is the
// one this page starts.
export function IdentityRail({ agents, squads, selection, onSelect, onNew }: { readonly agents: readonly
  AgentEntityRow[]; readonly squads: readonly SquadEntityRow[]; readonly selection: RuntimeSelection |
  null; readonly onSelect: (selection: RuntimeSelection) => void; readonly onNew: (segment: "agents" |
  "squads") => void }) {
  const [segments, setSegments] = useState<Readonly<Record<string, boolean>>>({ agents: true, squads: true });
  const onToggle = (segment: string) => setSegments((value) => ({ ...value, [segment]: !(value[segment] ?? true) }));
  const picked = (type: "agent" | "squad", id: string) => selection?.type === type && selection.id === id;
  return <nav data-testid="runtime-rail" aria-label={t("agentRuntime.railLabel")}
    className="flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-border bg-surface">
    <Segment segment="agents" title={t("agentRuntime.segAgents")} sub={t("agentRuntime.segAgentsSub")}
      count={agents.length} open={segments.agents ?? true} onToggle={() => onToggle("agents")} onNew={() =>
      onNew("agents")}>
      {agents.map((agent) => <Row key={agent.id} tip={agent.id} testId={`rail-agent-${agent.id}`} selected={picked("agent", agent.id)} onSelect={() => onSelect({ type: "agent", id: agent.id })}>
        <Avatar id={agent.id} /><span className="min-w-0 flex-1 truncate text-[12px]">{agent.name}</span>
        <span data-tip={t("agentRuntime.layerTip", { layer: agent.layer })} className="shrink-0 rounded-[3px] border border-border-strong px-1 font-mono text-[9px] tracking-[0.04em] text-text-faint">{agent.layer}</span>
        {agent.validity === "blocked" && <LiveDot state="failed" tip={t("agentRuntime.declarationBlocked")} />}
      </Row>)}
    </Segment>
    <Segment segment="squads" title={t("agentRuntime.segSquads")} sub={t("agentRuntime.segSquadsSub")}
      count={squads.length} open={segments.squads ?? true} onToggle={() => onToggle("squads")} onNew={() =>
      onNew("squads")}>
      {squads.map((squad) => <Row key={squad.id} tip={squad.id} testId={`rail-squad-${squad.id}`} selected={picked("squad", squad.id)} onSelect={() => onSelect({ type: "squad", id: squad.id })}>
        <KindDot kind="any" /><span className="min-w-0 flex-1 truncate text-[12px]">{squad.name}</span>
        <span className="shrink-0 rounded-[3px] border border-border-strong px-1 font-mono text-[9px] text-text-faint">{t("agentRuntime.memberCount", { count: squad.workers.length + 1 })}</span>
      </Row>)}
    </Segment>
    <details className="px-2.5 py-2 text-[10px] leading-[1.5] text-text-faint"><summary className="cursor-pointer list-none">{t("agentRuntime.thesisSummary")}</summary><p className="mt-1">{t("agentRuntime.thesisBody")}</p></details>
  </nav>;
}

// Sessions answer "who is running": grouped by Agent or Squad, never by runtime instance —
// the carrier is only where a session happens to run. A runtime session the dispatch ledger
// does not know about still belongs here, under its unattributed group. W5:「编排」段撤销
// ——task 派工链归 Task 详情「派工」页签,运行侧只保留 session 行与其绑定的 task 标题。
export function SessionRail({ sessions, remainingCount = 0, loadingMore = false, selectedId, onSelect,
  onLoadMore }: { readonly sessions: readonly RuntimeDockRow[]; readonly remainingCount?: number;
  readonly loadingMore?: boolean; readonly selectedId: string | null; readonly onSelect:
  (runtimeSessionId: string) => void; readonly onLoadMore?: () => Promise<unknown> }) {
  const [open, setOpen] = useState(true), [visibleCount, setVisibleCount] = useState(ROW_BATCH_SIZE);
  const loadedHidden = Math.max(0, sessions.length - visibleCount), remaining = loadedHidden + remainingCount;
  return <nav data-testid="runtime-rail" aria-label={t("agentRuntime.railLabel")}
    className="flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-border bg-surface">
    <Segment segment="sessions" title={t("agentRuntime.segSessions")}
      sub={t("agentRuntime.segSessionsSub")} count={sessions.length + remainingCount} open={open}
      onToggle={() => setOpen(!open)}>
      <SessionGroupRows sessions={sessions.slice(0, visibleCount)} selectedId={selectedId} onSelect={onSelect} />
      {remaining > 0 && <button type="button" data-testid="runtime-sessions-more" disabled={loadingMore}
        onClick={() => { const reveal = () => setVisibleCount((count) => count + ROW_BATCH_SIZE);
          if (loadedHidden > 0 || onLoadMore === undefined) reveal(); else void onLoadMore().then(reveal); }}
        className="mt-1 w-full rounded border border-dashed border-border px-1.5 py-1 text-center font-mono
          text-[10px] text-text-muted hover:border-border-strong hover:text-text disabled:opacity-60">{
          t("agentRuntime.showMoreSessions", { count: Math.min(ROW_BATCH_SIZE, remaining), remaining })
        }</button>}
    </Segment>
  </nav>;
}

function SessionGroupRows({ sessions, selectedId, onSelect }: { readonly sessions: readonly
  RuntimeDockRow[]; readonly selectedId: string | null; readonly onSelect: (runtimeSessionId: string) => void }) {
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({});
  return <>{runtimeDockGroups(sessions).map((group) => <div key={group.key}>
    <button type="button" aria-expanded={!collapsed[group.key]} onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))} className="flex w-full items-center gap-1.5 px-1.5 pt-1 pb-0.5 text-left text-[10.5px] text-text-muted">
      <span aria-hidden className={`text-[7px] text-text-faint transition-transform ${collapsed[group.key] ? "" : "rotate-90"}`}>▶</span>
      {group.kind === "squad" ? <KindDot kind="any" /> : group.kind === "agent" ? <Avatar id={group.label || group.key} /> : <KindDot kind="claude" />}
      <b className="font-semibold">{group.label || t("agentRuntime.unattributed")}</b><span className="text-text-faint">{group.kind}</span>
      <span className="ml-auto font-mono text-[10px] text-text-faint">{group.rows.length}</span>
    </button>
    {!collapsed[group.key] && group.rows.map((row) => <Row key={row.runtimeSessionId} tip={row.runtimeSessionId} testId={`rail-session-${row.runtimeSessionId}`} selected={selectedId === row.runtimeSessionId} onSelect={() => onSelect(row.runtimeSessionId)}>
      <LiveDot state={runtimeDockStatusDot[row.status]} tip={t(runtimeDockStatusKey[row.status] as never)} />
      <span className="min-w-0 flex-1 truncate text-[11.5px]">{row.agentName ?? row.instanceId}</span>
      <span className="min-w-0 max-w-[76px] shrink truncate font-mono text-[9.5px] text-text-muted">{row.taskTitle ?? t("agentRuntime.noTask")}</span>
      <span data-testid={`runtime-outcome-${row.runtimeSessionId}`}
        className={`shrink-0 font-mono text-[9.5px] ${OUTCOME_TONE[row.status]}`}>{
        t(runtimeDockStatusKey[row.status] as never)}</span>
    </Row>)}
  </div>)}</>;
}

function Segment({ segment, title, sub, count, open, onToggle, onNew, children }: { readonly segment: string; readonly title: string; readonly sub: string; readonly count: number; readonly open: boolean; readonly onToggle: () => void; readonly onNew?: () => void; readonly children: ReactNode }) {
  return <section className="border-b border-border">
    <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1.5 hover:bg-surface-raised">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <span aria-hidden className={`shrink-0 text-[8px] text-text-faint transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        <span className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-text-faint">{title}</span><span className="truncate text-[10px] text-text-faint">{sub}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-text-faint">{count}</span>
      </button>
      {onNew && <button type="button" data-testid={`runtime-new-${segment}`} onClick={onNew} className="shrink-0 rounded border border-border px-1.5 text-[10.5px] text-text-faint hover:border-accent hover:text-accent">{t("agentRuntime.new")}</button>}
    </div>
    {open && <div className="px-1.5 pb-2">{children}</div>}
  </section>;
}
function Row({ tip, testId, selected, onSelect, children }: { readonly tip: string; readonly testId?: string; readonly selected: boolean; readonly onSelect: () => void; readonly children: ReactNode }) {
  return <button type="button" data-tip={tip} data-testid={testId} aria-current={selected} onClick={onSelect} className={`flex w-full items-center gap-[7px] rounded border px-2 py-1 text-left ${selected ? "border-accent/40 bg-accent/[0.14]" : "border-transparent hover:bg-surface-raised"}`}>{children}</button>;
}
