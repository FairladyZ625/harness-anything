import { useDeferredValue, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentEntityClient, isAvailableAgentEntityRow, isAvailableSquadEntityRow } from "../agent-entity-client.ts";
import { useCatalogSnapshot } from "../catalog-data.ts";
import type { DispatchRequest, DispatchSubject } from "../dispatch-flow.ts";
import { t } from "../i18n/index.tsx";
import { DispatchDialog, type DispatchDialogTaskOption } from "../components/DispatchDialog.tsx";
import { AgentSquadFilterBar } from "../components/AgentSquadFilterBar.tsx";
import {
  DEFAULT_AGENT_SQUAD_FILTERS,
  filterAgents,
  filterSquads,
  hasActiveAgentSquadFilters,
  type AgentSquadFilters,
} from "../model/agentSquadFilters.ts";
import { formatTime } from "../model/time.ts";
import { useSettingsQuery } from "../settings-data.ts";
import { AgentCard, agentDeclarationFrom, agentDraftFrom } from "../components/runtime/AgentCard.tsx";
import { ActionError } from "../components/runtime/ActionError.tsx";
import { DegradedEntityCard, type SettingsRoleRef } from "../components/runtime/DegradedEntityCard.tsx";
import { NewEntityDialog, type NewEntityRequest } from "../components/runtime/NewEntityDialog.tsx";
import { Btn, Empty, Hint } from "../components/runtime/parts.tsx";
import { IdentityRail, RoleLabel } from "../components/runtime/RuntimeRail.tsx";
import { CatalogBackButton, CatalogSplit, useCatalogDetailPane } from "../components/primitives/CatalogSplit.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";
import { IdentityInspector } from "../components/runtime/RuntimeInspector.tsx";
import { SquadCard, squadDeclarationFrom, squadDraftFrom } from "../components/runtime/SquadCard.tsx";
import { SquadCockpit } from "../components/runtime/SquadCockpit.tsx";
import {
  runtimeSelectionFromRef,
  runtimeSelectionRef,
  useAgentDetail,
  useAgentSquadWorkspace,
  useRelatedDispatches,
  useSquadDetail,
  type RuntimeSelection,
} from "../components/runtime/useRuntimeWorkspace.ts";

type Dialog =
  | { readonly kind: "new-entity"; readonly entity: "agent" | "squad"; readonly initialId?: string }
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
//
// 目录版式(标准 §2.5):页头结论行直说 N 个声明无效并给修复入口;进入页面默认选中
// 第一个异常项(无异常则第一项);右侧详情按 2.2 文档型——先一行结论(可用否及原因、
// 被哪些设置/任务引用、最近一次派工结果),再是声明字段。
export function AgentSquadView({
  repoId,
  tasks,
  focusedEntityRef,
  onSelectEntity,
  onFocusGraph,
}: {
  readonly repoId: string;
  readonly tasks: readonly DispatchDialogTaskOption[];
  readonly focusedEntityRef: string | null;
  readonly onSelectEntity: (ref: string) => void;
  /** 统一「在关系图中查看」入口(task_89d324b5);透传给 Agent 详情卡。 */
  readonly onFocusGraph?: (ref: string) => void;
}) {
  const refSelection = runtimeSelectionFromRef(focusedEntityRef);
  // 窄容器(内容区 <720px,styles.css .catalog-split)的单列形态:目录全宽、点行进详情、
  // 返回键回目录;宽容器常驻双栏,该状态不参与。深链/跨页实体跳转视为一次点行。
  const narrow = useCatalogDetailPane(
    refSelection !== null && (refSelection.type === "agent" || refSelection.type === "squad")
      ? `${refSelection.type}/${refSelection.id}`
      : null,
  );
  const workspace = useAgentSquadWorkspace(repoId),
    catalog = useCatalogSnapshot(repoId),
    settings = useSettingsQuery(repoId),
    skills = useQuery({
      queryKey: ["agent-skills", repoId],
      queryFn: () => agentEntityClient.listAgentSkills(repoId),
      staleTime: 10_000,
    });
  const [dialog, setDialog] = useState<Dialog | null>(null),
    [inspector, setInspector] = useState(true),
    // 查看者本地过滤状态:内存即可,不写台账(任务契约 §6)。deferred 保输入不卡。
    [filters, setFilters] = useState<AgentSquadFilters>(DEFAULT_AGENT_SQUAD_FILTERS);
  const deferredQuery = useDeferredValue(filters.query),
    effectiveFilters = filters.query === deferredQuery ? filters : { ...filters, query: deferredQuery };
  const agentRows = workspace.agents.data ?? [],
    squadRows = workspace.squads.data ?? [],
    agents = agentRows.filter(isAvailableAgentEntityRow),
    squads = squadRows.filter(isAvailableSquadEntityRow),
    degradedAgents = agentRows.filter((row) => !isAvailableAgentEntityRow(row)),
    degradedSquads = squadRows.filter((row) => !isAvailableSquadEntityRow(row)),
    invalidCount = degradedAgents.length + degradedSquads.length,
    filteredAgentRows = filterAgents(agentRows, squadRows, effectiveFilters),
    filteredSquadRows = filterSquads(squadRows, effectiveFilters),
    filtering = hasActiveAgentSquadFilters(effectiveFilters);
  // 目录行第二行的说明取全目录(不随筛选变):leader 名称与 Agent 所在 Squad。
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name])),
    squadsByAgent = new Map<string, string[]>();
  for (const squad of squads)
    for (const member of new Set([squad.leader, ...squad.workers]))
      squadsByAgent.set(member, [...(squadsByAgent.get(member) ?? []), squad.name]);
  // 深链指向的实体可能已被删除(或仍在读取):存在才采用(降级行同样可选——它就是
  // 目录要暴露的异常);否则默认选第一个异常项(§2.5),无异常回落首项 Agent、再
  // 回落首项 Squad——派生选择,不写回导航栈。
  const entityExists = (type: "agent" | "squad", id: string) =>
    type === "agent" ? agentRows.some((row) => row.id === id) : squadRows.some((row) => row.id === id);
  const fallback: RuntimeSelection | null =
    (degradedAgents[0] ? { type: "agent", id: degradedAgents[0].id } : null) ??
    (agents[0] ? { type: "agent", id: agents[0].id } : null) ??
    (degradedSquads[0] ? { type: "squad", id: degradedSquads[0].id } : null) ??
    (squads[0] ? { type: "squad", id: squads[0].id } : null);
  const current: RuntimeSelection | null =
    refSelection?.type === "agent" || refSelection?.type === "squad"
      ? entityExists(refSelection.type, refSelection.id)
        ? refSelection
        : fallback
      : fallback;
  // 相关派工轮次跟随有效选择(含降级行):结论行的「最近一次派工结果」不能因为
  // 选择是派生的(非深链)就查不到。
  const { dockRows } = useRelatedDispatches(
    repoId,
    current !== null && (current.type === "agent" || current.type === "squad")
      ? { kind: current.type, id: current.id }
      : null,
  );
  const agentDetail = useAgentDetail(
      repoId,
      current?.type === "agent" && agents.some((agent) => agent.id === current.id) ? current.id : null,
    ),
    squadDetail = useSquadDetail(
      repoId,
      current?.type === "squad" && squads.some((squad) => squad.id === current.id) ? current.id : null,
    ),
    selectedAgent = current?.type === "agent" ? (agentRows.find((row) => row.id === current.id) ?? null) : null,
    selectedSquad = current?.type === "squad" ? (squadRows.find((row) => row.id === current.id) ?? null) : null;
  // 过滤命中不含当前选中项时不改派生选择(详情不跳走),只在列表上显形提示 +
  // 一键清除——选中态的裁决权仍在导航栈,过滤只是查看者的镜头。
  const selectionHidden =
    filtering &&
    current !== null &&
    !(current.type === "agent"
      ? filteredAgentRows.some((row) => row.id === current.id)
      : filteredSquadRows.some((row) => row.id === current.id));
  const clearFilters = () => setFilters(DEFAULT_AGENT_SQUAD_FILTERS);

  const openAgentDispatch = async (agentId: string, mission: string) => {
    const row = agents.find((agent) => agent.id === agentId);
    if (!row) return;
    setDialog({
      kind: "dispatch",
      subject: { kind: "agent", agent: { agentId: row.id, agentName: row.name, runtimes: row.runtimes } },
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
      leaderRow = agents.find((agent) => agent.id === detail.leader);
    // dec_AB0672F220EE630C0A06C575B8:一次小队派发只派 Commander 本人。subject 只带
    // leader,不带 worker 清单;下级由 Commander 在自己的会话里自主派出,其派工行
    // 带 squadId 与 parentRuntimeSessionId,由小队页直接读出。
    setDialog({
      kind: "dispatch",
      subject: {
        kind: "squad",
        squadId,
        squadName: detail.name,
        leader: {
          agentId: detail.leader,
          agentName: leaderRow?.name ?? detail.leader,
          runtimes: leaderRow?.runtimes ?? [],
        },
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
            runtimes: [],
            preset: "",
            skills: [],
            instructions: t("agentRuntime.blankInstructions"),
            prompts: [],
            instance: "",
            permissionMode: "" as const,
            fallback: undefined,
          };
      const saved = await workspace.saveAgent(agentDeclarationFrom(request.id, { ...draft, name: request.name }));
      if (saved === null) return;
    } else {
      let draft;
      if (request.templateId !== null)
        draft = squadDraftFrom(await agentEntityClient.showSquad(repoId, request.templateId));
      else {
        if (request.leaderTurnBudget === null) throw new Error("A blank Squad requires a leader turn budget.");
        draft = {
          name: request.name,
          leader: agents.find((agent) => agent.role === "commander")?.id ?? agents[0]?.id ?? "",
          workers: [],
          leaderTurnBudget: request.leaderTurnBudget,
          roster: t("agentRuntime.blankRoster"),
        };
      }
      const saved = await workspace.saveSquad(squadDeclarationFrom(request.id, { ...draft, name: request.name }));
      if (saved === null) return;
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
  const firstInvalid =
    (degradedAgents[0] ? { kind: "agent" as const, id: degradedAgents[0].id } : null) ??
    (degradedSquads[0] ? { kind: "squad" as const, id: degradedSquads[0].id } : null);
  return (
    <section data-testid="agent-squad-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 页头(标准 §2.3/§2.5):页名 + 一句结论(全部可用一句话带过;有无效声明直说
          N 个并给修复入口)+ 关键计数;右侧视图开关。 */}
      <PageHeader
        title={t("agentRuntime.agentsTitle")}
        note={
          invalidCount > 0 ? (
            <span data-testid="agent-squad-conclusion" className="inline-flex flex-wrap items-center gap-2">
              <StatusTag tone="bad" label={t("agentRuntime.conclusionInvalid", { count: invalidCount })} />
              {t("agentRuntime.conclusionCounts", { agents: agents.length, squads: squads.length })}
              <button
                type="button"
                data-testid="agent-squad-conclusion-fix"
                onClick={() => firstInvalid && onSelectEntity(`${firstInvalid.kind}/${firstInvalid.id}`)}
                className="rounded-xs border border-status-blocked/40 px-1.5 py-px ui-meta text-status-blocked
                hover:bg-status-blocked/10"
              >
                {t("agentRuntime.conclusionFix")}
              </button>
            </span>
          ) : (
            <span data-testid="agent-squad-conclusion" className="inline-flex flex-wrap items-center gap-2">
              <StatusTag tone="done" label={t("agentRuntime.conclusionAllHealthy")} />
              {t("agentRuntime.conclusionCounts", { agents: agents.length, squads: squads.length })}
            </span>
          )
        }
        actions={
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => setInspector(!inspector)}
            tip={t("agentRuntime.toggleInspector")}
          >
            ▐
          </Btn>
        }
      />
      {readError !== undefined && (
        <p
          role="alert"
          data-testid="runtime-read-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono ui-meta
        text-status-blocked"
        >
          {t("agentRuntime.readFailed", { error: readError instanceof Error ? readError.message : String(readError) })}
        </p>
      )}
      {workspace.feedback && !workspace.error && (
        <p
          role="status"
          onClick={workspace.clearFeedback}
          className="shrink-0 border-b border-border px-3.5 py-1.5 font-mono ui-meta text-text-muted"
        >
          {workspace.feedback}
        </p>
      )}
      <CatalogSplit detailOpen={narrow.detailOpen}>
        <IdentityRail
          agents={filteredAgentRows}
          squads={filteredSquadRows}
          agentsTotal={agentRows.length}
          squadsTotal={squadRows.length}
          agentNames={agentNames}
          squadsByAgent={squadsByAgent}
          selection={current}
          onSelect={(selection) => {
            onSelectEntity(runtimeSelectionRef(selection));
            narrow.openDetail();
          }}
          onNew={(segment) => setDialog({ kind: "new-entity", entity: segment === "agents" ? "agent" : "squad" })}
          toolbar={
            <AgentSquadFilterBar agents={agentRows} squads={squadRows} filters={filters} onChange={setFilters} />
          }
          notice={
            selectionHidden && (
              <p
                role="status"
                data-testid="agent-squad-selection-hidden"
                className="shrink-0 border-b border-border px-3.5 py-2 ui-meta text-text-muted"
              >
                {t("agentRuntime.filterSelectionHidden")}{" "}
                <button
                  type="button"
                  data-testid="agent-squad-selection-hidden-clear"
                  onClick={clearFilters}
                  className="text-accent underline underline-offset-2 hover:text-text"
                >
                  {t("agentRuntime.filterClear")}
                </button>
              </p>
            )
          }
          agentsEmpty={
            filtering ? (
              <p data-testid="agent-squad-agents-empty" className="px-3.5 py-2 ui-meta text-text-faint">
                {t("agentRuntime.filterNoMatches")}{" "}
                <button
                  type="button"
                  data-testid="agent-squad-agents-empty-clear"
                  onClick={clearFilters}
                  className="text-accent underline underline-offset-2"
                >
                  {t("agentRuntime.filterClear")}
                </button>
              </p>
            ) : undefined
          }
          squadsEmpty={
            filtering ? (
              <p data-testid="agent-squad-squads-empty" className="px-3.5 py-2 ui-meta text-text-faint">
                {t("agentRuntime.filterNoMatches")}{" "}
                <button
                  type="button"
                  data-testid="agent-squad-squads-empty-clear"
                  onClick={clearFilters}
                  className="text-accent underline underline-offset-2"
                >
                  {t("agentRuntime.filterClear")}
                </button>
              </p>
            ) : undefined
          }
        />
        <main
          data-testid="agent-squad-detail"
          data-pane="detail"
          className="min-w-0 flex-1 overflow-y-auto px-5 pt-4 pb-6"
        >
          <CatalogBackButton testId="agent-squad-back-to-list" onBack={narrow.backToList} />
          {current === null ? (
            <>
              {workspace.error ? <ActionError>{workspace.error}</ActionError> : null}
              <Empty>{t(catalogsPending ? "agentRuntime.loading" : "agentRuntime.emptyAgents")}</Empty>
            </>
          ) : current.type === "agent" ? (
            selectedAgent !== null && isAvailableAgentEntityRow(selectedAgent) ? (
              agentDetail.data ? (
                <>
                  <EntityConclusion
                    refs={settingsRoleRefs(settings.data?.values, selectedAgent.id)}
                    squads={squads.filter(
                      (squad) => squad.leader === selectedAgent.id || squad.workers.includes(selectedAgent.id),
                    )}
                    agentId={selectedAgent.id}
                    declaredRole={selectedAgent.role}
                    lastDispatch={dockRows[0] ?? null}
                  />
                  <AgentCard
                    detail={agentDetail.data}
                    row={selectedAgent}
                    squads={squads}
                    instances={workspace.instances}
                    availableSkills={skills.data ?? []}
                    presets={catalog.data?.presets ?? []}
                    busy={workspace.busy}
                    actionError={workspace.error}
                    onSave={(declaration) => void workspace.saveAgent(declaration)}
                    onDispatch={(mission) => void openAgentDispatch(current.id, mission)}
                    onSelectSquad={(squadId) => onSelectEntity(`squad/${squadId}`)}
                    onSelectRuntime={(instanceId) => onSelectEntity(`provider/${instanceId}`)}
                    onSelectAgent={(agentId) => onSelectEntity(`agent/${agentId}`)}
                    onFocusGraph={onFocusGraph}
                  />
                </>
              ) : (
                <Empty>{t("agentRuntime.loading")}</Empty>
              )
            ) : selectedAgent !== null ? (
              <DegradedEntityCard
                kind="agent"
                row={selectedAgent}
                settingsRefs={settingsRoleRefs(settings.data?.values, selectedAgent.id)}
                referencingSquads={squads.filter(
                  (squad) => squad.leader === selectedAgent.id || squad.workers.includes(selectedAgent.id),
                )}
                onRedeclare={() => setDialog({ kind: "new-entity", entity: "agent", initialId: selectedAgent.id })}
                onSelectSquad={(squadId) => onSelectEntity(`squad/${squadId}`)}
              />
            ) : null
          ) : selectedSquad !== null && isAvailableSquadEntityRow(selectedSquad) ? (
            squadDetail.data ? (
              <>
                <SquadConclusion squad={selectedSquad} lastDispatch={dockRows[0] ?? null} />
                <SquadCockpit
                  squad={squadDetail.data}
                  rows={dockRows.filter((row) => row.squadId === current.id)}
                  busy={workspace.busy}
                  onLaunch={() => void openSquadDispatch(current.id)}
                  onOpenSession={(runtimeSessionId) => onSelectEntity(`session/${runtimeSessionId}`)}
                />
                <SquadCard
                  detail={squadDetail.data}
                  agents={agents}
                  busy={workspace.busy}
                  actionError={workspace.error}
                  onSave={(declaration) => void workspace.saveSquad(declaration)}
                  onSelectAgent={(agentId) => onSelectEntity(`agent/${agentId}`)}
                  onSelectSquad={(squadId) => onSelectEntity(`squad/${squadId}`)}
                />
              </>
            ) : (
              <Empty>{t("agentRuntime.loading")}</Empty>
            )
          ) : selectedSquad !== null ? (
            <DegradedEntityCard
              kind="squad"
              row={selectedSquad}
              settingsRefs={[]}
              referencingSquads={[]}
              onRedeclare={() => setDialog({ kind: "new-entity", entity: "squad", initialId: selectedSquad.id })}
              onSelectSquad={(squadId) => onSelectEntity(`squad/${squadId}`)}
            />
          ) : null}
        </main>
        {inspector && current !== null && (
          <IdentityInspector
            selection={current}
            agents={agents}
            squads={squads}
            rows={dockRows}
            onSelect={(selection) => onSelectEntity(runtimeSelectionRef(selection))}
            onOpenSession={(runtimeSessionId) => onSelectEntity(`session/${runtimeSessionId}`)}
          />
        )}
      </CatalogSplit>
      {dialog?.kind === "new-entity" && (
        <NewEntityDialog
          kind={dialog.entity}
          agents={agents}
          squads={squads}
          busy={workspace.busy}
          actionError={workspace.error}
          initialId={dialog.initialId}
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
          onPreview={(request) => workspace.preview(request)}
        />
      )}
      {workspace.settlement && (
        <p
          role="status"
          className="shrink-0 border-t border-border px-3.5 py-1 font-mono ui-meta
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

/** 可用 Agent 的详情结论行(标准 §2.2:结论在上,声明字段在下)。 */
function EntityConclusion({
  refs,
  squads,
  agentId,
  declaredRole,
  lastDispatch,
}: {
  readonly refs: readonly SettingsRoleRef[];
  readonly squads: readonly { readonly id: string; readonly name: string; readonly leader: string }[];
  readonly agentId: string;
  readonly declaredRole: "worker" | "reviewer" | "commander";
  readonly lastDispatch: {
    readonly status: string;
    readonly taskTitle: string | null;
    readonly startedAt: string;
  } | null;
}) {
  // 声明角色与被当作什么角色调用:设置键(defaultWorker/…)与 Squad 位次是两处调用面;
  // 声明与调用不一致时用琥珀标签点出,一致的引用不额外强调。
  const calledAs: readonly { readonly label: string; readonly role: "worker" | "reviewer" | "commander" }[] = [
    ...refs.map((ref) => ({ label: `roles.${ref.key}`, role: ref.role })),
    ...squads.map((squad) => ({
      label: squad.name,
      role: squad.leader === agentId ? ("commander" as const) : ("worker" as const),
    })),
  ];
  const mismatch = calledAs.some((call) => call.role !== declaredRole);
  return (
    <section
      data-testid="agent-detail-conclusion"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xs border border-border bg-surface px-3.5 py-2"
    >
      <StatusTagLine tone="done" label={t("agentRuntime.detailAvailable")} />
      <span className="flex items-center gap-1.5 ui-meta">
        {t("agentRuntime.declaredRole")}
        <RoleLabel role={declaredRole} />
      </span>
      <span className="flex flex-wrap items-center gap-1.5 ui-meta text-text-muted">
        {calledAs.length === 0 ? (
          t("agentRuntime.notReferenced")
        ) : (
          <>
            {t("agentRuntime.calledAsPrefix")}
            {calledAs.map((call) => (
              <span key={call.label} className="flex items-center gap-1 rounded-xs border border-border px-1.5 py-px">
                <span className="font-mono ui-meta">{call.label}</span>
                <span className="ui-meta text-text-faint">· {roleWord(call.role)}</span>
              </span>
            ))}
          </>
        )}
      </span>
      {mismatch ? (
        <StatusTagLine
          tone="wait"
          label={t("agentRuntime.roleMismatch", {
            declared: roleWord(declaredRole),
            called: roleWord(calledAs.find((call) => call.role !== declaredRole)!.role),
          })}
        />
      ) : null}
      <span className="ml-auto font-mono ui-meta text-text-faint">
        {lastDispatch === null
          ? t("agentRuntime.noDispatch")
          : t("agentRuntime.lastDispatch", {
              status: lastDispatch.status,
              task: lastDispatch.taskTitle ?? "",
              time: formatTime(lastDispatch.startedAt, { style: "month-day-time" }) ?? lastDispatch.startedAt,
            })}
      </span>
    </section>
  );
}

/** 可用 Squad 的详情结论行:成员规模与最近一次派工。 */
function SquadConclusion({
  squad,
  lastDispatch,
}: {
  readonly squad: {
    readonly id: string;
    readonly name: string;
    readonly leader: string;
    readonly workers: readonly string[];
  };
  readonly lastDispatch: {
    readonly status: string;
    readonly taskTitle: string | null;
    readonly startedAt: string;
  } | null;
}) {
  return (
    <section
      data-testid="squad-detail-conclusion"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xs border border-border bg-surface px-3.5 py-2"
    >
      <StatusTagLine tone="done" label={t("agentRuntime.detailAvailable")} />
      <span className="ui-meta text-text-muted">
        {t("agentRuntime.memberCount", { count: squad.workers.length + 1 })}
      </span>
      <span className="ml-auto font-mono ui-meta text-text-faint">
        {lastDispatch === null
          ? t("agentRuntime.noDispatch")
          : t("agentRuntime.lastDispatch", {
              status: lastDispatch.status,
              task: lastDispatch.taskTitle ?? "",
              time: formatTime(lastDispatch.startedAt, { style: "month-day-time" }) ?? lastDispatch.startedAt,
            })}
      </span>
    </section>
  );
}

function StatusTagLine({
  tone,
  label,
  children,
}: {
  readonly tone: StatusTone;
  readonly label: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2 ui-meta text-text-muted">
      <StatusTag tone={tone} label={label} />
      {children}
    </span>
  );
}

const roleWord = (role: "worker" | "reviewer" | "commander"): string =>
  t(
    role === "commander"
      ? "agentRuntime.roleCommander"
      : role === "reviewer"
        ? "agentRuntime.roleReviewer"
        : "agentRuntime.roleWorker",
  );

const ROLE_REF_KEYS = [
  { key: "defaultWorker", role: "worker" },
  { key: "defaultCommander", role: "commander" },
  { key: "defaultReviewer", role: "reviewer" },
] as const;

/** 设置读面(values.roles)里引用该实体 id 的角色键——业主关心的「被当作什么角色调用」。 */
function settingsRoleRefs(values: Readonly<Record<string, unknown>> | undefined, entityId: string): SettingsRoleRef[] {
  const roles = values?.roles as Partial<Record<(typeof ROLE_REF_KEYS)[number]["key"], string | null>> | undefined;
  if (roles === undefined) return [];
  return ROLE_REF_KEYS.filter(({ key }) => roles[key] === entityId).map(({ key, role }) => ({ key, role }));
}
