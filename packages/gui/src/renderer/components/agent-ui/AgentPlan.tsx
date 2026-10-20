import { Fragment, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { LayoutGroup, motion } from "motion/react";
import { ArrowCounterClockwise, ListPlus, PencilSimple, X } from "@phosphor-icons/react";
import { formatDuration } from "../../model/time.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";
import { Button } from "../primitives/Button.tsx";
import { StatusTag, type StatusTone } from "../primitives/StatusTag.tsx";
import { steerNoteLayoutId, type SteerNote } from "./AgentSteering.tsx";

/**
 * 任务步骤级执行与审查面板(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Affect UI AgentPlan):
 * 运行前(editing)支持重命名、@dnd-kit/core 拖拽调序、增删步骤;运行中(running)展示
 * 当前激活步骤、每步实时计时器,失败步骤原位「从此步重试」;已吸收的插话纸条以
 * layoutId 渲染进步骤卡(AgentSteering 队列 → 这里,FLIP 滑入)。
 *
 * 状态归调用方:所有变更经 onRename/onAdd/onRemove/onReorder/onRetryFromStep 回调;
 * 拖拽只在 editing 态启用(任务书约束),排序算法 moveStepBefore 为纯函数导出供直证。
 * 计时器纪律:注入 nowMs 时不建 interval;未注入时仅 running 态存在执行中步骤才
 * 1s tick,卸载、切换 editing 或步骤收口即清理。
 * 原语复用(CEO 返工裁定 F2/F3):状态词经 StatusTag(tone+label),按钮经
 * primitives/Button,文案经 agentUi.* i18n;拖拽手柄是 dnd-kit 激活器而非命令按钮
 * (attributes/listeners 必须原地展开,Button 不透传),保留原生 button 并在此说明。
 */

export type PlanStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: PlanStepStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** 已吸收的插话纸条(从 AgentSteering 队列滑入)。 */
  readonly steerNotes?: readonly SteerNote[];
}

/** 步骤状态的非文字表面配色(左缘状态条)。 */
const STEP_COLOR: Record<PlanStepStatus, string> = {
  pending: "var(--color-status-planned)",
  running: "var(--color-status-active)",
  done: "var(--color-status-done)",
  failed: "var(--color-danger)",
  skipped: "var(--color-status-cancelled)",
};

/** 步骤状态词 → StatusTag tone(CEO 映射:pending→plan、skipped→cancel,其余同名族)。 */
const STEP_TONE: Record<PlanStepStatus, StatusTone> = {
  pending: "plan",
  running: "active",
  done: "done",
  failed: "bad",
  skipped: "cancel",
};

/** 步骤状态词的 i18n 键。 */
const STEP_KEY: Record<PlanStepStatus, MessageKey> = {
  pending: "agentUi.plan.status.pending",
  running: "agentUi.plan.status.running",
  done: "agentUi.plan.status.done",
  failed: "agentUi.plan.status.failed",
  skipped: "agentUi.plan.status.skipped",
};

/** 拖拽调序纯函数:把 draggedId 移到 beforeStepId 之前;beforeStepId="end" 移到末尾。 */
export function moveStepBefore(stepIds: readonly string[], draggedId: string, beforeStepId: string | "end"): string[] {
  const without = stepIds.filter((id) => id !== draggedId);
  if (without.length === stepIds.length) return [...stepIds];
  const insertAt = beforeStepId === "end" ? without.length : without.indexOf(beforeStepId);
  if (insertAt < 0) return [...stepIds];
  without.splice(insertAt, 0, draggedId);
  return without;
}

const draggableIdOf = (stepId: string) => `plan-step-${stepId}`;
const droppableIdOf = (before: string) => `plan-insert-${before}`;
const parseDraggableId = (id: string | number): string | null =>
  typeof id === "string" && id.startsWith("plan-step-") ? id.slice("plan-step-".length) : null;
const parseInsertId = (id: string | number): string | "end" | null =>
  typeof id === "string" && id.startsWith("plan-insert-") ? id.slice("plan-insert-".length) : null;

function InsertZone({ before, testId }: { readonly before: string; readonly testId?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableIdOf(before) });
  return (
    <div
      ref={setNodeRef}
      aria-hidden
      data-testid={testId !== undefined ? `${testId}-zone-${before}` : undefined}
      className={`shrink-0 rounded-full transition-all ${isOver ? "h-1.5 bg-accent" : "mx-2 h-px bg-border"}`}
    />
  );
}

function StepRow({
  step,
  editing,
  elapsedText,
  onRename,
  onRemove,
  onRetryFromStep,
  testId,
}: {
  readonly step: PlanStep;
  readonly editing: boolean;
  readonly elapsedText: string | null;
  readonly onRename: (id: string, title: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onRetryFromStep: (id: string) => void;
  readonly testId?: string;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: draggableIdOf(step.id),
    disabled: !editing,
  });
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(step.title);
  const color = STEP_COLOR[step.status];
  const running = step.status === "running";

  const commitRename = () => {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed !== "" && trimmed !== step.title) onRename(step.id, trimmed);
    else setDraft(step.title);
  };

  return (
    <li
      ref={setNodeRef}
      data-plan-status={step.status}
      data-testid={testId !== undefined ? `${testId}-step-${step.id}` : undefined}
      className={running ? "live-row" : ""}
      style={{
        opacity: isDragging ? 0.4 : 1,
        display: "flex",
        minHeight: 32,
        flexDirection: "column",
        gap: 4,
        borderRadius: "var(--radius-sm)",
        borderLeft: `2px solid ${color}`,
        paddingLeft: 8,
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {editing && (
          /* 拖拽手柄是 dnd-kit 激活器:attributes/listeners 必须原地展开到激活元素,
             primitives/Button 不透传这组 props,故保留原生 button(CEO 裁定 F2 例外)。 */
          <button
            type="button"
            aria-label={t("agentUi.plan.dragHandle", { title: step.title })}
            title={t("agentUi.plan.dragHandleTip")}
            {...attributes}
            {...listeners}
            data-testid={testId !== undefined ? `${testId}-handle-${step.id}` : undefined}
            className="ui-control inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-xs text-text-faint hover:text-text"
          >
            ⠿
          </button>
        )}
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") {
                setDraft(step.title);
                setRenaming(false);
              }
            }}
            aria-label={t("agentUi.plan.stepTitle")}
            data-testid={testId !== undefined ? `${testId}-rename-${step.id}` : undefined}
            className="ui-control min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-1.5 ui-meta"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate ui-meta text-text">{step.title}</span>
        )}
        <StatusTag tone={STEP_TONE[step.status]} label={t(STEP_KEY[step.status])} mono />
        {elapsedText !== null && (
          <span
            className="shrink-0 font-mono tabular-nums ui-micro text-text-muted"
            data-testid={testId !== undefined ? `${testId}-elapsed-${step.id}` : undefined}
          >
            {elapsedText}
          </span>
        )}
        {step.status === "failed" && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => onRetryFromStep(step.id)}
            testId={testId !== undefined ? `${testId}-retry-${step.id}` : undefined}
          >
            <ArrowCounterClockwise aria-hidden />
            {t("agentUi.plan.retryFromStep")}
          </Button>
        )}
        {editing && (
          <>
            <Button
              variant="ghost"
              size="sm"
              ariaLabel={t("agentUi.plan.renameStep", { title: step.title })}
              onClick={() => setRenaming(true)}
              testId={testId !== undefined ? `${testId}-edit-${step.id}` : undefined}
            >
              <PencilSimple aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              ariaLabel={t("agentUi.plan.removeStep", { title: step.title })}
              onClick={() => onRemove(step.id)}
              testId={testId !== undefined ? `${testId}-remove-${step.id}` : undefined}
            >
              <X aria-hidden />
            </Button>
          </>
        )}
      </div>
      {(step.steerNotes?.length ?? 0) > 0 && (
        <div className="flex min-w-0 flex-col gap-1 pl-6">
          {step.steerNotes!.map((note) => (
            <motion.div
              key={note.id}
              layoutId={steerNoteLayoutId(note.id)}
              data-testid={testId !== undefined ? `${testId}-note-${note.id}` : undefined}
              className="rounded-xs border px-2 py-1 ui-micro"
              style={{
                borderColor: "color-mix(in oklch, var(--color-agent-question-border) 100%, transparent)",
                background: "var(--color-agent-question-surface)",
              }}
            >
              <span className="min-w-0 whitespace-pre-wrap break-words">{note.text}</span>
            </motion.div>
          ))}
        </div>
      )}
    </li>
  );
}

export function AgentPlan({
  steps,
  phase,
  nowMs,
  onRename,
  onAdd,
  onRemove,
  onReorder,
  onRetryFromStep,
  layoutGroupId,
  testId,
}: {
  readonly steps: readonly PlanStep[];
  /** editing=运行前(可重命名/调序/增删);running=运行中(计时/重试)。 */
  readonly phase: "editing" | "running";
  /** 测试注入的基准时间;给出时不建 interval。 */
  readonly nowMs?: number;
  readonly onRename?: (id: string, title: string) => void;
  readonly onAdd?: () => void;
  readonly onRemove?: (id: string) => void;
  /** 拖拽/键盘调序后回传新的步骤 id 顺序。 */
  readonly onReorder?: (orderedIds: readonly string[]) => void;
  readonly onRetryFromStep?: (id: string) => void;
  /** 与 AgentSteering 传同一 id,插话纸条 FLIP 滑入跨组件生效。 */
  readonly layoutGroupId?: string;
  readonly testId?: string;
}) {
  const [liveNow, setLiveNow] = useState(() => nowMs ?? Date.now());
  const now = nowMs ?? liveNow;
  const hasRunningStep = useMemo(() => steps.some((step) => step.status === "running"), [steps]);
  const editing = phase === "editing";

  useEffect(() => {
    if (nowMs !== undefined || !hasRunningStep) return;
    const timer = setInterval(() => setLiveNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [nowMs, hasRunningStep]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const [dragging, setDragging] = useState<PlanStep | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    const stepId = parseDraggableId(event.active.id);
    setDragging(steps.find((step) => step.id === stepId) ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    if (onReorder === undefined || !editing) return;
    const draggedId = parseDraggableId(event.active.id);
    if (draggedId === null || event.over === null) return;
    const beforeFromInsert = parseInsertId(event.over.id);
    if (beforeFromInsert !== null) {
      onReorder(
        moveStepBefore(
          steps.map((step) => step.id),
          draggedId,
          beforeFromInsert,
        ),
      );
      return;
    }
    const targetStepId = parseDraggableId(event.over.id);
    if (targetStepId !== null && targetStepId !== draggedId) {
      onReorder(
        moveStepBefore(
          steps.map((step) => step.id),
          draggedId,
          targetStepId,
        ),
      );
    }
  };

  const elapsedTextOf = (step: PlanStep): string | null => {
    if (step.status === "running" && step.startedAt !== undefined)
      return formatDuration(Math.max(0, now - step.startedAt));
    if (step.endedAt !== undefined && step.startedAt !== undefined)
      return formatDuration(Math.max(0, step.endedAt - step.startedAt));
    return null;
  };

  const list = (
    <div data-testid={testId} data-plan-phase={phase} className="flex min-w-0 flex-col gap-1.5">
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <ol className="flex min-w-0 flex-col" style={{ gap: 0 }}>
          {steps.map((step) => (
            <Fragment key={step.id}>
              {editing && <InsertZone before={step.id} testId={testId} />}
              <StepRow
                step={step}
                editing={editing}
                elapsedText={elapsedTextOf(step)}
                onRename={onRename ?? (() => {})}
                onRemove={onRemove ?? (() => {})}
                onRetryFromStep={onRetryFromStep ?? (() => {})}
                testId={testId}
              />
            </Fragment>
          ))}
          {editing && <InsertZone before="end" testId={testId} />}
        </ol>
        <DragOverlay dropAnimation={null}>
          {dragging !== null ? (
            <div className="rounded-sm border border-border-strong bg-surface-raised px-2 py-1 ui-meta shadow-lg">
              {dragging.title}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {editing && onAdd !== undefined && (
        <Button variant="ghost" size="sm" onClick={onAdd} testId={testId !== undefined ? `${testId}-add` : undefined}>
          <ListPlus aria-hidden />
          {t("agentUi.plan.addStep")}
        </Button>
      )}
    </div>
  );

  return layoutGroupId !== undefined ? <LayoutGroup id={layoutGroupId}>{list}</LayoutGroup> : list;
}
