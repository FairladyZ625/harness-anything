import type { ReactNode } from "react";
import { DayDigest, type DayPath } from "../../components/primitives/DayDigest";
import type { StatusTone } from "../../components/primitives/StatusTag";
import type { WorkDayGroup, WorkStepKind } from "../../model/workspace-narrative.ts";
import { WORK_STEP_LABEL_KEY } from "../../model/workspace-narrative.ts";
import type { MessageKey } from "../../i18n/core.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 工作页「进展」页签与全局总览「最近变化」共用的按天收束时间线。概况首屏不再放
 * 时间线(2026-10-21 业主 13:50:降密度,首屏看终点与剩余);详细密度住在这里。
 */

/** 步骤种类的呈现(标签/状态色);文案键单源在 WORK_STEP_LABEL_KEY,这里只补色调。 */
export const STEP_META: Readonly<Record<WorkStepKind, { readonly label: MessageKey; readonly tone: StatusTone }>> = {
  start: { label: WORK_STEP_LABEL_KEY.start, tone: "active" },
  dispatch: { label: WORK_STEP_LABEL_KEY.dispatch, tone: "active" },
  submit: { label: WORK_STEP_LABEL_KEY.submit, tone: "wait" },
  approved: { label: WORK_STEP_LABEL_KEY.approved, tone: "done" },
  rejected: { label: WORK_STEP_LABEL_KEY.rejected, tone: "bad" },
  returned: { label: WORK_STEP_LABEL_KEY.returned, tone: "bad" },
  completed: { label: WORK_STEP_LABEL_KEY.completed, tone: "done" },
  reopened: { label: WORK_STEP_LABEL_KEY.reopened, tone: "active" },
  fact: { label: WORK_STEP_LABEL_KEY.fact, tone: "plan" },
  gatePass: { label: WORK_STEP_LABEL_KEY.gatePass, tone: "done" },
  gateFail: { label: WORK_STEP_LABEL_KEY.gateFail, tone: "bad" },
  gateCheck: { label: WORK_STEP_LABEL_KEY.gateCheck, tone: "plan" },
  consent: { label: WORK_STEP_LABEL_KEY.consent, tone: "done" },
  witness: { label: WORK_STEP_LABEL_KEY.witness, tone: "plan" },
  dismissed: { label: WORK_STEP_LABEL_KEY.dismissed, tone: "neutral" },
  abandoned: { label: WORK_STEP_LABEL_KEY.abandoned, tone: "cancel" },
};

/** 按天收束列表:DayDigest 原语,每任务一条路径。 */
export function WorkDayList({
  dayGroups,
  dayLabelOf,
  timeOf,
  onOpenTask,
}: {
  readonly dayGroups: readonly WorkDayGroup[];
  readonly dayLabelOf: (dateKey: string) => string;
  readonly timeOf: (iso: string) => string;
  readonly onOpenTask: (taskId: string) => void;
}) {
  return (
    <div>
      {dayGroups.map((group, index) => (
        <DayDigest
          key={group.dateKey}
          day={dayLabelOf(group.dateKey)}
          defaultOpen={index === 0}
          summary={<DaySummary group={group} />}
          paths={group.paths.map<DayPath>((path) => ({
            time: timeOf(path.firstAt),
            name: path.title ?? path.taskId,
            steps: path.steps.map((step) => ({
              label: t(STEP_META[step].label),
              tone: STEP_META[step].tone,
            })),
            onClick: () => onOpenTask(path.taskId),
          }))}
        />
      ))}
    </div>
  );
}

/** 一天的摘要:完成/提交/打回/退回计数;全局总览的「最近变化」共用。 */
export function DaySummary({ group }: { readonly group: WorkDayGroup }) {
  const parts: ReactNode[] = [];
  const push = (key: MessageKey, count: number) => {
    if (count > 0) parts.push(<span key={key}>{t(key, { count })}</span>);
  };
  push("views.workspace.day.completedPart", group.counts.completed);
  push("views.workspace.day.submittedPart", group.counts.submitted);
  push("views.workspace.day.rejectedPart", group.counts.rejected);
  push("views.workspace.day.returnedPart", group.counts.returned);
  if (parts.length === 0)
    parts.push(<span key="active">{t("views.workspace.day.activeOnly", { count: group.paths.length })}</span>);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? " · " : ""}
          {part}
        </span>
      ))}
    </>
  );
}
