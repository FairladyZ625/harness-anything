import type { ReactNode } from "react";
import { DayDigest, type DayPath } from "../../components/primitives/DayDigest";
import { DenseRow } from "../../components/primitives/DenseRow";
import { Region } from "../../components/primitives/Region";
import { BoardColumn, BoardMain, BoardRegion, BoardSide, RegionBoard } from "../../components/primitives/RegionBoard";
import { SegBar } from "../../components/primitives/SegBar";
import { StatusTag, type StatusTone } from "../../components/primitives/StatusTag";
import { SplitDivider, SplitLayoutControls, useSplitLayout } from "../../components/primitives/split-layout";
import { entryTitle, metaLine } from "./entry-lines.tsx";
import type { WorkLeafRow } from "./WorkTasksTab.tsx";
import type { AttestationPoolLanes } from "../../model/attestation-pool.ts";
import type { WorkDayGroup, WorkStepKind, WorkSubgroup } from "../../model/workspace-narrative.ts";
import { WORK_STEP_LABEL_KEY } from "../../model/workspace-narrative.ts";
import type { SnapshotStatus, TaskRow } from "../../model/types.ts";
import type { MessageKey } from "../../i18n/core.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 概况页(标准 §2.1):与全局总览同一套区域板。左侧主区按固定顺序放「等你裁决 →
 * 阻塞与异常 → 进行中 → 接下来 → 结构与统计」,右侧一列是「最近进展」时间线;每块信息
 * 都在一个 Region 里,行用 DenseRow,内容超出在区域内滚动,没有内容的区域整块消失(§1.5)。
 *
 * 不走 overview-layout 的权重落列:那套算法把区域放进当前最矮的一列,保证不了时间线
 * 固定在右列,而且工作概况没有 daemon 权重。列容器是共享的 RegionBoard(固定顺序 +
 * 右侧时间线,断点与列内分配见该原语)。
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

/** 状态数字格:完成/待裁决/评审中/在做/待开工/阻塞/取消,只显示非零项。 */
const STATUS_ORDER: readonly SnapshotStatus[] = [
  "done",
  "submitted",
  "in_review",
  "active",
  "planned",
  "blocked",
  "cancelled",
];

const STATUS_LABEL: Readonly<Record<SnapshotStatus, MessageKey>> = {
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
  /** 分割偏好归属的仓(task_fb3ba20d66…:主区|最近进展比例按仓记忆)。 */
  readonly repoId: string;
  readonly submitted: readonly TaskRow[];
  readonly stalled: readonly TaskRow[];
  /** 工作的全部叶子任务(任务页同一份行);阻塞、进行中、接下来三个区域从这里取。 */
  readonly leaves: readonly WorkLeafRow[];
  readonly lanes: AttestationPoolLanes;
  readonly dayGroups: readonly WorkDayGroup[];
  readonly dayLabelOf: (dateKey: string) => string;
  readonly timeOf: (iso: string) => string;
  readonly subgroups: readonly WorkSubgroup[];
  readonly leafCounts: Readonly<Partial<Record<SnapshotStatus, number>>>;
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
  repoId,
  submitted,
  stalled,
  leaves,
  lanes,
  dayGroups,
  dayLabelOf,
  timeOf,
  subgroups,
  leafCounts,
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
    // 「最久的等了 X」只对已提交的任务有意义;纯签发/同意的区域不带这句。
    oldest = submitted
      .map(({ lastKnownAt }) => lastKnownAt)
      .sort()
      .at(0),
    stalledIds = new Set(stalled.map(({ taskId }) => taskId)),
    recentFirst = (left: WorkLeafRow, right: WorkLeafRow) => right.at.localeCompare(left.at),
    blocked = leaves.filter(({ status }) => status === "blocked").sort(recentFirst),
    noAgent = leaves.filter(({ taskId }) => stalledIds.has(taskId)).sort(recentFirst),
    running = leaves
      .filter(({ taskId, status }) => (status === "active" || status === "in_review") && !stalledIds.has(taskId))
      .sort(recentFirst),
    planned = leaves
      .filter(({ status }) => status === "planned")
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || recentFirst(left, right)),
    pathCount = dayGroups.reduce((sum, group) => sum + group.paths.length, 0);

  const taskRow = (leaf: WorkLeafRow, tag?: ReactNode) => (
    <div key={leaf.taskId} data-task-row={leaf.taskId}>
      <WorkTaskRow task={leaf} tag={tag} agoOf={agoOf} onOpen={onOpenTask} />
    </div>
  );

  const attention = (
    <>
      {heroCount > 0 ? (
        <BoardRegion region="mine" data-testid="work-hero">
          <Region
            title={t("views.workspace.hero.title")}
            big={heroCount}
            bigTone="wait"
            edge="wait"
            footer={oldest === undefined ? undefined : t("views.workspace.hero.note", { ago: agoOf(oldest) })}
          >
            {submitted.map((task) => (
              <ActionRow
                key={task.taskId}
                taskId={task.taskId}
                title={task.title}
                reason={t("views.workspace.hero.waited", { ago: agoOf(task.lastKnownAt) })}
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
          </Region>
        </BoardRegion>
      ) : null}

      {blocked.length + noAgent.length > 0 ? (
        <BoardRegion region="stuck" data-testid="work-stuck">
          <Region
            title={t("views.workspace.stuck.title")}
            tag={
              <>
                {blocked.length > 0 ? (
                  <StatusTag tone="bad" label={t("views.overviewView.stuckBlocked", { count: blocked.length })} />
                ) : null}
                {noAgent.length > 0 ? (
                  <StatusTag tone="wait" label={t("views.workspace.stuck.noAgentCount", { count: noAgent.length })} />
                ) : null}
              </>
            }
            big={blocked.length + noAgent.length}
            bigTone={blocked.length > 0 ? "bad" : "wait"}
            edge={blocked.length > 0 ? "bad" : "wait"}
            footer={noAgent.length > 0 ? t("views.workspace.stuck.footer") : undefined}
          >
            {blocked.map((leaf) => taskRow(leaf, <StatusTag status="blocked" />))}
            {noAgent.map((leaf) => taskRow(leaf, <StatusTag tone="wait" label={t("views.workspace.stuck.noAgent")} />))}
          </Region>
        </BoardRegion>
      ) : null}

      {running.length > 0 ? (
        <BoardRegion region="run" data-testid="work-running">
          <Region title={t("views.workspace.running.title")} big={running.length} bigTone="active">
            {running.map((leaf) => taskRow(leaf, <StatusTag status={leaf.status} />))}
          </Region>
        </BoardRegion>
      ) : null}
    </>
  );

  const outlook = (
    <>
      {planned.length > 0 ? (
        <BoardRegion region="next" data-testid="work-next">
          <Region title={t("views.workspace.next.title")} big={planned.length} footer={t("views.workspace.next.note")}>
            {/* 全是待开工,状态标签每行都一样,不进行(§2.4 重复值不进行)。 */}
            {planned.map((leaf) => taskRow(leaf))}
          </Region>
        </BoardRegion>
      ) : null}

      <BoardRegion region="structure" data-testid="work-structure">
        <Region
          title={t("views.workspace.structure.title")}
          big={leaves.length}
          footer={t("views.workspace.structure.footer")}
        >
          <div className="grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-px border-t border-border bg-border">
            {[...STATUS_ORDER.filter((status) => (leafCounts[status] ?? 0) > 0), null].map((status) => (
              <button
                key={status ?? "all"}
                type="button"
                data-status-filter={status ?? ""}
                onClick={() => onFilterStatus(status ?? "")}
                className="bg-surface px-3.5 py-2 text-left hover:bg-surface-raised"
              >
                <b className="block font-mono text-base font-semibold leading-tight tabular-nums text-text">
                  {status === null ? leaves.length : leafCounts[status]}
                </b>
                <span className="text-text-faint ui-micro">
                  {status === null ? t("views.workspace.rail.all") : t(STATUS_LABEL[status])}
                </span>
              </button>
            ))}
          </div>
          {subgroups.map((group) => (
            <div key={group.key} data-group-filter={group.key}>
              <DenseRow
                title={
                  <span style={{ paddingLeft: `${group.depth * 14}px` }}>
                    {group.loose ? t("views.workspace.tasks.loose") : (group.title ?? group.key)}
                  </span>
                }
                reason={
                  group.inFlight > 0 ? (
                    <span className="text-status-submitted">
                      {t("views.workspace.rail.inFlight", { count: group.inFlight })}
                    </span>
                  ) : undefined
                }
                time={
                  <span className="flex items-center gap-2">
                    <SegBar counts={group.counts} className="h-1 w-16" />
                    {(group.counts.done ?? 0) + (group.counts.cancelled ?? 0)}/{group.memberTaskIds.length}
                  </span>
                }
                onClick={() => onFilterGroup(group.key)}
              />
            </div>
          ))}
        </Region>
      </BoardRegion>
    </>
  );

  // 主区|最近进展 分割(task_fb3ba20d66…):默认自适应(≥900px 主区 3 份|时间线 2 份,
  // ≥1400px 主区自身展开成列);用户显式排列/比例后由固定两窗接管,重置回自适应。
  // 比例按仓记忆;没有时间线(没有进展数据)时板退回无右列形态,不给分割。
  const split = useSplitLayout({
    repoId,
    slot: "work-overview",
    minRatio: 0.3,
    maxRatio: 0.8,
    defaultRatioRow: 0.6,
    defaultRatioColumn: 0.6,
    autoBreakpoint: 900,
    collapsible: false,
  });
  const splitBoard =
    split.mode === "auto" || dayGroups.length === 0
      ? undefined
      : {
          orientation: split.mode,
          ratio: split.ratio,
          containerRef: split.containerRef,
          divider: (
            <SplitDivider
              {...split.dividerProps}
              label={t("views.workspace.splitDividerLabel")}
              testId="work-overview-split-divider"
            />
          ),
        };

  return (
    <>
      {dayGroups.length > 0 ? (
        <div className="flex shrink-0 justify-end" data-testid="work-overview-split-bar">
          <SplitLayoutControls {...split.controlsProps} testId="work-overview-split-controls" />
        </div>
      ) : null}
      <RegionBoard data-testid="work-overview-board" split={splitBoard}>
        <BoardMain data-testid="work-overview-main">
          {heroCount + blocked.length + noAgent.length + running.length > 0 ? (
            <BoardColumn>{attention}</BoardColumn>
          ) : null}
          <BoardColumn>{outlook}</BoardColumn>
        </BoardMain>
        {dayGroups.length > 0 ? (
          <BoardSide region="recent" data-testid="work-timeline">
            <Region
              title={t("views.workspace.progress.title")}
              big={pathCount}
              padded
              footer={
                <>
                  <span className="min-w-0 truncate">{t("views.workspace.progress.note")}</span>
                  <button type="button" className="ml-auto shrink-0 text-accent" onClick={onOpenProgress}>
                    {t("views.workspace.progress.all")}
                  </button>
                </>
              }
            >
              <WorkDayList dayGroups={dayGroups} dayLabelOf={dayLabelOf} timeOf={timeOf} onOpenTask={onOpenTask} />
            </Region>
          </BoardSide>
        ) : null}
      </RegionBoard>
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

/** 带就地动作的行(DenseRow 两行形态,§2.4):第一行标题与右侧动作,第二行弱色报原因、
 * 动作回执与标题补充。整行点开抽屉;动作区拦下冒泡。行高只由 DenseRow 定。 */
function ActionRow({
  taskId,
  title,
  reason,
  onOpen,
  state,
  children,
}: {
  readonly taskId: string;
  readonly title: string;
  readonly reason?: string;
  readonly onOpen: (taskId: string) => void;
  readonly state?: { readonly state: string; readonly hint?: string; readonly code?: string };
  readonly children?: ReactNode;
}) {
  const { focus, supplement } = entryTitle(title);
  return (
    <div data-task-row={taskId} onClick={() => onOpen(taskId)} className="cursor-pointer hover:bg-text/5">
      <DenseRow
        relaxed
        title={focus}
        reason={metaLine([
          reason,
          state ? `${state.state}${state.code ? ` · ${state.code}` : state.hint ? ` · ${state.hint}` : ""}` : undefined,
          supplement,
        ])}
        time={
          children === undefined ? undefined : (
            <span
              className="flex items-center gap-2 font-sans"
              // 动作区不冒泡到整行:点按钮是动作,不是开抽屉。
              onClick={(event) => event.stopPropagation()}
            >
              {children}
            </span>
          )
        }
      />
    </div>
  );
}

/** 任务行(DenseRow 两行形态,任务页与概况的区域共用):第一行可选的状态标签与冒号前的标题
 * (可带搜索高亮);第二行弱色依次报执行者、卡点或等待原因、最近活动,标题冒号后的补充垫在
 * 末尾随行截断。整组状态相同时不传 tag(§2.4 重复值不进行)。 */
export function WorkTaskRow({
  task,
  needle = "",
  tag,
  agoOf,
  onOpen,
}: {
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly pinned?: boolean;
    readonly at: string;
    readonly executor?: string;
    readonly waiting?: string;
  };
  readonly needle?: string;
  readonly tag?: ReactNode;
  readonly agoOf: (iso: string) => string;
  readonly onOpen: (taskId: string) => void;
}) {
  const { focus, supplement } = entryTitle(task.title, needle);
  return (
    <DenseRow
      relaxed
      tag={tag}
      title={
        task.pinned === true ? (
          <>
            <span className="text-status-planned">● </span>
            {focus}
          </>
        ) : (
          focus
        )
      }
      reason={metaLine([
        task.executor ? `${t("views.workspace.tasks.executor")} ${task.executor}` : undefined,
        task.waiting,
        t("views.workspace.stalled.lastActivity", { ago: agoOf(task.at) }),
        supplement,
      ])}
      onClick={() => onOpen(task.taskId)}
    />
  );
}
