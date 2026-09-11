import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient } from "../../api-client.ts";
import type { TaskRow } from "../../model/types.ts";
import { settleTaskReceipt } from "../../task-actions.ts";
import { taskQueryKeys, useTaskDocumentQuery } from "../../task-data.ts";

const closeoutHeadings = ["Summary", "Verification", "Residual Risk", "Same Mechanism Elsewhere"] as const;

function closeoutSections(body: string): readonly { readonly heading: string; readonly body: string }[] {
  return closeoutHeadings.map((heading, index) => {
    const start = body.search(new RegExp(`^## ${heading}\\s*$`, "mu"));
    if (start < 0) return { heading, body: "未提供" };
    const contentStart = body.indexOf("\n", start) + 1;
    const nextHeading = closeoutHeadings
      .slice(index + 1)
      .map((candidate) => body.search(new RegExp(`^## ${candidate}\\s*$`, "mu")))
      .find((position) => position >= contentStart);
    return { heading, body: body.slice(contentStart, nextHeading ?? body.length).trim() || "未提供" };
  });
}

export function TaskReviewPanel({ task }: { readonly task: TaskRow }) {
  const queryClient = useQueryClient(),
    execution = task.executions
      ?.filter((candidate) => candidate.iteration === task.iteration && candidate.state === "submitted")
      .at(-1),
    currentReviews = (task.reviews ?? []).filter((review) => review.executionId === execution?.executionId),
    approvedReview = currentReviews.findLast((review) => review.verdict === "approved"),
    consent = (task.consents ?? []).findLast(
      (candidate) =>
        candidate.executionId === execution?.executionId && candidate.reviewId === approvedReview?.reviewId,
    ),
    closeout = useTaskDocumentQuery(task.projectId, task.taskId, "closeout.md"),
    explanation = useQuery({
      queryKey: ["task-action-explanation", task.projectId, task.taskId],
      queryFn: () => harnessClient.explainTaskActions({ repoId: task.projectId, taskId: task.taskId }),
      enabled: execution !== undefined && approvedReview === undefined,
    }),
    ci = useQuery({
      queryKey: ["ci-observatory", task.projectId],
      queryFn: () => harnessClient.getCiObservatory({ repoId: task.projectId, window: 25 }),
      enabled: consent !== undefined,
    }),
    reviewExplanation = explanation.data?.subjects[0]?.actions.find((action) => action.action.id === "review"),
    reviewBlocked = reviewExplanation?.available === false,
    [verdict, setVerdict] = useState<"approved" | "changes_requested" | "dismissed">("approved"),
    [reason, setReason] = useState(""),
    [ciReceipt, setCiReceipt] = useState(""),
    [feedback, setFeedback] = useState(""),
    [pending, setPending] = useState(false),
    sections = useMemo(
      () => closeoutSections(closeout.data?.status === "ready" ? closeout.data.body : ""),
      [closeout.data],
    );

  if (task.coordinationStatus !== "in_review" || !execution?.submission) return null;

  const mutate = async (run: () => Promise<Parameters<typeof settleTaskReceipt>[0]>) => {
    setPending(true);
    setFeedback("");
    try {
      const settled = settleTaskReceipt(await run());
      setFeedback(
        settled.state === "applied" ? "canonical receipt 已落定。" : (settled.hint ?? settled.code ?? settled.state),
      );
      if (settled.state === "applied")
        await queryClient.invalidateQueries({ queryKey: taskQueryKeys.all(task.projectId), refetchType: "active" });
      return settled.state === "applied";
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setPending(false);
    }
  };

  return (
    <section data-testid="task-review-panel" className="rounded-lg border border-accent/40 bg-accent/5 p-4">
      <h2 className="ui-prose font-semibold text-text">独立评审 / 同意完成</h2>
      <p className="mt-1 ui-meta text-text-muted">先核对 closeout 与提交包，再按 canonical 生命周期逐步落定。</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {sections.map((section) => (
          <article key={section.heading} className="rounded border border-border bg-surface p-3">
            <h3 className="font-mono ui-micro font-semibold uppercase text-text-faint">{section.heading}</h3>
            <p className="mt-1 whitespace-pre-wrap ui-meta text-text-muted">{section.body}</p>
          </article>
        ))}
      </div>
      <div className="mt-3 rounded border border-border bg-surface p-3" data-testid="task-review-submission">
        <h3 className="font-mono ui-micro font-semibold uppercase text-text-faint">Submission</h3>
        <p className="mt-2 ui-meta text-text">{execution.submission.completionClaim}</p>
        <p className="mt-1 font-mono ui-micro text-text-muted">
          deliverables · {execution.submission.deliverables.join(", ") || "—"}
        </p>
        <p className="font-mono ui-micro text-text-muted">outputs · {execution.submission.outputs.join(", ") || "—"}</p>
        <p className="font-mono ui-micro text-text-muted">
          verification · {execution.submission.verificationNotes.join(", ") || "—"}
        </p>
      </div>

      {!approvedReview ? (
        <div className="mt-4 grid gap-2">
          {reviewBlocked ? (
            <div
              data-testid="task-review-self-blocked"
              className="rounded border border-danger/40 bg-danger/5 p-3 ui-meta text-danger"
            >
              当前身份不能独立评审此 execution。
              {reviewExplanation.nextActions.map((action) => (
                <p key={action} className="mt-1 font-mono ui-micro">
                  {action}
                </p>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <select
              value={verdict}
              onChange={(event) => setVerdict(event.target.value as typeof verdict)}
              className="rounded border border-border bg-surface px-2 py-1 ui-meta"
            >
              <option value="approved">approved</option>
              <option value="changes_requested">changes requested</option>
              <option value="dismissed">dismissed</option>
            </select>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="评审理由"
              className="min-w-64 flex-1 rounded border border-border bg-surface px-2 py-1 ui-meta"
            />
            <button
              type="button"
              disabled={pending || reviewBlocked || !reason.trim()}
              onClick={() =>
                void mutate(() =>
                  harnessClient.reviewTaskExecution({
                    repoId: task.projectId,
                    taskId: task.taskId,
                    executionId: execution.executionId,
                    reviewId: `review-gui-${crypto.randomUUID()}`,
                    verdict,
                    reason: reason.trim(),
                    evidenceChecked: ["closeout.md", "submission packet"],
                  }),
                )
              }
              className="rounded bg-accent px-3 py-1 ui-meta font-semibold text-bg disabled:opacity-40"
            >
              提交独立评审
            </button>
          </div>
        </div>
      ) : !consent ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void mutate(() =>
              harnessClient.consentTaskReview({
                repoId: task.projectId,
                taskId: task.taskId,
                executionId: execution.executionId,
                reviewId: approvedReview.reviewId,
                consentId: `consent-gui-${crypto.randomUUID()}`,
              }),
            )
          }
          className="mt-4 rounded bg-accent px-3 py-1 ui-meta font-semibold text-bg disabled:opacity-40"
        >
          同意此评审
        </button>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <select
            value={ciReceipt}
            onChange={(event) => setCiReceipt(event.target.value)}
            className="min-w-80 rounded border border-border bg-surface px-2 py-1 ui-meta"
          >
            <option value="">选择 main CI 观察</option>
            {(ci.data?.runs ?? []).map((run) => (
              <option key={`${run.receiptRef}:${run.job}`} value={run.receiptRef}>
                {run.pass ? "✓" : "✗"} {run.runId} · {run.job} · {run.sha.slice(0, 8)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending || !ciReceipt}
            onClick={() =>
              void mutate(() =>
                harnessClient.completeTask({
                  repoId: task.projectId,
                  taskId: task.taskId,
                  executionId: execution.executionId,
                  ci: ciReceipt,
                }),
              )
            }
            className="rounded bg-success px-3 py-1 ui-meta font-semibold text-bg disabled:opacity-40"
          >
            完成任务
          </button>
        </div>
      )}
      {feedback ? <p className="mt-3 font-mono ui-micro text-text-muted">{feedback}</p> : null}
    </section>
  );
}
