import type { ReactNode } from "react";
import { DenseRow } from "../../components/primitives/DenseRow";
import { Region } from "../../components/primitives/Region";
import {
  BoardColumn,
  BoardMain,
  BoardRegion,
  BoardSide,
  MovableRegionBoard,
} from "../../components/primitives/RegionBoard";
import { StatusTag } from "../../components/primitives/StatusTag";
import { Button } from "../../components/primitives/Button.tsx";
import { WorkExplainerDocument } from "./WorkExplainer.tsx";
import { entryTitle, metaLine } from "./entry-lines.tsx";
import type { WorkLeafRow } from "./WorkTasksTab.tsx";
import type { AttestationPoolLanes } from "../../model/attestation-pool.ts";
import type { SnapshotStatus, TaskRow } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 工作概况首屏(业主 2026-10-21 13:50:降密度、看出终点):主区两块——「终点与剩余」
 * (Goal 原文、完成标准、完成进度、未完成任务清单:标题/阶段/负责人)与「等你裁决」
 * (空时整块不渲染);右列整列是工作说明预览。阻塞/进行中/接下来并入剩余清单的行标签,
 * 状态筛选与子组树住任务页签,按天时间线住进展页签。
 */

const actionButton = "h-6 rounded-xs border px-2.5 ui-meta disabled:opacity-60";

/** 剩余清单的排序:受阻最前,再按在途(待初审/评审中/在做)到待开工,同级置顶、最近活动在前。
 * 表外状态(unknown/archived)排在表内之后——`indexOf` 的 -1 会把它们顶到「受阻」前面。 */
const STAGE_ORDER: readonly SnapshotStatus[] = ["blocked", "submitted", "in_review", "active", "planned"],
  stageRank = (status: SnapshotStatus) => {
    const index = STAGE_ORDER.indexOf(status);
    return index === -1 ? STAGE_ORDER.length : index;
  };

export interface WorkOverviewProps {
  /** 分割偏好归属的连接(system status 仓行;task_fb3ba20d66…:比例按连接+仓记忆)。 */
  readonly connectionId: string | null;
  /** 分割偏好归属的仓。 */
  readonly repoId: string;
  /** 工作根任务:概况的工作说明预览读它的 artifacts/explainer.html(与页签同一份)。 */
  readonly rootTaskId: string;
  /** 终点区的 Goal 原文(task_plan 的 Mission/Goal/Brief 节,由读模型提取);没有就 null。 */
  readonly mission: string | null;
  /** 终点区的完成标准(task_plan 的 Exit Criteria 节清单行);没有就 null,如实缺行。 */
  readonly criteria: readonly string[] | null;
  /** 完成进度:done 是已完成可执行叶子数,total 是可执行叶子总数(页头同一来源)。 */
  readonly progress: { readonly done: number; readonly total: number };
  readonly submitted: readonly TaskRow[];
  /** 标着在做但没有 agent 在跑的任务:剩余清单里行标签换「无 agent」。 */
  readonly stalled: readonly TaskRow[];
  /** 工作的全部叶子任务(任务页同一份行);剩余清单从这里取。 */
  readonly leaves: readonly WorkLeafRow[];
  readonly lanes: AttestationPoolLanes;
  readonly agoOf: (iso: string) => string;
  readonly feedback?: (
    taskId: string,
  ) => { readonly state: string; readonly hint?: string; readonly code?: string } | undefined;
  readonly onAdjudicate?: (task: TaskRow, decision: "forward" | "return", reason: string) => void;
  readonly onAttest?: (task: Pick<TaskRow, "taskId">, gateId: string, mode: "approve" | "override") => void;
  readonly onConsent?: (task: TaskRow, reviewId: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  /** 概况预览的「打开完整工作说明」:切到工作页的工作说明页签。 */
  readonly onOpenExplainer: () => void;
}

export function WorkOverview({
  connectionId,
  repoId,
  rootTaskId,
  mission,
  criteria,
  progress,
  submitted,
  stalled,
  leaves,
  lanes,
  agoOf,
  feedback,
  onAdjudicate,
  onAttest,
  onConsent,
  onOpenTask,
  onOpenExplainer,
}: WorkOverviewProps) {
  const heroCount = submitted.length + lanes.gates.length + lanes.breakGlass.length + lanes.consents.length,
    // 「最久的等了 X」只对已提交的任务有意义;纯签发/同意的区域不带这句。
    oldest = submitted
      .map(({ lastKnownAt }) => lastKnownAt)
      .sort()
      .at(0),
    stalledIds = new Set(stalled.map(({ taskId }) => taskId)),
    recentFirst = (left: WorkLeafRow, right: WorkLeafRow) => right.at.localeCompare(left.at),
    remaining = leaves
      .filter(({ status }) => status !== "done" && status !== "cancelled")
      .sort(
        (left, right) =>
          stageRank(left.status) - stageRank(right.status) ||
          Number(right.pinned) - Number(left.pinned) ||
          recentFirst(left, right),
      );

  const goal = (
    <BoardRegion region="goal" fill data-testid="work-goal">
      <Region
        title={t("views.workspace.goal.title")}
        big={remaining.length}
        bigTone={remaining.length > 0 ? "active" : "done"}
        footer={t("views.workspace.progressNumbers", {
          done: progress.done,
          total: progress.total,
          percent: Math.round((progress.done / Math.max(1, progress.total)) * 100),
        })}
      >
        {mission !== null ? (
          <p data-testid="work-goal-mission" className="break-words px-3.5 pb-2 pt-1 text-text ui-body">
            {mission}
          </p>
        ) : null}
        {criteria !== null ? (
          <div className="px-3.5 pb-2">
            <p className="mb-1 text-text-faint ui-meta">{t("views.workspace.goal.criteria")}</p>
            <ul className="space-y-0.5">
              {criteria.map((line, index) => (
                <li key={`${index}:${line}`} className="break-words text-text-muted ui-body">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {remaining.length > 0 ? (
          <div className="border-t border-border">
            {remaining.map((leaf) => (
              <div
                key={leaf.taskId}
                data-task-row={leaf.taskId}
                className={leaf.status === "active" ? "live-row" : undefined}
              >
                <WorkTaskRow
                  task={leaf}
                  /* 阶段标签答「卡在哪一步」;标着在做但没 agent 的行换「无 agent」答「卡在谁手上」。 */
                  tag={
                    stalledIds.has(leaf.taskId) ? (
                      <StatusTag tone="wait" label={t("views.workspace.goal.noAgent")} />
                    ) : (
                      <StatusTag status={leaf.status} />
                    )
                  }
                  agoOf={agoOf}
                  onOpen={onOpenTask}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="px-3.5 py-3 text-text-faint ui-body">{t("views.workspace.goal.done")}</p>
        )}
      </Region>
    </BoardRegion>
  );

  const hero = heroCount > 0 && (
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
  );

  /* 工作说明预览:与工作说明页签同一份根任务文档、同一个隔离 renderer;独占右列整列
     (不再与时间线对半分),长页面滚动留在 guest 内部;「打开完整工作说明」留在区域框上。 */
  const explainer = (
    <BoardSide region="explainer" data-testid="work-explainer">
      <Region
        title={t("views.workspace.explainer.regionTitle")}
        padded
        footer={
          <span className="ml-auto">
            <Button size="sm" variant="ghost" testId="work-explainer-open-full" onClick={onOpenExplainer}>
              {t("views.workspace.explainer.openFull")}
            </Button>
          </span>
        }
      >
        <WorkExplainerDocument repoId={repoId} taskId={rootTaskId} />
      </Region>
    </BoardSide>
  );

  return (
    <MovableRegionBoard connectionId={connectionId} repoId={repoId} slot="work-overview" testId="work-overview-board">
      <BoardMain data-testid="work-overview-main">
        <BoardColumn>
          {goal}
          {hero || null}
        </BoardColumn>
      </BoardMain>
      {explainer}
    </MovableRegionBoard>
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
