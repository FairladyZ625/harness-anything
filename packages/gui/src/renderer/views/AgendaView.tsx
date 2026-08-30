import { PushPin } from "@phosphor-icons/react";
import type { AgendaAwaitingRow, AgendaTaskRow } from "../../api/renderer-dto.ts";
import { StatusBadge } from "../components/badges";
import type { TaskRow } from "../model/types";
import { formatTime } from "../model/time.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import type { AgendaSuccess } from "../api-client.ts";

/** 议程段定义:段名与 CEO tick 读到的 `ha agenda` 四段同名,pinned 是唯一人工输入。 */
export type AgendaSectionId = "pinned" | "inFlight" | "awaitingDecision" | "dispatchable" | "waitingOnOthers";

export interface AgendaSegment {
  readonly id: AgendaSectionId;
  readonly rows: readonly AgendaRow[];
}

export type AgendaRow =
  | { readonly kind: "task"; readonly row: AgendaTaskRow; readonly origin: AgendaSectionId | null }
  | { readonly kind: "awaiting"; readonly row: AgendaAwaitingRow };

/**
 * 议程分组的纯前端切面:分组判定与组内 pin 置顶全部来自 daemon 投影,这里只做
 * 「pinned 段跨组收拢 + 其余任务段去 pinned」的展示编排——pinned 任务在自己段里带
 * 来源段标签,不在两个段里重复出现。
 */
export function agendaSegments(agenda: AgendaSuccess): readonly AgendaSegment[] {
  const pinnedRows: AgendaRow[] = [];
  const drop = new Set<string>();
  for (const origin of ["inFlight", "waitingOnOthers", "dispatchable"] as const) {
    for (const row of agenda[origin]) {
      if (row.pinned !== true) continue;
      drop.add(row.taskId);
      pinnedRows.push({ kind: "task", row, origin });
    }
  }
  const remaining = (rows: readonly AgendaTaskRow[]): AgendaRow[] =>
    rows.filter((row) => !drop.has(row.taskId)).map((row) => ({ kind: "task", row, origin: null }));
  return [
    { id: "pinned", rows: pinnedRows },
    { id: "inFlight", rows: remaining(agenda.inFlight) },
    { id: "awaitingDecision", rows: agenda.awaitingDecision.map((row) => ({ kind: "awaiting", row })) },
    { id: "dispatchable", rows: remaining(agenda.dispatchable) },
    { id: "waitingOnOthers", rows: remaining(agenda.waitingOnOthers) },
  ];
}

/**
 * 行/标记的样式常量:拆成数组片段而不是一条长串,让格式化后的每一行都留在
 * 120 列以内(G36 line-density 的判据是「新增的过长行」)。
 */
const ROW_CLASS = [
  "cv-auto-4-5r flex w-full items-start gap-2 rounded-md",
  "border border-border bg-surface-raised px-2 py-1.5 text-left",
].join(" ");

const PIN_MARKER_CLASS = [
  "mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded",
  "border border-accent/40 px-1 font-mono text-[10px] text-accent",
].join(" ");

const PIN_BUTTON_CLASS = [
  "mt-0.5 inline-flex shrink-0 items-center justify-center rounded",
  "p-0.5 text-[13px] hover:bg-surface",
].join(" ");

const SECTION_HEADING_CLASS = [
  "flex items-baseline gap-2 px-1 font-mono text-[12px]",
  "uppercase tracking-wide text-text-faint",
].join(" ");

const SECTION_TITLE_KEY: Record<AgendaSectionId, MessageKey> = {
  pinned: "views.agendaView.sectionPinned",
  inFlight: "views.agendaView.sectionInFlight",
  awaitingDecision: "views.agendaView.sectionAwaiting",
  dispatchable: "views.agendaView.sectionDispatchable",
  waitingOnOthers: "views.agendaView.sectionWaiting",
};

function TaskAgendaRow({
  row,
  origin,
  onSelect,
  onSetPin,
  taskById,
}: {
  readonly row: AgendaTaskRow;
  readonly origin: AgendaSectionId | null;
  readonly onSelect: (taskId: string) => void;
  readonly onSetPin?: (task: TaskRow, pinned: boolean) => void;
  readonly taskById: ReadonlyMap<string, TaskRow>;
}) {
  const task = taskById.get(row.taskId);
  return (
    <div data-testid="agenda-task-row" className={ROW_CLASS}>
      {row.pinned === true && (
        <span data-testid="agenda-pinned-marker" title={t("views.agendaView.pinnedToday")} className={PIN_MARKER_CLASS}>
          <PushPin weight="fill" />
        </span>
      )}
      <button
        type="button"
        onClick={() => onSelect(row.taskId)}
        className="min-w-0 flex-1 text-left"
        title={row.taskId}
      >
        <p className="truncate text-[13px] text-text">
          <span className="font-mono text-[11px] text-text-faint">{row.taskId} </span>
          {row.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-text-faint">
          <StatusBadge status={row.status} />
          {origin !== null && <span>{t(SECTION_TITLE_KEY[origin])}</span>}
          {row.leaseExecutionId !== null && <span>lease={row.leaseExecutionId}</span>}
          {row.activeExecutionIds.length > 0 && <span>executions={row.activeExecutionIds.join(",")}</span>}
          <span>blocking={row.blockingAssessment.state}</span>
          <span>{formatTime(row.updatedAt, { style: "month-day-time" }) ?? "—"}</span>
        </p>
      </button>
      {onSetPin && task && (
        <button
          type="button"
          data-testid={`agenda-pin-toggle-${row.taskId}`}
          onClick={() => onSetPin(task, row.pinned !== true)}
          aria-pressed={row.pinned === true}
          title={row.pinned === true ? t("views.agendaView.unpinTitle") : t("views.agendaView.pinTitle")}
          className={[
            PIN_BUTTON_CLASS,
            row.pinned === true ? "text-accent" : "text-text-faint hover:text-text-muted",
          ].join(" ")}
        >
          <PushPin weight={row.pinned === true ? "fill" : "bold"} />
        </button>
      )}
    </div>
  );
}

function AwaitingRow({
  row,
  onSelectTask,
  onNavigateDecision,
}: {
  readonly row: AgendaAwaitingRow;
  readonly onSelectTask: (taskId: string) => void;
  readonly onNavigateDecision: (decisionId: string) => void;
}) {
  return row.kind === "decision" ? (
    <div data-testid="agenda-decision-row" className={ROW_CLASS}>
      <button
        type="button"
        onClick={() => onNavigateDecision(row.decisionId)}
        className="min-w-0 flex-1 text-left"
        title={row.decisionId}
      >
        <p className="truncate text-[13px] text-text">
          <span className="font-mono text-[11px] text-text-faint">{row.decisionId} </span>
          {row.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-text-faint">
          <span>{t("views.agendaView.proposedDecision")}</span>
          <span>risk={row.riskTier}</span>
          <span>urgency={row.urgency}</span>
          <span>{formatTime(row.proposedAt, { style: "month-day-time" }) ?? "—"}</span>
        </p>
      </button>
    </div>
  ) : (
    <div data-testid="agenda-execution-row" className={ROW_CLASS}>
      {row.pinned === true && (
        <span data-testid="agenda-pinned-marker" className={PIN_MARKER_CLASS}>
          <PushPin weight="fill" />
        </span>
      )}
      <button type="button" onClick={() => onSelectTask(row.taskId)} className="min-w-0 flex-1 text-left">
        <p className="truncate text-[13px] text-text">
          <span className="font-mono text-[11px] text-text-faint">{row.executionId} </span>
          {row.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-text-faint">
          <span>{t("views.agendaView.submittedExecution")}</span>
          <span className="font-mono">{row.taskId}</span>
          <span>{formatTime(row.submittedAt, { style: "month-day-time" }) ?? "—"}</span>
        </p>
      </button>
    </div>
  );
}

export function AgendaView({
  agenda,
  tasks,
  onSelect,
  onNavigateDecision,
  onSetPin,
}: {
  readonly agenda: AgendaSuccess | undefined;
  readonly tasks: readonly TaskRow[];
  readonly onSelect: (taskId: string) => void;
  readonly onNavigateDecision: (decisionId: string) => void;
  readonly onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  if (agenda === undefined)
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-border px-4 py-3">
          <h1 className="ui-title font-semibold">{t("views.agendaView.title")}</h1>
        </header>
        <div className="grid h-full place-items-center">
          <span className="font-mono text-[13px] text-text-faint">{t("views.agendaView.reading")}</span>
        </div>
      </div>
    );
  const segments = agendaSegments(agenda),
    taskById = new Map(tasks.map((task) => [task.taskId, task]));
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="ui-title font-semibold">{t("views.agendaView.title")}</h1>
          <span className="font-mono text-[13px] text-text-faint">{t("views.agendaView.subtitle")}</span>
          <span data-testid="agenda-projection-status" className="ml-auto font-mono text-[12px] text-text-faint">
            {agenda.status === "ready"
              ? t("views.agendaView.watermarkReady", {
                  watermark: String(agenda.watermark),
                  sourceRevision: String(agenda.sourceRevision),
                })
              : t("views.agendaView.watermarkCatchingUp", {
                  watermark: String(agenda.watermark),
                  sourceRevision: String(agenda.sourceRevision),
                })}
          </span>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {segments.map((segment) => (
            <section
              key={segment.id}
              data-testid={`agenda-section-${segment.id}`}
              className="flex min-h-0 flex-col gap-1.5 rounded-lg border border-border bg-surface p-2"
            >
              <h2 className={SECTION_HEADING_CLASS}>
                {segment.id === "pinned" ? <PushPin weight="fill" className="text-accent" /> : null}
                {t(SECTION_TITLE_KEY[segment.id])}
                <span className="ml-auto" data-testid={`agenda-count-${segment.id}`}>
                  {segment.rows.length}
                </span>
              </h2>
              {segment.rows.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-2 py-3 text-[12px] text-text-faint">
                  {t("views.agendaView.emptySection")}
                </p>
              ) : (
                segment.rows.map((row) =>
                  row.kind === "task" ? (
                    <TaskAgendaRow
                      key={`task/${row.row.taskId}`}
                      row={row.row}
                      origin={row.origin}
                      onSelect={onSelect}
                      onSetPin={onSetPin}
                      taskById={taskById}
                    />
                  ) : (
                    <AwaitingRow
                      key={
                        row.row.kind === "decision"
                          ? `decision/${row.row.decisionId}`
                          : `execution/${row.row.executionId}`
                      }
                      row={row.row}
                      onSelectTask={onSelect}
                      onNavigateDecision={onNavigateDecision}
                    />
                  ),
                )
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
