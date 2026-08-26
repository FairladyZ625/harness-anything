import { useState } from "react";
import { t } from "../i18n/index.tsx";
import { Btn, CapDot, Empty, Hint } from "../components/runtime/parts.tsx";
import { NewRuntimeDialog } from "../components/runtime/NewRuntimeDialog.tsx";
import { ProviderRail } from "../components/runtime/RuntimeRail.tsx";
import { ProviderInspector } from "../components/runtime/RuntimeInspector.tsx";
import { RuntimeCard } from "../components/runtime/RuntimeCard.tsx";
import { runtimeSelectionFromRef, useProviderWorkspace } from "../components/runtime/useRuntimeWorkspace.ts";

// Provider 入口(W6 IA 拆分):承运者(Runtime 实例)的完整工作区——目录 rail、
// 实例卡片(编辑/auth/self-test/权限/删除)与右栏 health。live 计数取 overview 的
// session liveness(daemon 自己的在跑投影),这一页不读 dispatch 台账。跨页出口:
// 兼容 Agent chips → Agent 入口,相关会话 → 会话入口;均为可寻址路由。
export function ProvidersView({ repoId, focusedEntityRef, onSelectEntity }: { readonly repoId: string;
  readonly focusedEntityRef: string | null; readonly onSelectEntity: (ref: string) => void }) {
  const refSelection = runtimeSelectionFromRef(focusedEntityRef);
  const refId = refSelection?.type === "runtime" ? refSelection.id : null;
  const workspace = useProviderWorkspace(repoId, refId);
  const [dialog, setDialog] = useState(false), [inspector, setInspector] = useState(true);
  const installations = workspace.machine.data?.installations ?? [];
  const instances = workspace.instances;
  // 深链指向的实例可能已被删除(或仍在读取):存在才采用,否则回落首项——派生选择,
  // 不写回导航栈。
  const selectedId = refId !== null && instances.some((candidate) => candidate.instanceId === refId) ?
    refId : instances[0]?.instanceId ?? null;
  const instance = selectedId === null ? null : instances.find((candidate) => candidate.instanceId ===
    selectedId) ?? null;
  const liveSessions = selectedId === null ? 0 : workspace.liveByInstance.get(selectedId) ?? 0;
  const carrierSessions = workspace.overview.data?.sessions.filter((session) => session.instanceId ===
    selectedId) ?? [];
  return <section data-testid="providers-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3.5">
      <b className="text-[13px] tracking-[0.02em]">{t("agentRuntime.providersTitle")}</b><span
        className="truncate font-mono text-[10.5px] text-text-faint">{t("agentRuntime.providersSubtitle")}</span>
      <span className="flex-1" />
      <span className="flex items-center gap-2.5 whitespace-nowrap text-[11px] text-text-muted"><span
        className="flex items-center gap-1"><CapDot size={10} state="full"
        tip={t("agentRuntime.legendReadyTip")} />{t("agentRuntime.legendReady")}</span><span
        className="flex items-center gap-1"><CapDot size={10} state="part"
        tip={t("agentRuntime.legendPartialTip")} />{t("agentRuntime.legendPartial")}</span><span
        className="flex items-center gap-1"><CapDot size={10} state="none"
        tip={t("agentRuntime.legendBlockedTip")} />{t("agentRuntime.legendBlocked")}</span></span>
      <Btn size="sm" variant="ghost" onClick={() => setInspector(!inspector)}
        tip={t("agentRuntime.toggleInspector")}>▐</Btn>
    </header>
    {workspace.machine.error && <p role="alert" data-testid="runtime-read-error"
      className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono text-[11px]
        text-status-blocked">{t("agentRuntime.readFailed", { error: workspace.machine.error instanceof Error ?
          workspace.machine.error.message : String(workspace.machine.error) })}</p>}
    {(workspace.error ?? workspace.feedback) && <p role="status" onClick={workspace.clearFeedback}
      className={`shrink-0 border-b border-border px-3.5 py-1.5 font-mono text-[11px] ${workspace.error ?
        "bg-status-blocked/10 text-status-blocked" : "text-text-muted"}`}>{workspace.error ?? workspace.feedback}</p>}
    <div className="flex min-h-0 flex-1">
      <ProviderRail instances={instances} authProbeStates={workspace.authProbeStates}
        selectedId={selectedId} liveByInstance={workspace.liveByInstance} onSelect={(instanceId) =>
        onSelectEntity(`provider/${instanceId}`)} onNew={() => setDialog(true)} />
      <main className="min-w-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
        {instance === null ? <Empty>{t(workspace.machine.isPending ? "agentRuntime.loading" :
          "agentRuntime.emptyProviders")}</Empty>
          : <RuntimeCard instance={instance} installations={installations}
            authProbeState={workspace.authProbeStates.get(instance.instanceId)}
            agents={workspace.agents.data ?? []} liveSessions={liveSessions} busy={workspace.busy}
              onSelectAgent={(agentId) => onSelectEntity(`agent/${agentId}`)} onSelectRuntime={(instanceId) =>
              onSelectEntity(`provider/${instanceId}`)} onAuth={(action) => void
                workspace.authInstance(instance.instanceId, action)} onValidate={() => void
                workspace.validateInstance(instance.instanceId)}
              onSetEnabled={(enabled) => void workspace.setInstanceEnabled(instance.instanceId,
                enabled)} onUpdate={(input) => void workspace.updateInstance(input)} onDelete={() => {
                void workspace.deleteInstance(instance.instanceId); }} onSelfTest={(model) =>
                workspace.selfTest(instance.instanceId, model)} />}
      </main>
      {inspector && <ProviderInspector instance={instance} probeState={selectedId === null ? undefined :
        workspace.authProbeStates.get(selectedId)} sessions={carrierSessions}
        onOpenSession={(runtimeSessionId) => onSelectEntity(`session/${runtimeSessionId}`)} />}
    </div>
    {dialog && <NewRuntimeDialog installations={installations} existingInstanceIds={instances.map((row) =>
      row.instanceId)} busy={workspace.busy} onCancel={() => setDialog(false)} onCreate={(input) => {
      void workspace.createInstance(input).then((created) => { if (created) { setDialog(false);
      onSelectEntity(`provider/${input.instanceId}`); } }); }} />}
    {workspace.settlement && <p role="status"
      className="shrink-0 border-t border-border px-3.5 py-1 font-mono text-[10.5px]
        text-text-faint"><Hint>{workspace.settlement.state} · {workspace.settlement.opId} ·
          {workspace.settlement.hint}</Hint></p>}
  </section>;
}
