import { useState } from "react";
import type { GuiSubmissionV1 } from "../../api/renderer-dto.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";
import type { TaskRow } from "../model/types.ts";

const lines = (value: FormDataEntryValue | null) => String(value ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);

function readEvidence(value: FormDataEntryValue | null): ReadonlyArray<{ type: string; path: string; summary: string }> | null {
  const result = [];
  for (const line of lines(value)) {
    const [type, path, ...summary] = line.split(":");
    if (!type || !path || summary.length === 0) return null;
    result.push({ type, path, summary: summary.join(":") });
  }
  return result;
}

export function TaskControlPanel({ task, feedback, onProgress, onSubmit }: {
  task: TaskRow;
  feedback?: TaskMutationFeedback;
  onProgress?: (input: { text: string; evidence: ReadonlyArray<{ type: string; path: string; summary: string }> }) => Promise<unknown>;
  onSubmit?: (submission: GuiSubmissionV1) => Promise<unknown>;
}) {
  const [localError, setLocalError] = useState<string | null>(null), pending = feedback?.state === "pending";
  const reason = task.origin === "external" ? "外部任务由来源引擎管理，本 GUI 只读。"
    : task.origin === "archival" || task.packageDisposition !== "active" ? "归档或非 active package 只读。"
      : task.canonicalStatus === "in_review" ? "任务已进入 review；progress 与 submission 已关闭。"
        : task.canonicalStatus === "done" ? "任务已完成，控制面只读。"
          : task.canonicalStatus === "planned" ? task.blocking === "blocked" ? "Blocked 是 relation overlay，不是状态机节点；请在 canonical relation 来源处理后再启动。" : "在看板列模式拖到 Active 以申请 execution lease。"
            : task.canonicalStatus === "active" && !task.activeExecutionId ? "Active task 没有可见 lease，不能追加 progress 或提交 review。" : null;

  return <section className="rounded-md border border-border bg-bg/50 p-2.5" data-testid="task-control-panel">
    <div className="font-mono text-[11px] uppercase tracking-wide text-text-faint">Task control</div>
    {task.blocking && <p className={`mt-1 text-[11px] ${task.blocking === "unknown" ? "text-stale" : task.blocking === "blocked" ? "text-status-blocked" : "text-text-faint"}`}>
      {task.blockingLabel}{task.blockers?.length ? ` · ${task.blockers.length} blocker(s)` : ""}
    </p>}
    {task.blockingWarnings?.map((warning) => <p key={warning} className="mt-1 text-[11px] text-stale">warning: {warning}</p>)}
    {task.blockers?.map((blocker) => <div key={blocker.relationId} className="mt-1 rounded border border-status-blocked/20 px-2 py-1 font-mono text-[11px] text-text-muted">
      {blocker.relationId} · {blocker.sourceTaskId} --{blocker.kind}→ {blocker.targetTaskId}
      {blocker.rationale && <p className="mt-0.5 font-sans text-[11px]">{blocker.rationale}</p>}
    </div>)}
    {reason && <p className="mt-2 text-[11px] leading-relaxed text-text-muted">{reason}</p>}
    {task.canonicalStatus === "active" && task.activeExecutionId && task.origin === "native" && task.packageDisposition === "active" && <div className="mt-2 space-y-2">
      <p className="font-mono text-[11px] text-text-faint">lease · {task.activeExecutionId}</p>
      <details className="rounded border border-border bg-surface p-2">
        <summary className="cursor-pointer text-[12px] font-medium text-text">追加 progress</summary>
        <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget), evidence = readEvidence(form.get("evidence"));
          if (!evidence) { setLocalError("evidence 每行必须是 type:path:summary"); return; } setLocalError(null); void onProgress?.({ text: String(form.get("text") ?? ""), evidence }); }}>
          <textarea name="text" required placeholder="进展原文" className="min-h-20 w-full rounded border border-border bg-bg px-2 py-1.5 text-[12px] text-text" />
          <textarea name="evidence" placeholder="可选，每行 type:path:summary" className="min-h-16 w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] text-text" />
          <button disabled={pending} className="rounded-md bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-accent-fg transition-colors duration-100 hover:bg-accent/85 disabled:opacity-50">写入 progress</button>
        </form>
      </details>
      <details className="rounded border border-border bg-surface p-2">
        <summary className="cursor-pointer text-[12px] font-medium text-text">Request review · atomic SubmissionV1</summary>
        <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); setLocalError(null); void onSubmit?.({
          completionClaim: String(form.get("completionClaim") ?? ""), deliverables: lines(form.get("deliverables")), outputs: lines(form.get("outputs")),
          verificationNotes: lines(form.get("verificationNotes")), knownGaps: lines(form.get("knownGaps")), residualRisks: lines(form.get("residualRisks")), commitSha: String(form.get("commitSha") ?? "")
        }); }}>
          <input name="completionClaim" required placeholder="Completion claim" className="w-full rounded border border-border bg-bg px-2 py-1.5 text-[12px] text-text" />
          {(["deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks"] as const).map((name) => <textarea key={name} name={name} required placeholder={`${name} · 每行一项`} className="min-h-14 w-full rounded border border-border bg-bg px-2 py-1.5 text-[11px] text-text" />)}
          <input name="commitSha" required pattern="[0-9a-f]{40}" placeholder="40-char commit SHA" className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] text-text" />
          <button disabled={pending} className="rounded-md bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-accent-fg transition-colors duration-100 hover:bg-accent/85 disabled:opacity-50">原子提交并进入 review</button>
        </form>
      </details>
    </div>}
    {localError && <p className="mt-2 text-[11px] text-danger">{localError}</p>}
    {feedback && <div data-testid="task-mutation-feedback" className={`mt-2 rounded border px-2 py-1.5 text-[11px] ${feedback.state === "error" ? "border-danger/40 text-danger" : feedback.state === "pending" ? "border-stale/40 text-stale" : "border-status-done/40 text-text-muted"}`}>
      <span className="font-mono">{feedback.kind} · {feedback.state} · opId={feedback.opId}</span>
      {feedback.code && <span className="ml-1 font-mono">code={feedback.code}</span>}
      <p className="mt-0.5">{feedback.hint}</p>
    </div>}
  </section>;
}
