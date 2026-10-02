import { useState } from "react";
import type { TaskRow } from "../../model/types.ts";
import { AdaptersView } from "../../views/AdaptersView.tsx";
import { AgentSquadView } from "../../views/AgentSquadView.tsx";
import { DaemonObserveView } from "../../views/DaemonObserveView.tsx";
import { EntitiesView } from "../../views/EntitiesView.tsx";
import { IdentityAccessView } from "../../views/IdentityAccessView.tsx";
import { PresetsView } from "../../views/PresetsView.tsx";
import { SettingsView } from "../../views/SettingsView.tsx";
import { SystemView } from "../../views/SystemView.tsx";
import { TokenUsageView } from "../../views/TokenUsageView.tsx";
import { PanelActionStrip, usePanelLocalSelection, type WorkbenchPanelProps } from "../workbench-panels.tsx";

/**
 * 系统域面板(实体/预设/引擎适配器/Agent·Squad/Token/系统/Daemon观察/设置/账号访问控制):
 * 各页功能体 + 自带读面(按 repoId,与页面共享缓存键)进面板。页头的主动作
 * (新建 kind/重读快照/刷新守护进程/范围切换/检查器开关)保留在面板动作条;
 * agent/squad、tokenAgent/tokenSquad、entitydoc/<kind> 的选择归面板本地。
 */

/** 实体面板:实体目录 + 详情;entitydoc/<kind> 深链归面板,声明实体 ref 走全局路由。 */
export function EntitiesPanel(props: WorkbenchPanelProps) {
  const { localRef, setLocalRef } = usePanelLocalSelection(entitiesPanelRef, props.onNavigateEntity);
  return (
    <div className="h-full min-h-0" data-testid="workbench-entities-panel">
      <EntitiesView
        repoId={props.repoId}
        focusedRef={localRef}
        onOpenEntityDoc={(kind) => setLocalRef(`entitydoc/${kind}`)}
        onOpenEntityRef={props.onNavigateEntity}
        onExitDetail={() => setLocalRef(null)}
        onOpenView={props.onOpenView}
        projectName={props.projectName}
        renderHeader={({ newKindAction }) => <PanelActionStrip>{newKindAction}</PanelActionStrip>}
      />
    </div>
  );
}

const entitiesPanelRef = (ref: string): boolean => ref.startsWith("entitydoc/");

/** 预设面板:预设目录 + 整页详情;preset/<id> 深链归面板,重读主动作保留。 */
export function PresetsPanel(props: WorkbenchPanelProps) {
  const [presetId, setPresetId] = useState<string | null>(null);
  return (
    <div className="h-full min-h-0" data-testid="workbench-presets-panel">
      <PresetsView
        repoId={props.repoId}
        focusedPresetId={presetId}
        onOpenPreset={setPresetId}
        onExitDetail={() => setPresetId(null)}
        projectName={props.projectName}
        renderHeader={({ rereadAction }) => <PanelActionStrip>{rereadAction}</PanelActionStrip>}
      />
    </div>
  );
}

/** 适配器面板:引擎适配器目录页原样进面板(纯只读目录,无动作)。 */
export function AdaptersPanel({ repoId, tasks }: { readonly repoId: string; readonly tasks: readonly TaskRow[] }) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-adapters-panel">
      <AdaptersView repoId={repoId} tasks={tasks} renderHeader={() => null} />
    </div>
  );
}

/** Agent·Squad 面板:agent/<id>、squad/<id> 选择归面板;其余引用走全局路由。 */
export function AgentSquadPanel(props: WorkbenchPanelProps) {
  const { localRef, selectEntity } = usePanelLocalSelection(agentSquadPanelRef, props.onNavigateEntity);
  return (
    <div className="h-full min-h-0" data-testid="workbench-agent-squad-panel">
      <AgentSquadView
        repoId={props.repoId}
        tasks={props.tasks.map(({ taskId, title, activeExecutionId }) => ({
          taskId,
          title,
          heldLease: activeExecutionId !== undefined,
        }))}
        focusedEntityRef={localRef}
        onSelectEntity={selectEntity}
        onFocusGraph={props.onFocusGraph}
        renderHeader={({ headerActions }) => <PanelActionStrip>{headerActions}</PanelActionStrip>}
      />
    </div>
  );
}

const agentSquadPanelRef = (ref: string): boolean => ref.startsWith("agent/") || ref.startsWith("squad/");

/** Token 面板:范围切换保留在面板动作条;tokenAgent/tokenSquad 成员详情归面板本地。 */
export function TokenUsagePanel(props: WorkbenchPanelProps) {
  const { localRef, setLocalRef, selectEntity } = usePanelLocalSelection(tokenPanelRef, props.onNavigateEntity);
  return (
    <div className="h-full min-h-0" data-testid="workbench-token-usage-panel">
      <TokenUsageView
        repoId={props.repoId}
        focusedEntityRef={localRef}
        onFocusMember={setLocalRef}
        onSelectEntity={selectEntity}
        onOpenTask={props.onOpenTask}
        renderHeader={({ rangeControl }) => <PanelActionStrip>{rangeControl}</PanelActionStrip>}
      />
    </div>
  );
}

const tokenPanelRef = (ref: string): boolean => ref.startsWith("tokenAgent/") || ref.startsWith("tokenSquad/");

/** 系统面板:守护进程状态 + 仓库表;刷新主动作保留,观察详情出口离开工作台。 */
export function SystemPanel(props: WorkbenchPanelProps) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-system-panel">
      <SystemView
        activeRepoId={props.activeRepoId}
        onOpenObserve={props.onOpenObserve}
        onNavigateEntity={props.onNavigateEntity}
        renderHeader={({ refreshAction }) => <PanelActionStrip>{refreshAction}</PanelActionStrip>}
      />
    </div>
  );
}

/** Daemon 观察面板:当前仓的两栏实况(事件流 + 日志流);面板内无返回钮(页头卸下)。 */
export function DaemonObservePanel(props: WorkbenchPanelProps) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-daemon-observe-panel">
      <DaemonObserveView
        repoId={props.activeRepoId}
        repos={props.repos}
        onBack={() => undefined}
        onNavigateEntity={props.onNavigateEntity}
        renderHeader={() => null}
      />
    </div>
  );
}

/** 设置面板:设置页功能体(左组导航 + 分区面板);「打开项目」离开工作台切仓。 */
export function SettingsPanel(props: WorkbenchPanelProps) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-settings-panel">
      <SettingsView
        repoId={props.activeRepoId}
        repos={props.repos}
        onOpenProject={props.onOpenProject}
        renderHeader={() => null}
      />
    </div>
  );
}

/** 账号访问控制面板:与页面同构的 Tab 壳(Electron 主进程桥,非桌面环境如实提示)。 */
export function IdentityAccessPanel(props: WorkbenchPanelProps) {
  return (
    <div className="h-full min-h-0" data-testid="workbench-identity-access-panel">
      <IdentityAccessView repos={props.repos} repoId={props.activeRepoId ?? undefined} renderHeader={() => null} />
    </div>
  );
}
