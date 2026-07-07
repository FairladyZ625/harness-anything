import { CheckCircle, XCircle, SealCheck, Lock } from "@phosphor-icons/react";
import type { TaskRow } from "../../model/types";
import { isExternal } from "../../model/types";
import { StatusBadge, CloseoutBadge, EngineBadge, FreshnessTag } from "../badges";
import type { Verdict } from "./shared";

export function CurrentReview({
  task,
  note,
  onNote,
  onJudge,
  onPreview,
}: {
  task: TaskRow | undefined;
  note: string;
  onNote: (note: string) => void;
  onJudge: (verdict: Verdict) => void;
  onPreview: (id: string) => void;
}) {
  if (!task) {
    return (
      <section className="grid h-full place-items-center rounded-lg border border-dashed border-border bg-surface p-6 text-center">
        <div>
          <SealCheck weight="duotone" className="mx-auto text-4xl text-text-faint" />
          <div className="mt-2 text-[16px] font-semibold">选择一个待审任务</div>
          <p className="mt-1 text-[14px] text-text-faint">
            左侧队列用于挑选当前审阅对象；任务标题会先打开预览抽屉。
          </p>
        </div>
      </section>
    );
  }

  const failed = task.gates.filter((gate) => !gate.ok);
  const missingDocs = task.docs.filter((doc) => doc.required && !doc.present);
  const canJudge = task.closeoutReadiness === "ready" || task.closeoutReadiness === "failed";

  return (
    <section className="flex h-full min-h-0 flex-col rounded-lg border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <button onClick={() => onPreview(task.taskId)} className="text-left hover:text-accent">
          <span className="font-mono text-[13px] text-text-faint">{task.taskId}</span>
          <h2 className="mt-1 text-[20px] font-semibold leading-tight">{task.title}</h2>
        </button>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusBadge status={task.coordinationStatus} />
          <CloseoutBadge value={task.closeoutReadiness} />
          <EngineBadge engine={task.engine} locked={isExternal(task)} />
          <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
          {isExternal(task) && (
            <span className="inline-flex items-center gap-1 text-[13px] text-text-faint">
              <Lock weight="bold" />
              判定写回本地 review，状态仍由 {task.engine} 管理
            </span>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-4 xl:grid-cols-2">
        {(task.taskId === "KER-101" || task.taskId === "KER-102") && (
          <div className="col-span-full rounded-md border border-accent/40 bg-accent/5 p-3 text-[13px] text-text">
            <span className="font-semibold text-accent">⚠ 承重决策关联：</span>
            当前任务与决策 <span className="font-mono bg-surface-raised px-1 rounded">{task.taskId === "KER-101" ? "DEC-101" : "DEC-102"}</span> 关联（派生/证据）。此处的“通过”仅代表 Task 机械收口（Gates 验证），**不等于决策通过**。请前往 <span className="font-semibold text-accent">“决策裁决”</span> 视图通过 Terminal 进行人机对话仲裁。
          </div>
        )}
        <section>
          <div className="mb-2 font-mono text-[12px] uppercase tracking-wide text-text-faint">gates</div>
          <div className="space-y-2">
            {task.gates.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-3 py-3 text-[14px] text-text-faint">
                无 gate 记录
              </div>
            )}
            {task.gates.map((gate) => (
              <div key={gate.name} className="flex items-start gap-2 rounded-md bg-surface-raised px-3 py-2">
                {gate.ok ? (
                  <CheckCircle weight="duotone" className="mt-0.5 shrink-0 text-[16px] text-status-done" />
                ) : (
                  <XCircle weight="duotone" className="mt-0.5 shrink-0 text-[16px] text-danger" />
                )}
                <div className="min-w-0">
                  <div className="font-mono text-[14px]">{gate.name}</div>
                  {gate.detail && (
                    <div className={`text-[13px] ${gate.ok ? "text-text-faint" : "text-danger"}`}>{gate.detail}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 font-mono text-[12px] uppercase tracking-wide text-text-faint">收口材料</div>
          <div className="space-y-2">
            {missingDocs.length === 0 ? (
              <div className="rounded-md bg-surface-raised px-3 py-3 text-[14px] text-text-muted">
                必需文档齐备，可以判定。
              </div>
            ) : (
              missingDocs.map((doc) => (
                <div key={doc.path} className="rounded-md bg-surface-raised px-3 py-2">
                  <div className="text-[14px] text-text">{doc.title}</div>
                  <div className="font-mono text-[12px] text-danger">{doc.path}</div>
                </div>
              ))
            )}
            {failed.length > 0 && (
              <div className="rounded-md border border-danger/40 px-3 py-2 text-[14px] text-danger">
                失败原因：{failed.map((gate) => gate.name).join(", ")}
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="border-t border-border px-4 py-3">
        <textarea
          value={note}
          onChange={(event) => onNote(event.target.value)}
          placeholder="审阅意见（原型内仅写入本会话记录）"
          rows={3}
          className="w-full resize-none rounded-md border border-border bg-surface-raised px-3 py-2 text-[15px] outline-none placeholder:text-text-faint focus:border-border-strong"
        />
        <div className="mt-2 flex gap-2">
          <button
            disabled={!canJudge}
            onClick={() => onJudge("passed")}
            className="flex-1 rounded-md bg-accent px-3 py-2 text-[15px] font-semibold text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            通过 passed
          </button>
          <button
            disabled={!canJudge}
            onClick={() => onJudge("failed")}
            className="flex-1 rounded-md border border-danger px-3 py-2 text-[15px] font-semibold text-danger disabled:cursor-not-allowed disabled:opacity-40"
          >
            打回 failed
          </button>
        </div>
      </footer>
    </section>
  );
}
