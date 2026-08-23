import { useState, type ReactNode } from "react";
import type { RuntimeInstanceSummary } from "../../../../../daemon/src/agent-runtime-instances.ts";
import type { AgentEntityRow, SquadEntityRow } from "../../agent-entity-client.ts";
import { runtimeDockGroups, type RuntimeDockRow } from "../../runtime-panorama.ts";
import { t } from "../../i18n/index.tsx";
import { runtimeAuthPresentation } from "../../runtime-auth-presentation.ts";
import { Avatar, CapDot, KindDot, LiveDot } from "./parts.tsx";
import { OUTCOME_TONE } from "./OrchestrationCard.tsx";
import type { RuntimeSelection } from "./useRuntimeWorkspace.ts";

export type OrchestrationEntry = { readonly taskId: string; readonly title: string; readonly dispatches: number; readonly running: number };
export function orchestrationEntries(rows: readonly RuntimeDockRow[]): readonly OrchestrationEntry[] {
  const byTask = new Map<string, { title: string; dispatches: number; running: number }>();
  for (const row of rows) { if (!row.taskId) continue; const entry = byTask.get(row.taskId) ?? { title: row.taskTitle ?? row.taskId, dispatches: 0, running: 0 }; entry.dispatches += 1; if (row.status === "running") entry.running += 1; byTask.set(row.taskId, entry); }
  return [...byTask].map(([taskId, value]) => ({ taskId, ...value })).sort((left, right) => right.running - left.running || left.taskId.localeCompare(right.taskId));
}

type Props = {
  readonly instances: readonly RuntimeInstanceSummary[]; readonly agents: readonly AgentEntityRow[]; readonly squads: readonly SquadEntityRow[]; readonly orchestration: readonly OrchestrationEntry[]; readonly sessions: readonly RuntimeDockRow[];
  readonly authProbeErrors?: ReadonlyMap<string, string>;
  readonly selection: RuntimeSelection | null; readonly open: Readonly<Record<string, boolean>>; readonly liveByInstance: ReadonlyMap<string, number>;
  readonly onToggle: (segment: string) => void; readonly onSelect: (selection: RuntimeSelection) => void; readonly onNew: (segment: "runtimes" | "agents" | "squads") => void;
};
// The prototype rail: five collapsible segments in the order carrier → identity →
// organisation → orchestration → execution, each row carrying the one fact that
// distinguishes it. Sessions sit at the same rank as the rest: picked here, shown in
// the main area — never in a drawer bolted onto the bottom.
export function RuntimeRail({ instances, authProbeErrors, agents, squads, orchestration, sessions, selection, open, liveByInstance, onToggle, onSelect, onNew }: Props) {
  const picked = (type: RuntimeSelection["type"], id: string) => selection?.type === type && selection.id === id;
  return <nav data-testid="runtime-rail" aria-label={t("agentRuntime.railLabel")} className="flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-border bg-surface">
    <Segment segment="runtimes" title={t("agentRuntime.segRuntimes")} sub={t("agentRuntime.segRuntimesSub")} count={instances.length} open={open.runtimes ?? true} onToggle={onToggle} onNew={() => onNew("runtimes")}>
      {instances.map((instance) => { const auth = runtimeAuthPresentation(instance, authProbeErrors?.get(instance.instanceId) ?? null), authTip = auth.state === "ready" ? t("agentRuntime.authVerified") : auth.state === "not-checked" ? t("agentRuntime.authNotChecked") : auth.state === "probe-error" ? t("agentRuntime.authProbeFailed", { error: auth.error ?? "" }) : instance.authReadiness.hint ?? t("agentRuntime.authNotReady"); return <Row key={instance.instanceId} tip={instance.instanceId} testId={`rail-runtime-${instance.instanceId}`} selected={picked("runtime", instance.instanceId)} onSelect={() => onSelect({ type: "runtime", id: instance.instanceId })}>
        <KindDot kind={instance.kindId} /><span className="min-w-0 flex-1 truncate text-[12px]">{instance.name}</span><span className="shrink-0 font-mono text-[10px] text-text-faint">{instance.defaultModel}</span>
        <CapDot state={auth.cap} tip={authTip} size={9} />
        <LiveDot state={(liveByInstance.get(instance.instanceId) ?? 0) > 0 ? "live" : instance.enabled ? "idle" : "failed"} tip={instance.enabled ? t("agentRuntime.instanceEnabled") : t("agentRuntime.instanceDisabled")} />
      </Row>; })}
    </Segment>
    <Segment segment="agents" title={t("agentRuntime.segAgents")} sub={t("agentRuntime.segAgentsSub")} count={agents.length} open={open.agents ?? true} onToggle={onToggle} onNew={() => onNew("agents")}>
      {agents.map((agent) => <Row key={agent.id} tip={agent.id} testId={`rail-agent-${agent.id}`} selected={picked("agent", agent.id)} onSelect={() => onSelect({ type: "agent", id: agent.id })}>
        <Avatar id={agent.id} /><span className="min-w-0 flex-1 truncate text-[12px]">{agent.name}</span>
        <span data-tip={t("agentRuntime.layerTip", { layer: agent.layer })} className="shrink-0 rounded-[3px] border border-border-strong px-1 font-mono text-[9px] tracking-[0.04em] text-text-faint">{agent.layer}</span>
        {agent.validity === "blocked" && <LiveDot state="failed" tip={t("agentRuntime.declarationBlocked")} />}
      </Row>)}
    </Segment>
    <Segment segment="squads" title={t("agentRuntime.segSquads")} sub={t("agentRuntime.segSquadsSub")} count={squads.length} open={open.squads ?? true} onToggle={onToggle} onNew={() => onNew("squads")}>
      {squads.map((squad) => <Row key={squad.id} tip={squad.id} testId={`rail-squad-${squad.id}`} selected={picked("squad", squad.id)} onSelect={() => onSelect({ type: "squad", id: squad.id })}>
        <KindDot kind="any" /><span className="min-w-0 flex-1 truncate text-[12px]">{squad.name}</span>
        <span className="shrink-0 rounded-[3px] border border-border-strong px-1 font-mono text-[9px] text-text-faint">{t("agentRuntime.memberCount", { count: squad.workers.length + 1 })}</span>
      </Row>)}
    </Segment>
    <Segment segment="orchestration" title={t("agentRuntime.segOrchestration")} sub={t("agentRuntime.segOrchestrationSub")} count={orchestration.length} open={open.orchestration ?? true} onToggle={onToggle}>
      {orchestration.map((entry) => <Row key={entry.taskId} tip={entry.taskId} testId={`rail-orchestration-${entry.taskId}`} selected={picked("orchestration", entry.taskId)} onSelect={() => onSelect({ type: "orchestration", id: entry.taskId })}>
        <span className="shrink-0 font-mono text-[10px] text-text-faint">{entry.taskId.slice(-6)}</span><span className="min-w-0 flex-1 truncate text-[12px]">{entry.title}</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-[9px] text-text-faint">{t("agentRuntime.dispatchCount", { count: entry.dispatches })}</span>
      </Row>)}
    </Segment>
    <Segment segment="sessions" title={t("agentRuntime.segSessions")} sub={t("agentRuntime.segSessionsSub")} count={sessions.length} open={open.sessions ?? true} onToggle={onToggle}>
      <SessionGroupRows sessions={sessions} picked={picked} onSelect={onSelect} />
    </Segment>
    <details className="px-2.5 py-2 text-[10px] leading-[1.5] text-text-faint"><summary className="cursor-pointer list-none">{t("agentRuntime.thesisSummary")}</summary><p className="mt-1">{t("agentRuntime.thesisBody")}</p></details>
  </nav>;
}

// Sessions answer "who is running": grouped by Agent or Squad, never by runtime instance —
// the carrier is only where a session happens to run. A runtime session the dispatch ledger
// does not know about still belongs here, under its unattributed group.
function SessionGroupRows({ sessions, picked, onSelect }: { readonly sessions: readonly RuntimeDockRow[]; readonly picked: (type: "session", id: string) => boolean; readonly onSelect: (selection: RuntimeSelection) => void }) {
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({});
  return <>{runtimeDockGroups(sessions).map((group) => <div key={group.key}>
    <button type="button" aria-expanded={!collapsed[group.key]} onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !current[group.key] }))} className="flex w-full items-center gap-1.5 px-1.5 pt-1 pb-0.5 text-left text-[10.5px] text-text-muted">
      <span aria-hidden className={`text-[7px] text-text-faint transition-transform ${collapsed[group.key] ? "" : "rotate-90"}`}>▶</span>
      {group.kind === "squad" ? <KindDot kind="any" /> : group.kind === "agent" ? <Avatar id={group.label || group.key} /> : <KindDot kind="claude" />}
      <b className="font-semibold">{group.label || t("agentRuntime.unattributed")}</b><span className="text-text-faint">{group.kind}</span>
      <span className="ml-auto font-mono text-[10px] text-text-faint">{group.rows.length}</span>
    </button>
    {!collapsed[group.key] && group.rows.map((row) => <Row key={row.runtimeSessionId} tip={row.runtimeSessionId} testId={`rail-session-${row.runtimeSessionId}`} selected={picked("session", row.runtimeSessionId)} onSelect={() => onSelect({ type: "session", id: row.runtimeSessionId })}>
      <LiveDot state={row.status === "running" ? "live" : row.status === "failed" ? "failed" : "idle"} tip={row.status} />
      <span className="min-w-0 flex-1 truncate text-[11.5px]">{row.agentName ?? row.instanceId}</span>
      <span className="min-w-0 max-w-[76px] shrink truncate font-mono text-[9.5px] text-text-muted">{row.taskTitle ?? t("agentRuntime.noTask")}</span>
      <span data-testid={`runtime-outcome-${row.runtimeSessionId}`} className={`shrink-0 font-mono text-[9.5px] ${OUTCOME_TONE[row.status]}`}>{row.status}</span>
    </Row>)}
  </div>)}</>;
}

function Segment({ segment, title, sub, count, open, onToggle, onNew, children }: { readonly segment: string; readonly title: string; readonly sub: string; readonly count: number; readonly open: boolean; readonly onToggle: (segment: string) => void; readonly onNew?: () => void; readonly children: ReactNode }) {
  return <section className="border-b border-border">
    <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1.5 hover:bg-surface-raised">
      <button type="button" aria-expanded={open} onClick={() => onToggle(segment)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
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
