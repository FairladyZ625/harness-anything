import { useMemo, useState } from "react";
import type {
  DecisionRow,
  Project,
  RelationEdge,
  SnapshotStatus,
  TaskRow,
} from "../model/types";
import { Card } from "../components/overview/parts";
import { DecisionStream } from "../components/overview/DecisionStream.tsx";
import { TaskStream } from "../components/overview/TaskStream.tsx";
import { PinnedStream } from "../components/overview/PinnedStream.tsx";
import { RuntimeHealthCard } from "../components/overview/RuntimeHealthCard.tsx";
import { DecisionPreviewDrawer } from "../components/DecisionPreviewDrawer.tsx";
import { decisionStateLabel } from "../components/badges";
import { deriveRuntimeHealth, type RuntimeHealthInput } from "../model/runtime-health.ts";
import { t } from "../i18n/index.tsx";
import { localTime } from "../model/local-time.ts";
import type { WorkspaceSummaryRead } from "../../api/renderer-dto.ts";

const timeOf = (iso: string) => localTime(iso) ?? "—";

/**
 * 总览 = 四条流(2026-08-21 泽宇反馈重构):
 * 决策流 / 任务流 / Pin 在做 / 运行时健康。
 * 交互规则:点击先开抽屉不跳页;状态切换是就地筛选;时间倒序;
 * 「去批准 / 去看板 / 系统页」是仅有的显式路由出口。
 */
export function OverviewView({
  project,
  tasks,
  decisions,
  workspaceSummary,
  relations,
  systemHealth,
  onSelect,
  onDrill,
  onOpenInbox,
  onOpenDecision,
  onOpenSystem,
}: {
  project: Project;
  tasks: TaskRow[];
  decisions: DecisionRow[];
  workspaceSummary: WorkspaceSummaryRead;
  relations: RelationEdge[];
  /** 第四格输入(App 从 systemQuery / tasksQuery 折算,见 model/runtime-health.ts)。 */
  systemHealth: Omit<RuntimeHealthInput, "lastSnapshotAt" | "now">;
  onSelect: (id: string) => void;
  /** 显式「去看板」出口:带任务流当前状态预置。 */
  onDrill: (status: SnapshotStatus) => void;
  onOpenInbox: () => void;
  /** 决策抽屉「打开详情」出口。 */
  onOpenDecision: (decisionId: string) => void;
  onOpenSystem: () => void;
}) {
  // 决策预览抽屉:本页局部状态,不开抽屉不进导航栈(不改导航契约)。
  const [previewDecisionId, setPreviewDecisionId] = useState<string | null>(null);
  const previewDecision = useMemo(
    () => decisions.find((decision) => decision.decisionId === previewDecisionId) ?? null,
    [decisions, previewDecisionId],
  );
  const lastSnapshotAt = useMemo(
    () => tasks.reduce((latest, task) => (task.lastKnownAt > latest ? task.lastKnownAt : latest), ""),
    [tasks],
  );
  const health = deriveRuntimeHealth({ ...systemHealth, lastSnapshotAt: lastSnapshotAt || null, now: new Date().toISOString() });

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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 xl:auto-rows-[minmax(0,1fr)] xl:grid-cols-2 xl:overflow-hidden">
        <Card title={t("views.overviewView.decisionStreamTitle")} bodyClassName="p-3">
          <DecisionStream
            decisions={decisions}
            summary={workspaceSummary.decisions}
            stateLabel={decisionStateLabel}
            onOpenPreview={setPreviewDecisionId}
            onOpenInbox={onOpenInbox}
          />
        </Card>

        <Card title={t("views.overviewView.taskStreamTitle")} bodyClassName="p-3">
          <TaskStream tasks={tasks} summary={workspaceSummary.tasks} onOpenPreview={onSelect} onGoBoard={onDrill} />
        </Card>

        <Card title={t("views.overviewView.pinnedStreamTitle")} bodyClassName="p-3">
          <PinnedStream tasks={tasks} onOpenPreview={onSelect} />
        </Card>

        <Card title={t("views.overviewView.runtimeHealthTitle")} bodyClassName="p-3">
          <RuntimeHealthCard health={health} onOpenSystem={onOpenSystem} />
        </Card>
      </div>

      <DecisionPreviewDrawer
        decision={previewDecision}
        tasks={tasks}
        relations={relations}
        onClose={() => setPreviewDecisionId(null)}
        onOpenDetail={(decisionId) => {
          setPreviewDecisionId(null);
          onOpenDecision(decisionId);
        }}
      />
    </div>
  );
}
