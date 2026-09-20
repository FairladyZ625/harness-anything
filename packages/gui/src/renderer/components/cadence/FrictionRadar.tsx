import { t } from "../../i18n/index.tsx";
import { formatTime } from "../../model/time.ts";
import {
  CADENCE_FRICTION_ALERT_THRESHOLD,
  CADENCE_FRICTION_KINDS,
  type CadenceFrictionKind,
  type CadenceFrictionSnapshot,
} from "../../model/cadence.ts";

/**
 * 研发摩擦力与空转雷达:高摩擦任务(门禁失败/评审打回/提交退回/重开)、
 * 摩擦信号分类计数与停滞任务预警。全部读 cadence 纯聚合快照,只读视图。
 */

const TASK_BUTTON = ["flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left hover:text-accent"].join(" ");
const TASK_LINE = "flex min-w-0 flex-wrap items-center gap-1.5";
const HIGH_BADGE = ["shrink-0 rounded bg-status-blocked/10 px-1.5 py-0.5 ui-micro text-status-blocked"].join(" ");
const titleTone = (high: boolean): string =>
  `truncate ui-body ${high ? "text-status-blocked font-semibold" : "text-text"}`;

const KIND_LABEL: Record<CadenceFrictionKind, () => string> = {
  gateFail: () => t("views.cadence.frictionGateFail"),
  reviewChanges: () => t("views.cadence.frictionReviewChanges"),
  returned: () => t("views.cadence.frictionReturned"),
  reopened: () => t("views.cadence.frictionReopened"),
};

export function FrictionRadar({
  friction,
  onOpenTask,
}: {
  readonly friction: CadenceFrictionSnapshot;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const signalTotal = CADENCE_FRICTION_KINDS.reduce((sum, kind) => sum + friction.byKind[kind], 0),
    hasStalled = friction.stalled.length > 0;
  return (
    <section
      data-testid="cadence-friction"
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface"
    >
      <header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="ui-body font-semibold">{t("views.cadence.frictionTitle")}</h2>
        <span className="font-mono ui-micro text-text-faint">
          {t("views.cadence.frictionTotal", { count: signalTotal })}
        </span>
      </header>
      {signalTotal === 0 && !hasStalled ? (
        <p data-testid="cadence-friction-empty" className="px-3 py-3 ui-meta text-text-faint">
          {t("views.cadence.frictionEmpty")}
        </p>
      ) : (
        <div className="flex max-h-80 flex-col overflow-y-auto">
          {signalTotal > 0 ? (
            <>
              <p className="flex flex-wrap gap-x-3 px-3 pt-2 font-mono ui-micro text-text-faint">
                {CADENCE_FRICTION_KINDS.map((kind) => (
                  <span key={kind}>{`${KIND_LABEL[kind]()} ${friction.byKind[kind]}`}</span>
                ))}
              </p>
              <ul data-testid="cadence-friction-tasks" className="max-h-56 overflow-y-auto">
                {friction.tasks.map((task) => (
                  <li key={task.taskId} className="border-t border-border px-3 py-2 first:border-t-0">
                    <button
                      type="button"
                      data-testid="cadence-friction-task"
                      className={TASK_BUTTON}
                      onClick={() => onOpenTask(task.taskId)}
                    >
                      <span className={TASK_LINE}>
                        <span className={titleTone(task.high)}>{task.title}</span>
                        {task.high ? <span className={HIGH_BADGE}>{t("views.cadence.frictionHigh")}</span> : null}
                      </span>
                      <span className="font-mono ui-micro text-text-faint">
                        {CADENCE_FRICTION_KINDS.filter((kind) => task[kind] > 0)
                          .map((kind) => `${KIND_LABEL[kind]()} ${task[kind]}`)
                          .join(" · ") || t("views.cadence.frictionLastAt")}
                        {task.lastSignalAt === null
                          ? ""
                          : ` · ${formatTime(task.lastSignalAt, { style: "time" }) ?? ""}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {hasStalled ? (
            <div className="border-t border-border px-3 py-2">
              <p className="font-mono ui-micro uppercase tracking-wide text-text-faint">
                {t("views.cadence.frictionStalled")}
              </p>
              <ul data-testid="cadence-friction-stalled" className="max-h-36 overflow-y-auto">
                {friction.stalled.map((task) => (
                  <li key={task.taskId} className="mt-1 flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      className="min-w-0 truncate text-left ui-meta text-stale hover:text-accent"
                      title={task.title}
                      onClick={() => onOpenTask(task.taskId)}
                    >
                      {task.title}
                    </button>
                    <span className="shrink-0 font-mono ui-micro text-text-faint">
                      {formatTime(task.lastSeenAt ?? "", { style: "date-time" }) ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="border-t border-border px-3 py-1.5 ui-micro text-text-faint">
            {t("views.cadence.frictionLegend", { threshold: CADENCE_FRICTION_ALERT_THRESHOLD })}
          </p>
        </div>
      )}
    </section>
  );
}
