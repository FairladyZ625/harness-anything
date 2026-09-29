import type { ReactNode } from "react";
import { DayDigest, type DayPath } from "../../components/primitives/DayDigest";
import { DenseRow } from "../../components/primitives/DenseRow";
import { PillFlow } from "../../components/primitives/PillFlow";
import { SegBar } from "../../components/primitives/SegBar";
import { Section } from "../../components/primitives/Section";
import { StatusTag, type StatusTone } from "../../components/primitives/StatusTag";
import type { AttestationPoolLanes } from "../../model/attestation-pool.ts";
import type { WorkDayGroup, WorkStepKind, WorkSubgroup } from "../../model/workspace-narrative.ts";
import type { SnapshotStatus, TaskRow } from "../../model/types.ts";
import type { MessageKey } from "../../i18n/core.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 概况页(原型 v2):主栏按叙事往下排——等你裁决(hero)、没有 agent 在跑(warn)、
 * 按天收束的进展、接下来的标签流;右栏是状态数字与子组树。块的高度由内容决定,
 * 没有内容的块整块消失(标准 §1/§2.2)。
 */

const STEP_META: Readonly<Record<WorkStepKind, { readonly label: MessageKey; readonly tone: StatusTone }>> = {
  start: { label: "views.workspace.step.start", tone: "active" },
  dispatch: { label: "views.workspace.step.dispatch", tone: "active" },
  submit: { label: "views.workspace.step.submit", tone: "wait" },
  approved: { label: "views.workspace.step.approved", tone: "done" },
  rejected: { label: "views.workspace.step.rejected", tone: "bad" },
  returned: { label: "views.workspace.step.returned", tone: "bad" },
  completed: { label: "views.workspace.step.completed", tone: "done" },
  reopened: { label: "views.workspace.step.reopened", tone: "active" },
  fact: { label: "views.workspace.step.fact", tone: "plan" },
  gatePass: { label: "views.workspace.step.gatePass", tone: "done" },
  gateFail: { label: "views.workspace.step.gateFail", tone: "bad" },
};

/** 状态数字格:完成/待裁决/评审中/在做/待开工/阻塞/取消,只显示非零项。 */
const RAIL_STATUS_ORDER: readonly SnapshotStatus[] = [
  "done",
  "submitted",
  "in_review",
  "active",
  "planned",
  "blocked",
  "cancelled",
];

const RAIL_STATUS_LABEL: Readonly<Record<SnapshotStatus, MessageKey>> = {
  planned: "components.badges.planned",
  active: "components.badges.active",
  submitted: "components.badges.submitted",
  in_review: "components.badges.inReview",
  blocked: "components.badges.blocked",
  done: "components.badges.done",
  cancelled: "components.badges.cancelled",
  unknown: "components.badges.unknown",
  archived: "components.badges.archived",
};

export interface WorkOverviewProps {
  readonly submitted: readonly TaskRow[];
  readonly stalled: readonly TaskRow[];
  readonly planned: readonly TaskRow[];
  readonly lanes: AttestationPoolLanes;
  readonly dayGroups: readonly WorkDayGroup[];
  readonly dayLabelOf: (dateKey: string) => string;
  readonly timeOf: (iso: string) => string;
  readonly subgroups: readonly WorkSubgroup[];
  readonly leafCounts: Readonly<Partial<Record<SnapshotStatus, number>>>;
  readonly leafTotal: number;
  readonly agoOf: (iso: string) => string;
  readonly feedback?: (
    taskId: string,
  ) => { readonly state: string; readonly hint?: string; readonly code?: string } | undefined;
  readonly onAdjudicate?: (task: TaskRow, decision: "forward" | "return", reason: string) => void;
  readonly onAttest?: (task: Pick<TaskRow, "taskId">, gateId: string, mode: "approve" | "override") => void;
  readonly onConsent?: (task: TaskRow, reviewId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenProgress: () => void;
  readonly onFilterStatus: (status: string) => void;
  readonly onFilterGroup: (group: string) => void;
}

const actionButton = "h-6 rounded-xs border px-2.5 ui-meta disabled:opacity-60";

export function WorkOverview({
  submitted,
  stalled,
  planned,
  lanes,
  dayGroups,
  dayLabelOf,
  timeOf,
  subgroups,
  leafCounts,
  leafTotal,
  agoOf,
  feedback,
  onAdjudicate,
  onAttest,
  onConsent,
  onOpenTask,
  onOpenProgress,
  onFilterStatus,
  onFilterGroup,
}: WorkOverviewProps) {
  const heroCount = submitted.length + lanes.gates.length + lanes.breakGlass.length + lanes.consents.length,
    // 「最久的等了 X」只对已提交的任务有意义;纯签发/同意的 hero 不带这句。
    oldest = submitted
      .map(({ lastKnownAt }) => lastKnownAt)
      .sort()
      .at(0);
  const main = (
    <div className="min-w-0">
      {heroCount > 0 ? (
        <div data-testid="work-hero">
          <Section
            variant="hero"
            title={t("views.workspace.hero.title")}
            count={heroCount}
            note={oldest === undefined ? undefined : t("views.workspace.hero.note", { ago: agoOf(oldest) })}
          >
            <div className="space-y-0.5">
              {submitted.map((task) => (
                <ActionRow
                  key={task.taskId}
                  taskId={task.taskId}
                  title={task.title}
                  time={agoOf(task.lastKnownAt)}
                  onOpen={onOpenTask}
                  state={feedback?.(task.taskId)}
                >
                  <button
                    type="button"
                    data-testid={`work-hero-forward-${task.taskId}`}
                    disabled={!onAdjudicate}
                    onClick={() =>
                      onAdjudicate?.(task, "forward", "Owner initial review accepted this cut for independent review.")
                    }
                    className={`${actionButton} border-status-submitted/45 bg-status-submitted/15 text-status-submitted`}
                  >
                    {t("views.workspace.hero.forward")}
                  </button>
                  <button
                    type="button"
                    data-testid={`work-hero-return-${task.taskId}`}
                    disabled={!onAdjudicate}
                    onClick={() => onAdjudicate?.(task, "return", "Owner initial review returned this cut for rework.")}
                    className={`${actionButton} border-border bg-text/5 text-text-muted`}
                  >
                    {t("views.workspace.hero.return")}
                  </button>
                </ActionRow>
              ))}
              {[...lanes.gates, ...lanes.breakGlass].map((item) => (
                <ActionRow
                  key={`${item.taskId}:${item.gateId}:${item.mode}`}
                  taskId={item.taskId}
                  title={item.taskTitle}
                  reason={`门禁 ${item.gateId} · ${item.gateStatus}`}
                  time={null}
                  onOpen={onOpenTask}
                  state={feedback?.(item.taskId)}
                >
                  <button
                    type="button"
                    disabled={!onAttest}
                    onClick={() => onAttest?.({ taskId: item.taskId }, item.gateId, item.mode)}
                    className={`${actionButton} border-status-submitted/45 bg-status-submitted/15 text-status-submitted`}
                  >
                    {item.mode === "approve" ? t("views.workspace.hero.attest") : t("views.workspace.hero.override")}
                  </button>
                </ActionRow>
              ))}
              {lanes.consents.map((item) => {
                const task = submitted.find(({ taskId }) => taskId === item.taskId) ?? null,
                  approved = task?.reviews?.filter((review) => review.verdict === "approved").at(-1);
                return (
                  <ActionRow
                    key={`${item.taskId}:consent`}
                    taskId={item.taskId}
                    title={item.taskTitle}
                    reason="待同意本轮交付"
                    time={null}
                    onOpen={onOpenTask}
                    state={feedback?.(item.taskId)}
                  >
                    <button
                      type="button"
                      disabled={!task || !approved || !onConsent}
                      onClick={() => task && approved && onConsent?.(task, approved.reviewId)}
                      className={`${actionButton} border-status-submitted/45 bg-status-submitted/15 text-status-submitted`}
                    >
                      {t("views.workspace.hero.consent")}
                    </button>
                  </ActionRow>
                );
              })}
            </div>
          </Section>
        </div>
      ) : null}

      {stalled.length > 0 ? (
        <div data-testid="work-stalled">
          <Section
            variant="warn"
            title={t("views.workspace.stalled.title")}
            count={stalled.length}
            note={t("views.workspace.stalled.note")}
          >
            <div className="space-y-0.5">
              {stalled.map((task) => (
                <ActionRow
                  key={task.taskId}
                  taskId={task.taskId}
                  title={task.title}
                  reason={t("views.workspace.stalled.lastActivity", { ago: agoOf(task.lastKnownAt) })}
                  time={null}
                  onOpen={onOpenTask}
                />
              ))}
            </div>
          </Section>
        </div>
      ) : null}

      {dayGroups.length > 0 ? (
        <Section
          title={t("views.workspace.progress.title")}
          note={t("views.workspace.progress.note")}
          action={
            <button type="button" className="text-accent ui-meta" onClick={onOpenProgress}>
              {t("views.workspace.progress.all")}
            </button>
          }
        >
          <WorkDayList
            dayGroups={dayGroups.slice(0, 2)}
            dayLabelOf={dayLabelOf}
            timeOf={timeOf}
            onOpenTask={onOpenTask}
          />
        </Section>
      ) : null}

      {planned.length > 0 ? (
        <Section title={t("views.workspace.next.title")} count={planned.length} note={t("views.workspace.next.note")}>
          <div data-testid="work-next">
            <PillFlow
              items={planned.map((task) => ({
                label: task.title,
                title: task.title,
                pinned: task.pinned === true,
                onClick: () => onOpenTask(task.taskId),
              }))}
            />
          </div>
        </Section>
      ) : null}
    </div>
  );
  const rail = (
    <aside data-testid="workspace-rail" className="space-y-6 self-start lg:sticky lg:top-0">
      <section>
        <h3 className="font-semibold text-text-muted ui-meta">{t("views.workspace.rail.status")}</h3>
        <div className="mt-2 grid grid-cols-3 gap-px overflow-hidden rounded-xs border border-border bg-border">
          {[...RAIL_STATUS_ORDER.filter((status) => (leafCounts[status] ?? 0) > 0), null].map((status) => (
            <button
              key={status ?? "all"}
              type="button"
              data-status-filter={status ?? ""}
              onClick={() => onFilterStatus(status ?? "")}
              className="bg-surface px-2.5 py-[7px] text-left hover:bg-surface-raised"
            >
              <b className="block font-mono text-base font-semibold leading-tight tabular-nums text-text">
                {status === null ? leafTotal : leafCounts[status]}
              </b>
              <span className="text-text-faint ui-micro">
                {status === null ? t("views.workspace.rail.all") : t(RAIL_STATUS_LABEL[status])}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3 className="font-semibold text-text-muted ui-meta">{t("views.workspace.rail.structure")}</h3>
        <div className="mt-2">
          {subgroups.map((group) => (
            <button
              key={group.key}
              type="button"
              data-group-filter={group.key}
              onClick={() => onFilterGroup(group.key)}
              className="grid w-full grid-cols-[minmax(0,1fr)_70px_44px] items-center gap-2 rounded-xs py-1 pr-1.5 text-left hover:bg-text/5"
              style={{ paddingLeft: `${6 + group.depth * 14}px` }}
            >
              <span className="min-w-0 truncate text-text ui-body">
                {group.loose ? t("views.workspace.tasks.loose") : (group.title ?? group.key)}
                {group.inFlight > 0 ? (
                  <i className="ml-1 not-italic text-status-submitted ui-micro">
                    {t("views.workspace.rail.inFlight", { count: group.inFlight })}
                  </i>
                ) : null}
              </span>
              <SegBar counts={group.counts} className="h-1" />
              <span className="text-right font-mono tabular-nums text-text-muted ui-meta">
                {(group.counts.done ?? 0) + (group.counts.cancelled ?? 0)}/{group.memberTaskIds.length}
              </span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
  return (
    <>
      {main}
      {rail}
    </>
  );
}

/** 概况与进展共用的按天收束列表:DayDigest 原语,每任务一条路径。 */
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

function DaySummary({ group }: { readonly group: WorkDayGroup }) {
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

/** 带就地动作的行:整行点开抽屉,右侧等宽时间与动作按钮(标准 §5);动作拦下冒泡。 */
function ActionRow({
  taskId,
  title,
  reason,
  time,
  onOpen,
  state,
  children,
}: {
  readonly taskId: string;
  readonly title: string;
  readonly reason?: string;
  readonly time: string | null;
  readonly onOpen: (taskId: string) => void;
  readonly state?: { readonly state: string; readonly hint?: string; readonly code?: string };
  readonly children?: ReactNode;
}) {
  return (
    <div
      data-task-row={taskId}
      onClick={() => onOpen(taskId)}
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-xs px-2.5 py-[7px] hover:bg-text/5"
    >
      <span className="min-w-0 truncate text-text ui-body">
        {title}
        {reason ? <span className="ml-2 text-text-faint ui-meta">{reason}</span> : null}
        {state ? (
          <span className="ml-2 text-text-faint ui-micro">
            {state.state}
            {state.code ? ` · ${state.code}` : state.hint ? ` · ${state.hint}` : ""}
          </span>
        ) : null}
      </span>
      <div
        className="flex items-center gap-2"
        onClick={(event) => {
          // 动作区不冒泡到整行:点按钮是动作,不是开抽屉。
          if (children !== undefined) event.stopPropagation();
        }}
      >
        {time === null ? null : (
          <span className="whitespace-nowrap font-mono tabular-nums text-text-muted ui-meta">{time}</span>
        )}
        {children}
      </div>
    </div>
  );
}

/** 任务页与检修页共用的状态行(DenseRow 原语 + 状态标签);标题由调用方给,可带搜索高亮。 */
export function WorkTaskRow({
  task,
  title,
  status,
  agoOf,
  onOpen,
}: {
  readonly task: {
    readonly taskId: string;
    readonly pinned?: boolean;
    readonly at: string;
  };
  readonly title: ReactNode;
  readonly status: SnapshotStatus;
  readonly agoOf: (iso: string) => string;
  readonly onOpen: (taskId: string) => void;
}) {
  return (
    <DenseRow
      tag={<StatusTag status={status} />}
      title={
        <>
          {task.pinned === true ? <span className="text-status-planned">● </span> : null}
          {title}
        </>
      }
      time={agoOf(task.at)}
      onClick={() => onOpen(task.taskId)}
    />
  );
}
