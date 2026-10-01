import { useMemo, useState } from "react";
import { ArrowSquareOut, Lock, PushPin, X } from "@phosphor-icons/react";
import type { EventEntry, RelationEdge, TaskRow } from "../model/types";
import { isExternal } from "../model/types";
import { normalizeTaskId } from "../model/triadic.ts";
import { CloseoutBadge, EngineBadge, FreshnessTag } from "./badges";
import { DayDigest } from "./primitives/DayDigest";
import { DenseRow } from "./primitives/DenseRow";
import { Drawer } from "./primitives/Drawer";
import { Section } from "./primitives/Section";
import { StatusTag } from "./primitives/StatusTag";
import { TitleText } from "./primitives/TitleText";
import { PhaseSteps } from "./taskDetail/PhaseSteps.tsx";
import { t } from "../i18n/index.tsx";
import { EntityRefLink } from "./EntityRefLink.tsx";
import { formatTime } from "../model/time.ts";
import { workspaceGoalLine } from "../model/workspace-narrative.ts";
import { useTaskDocumentQuery } from "../task-data.ts";
import { taskStuckItems } from "../model/task-stuck.ts";
import { StuckRows, type StuckRowCopy } from "./taskDetail/StuckRows.tsx";

/**
 * 任务预览:右侧抽屉里的任务实体详情,按视觉基线 §4 的抽屉内容契约组合——
 * 生命周期进度、要做什么、做成了什么/卡在哪、关键记录、关联任务、操作按钮。
 * 抽屉壳(定位、Esc、点外面关、进出场)由 primitives/Drawer 提供。
 * 事件流完整渲染不分批(2026-08-25 泽宇裁决),按天收束成 DayDigest。
 */
export function TaskPreviewDrawer({
  task,
  tasks,
  relations,
  onClose,
  onOpenDetail,
  onPreviewTask,
  onSetPin,
}: {
  task: TaskRow | null;
  tasks: readonly TaskRow[];
  relations: readonly RelationEdge[];
  onClose: () => void;
  onOpenDetail: (id: string) => void;
  onPreviewTask: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  // 关闭时保留最后一张卡渲染退出动画;换卡时(taskId 变)同步到最新数据。
  const [shown, setShown] = useState<TaskRow | null>(task);
  if (task !== null && task.taskId !== shown?.taskId) setShown(task);

  return (
    <Drawer
      open={task !== null}
      onClose={onClose}
      modal={false}
      ariaLabel={t("components.taskPreviewDrawer.closeTaskPreview")}
    >
      {shown !== null && (
        <TaskPreviewBody
          task={shown}
          tasks={tasks}
          relations={relations}
          onClose={onClose}
          onOpenDetail={onOpenDetail}
          onPreviewTask={onPreviewTask}
          onSetPin={onSetPin}
        />
      )}
    </Drawer>
  );
}

function TaskPreviewBody({
  task,
  tasks,
  relations,
  onClose,
  onOpenDetail,
  onPreviewTask,
  onSetPin,
}: {
  task: TaskRow;
  tasks: readonly TaskRow[];
  relations: readonly RelationEdge[];
  onClose: () => void;
  onOpenDetail: (id: string) => void;
  onPreviewTask: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  const related = relations
    .filter(
      (edge) =>
        (edge.from.startsWith("task/") && normalizeTaskId(edge.from) === task.taskId) ||
        (edge.to.startsWith("task/") && normalizeTaskId(edge.to) === task.taskId),
    )
    .map((edge) => {
      const otherRef = normalizeTaskId(edge.from) === task.taskId ? edge.to : edge.from,
        otherId = otherRef.startsWith("task/") ? normalizeTaskId(otherRef) : "";
      return { edge, task: tasks.find((candidate) => candidate.taskId === otherId) };
    })
    .filter((item) => item.task);
  // 卡在哪:只收真正的阻塞(判定见 model/task-stuck.ts)——blocked 及其原因、
  // 待返工、已 submit 后仍未通过的门/缺失文档;空了整块消失(§1.5)。
  const stuck = taskStuckItems(task);
  const gateFailedAny = task.gates.some((gate) => gate.ok === false);
  // 完整渲染,不分批(2026-08-25 泽宇裁决:性能顾虑用按需渲染解决,不转嫁给用户点击)。
  const orderedEvents = [...(task.events ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  const dayGroups = useMemo(() => groupByDay(orderedEvents), [orderedEvents]);
  const plan = useTaskDocumentQuery(task.projectId, task.taskId, "task_plan.md");
  const goal = plan.data?.status === "ready" && plan.data.body !== null ? workspaceGoalLine(plan.data.body) : null;
  const stuckCopy: StuckRowCopy = {
    dependency: t("components.taskPreviewDrawer.stuckDependency"),
    dependencyFallback: t("components.taskPreviewDrawer.stuckDependencyFallback"),
    awaits: t("components.taskPreviewDrawer.stuckAwaits"),
    cycle: t("components.taskPreviewDrawer.stuckCycle"),
    cycleDetail: t("components.taskPreviewDrawer.stuckCycleDetail"),
    rework: t("components.taskPreviewDrawer.stuckRework"),
    reworkTitle: t("components.taskPreviewDrawer.stuckReworkTitle"),
    reworkReason: (nextIteration) => t("components.taskPreviewDrawer.stuckReworkReason", { iteration: nextIteration }),
    gateFailed: t("components.taskPreviewDrawer.gateFailed"),
    missingDocument: t("components.taskPreviewDrawer.missingDocument"),
  };

  return (
    <>
      <header className="border-b border-border pb-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <EntityRefLink
                entityRef={`task/${task.taskId}`}
                onNavigate={() => onOpenDetail(task.taskId)}
                title={task.taskId}
                className="font-mono text-text-faint hover:text-accent hover:underline ui-body"
              />
              <EngineBadge engine={task.engine} locked={isExternal(task)} />
              {isExternal(task) && (
                <span className="inline-flex items-center gap-1 text-text-faint ui-meta">
                  <Lock weight="bold" />
                  {t("components.taskPreviewDrawer.readOnlySource")}
                </span>
              )}
            </div>
            <h2 className="mt-2 font-semibold leading-tight text-text ui-heading">
              <TitleText title={task.title} />
            </h2>
          </div>
          {onSetPin && (
            <button
              type="button"
              data-testid="task-preview-pin-toggle"
              onClick={() => onSetPin(task, task.pinned !== true)}
              aria-pressed={task.pinned === true}
              title={task.pinned === true ? t("views.taskDetailView.unpinTitle") : t("views.taskDetailView.pinTitle")}
              className={`grid size-8 shrink-0 place-items-center rounded-md hover:bg-surface-raised ${
                task.pinned === true ? "text-accent" : "text-text-faint hover:text-text"
              }`}
            >
              <PushPin weight={task.pinned === true ? "fill" : "bold"} />
            </button>
          )}
          <button
            onClick={onClose}
            aria-label={t("components.taskPreviewDrawer.closeTaskPreview")}
            className="grid size-8 shrink-0 place-items-center rounded-md text-text-faint hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusTag status={task.coordinationStatus} />
          {task.coordinationStatus === "blocked" && task.canonicalStatus && (
            <span className="font-mono text-status-blocked ui-micro">
              {t("components.taskPreviewDrawer.canonical")} {task.canonicalStatus}
            </span>
          )}
          <CloseoutBadge value={task.closeoutReadiness} />
          <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
        </div>
        {/* 归属一行:父任务与所属工作都是实体链接,root 不渲染。 */}
        {(task.parentTaskId ?? task.workId) && (
          <p className="mt-1.5 flex flex-wrap items-center gap-1 font-mono ui-micro text-text-faint">
            {task.parentTaskId ? (
              <EntityRefLink
                entityRef={`task/${task.parentTaskId}`}
                onNavigate={() => onOpenDetail(task.parentTaskId!)}
                title={task.parentTaskId}
                className="text-text-faint hover:text-accent hover:underline"
              />
            ) : null}
            {task.parentTaskId && task.workId ? <span>·</span> : null}
            {task.workId ? (
              <EntityRefLink
                entityRef={`task/${task.workId}`}
                onNavigate={() => onOpenDetail(task.workId!)}
                title={task.workTitle ?? task.workId}
                className="text-text-faint hover:text-accent hover:underline"
              >
                {task.workTitle ?? task.workId}
              </EntityRefLink>
            ) : null}
          </p>
        )}
      </header>

      {/* 生命周期进度:阶段投影 + 谁持有 lease(下一步谁动手)。 */}
      <Section title={t("components.taskPreviewDrawer.lifecycle")}>
        <PhaseSteps phase={task.phase} />
        <p className="mt-1 font-mono tabular-nums text-text-faint ui-meta">
          {t("components.taskPreviewDrawer.lifecycleMeta", {
            node: task.currentNode ?? "—",
            iteration: task.iteration ?? "—",
            holder: task.leaseHolder ?? t("components.taskPreviewDrawer.noLease"),
          })}
        </p>
      </Section>

      {/* 要做什么:task_plan 的 Brief 一行目标,可展开(与工作页同一提取器)。 */}
      {goal !== null && <GoalLine goal={goal} />}

      {/* 卡在哪:真正的阻塞才有块;空了整块消失(§1.5)。 */}
      {stuck.length > 0 ? (
        <Section variant="warn" title={t("components.taskPreviewDrawer.stuck")} count={stuck.length}>
          <StuckRows items={stuck} copy={stuckCopy} />
        </Section>
      ) : null}

      {/* 做成了什么:通过的门禁与就绪的收口,一句话,不画框。 */}
      {task.gates.length > 0 && !gateFailedAny ? (
        <Section title={t("components.taskPreviewDrawer.made")}>
          <p className="font-mono tabular-nums text-text-muted ui-meta">
            {t("components.taskPreviewDrawer.gatesPassed", {
              passed: task.gates.length,
              readiness: task.closeoutReadiness,
            })}
          </p>
        </Section>
      ) : null}

      {/* 关联任务:行点开另一张预览;空了整块消失。 */}
      {related.length > 0 ? (
        <Section title={t("components.taskPreviewDrawer.associatedTasks")} count={related.length}>
          {related.map(({ edge, task: relatedTask }) => (
            <DenseRow
              key={`${edge.from}-${edge.kind}-${edge.to}`}
              tag={<span className="font-mono text-text-faint ui-micro">{edge.kind}</span>}
              title={relatedTask!.taskId}
              reason={relatedTask!.title}
              onClick={() => onPreviewTask(relatedTask!.taskId)}
            />
          ))}
        </Section>
      ) : null}

      {/* 关键记录:事件按天收束,每天一组;全部渲染不分批(2026-08-25 裁决),
          天与天可各自收起,默认展开——摘要不重复正文,空了整块消失。 */}
      {dayGroups.length > 0 ? (
        <Section title={t("components.taskPreviewDrawer.keyRecords")} count={orderedEvents.length}>
          {dayGroups.map((group) => (
            <DayDigest
              key={group.day}
              day={group.day}
              defaultOpen
              summary={t("components.taskPreviewDrawer.dayRecords", { count: group.events.length })}
              paths={group.events.map((event) => ({
                time: formatTime(event.at, { style: "time" }) ?? undefined,
                name: event.summary,
                steps: [],
                ref: event.ref,
                onClick: () => onOpenDetail(task.taskId),
              }))}
            />
          ))}
        </Section>
      ) : null}

      <footer className="flex items-center gap-2 pt-3">
        <button
          onClick={() => onOpenDetail(task.taskId)}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-sm bg-accent px-3 py-2 font-semibold text-accent-fg ui-prose"
        >
          <ArrowSquareOut weight="bold" />
          {t("components.taskPreviewDrawer.openFullDetails")}
        </button>
        <button
          onClick={onClose}
          className="rounded-sm border border-border px-3 py-2 text-text-muted hover:bg-surface-raised hover:text-text ui-prose"
        >
          {t("components.taskPreviewDrawer.close")}
        </button>
      </footer>
    </>
  );
}

/** 一行目标(可展开):与工作详情页同一 Brief 提取器,收起时一行截断。 */
function GoalLine({ goal }: { readonly goal: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title={t("components.taskPreviewDrawer.goal")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`cursor-pointer whitespace-pre-line text-text-muted ui-body ${open ? "" : "line-clamp-1"}`}
      >
        {goal}
      </div>
    </Section>
  );
}

interface EventDayGroup {
  readonly day: string;
  readonly events: readonly EventEntry[];
}

function groupByDay(events: readonly EventEntry[]): EventDayGroup[] {
  const groups: { day: string; events: EventEntry[] }[] = [];
  for (const event of events) {
    const day = formatTime(event.at, { style: "date" }) ?? event.at.slice(0, 10);
    const last = groups.at(-1);
    if (last !== undefined && last.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
}
