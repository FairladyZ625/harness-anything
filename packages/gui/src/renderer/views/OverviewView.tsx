import { useState } from "react";
import type { Project, SnapshotStatus } from "../model/types";
import { DecisionReviewTiles } from "../components/overview/DecisionReviewTiles.tsx";
import { DecisionReviewNow } from "../components/overview/DecisionReviewNow.tsx";
import type { DecisionTileTarget } from "../model/decision-review.ts";
import { OverviewStatsBar, type OverviewStatsAnomaly } from "../components/overview/OverviewStatsBar.tsx";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import type { AwaitsPanelSubject } from "../awaits-answer.ts";
import { StatusTag } from "../components/primitives/StatusTag";
import type { RuntimeHealth } from "../model/runtime-health.ts";
import { t } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import type { WorkspaceSummaryRead } from "../../api/renderer-dto.ts";
import type { AgendaSuccess } from "../api-client.ts";
import type { TaskWipRead } from "../../api/renderer-dto.ts";
import { TaskWipSummary } from "../components/TaskWipSummary.tsx";

const timeOf = (iso: string) => formatTime(iso, { style: "time" }) ?? "—";

/**
 * 总览(原型 S1,dec_DC3A1BB9 CH1):头部、四格计数、「需要我的判断 / 正在发生」两栏、
 * 下方「推进中的工作」(置顶的工作)。行与计数全部取已挂载的同一条议程读面(repo.agenda.read),
 * 本页不另发请求。系统运行状态常驻侧栏左下角;底部统计条只给台账计数与异常口径。
 */
export function OverviewView({
  repoId,
  project,
  wipSnapshot,
  agenda,
  workspaceSummary,
  health,
  daemonReadFailed,
  ledgerRevision,
  onNavigateEntity,
  onOpenDecisionTarget,
  onOpenTask,
}: {
  repoId: string;
  project: Project;
  wipSnapshot?: TaskWipRead;
  /** `ha agenda` 同一条 repo.agenda.read 投影;undefined = 尚未读到。 */
  agenda?: AgendaSuccess;
  workspaceSummary: WorkspaceSummaryRead;
  /** 侧栏系统运行区同一份派生(App 折算,见 model/runtime-health.ts);这里只喂底部统计条的异常口径。 */
  health: RuntimeHealth;
  /** systemQuery 直接读失败(与「观测年龄超时」分开点名)。 */
  daemonReadFailed: boolean;
  /** 底部统计条的版本对(null = 台账切面还没读到过);同一份 repo.tasks.read 切面。 */
  ledgerRevision: { readonly watermark: number; readonly sourceRevision: number } | null;
  /** 答复面板里来源实体链接的导航出口。 */
  onNavigateEntity: (ref: string) => void;
  /** 四格与「需要我的判断 / 正在发生」的落点:单条 Decision 的评审落点,或议程页 / 会话页。 */
  onOpenDecisionTarget: (target: DecisionTileTarget) => void;
  /** 推进中的工作的落点:App 按「根任务即工作」分流到工作页或任务详情。 */
  onOpenTask: (taskId: string) => void;
}) {
  const [panel, setPanel] = useState<AwaitsPanelSubject | null>(null);
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
          <span className="truncate font-mono ui-meta text-text-faint">{project.path}</span>
          <span className="ml-auto shrink-0 font-mono ui-meta text-text-faint">
            投影 @ {timeOf(project.watermarkAt)}
          </span>
        </div>
        <p className="mt-1 ui-meta text-text-muted">{t("views.overviewView.tagline")}</p>
        <TaskWipSummary snapshot={wipSnapshot} />
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <section
          data-testid="overview-decision-review"
          className="space-y-3"
          aria-label={t("views.overviewView.decisionTilesLabel")}
        >
          <DecisionReviewTiles agenda={agenda} onOpen={onOpenDecisionTarget} />
          <DecisionReviewNow
            agenda={agenda}
            onOpen={onOpenDecisionTarget}
            onAnswer={(row) => setPanel({ mode: "answer", row })}
          />
        </section>
        <InFlightWork agenda={agenda} onOpenTask={onOpenTask} />
      </div>

      <OverviewStatsBar summary={workspaceSummary} revision={ledgerRevision} anomalies={statsAnomalies} />

      {panel ? (
        <AwaitsAnswerPanel
          repoId={repoId}
          subject={panel}
          onClose={() => setPanel(null)}
          onNavigateEntity={(ref) => {
            setPanel(null);
            onNavigateEntity(ref);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 「推进中的工作」(原型 S1):置顶的工作,取议程读面的 pinnedEntities 里的 task 行——与侧栏
 * 「置顶工作」同一份,不另立 pin 状态。卡片写标题与阶段(读面给的状态词),点击进工作。
 */
function InFlightWork({
  agenda,
  onOpenTask,
}: {
  agenda: AgendaSuccess | undefined;
  onOpenTask: (taskId: string) => void;
}) {
  const works = agenda?.pinnedEntities.filter(({ kind }) => kind === "task") ?? null;
  return (
    <section data-testid="overview-in-flight-work" className="space-y-2">
      <h2 className="text-sm font-semibold text-text">{t("views.overviewView.inFlightWorkTitle")}</h2>
      {works === null ? (
        <p className="ui-meta text-text-muted">{t("views.overviewView.pinnedLoading")}</p>
      ) : works.length === 0 ? (
        <p className="ui-meta text-text-muted">
          {t("views.overviewView.inFlightWorkEmpty")}{" "}
          <span className="font-mono text-text-faint">{t("views.overviewView.pinnedHint")}</span>
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {works.map((work) => {
            const taskId = work.ref.replace(/^task\//u, "");
            return (
              <button
                key={work.ref}
                type="button"
                data-testid={`overview-in-flight-work-${taskId}`}
                onClick={() => onOpenTask(taskId)}
                title={work.ref}
                className="min-w-0 space-y-2 rounded-md border border-border bg-surface-raised px-3 py-2.5 text-left transition-colors duration-150 hover:border-accent/60"
              >
                <p className="line-clamp-2 break-words text-sm font-semibold text-text">{work.title}</p>
                <StatusTag status={work.status as SnapshotStatus} />
              </button>
            );
          })}
        </div>
      )}
      {agenda && agenda.pinnedEntityOverflow > 0 ? (
        <p className="font-mono ui-micro text-text-faint">
          {t("views.overviewView.pinnedOverflow", { count: agenda.pinnedEntityOverflow })}
        </p>
      ) : null}
    </section>
  );
}
