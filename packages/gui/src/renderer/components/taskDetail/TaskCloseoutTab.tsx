import { useMemo } from "react";
import { CheckCircle, ClockCounterClockwise, XCircle } from "@phosphor-icons/react";
import type { TaskCompletionRead } from "../../../api/renderer-dto.ts";
import type { TaskMutationFeedback } from "../../task-actions.ts";
import { useTaskCompletionQuery } from "../../task-data.ts";
import type { TaskRow } from "../../model/types.ts";
import {
  adaptTaskExecutions,
  buildExecutionEvidenceContext,
  checkerResultField,
  field,
  receiptField,
  type ExecutionEvidenceRow,
} from "../../model/execution-evidence.ts";
import { CloseoutBadge } from "../badges.tsx";
import { CopyContextButton } from "../CopyContextButton.tsx";
import { TaskControlPanel } from "../TaskControlPanel.tsx";
import { ReadError, SectionHeading, Timestamp } from "./TaskDetailSections.tsx";

const asideClass = "grid content-start gap-7 border-t border-border pt-6 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6";

export interface TaskActionProps {
  readonly mutationFeedback?: TaskMutationFeedback;
  readonly onProgress?: (input: {
    text: string;
    evidence: ReadonlyArray<{ type: string; path: string; summary: string }>;
  }) => Promise<unknown>;
  readonly onSubmit?: () => Promise<unknown>;
  /** 收口销账:true=同意完成,false=提交完成(请中心派发独立评审)。 */
  readonly onComplete?: (consent: boolean) => Promise<unknown>;
}

export function TaskCloseoutTab({
  task,
  mutationFeedback,
  onProgress,
  onSubmit,
  onComplete,
}: { readonly task: TaskRow } & TaskActionProps) {
  const completion = useTaskCompletionQuery(task.projectId, task.taskId),
    completionNext = completion.data?.completionNext,
    reviews = task.reviews ?? [],
    consents = task.consents ?? [],
    codeDocs = task.codeDocWitnesses ?? [],
    gateWitnesses = task.gateWitnesses ?? [];
  // W5:执行证据页撤销后,execution 输出/回执并入收口——从投影行原样适配
  // (model/execution-evidence),reviews/consents/gate 见证按 execution 对齐。
  const executions = useMemo(
    () =>
      task.executions === undefined || task.executionEvidence === undefined
        ? []
        : adaptTaskExecutions({
            taskId: task.taskId,
            updatedAt: task.lastKnownAt,
            snapshotAvailability: task.snapshotAvailability,
            snapshot: {
              task: { title: task.title },
              executions: task.executions,
              reviews: task.reviews ?? [],
              consents: task.consents ?? [],
              gateWitnesses: task.gateWitnesses ?? [],
            },
            executionEvidence: task.executionEvidence,
          }),
    [task],
  );
  return (
    <section data-testid="task-closeout-tab">
      <SectionHeading
        eyebrow="CLOSEOUT"
        title="收口与门"
        description="后端 closeoutAssessment、snapshot witness 与 execution 输出回执的原样展示"
      />
      <div className="mt-7 grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid content-start gap-8">
          <div className="flex flex-wrap items-center gap-3 border-y border-border py-4">
            <CloseoutBadge value={task.closeoutReadiness} />
            {completion.isError ? <ReadError text={String(completion.error)} /> : null}
            {completionNext ? (
              <div data-testid="task-completion-next">
                <p>{completionNext.reason}</p>
                <p>{completionNext.action}</p>
                <p>{completionNext.authority}</p>
              </div>
            ) : null}
            {task.snapshotAvailability ? (
              <span className="ml-auto font-mono ui-micro text-text-faint">
                availability · consent {task.snapshotAvailability.consents} · code/doc{" "}
                {task.snapshotAvailability.codeDocWitnesses} · gates {task.snapshotAvailability.gateWitnesses}
              </span>
            ) : null}
          </div>
          <CompletionPanel
            task={task}
            completionBlocker={completion.data?.completionBlocker ?? null}
            onComplete={onComplete}
          />
          <AuditGroup title="Review" count={reviews.length}>
            {reviews.map((review) => (
              <AuditRow
                key={review.reviewId}
                id={review.reviewId}
                state={review.verdict}
                summary={review.reason}
                at={review.reviewedAt}
              />
            ))}
          </AuditGroup>
          <AuditGroup title="Consent" count={consents.length}>
            {consents.map((consent) => (
              <AuditRow
                key={consent.consentId}
                id={consent.consentId}
                state="recorded"
                summary={`review ${consent.reviewId}`}
                at={consent.consentedAt}
              />
            ))}
          </AuditGroup>
          <AuditGroup title="Code / doc witness" count={codeDocs.length}>
            {codeDocs.map((witness) => (
              <AuditRow
                key={witness.schema === "code-doc-witness/v1" ? witness.witnessId : witness.recordId}
                id={witness.schema === "code-doc-witness/v1" ? witness.witnessId : witness.recordId}
                state={
                  witness.schema === "code-doc-witness/v1" || witness.paths.length > 0 ? "reconciled" : "known-invalid"
                }
                summary={witness.paths.join(", ")}
                at={witness.schema === "code-doc-witness/v1" ? witness.reconciledAt : witness.repointedAt}
              />
            ))}
          </AuditGroup>
          <AuditGroup title="Gate witness" count={gateWitnesses.length}>
            {gateWitnesses.map((witness) => (
              <AuditRow
                key={witness.witnessId}
                id={witness.gateId}
                state={witness.result}
                summary={`${witness.checkerId} · ${witness.receiptId}`}
                at={witness.verifiedAt}
              />
            ))}
          </AuditGroup>
          <ExecutionOutputsGroup executions={executions} />
        </div>

        <aside className={asideClass}>
          <div>
            <h3 className="ui-body font-semibold text-text">Gate assessment</h3>
            {task.gates.length === 0 ? (
              <p className="mt-3 ui-meta text-text-faint">没有 completion gate。</p>
            ) : (
              <div className="mt-3 grid gap-2">
                {task.gates.map((gate) => (
                  <div key={gate.name} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 ui-micro">
                    {gate.ok === true ? (
                      <CheckCircle weight="bold" className="mt-0.5 text-status-done" />
                    ) : gate.ok === false ? (
                      <XCircle weight="bold" className="mt-0.5 text-danger" />
                    ) : (
                      <ClockCounterClockwise weight="bold" className="mt-0.5 text-stale" />
                    )}
                    <div>
                      <p className="font-mono text-text-muted">{gate.name}</p>
                      {gate.detail ? <p className="mt-0.5 leading-5 text-text-faint">{gate.detail}</p> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <TaskControlPanel task={task} feedback={mutationFeedback} onProgress={onProgress} onSubmit={onSubmit} />
        </aside>
      </div>
    </section>
  );
}

/**
 * 完成销账面板:完成/评审/同意的状态只有一个来源——`repo.tasks.completion.read`
 * 的 completionNext 与 completionBlocker,不从 task 行自行推导。阶段由结构化
 * blocker.code 判别(review_missing=待独立评审,consent_missing=待同意),
 * action 文案只作展示;面板动作只镜像这条入口(「提交完成」=无 consent 的
 * task-complete,由 daemon 在 review 门派发独立评审;评审批准后 read 会给出
 * consent_missing,那时「同意完成」才可点)。不提供人工填 verdict 的按钮,
 * 也不提供 CI 观察选择。
 */
function CompletionPanel({
  task,
  completionBlocker,
  onComplete,
}: {
  readonly task: TaskRow;
  readonly completionBlocker: TaskCompletionRead["completionBlocker"];
  readonly onComplete?: (consent: boolean) => Promise<unknown>;
}) {
  const code = completionBlocker?.code,
    stage = code === "consent_missing" ? ("consent" as const) : code === "review_missing" ? ("review" as const) : null;
  if (task.coordinationStatus !== "in_review" || stage === null) return null;
  const buttonClass =
    "rounded-md bg-accent px-2.5 py-1.5 ui-meta font-semibold text-accent-fg transition-colors duration-100 " +
    "hover:bg-accent/85 disabled:opacity-50";
  return (
    <section data-testid="task-completion-panel" className="rounded-lg border border-accent/40 bg-accent/5 p-3">
      <h3 className="ui-body font-semibold text-text">完成销账</h3>
      <p className="mt-1 ui-meta text-text-muted">
        {stage === "review"
          ? "独立评审尚未批准:提交完成会请中心派发独立评审者;批准前同意完成不可用。"
          : "独立评审已批准:同意完成即按已评审内容记录一次同意并收口。"}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="task-completion-submit"
          disabled={stage !== "review"}
          onClick={() => void onComplete?.(false)}
          className={buttonClass}
        >
          提交完成
        </button>
        <button
          type="button"
          data-testid="task-completion-consent"
          disabled={stage !== "consent"}
          onClick={() => void onComplete?.(true)}
          className={buttonClass}
        >
          同意完成
        </button>
      </div>
    </section>
  );
}

function AuditGroup({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="ui-body font-semibold text-text">{title}</h3>
        <span className="font-mono ui-micro text-text-faint">{count}</span>
      </div>
      {count === 0 ? (
        <p className="border-t border-border py-3 ui-meta text-text-faint">暂无记录。</p>
      ) : (
        <div className="divide-y divide-border border-y border-border">{children}</div>
      )}
    </section>
  );
}

function ExecutionOutputsGroup({ executions }: { readonly executions: readonly ExecutionEvidenceRow[] }) {
  return (
    <AuditGroup title="Execution 输出" count={executions.length}>
      {executions.map((execution) => (
        <article
          key={execution.executionId}
          data-testid={`task-execution-${execution.executionId}`}
          className="grid gap-3 py-3"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono ui-micro">
            <span className="font-semibold text-text">{execution.executionId}</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-text-muted">{field(execution.state)}</span>
            {execution.origin && (
              <span className="rounded border border-border px-1.5 py-0.5 text-text-faint">{execution.origin}</span>
            )}
            <span className="text-text-faint">
              iteration {field(execution.iteration)} · commit{" "}
              {field(execution.commitSha && execution.commitSha.slice(0, 10))}
            </span>
            <span className="ml-auto text-text-faint">
              {execution.outputs.length} outputs ·{" "}
              {execution.outputs.filter(({ isPassingReceipt }) => isPassingReceipt).length} passing
            </span>
          </div>
          {execution.outputs.length === 0 ? (
            <p className="ui-meta text-text-faint">该 execution 没有输出记录。</p>
          ) : (
            <div className="grid gap-1">
              {execution.outputs.map((output, index) => (
                <div
                  key={`${output.evidenceId ?? "unknown"}-${index}`}
                  className={
                    "flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border/70 " +
                    "bg-surface-raised/35 px-2 py-1.5 font-mono ui-micro"
                  }
                >
                  <span className="min-w-0 truncate text-text">{field(output.evidenceId)}</span>
                  <span className="min-w-0 truncate text-text-muted">
                    {field(output.substrate)} · {field(output.locator)}
                  </span>
                  <span
                    className={
                      output.isPassingReceipt
                        ? "text-status-done"
                        : output.checkerReceiptRef === null
                          ? "text-stale"
                          : "text-status-unknown"
                    }
                  >
                    {receiptField(output.checkerReceiptRef)} · {checkerResultField(output.checkerResult)}
                  </span>
                  <span className="ml-auto">
                    <CopyContextButton compact buildText={() => buildExecutionEvidenceContext(execution, output)} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </article>
      ))}
    </AuditGroup>
  );
}

function AuditRow({
  id,
  state,
  summary,
  at,
}: {
  readonly id: string;
  readonly state: string;
  readonly summary: string;
  readonly at: string;
}) {
  return (
    <div className="grid gap-2 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_9rem]">
      <div>
        <p className="font-mono ui-micro text-text-muted">{id}</p>
        <p className="mt-0.5 font-mono ui-micro text-text-faint">{state}</p>
      </div>
      <p className="min-w-0 break-words ui-meta leading-5 text-text">{summary}</p>
      <Timestamp value={at} />
    </div>
  );
}
