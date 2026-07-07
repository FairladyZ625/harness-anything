import { useEffect } from "react";
import {
  ArrowSquareOut,
  CheckCircle,
  Lock,
  X,
  XCircle,
} from "@phosphor-icons/react";
import type { EventEntry, RelationEdge, TaskRow } from "../model/types";
import { isExternal } from "../model/types";
import {
  CloseoutBadge,
  EngineBadge,
  FreshnessTag,
  StatusBadge,
} from "./badges";

const timeOf = (iso: string) => iso.slice(5, 16).replace("T", " ");

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border px-4 py-3">
      <div className="mb-2 font-mono text-[12px] uppercase tracking-wide text-text-faint">
        {title}
      </div>
      {children}
    </section>
  );
}

export function TaskPreviewDrawer({
  task,
  tasks,
  relations,
  events,
  onClose,
  onOpenDetail,
  onPreviewTask,
}: {
  task: TaskRow | null;
  tasks: TaskRow[];
  relations: RelationEdge[];
  events: EventEntry[];
  onClose: () => void;
  onOpenDetail: (id: string) => void;
  onPreviewTask: (id: string) => void;
}) {
  useEffect(() => {
    if (!task) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, task]);

  if (!task) return null;

  const related = relations
    .filter((edge) => edge.from === task.taskId || edge.to === task.taskId)
    .map((edge) => {
      const otherId = edge.from === task.taskId ? edge.to : edge.from;
      return { edge, task: tasks.find((candidate) => candidate.taskId === otherId) };
    })
    .filter((item) => item.task);
  const missingDocs = task.docs.filter((doc) => doc.required && !doc.present);
  const taskEvents = events
    .filter((event) => event.taskId === task.taskId)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 4);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-bg/45">
      <aside className="flex h-full w-full max-w-[520px] flex-col border-l border-border-strong bg-surface shadow-2xl shadow-black/40">
        <header className="border-b border-border px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] text-text-faint">
                  {task.taskId}
                </span>
                <EngineBadge engine={task.engine} locked={isExternal(task)} />
                {isExternal(task) && (
                  <span className="inline-flex items-center gap-1 text-[12px] text-text-faint">
                    <Lock weight="bold" />
                    只读源
                  </span>
                )}
              </div>
              <h2 className="mt-2 text-[20px] font-semibold leading-tight text-text">
                {task.title}
              </h2>
            </div>
            <button
              onClick={onClose}
              aria-label="关闭任务预览"
              className="grid size-8 shrink-0 place-items-center rounded-md text-text-faint hover:bg-surface-raised hover:text-text"
            >
              <X weight="bold" />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusBadge status={task.coordinationStatus} />
            <CloseoutBadge value={task.closeoutReadiness} />
            <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title="上下文">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[14px]">
              <div>
                <dt className="font-mono text-[12px] text-text-faint">module</dt>
                <dd className="font-mono text-text">{task.module}</dd>
              </div>
              <div>
                <dt className="font-mono text-[12px] text-text-faint">raw status</dt>
                <dd className="font-mono text-text">{task.rawStatus}</dd>
              </div>
              <div>
                <dt className="font-mono text-[12px] text-text-faint">package</dt>
                <dd className="font-mono text-text">{task.packageDisposition}</dd>
              </div>
              <div>
                <dt className="font-mono text-[12px] text-text-faint">source</dt>
                <dd className="font-mono text-text">{task.source}</dd>
              </div>
            </dl>
          </Section>

          <Section title="Gates">
            {task.gates.length === 0 ? (
              <p className="text-[14px] text-text-faint">暂无 gate 记录</p>
            ) : (
              <div className="space-y-2">
                {task.gates.map((gate) => (
                  <div
                    key={gate.name}
                    className="flex items-start gap-2 rounded-md bg-surface-raised px-3 py-2"
                  >
                    {gate.ok ? (
                      <CheckCircle
                        weight="duotone"
                        className="mt-0.5 shrink-0 text-[16px] text-status-done"
                      />
                    ) : (
                      <XCircle
                        weight="duotone"
                        className="mt-0.5 shrink-0 text-[16px] text-danger"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="font-mono text-[14px] text-text">
                        {gate.name}
                      </div>
                      {gate.detail && (
                        <div
                          className={`mt-0.5 text-[13px] ${
                            gate.ok ? "text-text-faint" : "text-danger"
                          }`}
                        >
                          {gate.detail}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="收口材料">
            {missingDocs.length === 0 ? (
              <p className="text-[14px] text-text-muted">必需文档齐备。</p>
            ) : (
              <div className="space-y-1.5">
                {missingDocs.map((doc) => (
                  <div
                    key={doc.path}
                    className="flex items-center gap-2 rounded-md bg-surface-raised px-3 py-2"
                  >
                    <span className="font-mono text-[13px] text-danger">missing</span>
                    <span className="min-w-0 flex-1 truncate text-[14px]">
                      {doc.title}
                    </span>
                    <span className="font-mono text-[12px] text-text-faint">
                      {doc.path}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="关联任务">
            {related.length === 0 ? (
              <p className="text-[14px] text-text-faint">暂无关联边。</p>
            ) : (
              <div className="space-y-1.5">
                {related.map(({ edge, task: relatedTask }) => (
                  <button
                    key={`${edge.from}-${edge.kind}-${edge.to}`}
                    onClick={() => onPreviewTask(relatedTask!.taskId)}
                    className="flex w-full items-center gap-2 rounded-md bg-surface-raised px-3 py-2 text-left hover:bg-bg"
                  >
                    <span className="font-mono text-[12px] text-text-faint">
                      {edge.kind}
                    </span>
                    <span className="font-mono text-[13px] text-text">
                      {relatedTask!.taskId}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14px] text-text-muted">
                      {relatedTask!.title}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title="近期事件">
            {taskEvents.length === 0 ? (
              <p className="text-[14px] text-text-faint">暂无事件。</p>
            ) : (
              <div className="space-y-2">
                {taskEvents.map((event) => (
                  <div key={`${event.at}-${event.summary}`} className="text-[14px]">
                    <span className="font-mono text-[12px] text-text-faint">
                      {timeOf(event.at)}
                    </span>
                    <span className="ml-2 text-text-muted">{event.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          <button
            onClick={() => onOpenDetail(task.taskId)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-[15px] font-semibold text-accent-fg"
          >
            <ArrowSquareOut weight="bold" />
            打开完整详情
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-2 text-[15px] text-text-muted hover:bg-surface-raised hover:text-text"
          >
            关闭
          </button>
        </footer>
      </aside>
    </div>
  );
}
