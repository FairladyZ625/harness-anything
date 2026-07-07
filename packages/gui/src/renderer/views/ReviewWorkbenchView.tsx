import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  WarningCircle,
} from "@phosphor-icons/react";
import type { TaskRow } from "../model/types";
import { CloseoutBadge } from "../components/badges";
import { TaskFilterBar } from "../components/TaskFilterBar";
import type { TaskFilters } from "../model/taskFilters";
import {
  NOW,
  fmtHours,
  nowClock,
  type Verdict,
  type QueueTab,
  type SessionRecord,
} from "../components/review/shared";
import { QueueRow } from "../components/review/QueueRow";
import { CurrentReview } from "../components/review/CurrentReview";

export function ReviewWorkbenchView({
  tasks,
  allTasks,
  filters,
  onFiltersChange,
  onSelect,
  onUpdate,
}: {
  tasks: TaskRow[];
  allTasks: TaskRow[];
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<TaskRow>) => void;
}) {
  const [tab, setTab] = useState<QueueTab>("ready");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const seqRef = useRef(0);

  const readyList = useMemo(
    () => tasks.filter((task) => task.closeoutReadiness === "ready"),
    [tasks],
  );
  const failedList = useMemo(
    () => tasks.filter((task) => task.closeoutReadiness === "failed"),
    [tasks],
  );
  const queue = tab === "failed" ? failedList : readyList;
  const byId = useMemo(() => new Map(allTasks.map((task) => [task.taskId, task])), [allTasks]);
  const currentTask =
    (currentId ? byId.get(currentId) : undefined) ?? queue[0] ?? undefined;

  useEffect(() => {
    if (!currentId && queue[0]) setCurrentId(queue[0].taskId);
    if (currentId && !byId.has(currentId)) setCurrentId(queue[0]?.taskId ?? null);
  }, [byId, currentId, queue]);

  const addRecord = (taskId: string, verdict: Verdict) => {
    const at = nowClock();
    setRecords((prev) => [
      { seq: ++seqRef.current, taskId, verdict, note, at },
      ...prev,
    ]);
    setNote("");
  };

  const judge = (verdict: Verdict) => {
    if (!currentTask) return;
    onUpdate(currentTask.taskId, { closeoutReadiness: verdict });
    addRecord(currentTask.taskId, verdict);
    const next = queue.find((task) => task.taskId !== currentTask.taskId);
    setCurrentId(next?.taskId ?? null);
  };

  const undo = (record: SessionRecord) => {
    onUpdate(record.taskId, { closeoutReadiness: "ready" });
    setRecords((prev) => prev.filter((item) => item.seq !== record.seq));
    setCurrentId(record.taskId);
  };

  const stats = useMemo(() => {
    const byModule = new Map<string, number>();
    const byEngine = new Map<string, number>();
    for (const task of readyList) {
      byModule.set(task.module, (byModule.get(task.module) ?? 0) + 1);
      byEngine.set(task.engine, (byEngine.get(task.engine) ?? 0) + 1);
    }
    const waits = readyList
      .filter((task) => task.waitingSince)
      .map((task) => (NOW - new Date(task.waitingSince!).getTime()) / 3.6e6);
    const avg = waits.length ? waits.reduce((sum, h) => sum + h, 0) / waits.length : 0;
    return {
      byModule: [...byModule.entries()].sort((a, b) => b[1] - a[1]),
      byEngine: [...byEngine.entries()].sort((a, b) => b[1] - a[1]),
      avg,
    };
  }, [readyList]);

  const tabs: { id: QueueTab; label: string; count: number }[] = [
    { id: "ready", label: "待审", count: readyList.length },
    { id: "failed", label: "已打回", count: failedList.length },
    { id: "session", label: "本会话", count: records.length },
  ];

  return (
    <div className="flex h-full flex-1 flex-col">
      {/* 三元语概念转向说明（E45/圆桌：闸门装反过） */}
      <div className="flex items-start gap-2 border-b border-stale/30 bg-stale/10 px-4 py-2 text-[12px] text-stale">
        <WarningCircle weight="bold" className="mt-0.5 shrink-0" />
        <div>
          <span className="font-semibold">此台 = task 收口（机械层）</span>
          ：审的是「活干完没有 + gates 是否过」。这是 A 轴（可验证），不该是人盯的主闸门。
          <span className="ml-1 text-text-muted">
            承重的 B 轴（产出接不接受、决策裁不裁）→ 去 <b>「决策裁决」</b> 视图。无争议的收口应自动过；
            只「产出承重」的才进决策队列（E49：低 risk 自动过，不每 task 产 decision）。
          </span>
        </div>
      </div>
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="ui-title font-semibold">审阅工作台</h1>
          <span className="font-mono text-[13px] text-text-faint">
            队列 → 当前对象 → gates/history
          </span>
          <div className="ml-auto flex items-center gap-1 rounded-md border border-border p-0.5">
            {tabs.map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`rounded px-3 py-1.5 text-[13px] ${
                  tab === item.id
                    ? "bg-surface-raised text-text"
                    : "text-text-muted hover:text-text"
                }`}
              >
                {item.label}{" "}
                <span className="font-mono text-[12px]">{item.count}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      <TaskFilterBar
        tasks={allTasks}
        filteredCount={tasks.length}
        filters={filters}
        onChange={onFiltersChange}
        contextLabel="审阅工作台"
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[300px_minmax(0,1fr)_240px]">
        <aside className="flex min-h-0 flex-col rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-3 py-2">
            <div className="text-[15px] font-semibold">
              {tab === "ready" ? "待审队列" : tab === "failed" ? "已打回队列" : "本会话记录"}
            </div>
            <div className="font-mono text-[12px] text-text-faint">
              {tab === "session" ? `${records.length} records` : `${queue.length} tasks`}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {tab === "session" ? (
              records.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-5 text-[14px] text-text-faint">
                  本会话尚无判定记录
                </div>
              ) : (
                <div className="space-y-2">
                  {records.map((record) => (
                    <div
                      key={record.seq}
                      className="rounded-lg border border-border bg-surface-raised px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px]">{record.taskId}</span>
                        <CloseoutBadge value={record.verdict} />
                      </div>
                      <div className="mt-1 font-mono text-[12px] text-text-faint">
                        {record.at}
                      </div>
                      {record.note && (
                        <div className="mt-1 line-clamp-2 text-[13px] text-text-muted">
                          {record.note}
                        </div>
                      )}
                      <button
                        onClick={() => undo(record)}
                        className="mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-text-muted hover:bg-surface hover:text-text"
                      >
                        <ArrowCounterClockwise weight="bold" />
                        撤销
                      </button>
                    </div>
                  ))}
                </div>
              )
            ) : queue.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-5 text-[14px] text-text-faint">
                当前筛选下无任务
              </div>
            ) : (
              <div className="space-y-2">
                {queue.map((task) => (
                  <QueueRow
                    key={task.taskId}
                    task={task}
                    active={currentTask?.taskId === task.taskId}
                    onSetCurrent={setCurrentId}
                    onPreview={onSelect}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        <CurrentReview
          task={tab === "session" ? undefined : currentTask}
          note={note}
          onNote={setNote}
          onJudge={judge}
          onPreview={onSelect}
        />

        <aside className="min-h-0 overflow-y-auto rounded-lg border border-border bg-surface px-3 py-3">
          <div className="space-y-4">
            <div>
              <div className="font-mono text-[12px] uppercase tracking-wide text-text-faint">
                待审总数
              </div>
              <div className="mt-1 font-mono text-[28px] font-semibold">
                {readyList.length}
              </div>
              <div className="text-[13px] text-text-faint">
                平均等待 {fmtHours(stats.avg)}
              </div>
            </div>

            <div>
              <div className="mb-1 font-mono text-[12px] uppercase tracking-wide text-text-faint">
                by module
              </div>
              <div className="space-y-1">
                {stats.byModule.map(([key, count]) => (
                  <div key={key} className="flex items-center justify-between text-[14px]">
                    <span className="font-mono text-text-muted">{key}</span>
                    <span className="font-mono">{count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1 font-mono text-[12px] uppercase tracking-wide text-text-faint">
                by engine
              </div>
              <div className="space-y-1">
                {stats.byEngine.map(([key, count]) => (
                  <div key={key} className="flex items-center justify-between text-[14px]">
                    <span className="font-mono text-text-muted">{key}</span>
                    <span className="font-mono">{count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-surface-raised px-3 py-2">
              <div className="font-mono text-[12px] uppercase tracking-wide text-text-faint">
                操作原则
              </div>
              <p className="mt-1 text-[14px] leading-snug text-text-muted">
                任务标题先打开预览抽屉；当前审阅对象只负责判定与记录，不丢失队列上下文。
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
