import { useMemo, useState } from "react";
import type { DecisionRow, Project, RelationEdge, SnapshotStatus, TaskRow } from "../model/types";
import { Card } from "../components/overview/parts";
import { DecisionStream } from "../components/overview/DecisionStream.tsx";
import { TaskStream } from "../components/overview/TaskStream.tsx";
import { PinnedStream } from "../components/overview/PinnedStream.tsx";
import { OverviewStatsBar, type OverviewStatsAnomaly } from "../components/overview/OverviewStatsBar.tsx";
import { DecisionPreviewDrawer } from "../components/DecisionPreviewDrawer.tsx";
import { decisionStateLabel } from "../components/badges";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import { t } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import type { WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import type { AgendaSuccess } from "../api-client.ts";

const timeOf = (iso: string) => formatTime(iso, { style: "time" }) ?? "—";

/**
 * 总览 = 三条流(2026-08-21 泽宇反馈重构;2026-08-31 收纳后运行时健康移出主区):
 * 决策流 / 任务流 / Pin 在做。系统运行状态(事件水位、刷新、健康)常驻侧栏左下角,
 * 本页不再占一行渲染近乎全空的健康区块,腾出的高度归决策流/任务流。
 * 交互规则:点击先开抽屉不跳页;状态切换是就地筛选;时间倒序;
 * 「去批准 / 去看板」是仅有的显式路由出口。
 */
export function OverviewView({
  project,
  tasks,
  agenda,
  decisions,
  workspaceSummary,
  relations,
  health,
  daemonReadFailed,
  ledgerRevision,
  onSelect,
  onNavigateEntity,
  onDrill,
  onOpenInbox,
  onOpenDecision,
  onSetPin,
  onDecisionPreviewChange,
}: {
  project: Project;
  tasks: readonly TaskRow[];
  /** `ha agenda` 同一条 repo.agenda.read 投影;PIN 区不从 task list 二次猜。 */
  agenda?: AgendaSuccess;
  decisions: DecisionRow[];
  workspaceSummary: WorkspaceSummaryRead;
  relations: RelationEdge[];
  /** 侧栏系统运行区同一份派生(App 折算,见 model/runtime-health.ts);这里只喂底部统计条的异常口径。 */
  health: RuntimeHealth;
  /** systemQuery 直接读失败(与「观测年龄超时」分开点名)。 */
  daemonReadFailed: boolean;
  /** 底部统计条的版本对(null = 台账切面还没读到过);同一份 repo.tasks.read 切面。 */
  ledgerRevision: { readonly watermark: number; readonly sourceRevision: number } | null;
  onSelect: (id: string) => void;
  /** 显式「去看板」出口:带任务流当前状态预置。 */
  onDrill: (status: SnapshotStatus) => void;
  onOpenInbox: () => void;
  /** 决策抽屉「打开详情」出口。 */
  onOpenDecision: (decisionId: string) => void;
  /** G10 实体互链:决策预览抽屉里的 agent/task ID 的导航出口。 */
  onNavigateEntity: (ref: string) => void;
  onSetPin?: (task: Pick<TaskRow, "taskId">, pinned: boolean) => void;
  /** 让 App 只在决策抽屉实际打开时挂载 active-edge 窄面。 */
  onDecisionPreviewChange?: (decisionId: string | null) => void;
}) {
  // 决策预览抽屉:本页局部状态,不开抽屉不进导航栈(不改导航契约)。
  const [previewDecisionId, setPreviewDecisionId] = useState<string | null>(null);
  const previewDecision = useMemo(
    () => decisions.find((decision) => decision.decisionId === previewDecisionId) ?? null,
    [decisions, previewDecisionId],
  );
  // 底部统计条的异常口径(task_b2fb4bc7):daemon 断连 / 投影落后 / 读失败。
  // 只消费本页已经拿到的读面,不为此新增任何查询。
  const statsAnomalies: OverviewStatsAnomaly[] = [];
  if (health.daemon.state === "unresponsive")
    statsAnomalies.push({ code: "daemon", label: t("views.overviewView.statsAnomalyDaemon") });
  if ((health.projection.lag ?? 0) > 0)
    statsAnomalies.push({
      code: "projection",
      label: t("views.overviewView.statsAnomalyProjection", { lag: String(health.projection.lag) }),
    });
  if (daemonReadFailed) statsAnomalies.push({ code: "read", label: t("views.overviewView.statsAnomalyRead") });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-surface/40 px-5 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="ui-title font-mono font-semibold">{project.name}</h1>
          <span className="truncate font-mono text-[12px] text-text-faint">{project.path}</span>
          <span className="ml-auto shrink-0 font-mono text-[12px] text-text-faint">
            投影 @ {timeOf(project.watermarkAt)}
          </span>
        </div>
        <p className="mt-1 text-[12px] text-text-muted">{t("views.overviewView.tagline")}</p>
      </header>

      <div
        className={[
          "grid min-h-0 flex-1 grid-cols-1 auto-rows-[22rem] gap-4 overflow-y-auto p-5",
          "xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]",
          "xl:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] xl:overflow-hidden",
        ].join(" ")}
      >
        <Card title={t("views.overviewView.decisionStreamTitle")} bodyClassName="p-3" className="xl:col-start-1">
          <DecisionStream
            decisions={decisions}
            summary={workspaceSummary.decisions}
            stateLabel={decisionStateLabel}
            onOpenPreview={(decisionId) => {
              setPreviewDecisionId(decisionId);
              onDecisionPreviewChange?.(decisionId);
            }}
            onOpenInbox={onOpenInbox}
          />
        </Card>

        <Card
          title={t("views.overviewView.taskStreamTitle")}
          bodyClassName="p-3"
          className="xl:col-start-2 xl:row-start-1 xl:row-span-2"
        >
          <TaskStream
            tasks={tasks}
            summary={workspaceSummary.tasks}
            onOpenPreview={onSelect}
            onGoBoard={onDrill}
            onSetPin={onSetPin}
          />
        </Card>

        <Card
          title={t("views.overviewView.pinnedStreamTitle")}
          bodyClassName="p-3"
          className="xl:col-start-1 xl:row-start-2"
        >
          <PinnedStream agenda={agenda} onOpenPreview={onSelect} onSetPin={onSetPin} />
        </Card>
      </div>

      <OverviewStatsBar summary={workspaceSummary} revision={ledgerRevision} anomalies={statsAnomalies} />

      <DecisionPreviewDrawer
        decision={previewDecision}
        tasks={tasks}
        relations={relations}
        onClose={() => {
          setPreviewDecisionId(null);
          onDecisionPreviewChange?.(null);
        }}
        onOpenDetail={(decisionId) => {
          setPreviewDecisionId(null);
          onDecisionPreviewChange?.(null);
          onOpenDecision(decisionId);
        }}
        onNavigateEntity={onNavigateEntity}
      />
    </div>
  );
}
