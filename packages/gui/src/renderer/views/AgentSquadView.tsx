import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentEntityClient } from "../agent-entity-client.ts";
import { useCatalogSnapshot } from "../catalog-data.ts";
import type { DispatchRequest, DispatchSubject } from "../dispatch-flow.ts";
import { t } from "../i18n/index.tsx";
import { DispatchDialog, type DispatchDialogTaskOption } from "../components/DispatchDialog.tsx";
import { AgentCard, agentDeclarationFrom, agentDraftFrom } from "../components/runtime/AgentCard.tsx";
import { NewEntityDialog, type NewEntityRequest } from "../components/runtime/NewEntityDialog.tsx";
import { Badge, Btn, Empty, Hint } from "../components/runtime/parts.tsx";
import { IdentityRail } from "../components/runtime/RuntimeRail.tsx";
import { IdentityInspector } from "../components/runtime/RuntimeInspector.tsx";
import { SquadCard, squadDeclarationFrom, squadDraftFrom } from "../components/runtime/SquadCard.tsx";
import {
  runtimeSelectionFromRef,
  runtimeSelectionRef,
  useAgentDetail,
  useAgentSquadWorkspace,
  useSquadDetail,
  type RuntimeSelection,
} from "../components/runtime/useRuntimeWorkspace.ts";

type Dialog =
  | { readonly kind: "new-entity"; readonly entity: "agent" | "squad" }
  | {
      readonly kind: "dispatch";
      readonly subject: DispatchSubject;
      readonly prompts: readonly string[];
      readonly mission: string;
    };

// Agent 入口 · 含 Squad(W6 IA 拆分):身份层(Agent 声明)与组织层(Squad)共享一页,
// 依据方案 P2——Squad 没有独立于 Agent 的生命周期,所以它是本页的一个面而非第四个
// 入口。派工(agent dispatch / squad launch)从这页发起;settle 后跳会话入口看它跑
// (session/<id>,可寻址,回撤原路返回)。跨页出口:兼容 Runtime 实例 → Provider,
// 相关会话 → 会话;页内 Agent↔Squad 互跳同样走可寻址选择,推导航栈。
export function AgentSquadView({
  repoId,
  tasks,
  focusedEntityRef,
  onSelectEntity,
}: {
  readonly repoId: string;
  readonly tasks: readonly DispatchDialogTaskOption[];
  readonly focusedEntityRef: string | null;
  readonly onSelectEntity: (ref: string) => void;
}) {
  const refSelection = runtimeSelectionFromRef(focusedEntityRef);
  // inspector 相关会话的检索面:深链选中谁就查谁(agent/squad id 进 daemon 侧 query,
  // 每个任务组带该执行者的最新一轮预览)。
  const workspace = useAgentSquadWorkspace(
      repoId,
      refSelection !== null && (refSelection.type === "agent" || refSelection.type === "squad")
        ? { kind: refSelection.type, id: refSelection.id }
        : null,
    ),
    catalog = useCatalogSnapshot(repoId),
    skills = useQuery({
      queryKey: ["agent-skills", repoId],
      queryFn: () => agentEntityClient.listAgentSkills(repoId),
      staleTime: 10_000,
    });
  const [dialog, setDialog] = useState<Dialog | null>(null),
    [inspector, setInspector] = useState(true);
  const agents = workspace.agents.data ?? [],
    squads = workspace.squads.data ?? [];
  // 深链指向的实体可能已被删除(或仍在读取):存在才采用,否则回落首项 Agent、再
  // 回落首项 Squad——派生选择,不写回导航栈。
  const current: RuntimeSelection | null =
    refSelection?.type === "agent" && agents.some((agent) => agent.id === refSelection.id)
      ? refSelection
      : refSelection?.type === "squad" && squads.some((squad) => squad.id === refSelection.id)
        ? refSelection
        : agents[0]
          ? { type: "agent", id: agents[0].id }
          : squads[0]
            ? { type: "squad", id: squads[0].id }
            : null;
  const agentDetail = useAgentDetail(repoId, current?.type === "agent" ? current.id : null),
    squadDetail = useSquadDetail(repoId, current?.type === "squad" ? current.id : null);

  const openAgentDispatch = async (agentId: string, mission: string) => {
    const row = agents.find((agent) => agent.id === agentId);
    if (!row) return;
    setDialog({
      kind: "dispatch",
      subject: { kind: "agent", agent: { agentId: row.id, agentName: row.name, runtimeType: row.runtimeType } },
      prompts: [],
      mission,
    });
    const detail = await agentEntityClient.showAgent(repoId, agentId);
    setDialog((value) =>
      value?.kind === "dispatch" && value.subject.kind === "agent" && value.subject.agent.agentId === agentId
        ? { ...value, prompts: detail.prompts }
        : value,
    );
  };
  const openSquadDispatch = async (squadId: string) => {
    const detail = await agentEntityClient.showSquad(repoId, squadId),
      byId = new Map(agents.map((agent) => [agent.id, agent]));
    const ref = (id: string) => ({
      agentId: id,
      agentName: byId.get(id)?.name ?? id,
      runtimeType: byId.get(id)?.runtimeType ?? "",
    });
    setDialog({
      kind: "dispatch",
      subject: {
        kind: "squad",
        squadId,
        squadName: detail.name,
        leader: ref(detail.leader),
        workers: detail.workers.map(ref),
      },
      prompts: [],
      mission: "",
    });
  };
  const createEntity = async (request: NewEntityRequest) => {
    if (request.kind === "agent") {
      const draft = request.templateId
        ? agentDraftFrom(await agentEntityClient.showAgent(repoId, request.templateId))
        : {
            name: request.name,
            role: "worker" as const,
            runtimeType: "any",
            model: "",
            preset: "",
            skills: [],
            instructions: t("agentRuntime.blankInstructions"),
            prompts: [],
          };
      await workspace.saveAgent(agentDeclarationFrom(request.id, { ...draft, name: request.name }));
    } else {
      const draft = request.templateId
        ? squadDraftFrom(await agentEntityClient.showSquad(repoId, request.templateId))
        : {
            name: request.name,
            leader: agents.find((agent) => agent.role === "commander")?.id ?? agents[0]?.id ?? "",
            workers: [],
            roster: t("agentRuntime.blankRoster"),
          };
      await workspace.saveSquad(squadDeclarationFrom(request.id, { ...draft, name: request.name }));
    }
    onSelectEntity(`${request.kind}/${request.id}`);
    setDialog(null);
  };
  const dispatch = async (request: DispatchRequest) => {
    const settled = await workspace.dispatch(request);
    setDialog(null);
    if (settled?.runtimeSessionId) onSelectEntity(`session/${settled.runtimeSessionId}`);
  };

  // The page reads only its own sources: one failing read degrades its region (rail, card,
  // inspector) and nothing else — the machine instance catalogue going down must not take
  // the identity reads with it.
  const readError = [workspace.overview.error, workspace.agents.error, workspace.squads.error].find(Boolean);
  const catalogsPending = workspace.agents.isPending && workspace.squads.isPending;
  return (
    <section data-testid="agent-squad-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3.5">
        <b className="text-[13px] tracking-[0.02em]">{t("agentRuntime.agentsTitle")}</b>
        <span className="truncate font-mono text-[10.5px] text-text-faint">{t("agentRuntime.agentsSubtitle")}</span>
        <span className="flex-1" />
        <Badge>{t("agentRuntime.agentCount", { count: agents.length })}</Badge>
        <Badge>{t("agentRuntime.squadCount", { count: squads.length })}</Badge>
        <Btn size="sm" variant="ghost" onClick={() => setInspector(!inspector)} tip={t("agentRuntime.toggleInspector")}>
          ▐
        </Btn>
      </header>
      {readError !== undefined && (
        <p
          role="alert"
          data-testid="runtime-read-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono text-[11px]
        text-status-blocked"
        >
          {t("agentRuntime.readFailed", { error: readError instanceof Error ? readError.message : String(readError) })}
        </p>
      )}
      {(workspace.error ?? workspace.feedback) && (
        <p
          role="status"
          onClick={workspace.clearFeedback}
          className={`shrink-0 border-b border-border px-3.5 py-1.5 font-mono text-[11px] ${
            workspace.error ? "bg-status-blocked/10 text-status-blocked" : "text-text-muted"
          }`}
        >
          {workspace.error ?? workspace.feedback}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <IdentityRail
          agents={agents}
          squads={squads}
          selection={current}
          onSelect={(selection) => onSelectEntity(runtimeSelectionRef(selection))}
          onNew={(segment) => setDialog({ kind: "new-entity", entity: segment === "agents" ? "agent" : "squad" })}
        />
        <main className="min-w-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
          {current === null ? (
            <Empty>{t(catalogsPending ? "agentRuntime.loading" : "agentRuntime.emptyAgents")}</Empty>
          ) : current.type === "agent" ? (
            agentDetail.data ? (
              <AgentCard
                detail={agentDetail.data}
                row={agents.find((agent) => agent.id === current.id) ?? null}
                squads={squads}
                instances={workspace.instances}
                availableSkills={skills.data ?? []}
                presets={catalog.data?.presets ?? []}
                busy={workspace.busy}
                onSave={(declaration) => void workspace.saveAgent(declaration)}
                onDispatch={(mission) => void openAgentDispatch(current.id, mission)}
                onSelectSquad={(squadId) => onSelectEntity(`squad/${squadId}`)}
                onSelectRuntime={(instanceId) => onSelectEntity(`provider/${instanceId}`)}
                onSelectAgent={(agentId) => onSelectEntity(`agent/${agentId}`)}
              />
            ) : (
              <Empty>{t("agentRuntime.loading")}</Empty>
            )
          ) : squadDetail.data ? (
            <SquadCard
              detail={squadDetail.data}
              row={squads.find((squad) => squad.id === current.id) ?? null}
              agents={agents}
              busy={workspace.busy}
              onSave={(declaration) => void workspace.saveSquad(declaration)}
              onLaunch={() => void openSquadDispatch(current.id)}
              onSelectAgent={(agentId) => onSelectEntity(`agent/${agentId}`)}
              onSelectSquad={(squadId) => onSelectEntity(`squad/${squadId}`)}
            />
          ) : (
            <Empty>{t("agentRuntime.loading")}</Empty>
          )}
        </main>
        {inspector && current !== null && (
          <IdentityInspector
            selection={current}
            agents={agents}
            squads={squads}
            rows={workspace.dockRows}
            onSelect={(selection) => onSelectEntity(runtimeSelectionRef(selection))}
            onOpenSession={(runtimeSessionId) => onSelectEntity(`session/${runtimeSessionId}`)}
          />
        )}
      </div>
      {dialog?.kind === "new-entity" && (
        <NewEntityDialog
          kind={dialog.entity}
          agents={agents}
          squads={squads}
          busy={workspace.busy}
          taken={dialog.entity === "agent" ? agents.map((agent) => agent.id) : squads.map((squad) => squad.id)}
          onCancel={() => setDialog(null)}
          onCreate={(request) => void createEntity(request)}
        />
      )}
      {dialog?.kind === "dispatch" && (
        <DispatchDialog
          subject={dialog.subject}
          instances={workspace.overview.data?.instances ?? []}
          tasks={tasks}
          prompts={dialog.prompts}
          initialMission={dialog.mission}
          busy={workspace.busy}
          notice={workspace.settlement?.state === "pending" ? workspace.settlement.hint : null}
          onCancel={() => setDialog(null)}
          onSubmit={(request) => void dispatch(request)}
        />
      )}
      {workspace.settlement && (
        <p
          role="status"
          className="shrink-0 border-t border-border px-3.5 py-1 font-mono text-[10.5px]
        text-text-faint"
        >
          <Hint>
            {workspace.settlement.state} · {workspace.settlement.opId} ·{workspace.settlement.hint}
          </Hint>
        </p>
      )}
    </section>
  );
}
