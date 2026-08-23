import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentEntityClient } from "../agent-entity-client.ts";
import { useCatalogSnapshot } from "../catalog-data.ts";
import type { DispatchRequest, DispatchSubject } from "../dispatch-flow.ts";
import { runtimeDockLiveCount } from "../runtime-panorama.ts";
import { t } from "../i18n/index.tsx";
import { DispatchDialog } from "../components/DispatchDialog.tsx";
import { AgentCard, agentDeclarationFrom, agentDraftFrom } from "../components/runtime/AgentCard.tsx";
import { NewEntityDialog, type NewEntityRequest } from "../components/runtime/NewEntityDialog.tsx";
import { NewRuntimeDialog } from "../components/runtime/NewRuntimeDialog.tsx";
import { Badge, Btn, CapDot, Empty, Hint } from "../components/runtime/parts.tsx";
import { RuntimeCard } from "../components/runtime/RuntimeCard.tsx";
import { RuntimeInspector } from "../components/runtime/RuntimeInspector.tsx";
import { RuntimeRail } from "../components/runtime/RuntimeRail.tsx";
import { SessionsPanel } from "../components/runtime/SessionsPanel.tsx";
import { SquadCard, squadDeclarationFrom, squadDraftFrom } from "../components/runtime/SquadCard.tsx";
import { useAgentDetail, useRuntimeWorkspace, useSquadDetail, type RuntimeSelection } from "../components/runtime/useRuntimeWorkspace.ts";

type TaskOption = { readonly taskId: string; readonly title: string; readonly heldLease: boolean };
type Dialog = { readonly kind: "new-runtime" } | { readonly kind: "new-entity"; readonly entity: "agent" | "squad" } | { readonly kind: "dispatch"; readonly subject: DispatchSubject; readonly prompts: readonly string[]; readonly mission: string };

// The Agent Runtime configuration plane: rail (carrier → identity → organisation →
// execution) · detail card · inspector, exactly the regions the design prototype argues
// for. Sessions are a first-class rail segment carried by the main area — selection is the
// only cross-region state. W5:「编排」rail 段随入口撤销——task 的派工链归 Task 详情
// 「派工」页签;session → task 的出口(onOpenTask)指向 Task 详情。
export function RuntimeWorkspace({ repoId, tasks, onOpenTask }: { readonly repoId: string; readonly tasks: readonly TaskOption[]; readonly onOpenTask: (taskId: string) => void }) {
  const workspace = useRuntimeWorkspace(repoId, tasks), catalog = useCatalogSnapshot(repoId), skills = useQuery({ queryKey: ["agent-skills", repoId], queryFn: () => agentEntityClient.listAgentSkills(repoId), staleTime: 10_000 });
  const [selection, setSelection] = useState<RuntimeSelection | null>(null), [segments, setSegments] = useState<Readonly<Record<string, boolean>>>({ runtimes: true, agents: true, squads: true, sessions: true });
  const [dialog, setDialog] = useState<Dialog | null>(null), [inspector, setInspector] = useState(true);
  const instances = workspace.instances, installations = workspace.machine.data?.installations ?? [], agents = workspace.agents.data ?? [], squads = workspace.squads.data ?? [];
  const current: RuntimeSelection | null = selection ?? (instances[0] ? { type: "runtime", id: instances[0].instanceId } : agents[0] ? { type: "agent", id: agents[0].id } : null);
  const agentDetail = useAgentDetail(repoId, current?.type === "agent" ? current.id : null), squadDetail = useSquadDetail(repoId, current?.type === "squad" ? current.id : null);
  const liveByInstance = new Map<string, number>(); for (const row of workspace.dockRows) if (row.status === "running") liveByInstance.set(row.instanceId, (liveByInstance.get(row.instanceId) ?? 0) + 1);
  const focusSession = (runtimeSessionId: string) => setSelection({ type: "session", id: runtimeSessionId });

  const openAgentDispatch = async (agentId: string, mission: string) => {
    const row = agents.find((agent) => agent.id === agentId); if (!row) return;
    setDialog({ kind: "dispatch", subject: { kind: "agent", agent: { agentId: row.id, agentName: row.name, runtimeType: row.runtimeType } }, prompts: [], mission });
    const detail = await agentEntityClient.showAgent(repoId, agentId);
    setDialog((value) => value?.kind === "dispatch" && value.subject.kind === "agent" && value.subject.agent.agentId === agentId ? { ...value, prompts: detail.prompts } : value);
  };
  const openSquadDispatch = async (squadId: string) => {
    const detail = await agentEntityClient.showSquad(repoId, squadId), byId = new Map(agents.map((agent) => [agent.id, agent]));
    const ref = (id: string) => ({ agentId: id, agentName: byId.get(id)?.name ?? id, runtimeType: byId.get(id)?.runtimeType ?? "" });
    setDialog({ kind: "dispatch", subject: { kind: "squad", squadId, squadName: detail.name, leader: ref(detail.leader), workers: detail.workers.map(ref) }, prompts: [], mission: "" });
  };
  const createEntity = async (request: NewEntityRequest) => {
    if (request.kind === "agent") {
      const draft = request.templateId ? agentDraftFrom(await agentEntityClient.showAgent(repoId, request.templateId)) : { name: request.name, role: "worker" as const, runtimeType: "any", model: "", preset: "", skills: [], instructions: t("agentRuntime.blankInstructions"), prompts: [] };
      await workspace.saveAgent(agentDeclarationFrom(request.id, { ...draft, name: request.name }));
      setSelection({ type: "agent", id: request.id });
    } else {
      const draft = request.templateId ? squadDraftFrom(await agentEntityClient.showSquad(repoId, request.templateId)) : { name: request.name, leader: agents.find((agent) => agent.role === "commander")?.id ?? agents[0]?.id ?? "", workers: [], roster: t("agentRuntime.blankRoster") };
      await workspace.saveSquad(squadDeclarationFrom(request.id, { ...draft, name: request.name }));
      setSelection({ type: "squad", id: request.id });
    }
    setDialog(null);
  };
  const dispatch = async (request: DispatchRequest) => { const settled = await workspace.dispatch(request); setDialog(null); if (settled?.runtimeSessionId) focusSession(settled.runtimeSessionId); };

  // Each region reads its own source, so one failing read degrades that region and nothing
  // else: the machine-local instance catalogue going down must not take the Agents, Squads
  // and Sessions regions — which never touch it — down with it.
  const readError = [workspace.machine.error, workspace.overview.error, workspace.agents.error, workspace.squads.error].find(Boolean);
  const catalogsPending = workspace.machine.isPending && workspace.agents.isPending;
  return <section data-testid="runtime-workspace" className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3.5">
      <b className="text-[13px] tracking-[0.02em]">{t("agentRuntime.title")}</b><span className="truncate font-mono text-[10.5px] text-text-faint">{t("agentRuntime.subtitle")}</span>
      <span className="flex-1" />
      <span className="flex items-center gap-2.5 whitespace-nowrap text-[11px] text-text-muted"><span className="flex items-center gap-1"><CapDot size={10} state="full" tip={t("agentRuntime.legendReadyTip")} />{t("agentRuntime.legendReady")}</span><span className="flex items-center gap-1"><CapDot size={10} state="part" tip={t("agentRuntime.legendPartialTip")} />{t("agentRuntime.legendPartial")}</span><span className="flex items-center gap-1"><CapDot size={10} state="none" tip={t("agentRuntime.legendBlockedTip")} />{t("agentRuntime.legendBlocked")}</span></span>
      <Badge status={runtimeDockLiveCount(workspace.dockRows) > 0 ? "active" : "planned"}>{t("agentRuntime.liveSessions", { count: runtimeDockLiveCount(workspace.dockRows) })}</Badge>
      <Btn size="sm" variant="ghost" onClick={() => setInspector(!inspector)} tip={t("agentRuntime.toggleInspector")}>▐</Btn>
    </header>
    {readError !== undefined && <p role="alert" data-testid="runtime-read-error" className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono text-[11px] text-status-blocked">{t("agentRuntime.readFailed", { error: readError instanceof Error ? readError.message : String(readError) })}</p>}
    {(workspace.error ?? workspace.feedback) && <p role="status" onClick={workspace.clearFeedback} className={`shrink-0 border-b border-border px-3.5 py-1.5 font-mono text-[11px] ${workspace.error ? "bg-status-blocked/10 text-status-blocked" : "text-text-muted"}`}>{workspace.error ?? workspace.feedback}</p>}
    <div className="flex min-h-0 flex-1">
      <RuntimeRail instances={instances} authProbeErrors={workspace.authProbeErrors} agents={agents} squads={squads} sessions={workspace.dockRows} selection={current} open={segments} liveByInstance={liveByInstance}
        onToggle={(segment) => setSegments((value) => ({ ...value, [segment]: !(value[segment] ?? true) }))} onSelect={setSelection} onNew={(segment) => setDialog(segment === "runtimes" ? { kind: "new-runtime" } : { kind: "new-entity", entity: segment === "agents" ? "agent" : "squad" })} />
      <main className="min-w-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
        {current === null ? <Empty>{t(catalogsPending ? "agentRuntime.loading" : "agentRuntime.emptyWorkspace")}</Empty>
          : current.type === "runtime" ? (instances.find((instance) => instance.instanceId === current.id)
            ? <RuntimeCard instance={instances.find((instance) => instance.instanceId === current.id)!} installations={installations} authProbeError={workspace.authProbeErrors.get(current.id)} agents={agents} liveSessions={liveByInstance.get(current.id) ?? 0} busy={workspace.busy}
                onSelectAgent={(agentId) => setSelection({ type: "agent", id: agentId })} onAuth={(action) => void workspace.authInstance(current.id, action)} onValidate={() => void workspace.validateInstance(current.id)}
                onSetEnabled={(enabled) => void workspace.setInstanceEnabled(current.id, enabled)} onUpdate={(input) => void workspace.updateInstance(input)} onDelete={() => { void workspace.deleteInstance(current.id); setSelection(null); }} onSelfTest={(model) => workspace.selfTest(current.id, model)} />
            : <Empty>{t("agentRuntime.notFound")}</Empty>)
          : current.type === "agent" ? (agentDetail.data
            ? <AgentCard detail={agentDetail.data} row={agents.find((agent) => agent.id === current.id) ?? null} squads={squads} instances={instances} availableSkills={skills.data ?? []} presets={catalog.data?.presets ?? []} busy={workspace.busy}
                onSave={(declaration) => void workspace.saveAgent(declaration)} onDispatch={(mission) => void openAgentDispatch(current.id, mission)}
                onSelectSquad={(squadId) => setSelection({ type: "squad", id: squadId })} onSelectRuntime={(instanceId) => setSelection({ type: "runtime", id: instanceId })} />
            : <Empty>{t("agentRuntime.loading")}</Empty>)
          : current.type === "squad" ? (squadDetail.data
            ? <SquadCard detail={squadDetail.data} row={squads.find((squad) => squad.id === current.id) ?? null} agents={agents} busy={workspace.busy}
                onSave={(declaration) => void workspace.saveSquad(declaration)} onLaunch={() => void openSquadDispatch(current.id)} onSelectAgent={(agentId) => setSelection({ type: "agent", id: agentId })} />
            : <Empty>{t("agentRuntime.loading")}</Empty>)
          : <SessionsPanel repoId={repoId} runtimeSessionId={current.id} row={workspace.dockRows.find((row) => row.runtimeSessionId === current.id) ?? null} busy={workspace.busy}
              onCancel={(runtimeSessionId) => void workspace.cancelSession(runtimeSessionId)} onOpenTask={onOpenTask} />}
      </main>
      {inspector && <RuntimeInspector selection={current} instances={instances} authProbeErrors={workspace.authProbeErrors} agents={agents} squads={squads} rows={workspace.dockRows} onSelect={setSelection} onSelectSession={focusSession} onOpenTask={onOpenTask} />}
    </div>
    {dialog?.kind === "new-runtime" && <NewRuntimeDialog installations={installations} existingInstanceIds={instances.map((instance) => instance.instanceId)} busy={workspace.busy} onCancel={() => setDialog(null)} onCreate={(input) => { void workspace.createInstance(input).then((created) => { if (created) { setDialog(null); setSelection({ type: "runtime", id: input.instanceId }); } }); }} />}
    {dialog?.kind === "new-entity" && <NewEntityDialog kind={dialog.entity} agents={agents} squads={squads} busy={workspace.busy} taken={dialog.entity === "agent" ? agents.map((agent) => agent.id) : squads.map((squad) => squad.id)} onCancel={() => setDialog(null)} onCreate={(request) => void createEntity(request)} />}
    {dialog?.kind === "dispatch" && <DispatchDialog subject={dialog.subject} instances={workspace.overview.data?.instances ?? []} tasks={tasks} prompts={dialog.prompts} initialMission={dialog.mission} busy={workspace.busy} notice={workspace.settlement?.state === "pending" ? workspace.settlement.hint : null} onCancel={() => setDialog(null)} onSubmit={(request) => void dispatch(request)} />}
    {workspace.settlement && <p role="status" className="shrink-0 border-t border-border px-3.5 py-1 font-mono text-[10.5px] text-text-faint"><Hint>{workspace.settlement.state} · {workspace.settlement.opId} · {workspace.settlement.hint}</Hint></p>}
  </section>;
}
