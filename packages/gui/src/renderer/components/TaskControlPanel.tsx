import { useState } from "react";
import type { GuiSubmissionV1 } from "../../api/renderer-dto.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";
import type { TaskCapability, TaskCapabilityReasonKey, TaskBlockingLabel, TaskRow } from "../model/types.ts";
import { taskCapabilityOf } from "../model/types.ts";
import { t } from "../i18n/index.tsx";

/**
 * 阻塞评估 label 码(kernel `blockingOf`)→ 本面板的文案键。判定(用哪句文案)来自
 * daemon 的 `blockingAssessment.label`;renderer 只把码翻成措辞,blocker 数量另行
 * 用 `blockerCount` 键拼接。
 */
const BLOCKING_LABEL_COPY = {
  relations: "components.taskControlPanel.blockingRelations",
  cycle: "components.taskControlPanel.blockingCycle",
  unresolved: "components.taskControlPanel.blockingUnresolved",
  none: "components.taskControlPanel.blockingNone",
} as const satisfies Record<TaskBlockingLabel, string>;

/**
 * 能力投影的 reason 码 → 本面板的文案键。判定(哪条 reason 成立)来自 daemon 的
 * `capabilities[]`(kernel `task-board-projection.ts`);renderer 只把码翻成措辞。
 */
const READ_ONLY_COPY = {
  invalid_disposition: "components.taskControlPanel.readOnlyArchived",
  invalid_transition: "components.taskControlPanel.readOnlyClosed",
  lease_required: "components.taskControlPanel.activeWithoutLease",
  lease_conflict: "components.taskControlPanel.leaseHeldElsewhere",
  completion_blocked: "components.taskControlPanel.closeoutIncomplete",
  blocked: "components.taskControlPanel.plannedBlocked",
  unknown: "components.taskControlPanel.blockingUnknown",
} as const satisfies Record<TaskCapabilityReasonKey, string>;

/**
 * 只读原因:progress 能力不可用时说明为什么。进不了「写 progress」这一步而 start
 * 可用,说明它还没起跑 —— 这一格的判据同样是投影给的 start 能力,不是状态词。
 */
function readOnlyReason(
  task: Pick<TaskRow, "origin">,
  progress: TaskCapability | undefined,
  start: TaskCapability | undefined,
): string | null {
  if (task.origin === "external") return t("components.taskControlPanel.readOnlyExternal");
  if (progress === undefined || start === undefined) return null;
  if (progress.available) return null;
  if (start.available) return t("components.taskControlPanel.planned");
  const reason = progress.reason === "invalid_transition" ? start.reason : progress.reason;
  return reason === null ? null : t(READ_ONLY_COPY[reason]);
}

const lines = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);

function readEvidence(
  value: FormDataEntryValue | null,
): ReadonlyArray<{ type: string; path: string; summary: string }> | null {
  const result = [];
  for (const line of lines(value)) {
    const [type, path, ...summary] = line.split(":");
    if (!type || !path || summary.length === 0) return null;
    result.push({ type, path, summary: summary.join(":") });
  }
  return result;
}

export function TaskControlPanel({
  task,
  feedback,
  onProgress,
  onSubmit,
}: {
  task: TaskRow;
  feedback?: TaskMutationFeedback;
  onProgress?: (input: {
    text: string;
    evidence: ReadonlyArray<{ type: string; path: string; summary: string }>;
  }) => Promise<unknown>;
  onSubmit?: (submission: GuiSubmissionV1) => Promise<unknown>;
}) {
  const [localError, setLocalError] = useState<string | null>(null),
    pending = feedback?.state === "pending";
  const progress = taskCapabilityOf(task, "progress"),
    start = taskCapabilityOf(task, "start"),
    reason = readOnlyReason(task, progress, start);

  return (
    <section className="rounded-md border border-border bg-bg/50 p-2.5" data-testid="task-control-panel">
      <div className="font-mono ui-micro uppercase tracking-wide text-text-faint">
        {t("components.taskControlPanel.title")}
      </div>
      {task.blocking && (
        <p
          className={`mt-1 ui-micro ${task.blocking === "unknown" ? "text-stale" : task.blocking === "blocked" ? "text-status-blocked" : "text-text-faint"}`}
        >
          {task.blockingLabel === undefined
            ? ""
            : t(BLOCKING_LABEL_COPY[task.blockingLabel], {
                count: task.blockers?.length ?? 0,
              })}
          {task.blockers?.length
            ? ` · ${t("components.taskControlPanel.blockerCount", { count: task.blockers.length })}`
            : ""}
        </p>
      )}
      {task.blockingWarnings?.map((warning) => (
        <p key={warning} className="mt-1 ui-micro text-stale">
          {t("components.taskControlPanel.warning", { warning })}
        </p>
      ))}
      {task.blockers?.map((blocker) => (
        <div
          key={blocker.relationId}
          className="mt-1 rounded border border-status-blocked/20 px-2 py-1 font-mono ui-micro text-text-muted"
        >
          {blocker.relationId} · {blocker.sourceTaskId} --{blocker.kind}→ {blocker.targetTaskId}
          {blocker.rationale && <p className="mt-0.5 font-sans ui-micro">{blocker.rationale}</p>}
        </div>
      ))}
      {reason && <p className="mt-2 ui-micro leading-relaxed text-text-muted">{reason}</p>}
      {progress?.available === true && (
        <div className="mt-2 space-y-2">
          <p className="font-mono ui-micro text-text-faint">
            {t("components.taskControlPanel.lease", { executionId: task.activeExecutionId })}
          </p>
          <details className="rounded border border-border bg-surface p-2">
            <summary className="cursor-pointer ui-meta font-medium text-text">
              {t("components.taskControlPanel.addProgress")}
            </summary>
            <form
              className="mt-2 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget),
                  evidence = readEvidence(form.get("evidence"));
                if (!evidence) {
                  setLocalError(t("components.taskControlPanel.evidenceFormat"));
                  return;
                }
                setLocalError(null);
                void onProgress?.({ text: String(form.get("text") ?? ""), evidence });
              }}
            >
              <textarea
                name="text"
                required
                placeholder={t("components.taskControlPanel.progressOriginal")}
                className="min-h-20 w-full rounded border border-border bg-bg px-2 py-1.5 ui-meta text-text"
              />
              <textarea
                name="evidence"
                placeholder={t("components.taskControlPanel.evidencePlaceholder")}
                className="min-h-16 w-full rounded border border-border bg-bg px-2 py-1.5 font-mono ui-micro text-text"
              />
              <button
                disabled={pending}
                className="rounded-md bg-accent px-2.5 py-1.5 ui-meta font-semibold text-accent-fg transition-colors duration-100 hover:bg-accent/85 disabled:opacity-50"
              >
                {t("components.taskControlPanel.writeProgress")}
              </button>
            </form>
          </details>
          <details className="rounded border border-border bg-surface p-2">
            <summary className="cursor-pointer ui-meta font-medium text-text">
              {t("components.taskControlPanel.requestReview")}
            </summary>
            <form
              className="mt-2 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setLocalError(null);
                void onSubmit?.({
                  completionClaim: String(form.get("completionClaim") ?? ""),
                  deliverables: lines(form.get("deliverables")),
                  outputs: lines(form.get("outputs")),
                  verificationNotes: lines(form.get("verificationNotes")),
                  knownGaps: lines(form.get("knownGaps")),
                  residualRisks: lines(form.get("residualRisks")),
                  commitSha: String(form.get("commitSha") ?? ""),
                });
              }}
            >
              <input
                name="completionClaim"
                required
                placeholder={t("components.taskControlPanel.completionClaim")}
                className="w-full rounded border border-border bg-bg px-2 py-1.5 ui-meta text-text"
              />
              {(["deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks"] as const).map((name) => (
                <textarea
                  key={name}
                  name={name}
                  required
                  placeholder={t("components.taskControlPanel.eachLineOneItem", { name })}
                  className="min-h-14 w-full rounded border border-border bg-bg px-2 py-1.5 ui-micro text-text"
                />
              ))}
              <input
                name="commitSha"
                required
                pattern="[0-9a-f]{40}"
                placeholder={t("components.taskControlPanel.commitSha")}
                className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono ui-micro text-text"
              />
              <button
                disabled={pending}
                className="rounded-md bg-accent px-2.5 py-1.5 ui-meta font-semibold text-accent-fg transition-colors duration-100 hover:bg-accent/85 disabled:opacity-50"
              >
                {t("components.taskControlPanel.submitReview")}
              </button>
            </form>
          </details>
        </div>
      )}
      {localError && <p className="mt-2 ui-micro text-danger">{localError}</p>}
      {feedback && (
        <div
          data-testid="task-mutation-feedback"
          className={`mt-2 rounded border px-2 py-1.5 ui-micro ${feedback.state === "error" ? "border-danger/40 text-danger" : feedback.state === "pending" ? "border-stale/40 text-stale" : "border-status-done/40 text-text-muted"}`}
        >
          <span className="font-mono">
            {feedback.kind} · {feedback.state} · opId={feedback.opId}
          </span>
          {feedback.code && <span className="ml-1 font-mono">code={feedback.code}</span>}
          <p className="mt-0.5">{feedback.hint}</p>
        </div>
      )}
    </section>
  );
}
