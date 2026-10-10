import { useState, type CSSProperties, type ReactNode } from "react";
import { isAvailableAgentEntityRow } from "../agent-entity-client.ts";
import { t } from "../i18n/index.tsx";
import { ActionError } from "../components/runtime/ActionError.tsx";
import { CapDot, Hint } from "../components/runtime/parts.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { NewRuntimeDialog } from "../components/runtime/NewRuntimeDialog.tsx";
import { orderProviderRows, ProviderRail } from "../components/runtime/RuntimeRail.tsx";
import { ProviderInspector } from "../components/runtime/RuntimeInspector.tsx";
import { RuntimeCard } from "../components/runtime/RuntimeCard.tsx";
import { CatalogBackButton, CatalogSplit, useCatalogDetailPane } from "../components/primitives/CatalogSplit.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { runtimeAuthPresentation } from "../runtime-auth-presentation.ts";
import { runtimeSelectionFromRef, useProviderWorkspace } from "../components/runtime/useRuntimeWorkspace.ts";
import { useSettingsMutation, useSettingsQuery } from "../settings-data.ts";

// Provider 入口(W6 IA 拆分):承运者(Runtime 实例)的完整工作区——目录 rail、
// 实例卡片(编辑/auth/self-test/权限/删除)与右栏 health。live 计数取 overview 的
// session liveness(daemon 自己的在跑投影),这一页不读 dispatch 台账。跨页出口:
// 兼容 Agent chips → Agent 入口,相关会话 → 会话入口;均为可寻址路由。
//
// 功能体是 ProvidersWorkspace(task_48fe291624e06a2e9ad9496c81 起与工作台 Provider
// 面板共用):页面经 renderHeader 装上 PageHeader(标题 + 状态点图例 + 检查器开关),
// 工作台面板不带头部——面板标签即标题。
export interface ProvidersViewProps {
  readonly repoId: string;
  readonly focusedEntityRef: string | null;
  readonly onSelectEntity: (ref: string) => void;
}

/** 页头插槽:主动作(检查器开关)由工作区实况派生,页面/面板各自决定要不要装。 */
export interface ProvidersHeaderSlot {
  readonly headerActions: ReactNode;
}

export function ProvidersView(props: ProvidersViewProps) {
  return (
    <ProvidersWorkspace
      {...props}
      renderHeader={({ headerActions }) => (
        <PageHeader
          title={t("agentRuntime.providersTitle")}
          note={t("agentRuntime.providersSubtitle")}
          actions={
            <>
              {/* 图例解释左列状态点的含义,随视图开关放页头右侧。 */}
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 ui-micro text-text-muted">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  <CapDot size={10} state="full" tip={t("agentRuntime.legendReadyTip")} />
                  {t("agentRuntime.legendReady")}
                </span>
                <span className="flex items-center gap-1 whitespace-nowrap">
                  <CapDot size={10} state="part" tip={t("agentRuntime.legendPartialTip")} />
                  {t("agentRuntime.legendPartial")}
                </span>
                <span className="flex items-center gap-1 whitespace-nowrap">
                  <CapDot size={10} state="none" tip={t("agentRuntime.legendBlockedTip")} />
                  {t("agentRuntime.legendBlocked")}
                </span>
              </span>
              {headerActions}
            </>
          }
        />
      )}
    />
  );
}

export function ProvidersWorkspace({
  repoId,
  focusedEntityRef,
  onSelectEntity,
  renderHeader,
}: ProvidersViewProps & {
  /** 页面组合的页头渲染;工作台面板不传(面板标签即标题)。 */
  readonly renderHeader?: (slot: ProvidersHeaderSlot) => ReactNode;
}) {
  const refSelection = runtimeSelectionFromRef(focusedEntityRef);
  const refId = refSelection?.type === "runtime" ? refSelection.id : null;
  // 窄容器(内容区 <720px,styles.css .catalog-split)的单列形态:目录全宽、点行进详情、
  // 返回键回目录;宽容器常驻双栏,该状态不参与。深链/跨页实体跳转视为一次点行。
  const narrow = useCatalogDetailPane(refId);
  const workspace = useProviderWorkspace(repoId, refId);
  const settings = useSettingsQuery(repoId),
    settingsMutation = useSettingsMutation(repoId);
  const [dialog, setDialog] = useState(false),
    [inspector, setInspector] = useState(true);
  const installations = workspace.machine.data?.installations ?? [];
  const instances = workspace.instances;
  // 深链指向的实例可能已被删除(或仍在读取):存在才采用,否则回落目录首项(异常置顶后的
  // 第一项,标准 §2.5)——派生选择,不写回导航栈。
  const selectedId =
    refId !== null && instances.some((candidate) => candidate.instanceId === refId)
      ? refId
      : (orderProviderRows(instances, workspace.authProbeStates)[0]?.instance.instanceId ?? null);
  const instance =
    selectedId === null ? null : (instances.find((candidate) => candidate.instanceId === selectedId) ?? null);
  const allowedInstances = Array.isArray(settings.data?.settings.runtime?.allowedInstances)
    ? settings.data.settings.runtime.allowedInstances
    : [];
  const settingsExpectedVersion =
    settings.data?.lastChanged === "initial" || settings.data === undefined ? 0 : settings.data.lastChanged.revision;
  const updateProjectAllowedInstances = (instanceId: string, allowed: boolean) => {
    const current =
      settings.data?.settings.runtime?.allowedInstances ??
      instances.filter((row) => row.enabled).map((row) => row.instanceId);
    return settingsMutation.mutate({
      runtimeAllowedInstances: allowed
        ? [...new Set([...current, instanceId])]
        : current.filter((id) => id !== instanceId),
      expectedVersion: settingsExpectedVersion,
    });
  };
  const liveSessions = selectedId === null ? 0 : (workspace.liveByInstance.get(selectedId) ?? 0);
  const carrierSessions =
    workspace.overview.data?.sessions.filter((session) => session.instanceId === selectedId) ?? [];
  const headerActions = (
    <Button size="sm" variant="ghost" onClick={() => setInspector(!inspector)} tip={t("agentRuntime.toggleInspector")}>
      ▐
    </Button>
  );
  return (
    <section data-testid="providers-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {renderHeader !== undefined ? renderHeader({ headerActions }) : null}
      {workspace.machine.error && (
        <p
          role="alert"
          data-testid="runtime-read-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono ui-micro
        text-status-blocked"
        >
          {t("agentRuntime.readFailed", {
            error:
              workspace.machine.error instanceof Error
                ? workspace.machine.error.message
                : String(workspace.machine.error),
          })}
        </p>
      )}
      {workspace.feedback && !workspace.error && (
        <p
          role="status"
          onClick={workspace.clearFeedback}
          className="shrink-0 border-b border-border px-3.5 py-1.5 font-mono ui-micro text-text-muted"
        >
          {workspace.feedback}
        </p>
      )}
      <CatalogSplit detailOpen={narrow.detailOpen}>
        <ProviderRail
          instances={instances}
          authProbeStates={workspace.authProbeStates}
          selectedId={selectedId}
          liveByInstance={workspace.liveByInstance}
          onSelect={(instanceId) => {
            onSelectEntity(`provider/${instanceId}`);
            narrow.openDetail();
          }}
          onNew={() => setDialog(true)}
        />
        <main
          data-testid="providers-detail"
          data-pane="detail"
          className="min-w-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6"
        >
          <CatalogBackButton testId="providers-back-to-list" onBack={narrow.backToList} />
          {instance === null ? (
            <>
              {workspace.error ? <ActionError>{workspace.error}</ActionError> : null}
              <Empty>{t(workspace.machine.isPending ? "agentRuntime.loading" : "agentRuntime.emptyProviders")}</Empty>
            </>
          ) : (
            <>
              <ProviderConclusion
                instance={instance}
                liveSessions={liveSessions}
                compatibleAgents={
                  (workspace.agents.data ?? [])
                    .filter(isAvailableAgentEntityRow)
                    .filter((agent) => agent.runtimes.some((runtime) => runtime.type === instance.kindId)).length
                }
                authProbeState={workspace.authProbeStates.get(instance.instanceId)}
              />
              <RuntimeCard
                instance={instance}
                installations={installations}
                authProbeState={workspace.authProbeStates.get(instance.instanceId)}
                agents={(workspace.agents.data ?? []).filter(isAvailableAgentEntityRow)}
                liveSessions={liveSessions}
                busy={workspace.busy}
                actionError={workspace.error}
                onSelectAgent={(agentId) => onSelectEntity(`agent/${agentId}`)}
                onSelectRuntime={(instanceId) => onSelectEntity(`provider/${instanceId}`)}
                onAuth={(action) => void workspace.authInstance(instance.instanceId, action)}
                onValidate={() => void workspace.validateInstance(instance.instanceId)}
                onSetEnabled={(enabled) => {
                  void workspace.setInstanceEnabled(instance.instanceId, enabled).then((result) => {
                    if (enabled && result) updateProjectAllowedInstances(instance.instanceId, true);
                  });
                }}
                projectAllowed={allowedInstances.includes(instance.instanceId)}
                onSetProjectAllowed={(allowed) => updateProjectAllowedInstances(instance.instanceId, allowed)}
                onUpdate={workspace.updateInstance}
                onDelete={() => {
                  void workspace.deleteInstance(instance.instanceId);
                }}
                onSelfTest={(model) => workspace.selfTest(instance.instanceId, model)}
              />
            </>
          )}
        </main>
        {inspector && (
          <ProviderInspector
            instance={instance}
            probeState={selectedId === null ? undefined : workspace.authProbeStates.get(selectedId)}
            sessions={carrierSessions}
            onOpenSession={(runtimeSessionId) => onSelectEntity(`session/${runtimeSessionId}`)}
          />
        )}
      </CatalogSplit>
      {dialog && (
        <NewRuntimeDialog
          installations={installations}
          existingInstanceIds={instances.map((row) => row.instanceId)}
          busy={workspace.busy}
          actionError={workspace.error}
          onCancel={() => setDialog(false)}
          onCreate={(input) => {
            void workspace.createInstance(input).then((created) => {
              if (created) {
                setDialog(false);
                updateProjectAllowedInstances(input.instanceId, true);
                onSelectEntity(`provider/${input.instanceId}`);
              }
            });
          }}
        />
      )}
      {workspace.settlement && (
        <p
          role="status"
          className="shrink-0 border-t border-border px-3.5 py-1 font-mono ui-micro
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

/** Provider 目录详情结论(标准 §2.5):先说明能否派工、谁在用和现在是否有运行。 */
function ProviderConclusion({
  instance,
  authProbeState,
  liveSessions,
  compatibleAgents,
}: {
  readonly instance: Parameters<typeof runtimeAuthPresentation>[0];
  readonly authProbeState: Parameters<typeof runtimeAuthPresentation>[1];
  readonly liveSessions: number;
  readonly compatibleAgents: number;
}) {
  const auth = runtimeAuthPresentation(instance, authProbeState);
  // 已停用是人为关掉、不是出错:中性档;只有不可达才吃红档与红竖线。
  const disabled = !instance.enabled,
    unreachable = instance.enabled && auth.cap === "none";
  return (
    <section
      data-testid="provider-detail-conclusion"
      className="status-edge relative mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xs border border-border bg-surface px-3.5 py-2"
      style={unreachable ? ({ "--status-edge": "var(--color-status-blocked)" } as CSSProperties) : undefined}
    >
      <StatusTag
        tone={disabled ? "neutral" : unreachable ? "bad" : auth.cap === "part" ? "wait" : "neutral"}
        label={t(
          !instance.enabled
            ? "agentRuntime.providerDisabledTag"
            : auth.cap === "none"
              ? "agentRuntime.providerUnreachable"
              : auth.cap === "part"
                ? "agentRuntime.providerNotChecked"
                : "agentRuntime.providerUsable",
        )}
      />
      <span className="ui-meta text-text-muted">{t("agentRuntime.providerUsedBy", { count: compatibleAgents })}</span>
      <span className="font-mono ui-micro text-text-faint">
        {liveSessions > 0 ? t("agentRuntime.liveSessions", { count: liveSessions }) : t("agentRuntime.idle")}
      </span>
    </section>
  );
}
