import { useState } from "react";
import { t } from "../i18n/index.tsx";
import { Badge, Btn, Empty } from "../components/runtime/parts.tsx";
import { SessionRail } from "../components/runtime/RuntimeRail.tsx";
import { SessionInspector } from "../components/runtime/RuntimeInspector.tsx";
import { SessionsPanel } from "../components/runtime/SessionsPanel.tsx";
import { runtimeDockLiveCount, type RuntimePanoramaTask } from "../runtime-panorama.ts";
import { runtimeSelectionFromRef, useSessionsWorkspace } from "../components/runtime/useRuntimeWorkspace.ts";

// 会话入口(W6 IA 拆分):「运行时」组的一级工作区,只装 session 一类实体。rail 按
// 执行者(agent/squad/未归属)分组;主区是会话详情;inspector 是同执行者的兄弟会话
// 与 task 出口。选择是可寻址的(session/<id>,经 entityRoutes 推栈,导航回撤原路返回),
// 进入页面未指定时落在最新一条(panorama 已把 running 排前)。数据只有 overview 与
// 收窄后的 dispatch 全景(W6:runtimePanoramaTasks 不退回全量查询)。
export function SessionsView({ repoId, tasks, focusedEntityRef, onSelectEntity, onOpenTask }: {
  readonly repoId: string; readonly tasks: readonly RuntimePanoramaTask[]; readonly focusedEntityRef: string |
  null; readonly onSelectEntity: (ref: string) => void; readonly onOpenTask: (taskId: string) => void }) {
  const workspace = useSessionsWorkspace(repoId, tasks);
  const [inspector, setInspector] = useState(true);
  const rows = workspace.dockRows;
  const refSelection = runtimeSelectionFromRef(focusedEntityRef);
  // 深链指向的会话可能已不在投影里:存在才采用,否则回落最新一条(panorama 已把
  // running 排前)——派生选择,不写回导航栈。
  const selectedId = refSelection?.type === "session" && rows.some((row) => row.runtimeSessionId ===
    refSelection.id) ? refSelection.id : rows[0]?.runtimeSessionId ?? null;
  const row = selectedId === null ? null : rows.find((candidate) => candidate.runtimeSessionId === selectedId) ?? null;
  const live = runtimeDockLiveCount(rows);
  return <section data-testid="sessions-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3.5">
      <b className="text-[13px] tracking-[0.02em]">{t("agentRuntime.sessionsTitle")}</b><span
        className="truncate font-mono text-[10.5px] text-text-faint">{t("agentRuntime.sessionsSubtitle")}</span>
      <span className="flex-1" />
      <Badge status={live > 0 ? "active" : "planned"}>{t("agentRuntime.liveSessions", { count: live })}</Badge>
      <Btn size="sm" variant="ghost" onClick={() => setInspector(!inspector)}
        tip={t("agentRuntime.toggleInspector")}>▐</Btn>
    </header>
    {workspace.overview.error && <p role="alert" data-testid="runtime-read-error"
      className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono text-[11px]
        text-status-blocked">{t("agentRuntime.readFailed", { error: workspace.overview.error instanceof Error ?
          workspace.overview.error.message : String(workspace.overview.error) })}</p>}
    {(workspace.error ?? workspace.feedback) && <p role="status" onClick={workspace.clearFeedback}
      className={`shrink-0 border-b border-border px-3.5 py-1.5 font-mono text-[11px] ${workspace.error ?
        "bg-status-blocked/10 text-status-blocked" : "text-text-muted"}`}>{workspace.error ?? workspace.feedback}</p>}
    <div className="flex min-h-0 flex-1">
      <SessionRail sessions={rows} selectedId={selectedId} onSelect={(runtimeSessionId) =>
        onSelectEntity(`session/${runtimeSessionId}`)} />
      <main className="min-w-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
        {selectedId === null
          ? <Empty>{t(workspace.overview.isPending ? "agentRuntime.loading" : "agentRuntime.noSessions")}</Empty>
          : <SessionsPanel repoId={repoId} runtimeSessionId={selectedId} row={row} busy={workspace.busy}
            onCancel={(runtimeSessionId) => void workspace.cancelSession(runtimeSessionId)} onOpenTask={onOpenTask}
            onNavigateEntity={onSelectEntity} />}
      </main>
      {inspector && <SessionInspector row={row} rows={rows} onSelectSession={(runtimeSessionId) =>
        onSelectEntity(`session/${runtimeSessionId}`)} onOpenTask={onOpenTask} onSelectEntity={onSelectEntity} />}
    </div>
  </section>;
}
