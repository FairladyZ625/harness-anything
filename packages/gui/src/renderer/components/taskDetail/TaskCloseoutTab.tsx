import { useEffect, useMemo } from "react";
import type { TaskCompletionRead } from "../../../api/renderer-dto.ts";
import type { TaskMutationFeedback } from "../../task-actions.ts";
import { useTaskCompletionQuery } from "../../task-data.ts";
import type { TaskRow } from "../../model/types.ts";
import {
  adaptTaskExecutions,
  buildExecutionEvidenceContext,
  outputReceiptState,
  type ExecutionEvidenceOutput,
  type ExecutionEvidenceRow,
  type OutputReceiptState,
} from "../../model/execution-evidence.ts";
import { t } from "../../i18n/index.tsx";
import { CloseoutBadge } from "../badges.tsx";
import { CopyContextButton } from "../CopyContextButton.tsx";
import { IdText } from "../IdText.tsx";
import { RecordRow } from "../primitives/RecordRow.tsx";
import { Section } from "../primitives/Section";
import { TaskControlPanel } from "../TaskControlPanel.tsx";
import { TaskGateAttestCard } from "./TaskGateAttestCard.tsx";
import { ReadError, Timestamp } from "./TaskDetailSections.tsx";

const asideClass = "grid content-start gap-7 border-t border-border pt-6 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6";

/** recordRef(execution/<id> 等)→ 收口记录行的 DOM 锚点:斜杠转连字符,getElementById 直取。 */
export function closeoutRecordDomId(recordRef: string): string {
  return `closeout-record-${recordRef.replaceAll("/", "-")}`;
}

export interface TaskActionProps {
  readonly mutationFeedback?: TaskMutationFeedback;
  readonly onProgress?: (input: {
    text: string;
    evidence: ReadonlyArray<{ type: string; path: string; summary: string }>;
  }) => Promise<unknown>;
  readonly onSubmit?: () => Promise<unknown>;
  /** 收口销账:纯机械动作。 */
  readonly onComplete?: () => Promise<unknown>;
  /** CEO 初审送审/打回与终审打回。 */
  readonly onAdjudicate?: (decision: "forward" | "return", reason: string, reviewId?: string) => Promise<unknown>;
  /** CEO 终审批准:对指定已批准评审记录同意。 */
  readonly onConsentReview?: (reviewId: string) => Promise<unknown>;
  /** Gate 签注:manual-attest 打勾(approve)或失败关卡特批(override)。 */
  readonly onAttest?: (
    task: Pick<TaskRow, "taskId">,
    gateId: string,
    mode: "approve" | "override",
    rationale?: string,
  ) => Promise<TaskMutationFeedback>;
}

export function TaskCloseoutTab({
  task,
  focusedRecordRef = null,
  mutationFeedback,
  onProgress,
  onSubmit,
  onComplete,
  onAdjudicate,
  onConsentReview,
  onAttest,
}: { readonly task: TaskRow; readonly focusedRecordRef?: string | null } & TaskActionProps) {
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
  // 引用对象的聚焦落点:时间线/预览抽屉点开的记录行滚入视野;行本体带选中
  // 高亮,落点可见。completion 读会在记录前插入内容,等读完成再定位一次。
  // 后续 completion 状态更新不是导航,不重排滚动。不设"已处理"标记——StrictMode
  // 重放会取消首帧再重排一遍,标记若在帧执行前置位,重排那一遍会短路掉滚动。
  useEffect(() => {
    if (focusedRecordRef === null || completion.isPending) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(closeoutRecordDomId(focusedRecordRef))?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedRecordRef, completion.isPending]);
  return (
    <section data-testid="task-closeout-tab">
      <Section title="收口与门" note="后端 closeoutAssessment、snapshot witness 与 execution 输出回执的原样展示">
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-8">
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
              onAdjudicate={onAdjudicate}
              onConsentReview={onConsentReview}
            />
            <AuditGroup title="Review" count={reviews.length}>
              {reviews.map((review) => (
                <AuditRow
                  key={review.reviewId}
                  id={review.reviewId}
                  state={review.verdict}
                  summary={review.reason}
                  at={review.reviewedAt}
                  recordRef={`review/${review.reviewId}`}
                  focused={focusedRecordRef === `review/${review.reviewId}`}
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
                  recordRef={`consent/${consent.consentId}`}
                  focused={focusedRecordRef === `consent/${consent.consentId}`}
                />
              ))}
            </AuditGroup>
            <AuditGroup title="Code / doc witness" count={codeDocs.length}>
              {codeDocs.map((witness) => (
                <AuditRow
                  key={witness.schema === "code-doc-witness/v1" ? witness.witnessId : witness.recordId}
                  id={witness.schema === "code-doc-witness/v1" ? witness.witnessId : witness.recordId}
                  state={
                    witness.schema === "code-doc-witness/v1" || witness.paths.length > 0
                      ? "reconciled"
                      : "known-invalid"
                  }
                  summary={witness.paths.join(", ")}
                  at={witness.schema === "code-doc-witness/v1" ? witness.reconciledAt : witness.repointedAt}
                  recordRef={`witness/${witness.schema === "code-doc-witness/v1" ? witness.witnessId : witness.recordId}`}
                  focused={
                    focusedRecordRef ===
                    `witness/${witness.schema === "code-doc-witness/v1" ? witness.witnessId : witness.recordId}`
                  }
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
                  recordRef={`witness/${witness.witnessId}`}
                  focused={focusedRecordRef === `witness/${witness.witnessId}`}
                />
              ))}
            </AuditGroup>
            <ExecutionOutputsGroup executions={executions} focusedRecordRef={focusedRecordRef} />
          </div>

          <aside className={asideClass}>
            <TaskGateAttestCard task={task} feedback={mutationFeedback} onAttest={onAttest} />
            <TaskControlPanel task={task} feedback={mutationFeedback} onProgress={onProgress} onSubmit={onSubmit} />
          </aside>
        </div>
      </Section>
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
  onAdjudicate,
  onConsentReview,
}: {
  readonly task: TaskRow;
  readonly completionBlocker: TaskCompletionRead["completionBlocker"];
  readonly onComplete?: () => Promise<unknown>;
  readonly onAdjudicate?: (decision: "forward" | "return", reason: string, reviewId?: string) => Promise<unknown>;
  readonly onConsentReview?: (reviewId: string) => Promise<unknown>;
}) {
  const code = completionBlocker?.code,
    stage =
      code === "consent_missing"
        ? ("consent" as const)
        : code === "review_missing"
          ? ("review" as const)
          : code === undefined || code === null
            ? ("ready" as const)
            : ("other" as const);
  if (!["submitted", "in_review"].includes(task.coordinationStatus) || stage === "other") return null;
  const approved = (task.reviews ?? []).filter((review) => review.verdict === "approved").at(-1),
    buttonClass =
      "rounded-sm bg-accent px-2.5 py-1.5 ui-meta font-semibold text-accent-fg transition-colors duration-100 " +
      "hover:bg-accent/85 disabled:opacity-50";
  return (
    <section data-testid="task-completion-panel" className="rounded border border-accent/40 bg-accent/5 p-3">
      <h3 className="ui-body font-semibold text-text">完成销账</h3>
      <p className="mt-1 ui-meta text-text-muted">
        {stage === "review"
          ? "独立评审尚未记录结论:评审员只查验,结论回流后由任务 owner 裁决;裁决前完成不可用。"
          : stage === "consent"
            ? "独立评审已批准:owner 终审批准即按已评审内容记录同意;同意后完成是纯机械动作。"
            : "终审批准已记录:结项是纯机械动作,立即封存。"}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {task.coordinationStatus === "submitted" ? (
          <>
            <button
              type="button"
              data-testid="task-triage-forward"
              disabled={!onAdjudicate}
              onClick={() =>
                void onAdjudicate?.("forward", "Owner initial review accepted this cut for independent review.")
              }
              className={buttonClass}
            >
              送独立评审
            </button>
            <button
              type="button"
              data-testid="task-triage-return"
              disabled={!onAdjudicate}
              onClick={() => void onAdjudicate?.("return", "Owner initial review returned this cut for rework.")}
              className={buttonClass}
            >
              初审打回
            </button>
          </>
        ) : null}
        {task.coordinationStatus === "in_review" && approved ? (
          <button
            type="button"
            data-testid="task-review-return"
            disabled={!onAdjudicate}
            onClick={() =>
              void onAdjudicate?.("return", "Owner final review returned this cut for rework.", approved.reviewId)
            }
            className={buttonClass}
          >
            终审打回
          </button>
        ) : null}
        {stage === "consent" ? (
          <button
            type="button"
            data-testid="task-completion-consent"
            disabled={!onConsentReview || !approved}
            onClick={() => approved && void onConsentReview?.(approved.reviewId)}
            className={buttonClass}
          >
            终审批准
          </button>
        ) : null}
        <button
          type="button"
          data-testid="task-completion-complete"
          disabled={stage !== "ready" || !onComplete}
          title={stage === "ready" ? undefined : "先终审批准,再机械结项"}
          onClick={() => void onComplete?.()}
          className={buttonClass}
        >
          机械结项
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

/**
 * 收口页 Execution 输出区的回执显示(task_3c3bd2eaa89460dbae843fa737):三种状态
 * 互不混淆——有检查器(通过=绿/未通过=红/有回执无结论=橙)、没有检查器(文档类
 * 产出的常态,receiptRef=null,中性灰)与数据确实缺失(投影缺字段,橙「未投影」)。
 * 旧显示把常态拼成「none / 无 receipt · unknown / 未投影」套警示色,业主把常态
 * 当成了故障。文案走 i18n;计数行按同一分类如实分桶,不把「无检查器」算作未通过。
 */

/** 展示侧缺字段文案:i18n 单语,区别于复制上下文里机器读的「unknown / 未投影」。 */
function displayField(value: unknown): string {
  return value === undefined || value === null || value === ""
    ? t("components.executionOutputs.missing")
    : String(value);
}

function receiptDisplay(state: OutputReceiptState): { readonly text: string; readonly className: string } {
  switch (state.kind) {
    case "pass":
      return {
        text: `${state.receiptRef} · ${t("components.executionOutputs.receiptPass")}`,
        className: "text-status-done",
      };
    case "fail":
      return {
        text: `${state.receiptRef} · ${t("components.executionOutputs.receiptFail")}`,
        className: "text-status-unknown",
      };
    case "no-result":
      return {
        text: `${state.receiptRef} · ${t("components.executionOutputs.receiptNoResult")}`,
        className: "text-stale",
      };
    case "no-checker":
      return { text: t("components.executionOutputs.receiptNoChecker"), className: "text-text-faint" };
    case "missing":
      return { text: t("components.executionOutputs.missing"), className: "text-stale" };
  }
}

function outputsCountText(outputs: readonly ExecutionEvidenceOutput[]): string {
  const counts: Record<OutputReceiptState["kind"], number> = {
    pass: 0,
    fail: 0,
    "no-result": 0,
    "no-checker": 0,
    missing: 0,
  };
  for (const output of outputs) counts[outputReceiptState(output).kind] += 1;
  const parts = [t("components.executionOutputs.countTotal", { count: outputs.length })];
  if (outputs.length > 0 && counts["no-checker"] === outputs.length) {
    parts.push(t("components.executionOutputs.countAllUnchecked"));
    return parts.join(" · ");
  }
  if (counts.pass > 0) parts.push(t("components.executionOutputs.countPass", { count: counts.pass }));
  if (counts.fail > 0) parts.push(t("components.executionOutputs.countFail", { count: counts.fail }));
  if (counts["no-result"] > 0)
    parts.push(t("components.executionOutputs.countNoResult", { count: counts["no-result"] }));
  if (counts["no-checker"] > 0)
    parts.push(t("components.executionOutputs.countNoChecker", { count: counts["no-checker"] }));
  if (counts.missing > 0) parts.push(t("components.executionOutputs.countMissing", { count: counts.missing }));
  return parts.join(" · ");
}

function ExecutionOutputsGroup({
  executions,
  focusedRecordRef,
}: {
  readonly executions: readonly ExecutionEvidenceRow[];
  readonly focusedRecordRef?: string | null;
}) {
  return (
    <AuditGroup title="Execution 输出" count={executions.length}>
      {executions.map((execution) => {
        const recordRef = `execution/${execution.executionId}`;
        return (
          <article
            key={execution.executionId}
            id={closeoutRecordDomId(recordRef)}
            data-testid={`task-execution-${execution.executionId}`}
            className={`grid grid-cols-[minmax(0,1fr)] gap-3 py-3 ${
              focusedRecordRef === recordRef ? "bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]" : ""
            }`}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono ui-micro">
              {/* executionId 是任务内记录的裸标识(行本体就是导航目标):展示叶截断 + 悬停完整值。 */}
              <IdText value={execution.executionId} className="font-semibold text-text" />
              <span className="rounded border border-border px-1.5 py-0.5 text-text-muted">
                {displayField(execution.state)}
              </span>
              {execution.origin && (
                <span className="rounded border border-border px-1.5 py-0.5 text-text-faint">{execution.origin}</span>
              )}
              <span className="text-text-faint">
                iteration {displayField(execution.iteration)} ·{" "}
                {execution.commitSha
                  ? `commit ${execution.commitSha.slice(0, 10)}`
                  : `commit ${t("components.executionOutputs.commitUncommitted")}`}
              </span>
              <span data-testid="execution-outputs-count" className="ml-auto text-text-faint">
                {outputsCountText(execution.outputs)}
              </span>
            </div>
            {execution.outputs.length === 0 ? (
              <p className="ui-meta text-text-faint">该 execution 没有输出记录。</p>
            ) : (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
                {execution.outputs.map((output, index) => {
                  const receipt = receiptDisplay(outputReceiptState(output));
                  return (
                    // 输出记录行(evidence 回执)与收口记录行同一 RecordRow 布局:
                    // 长 evidenceId 截断、长 locator 词内换行留在自身列,复制在行尾动作位。
                    <RecordRow
                      key={`${output.evidenceId ?? "unknown"}-${index}`}
                      id={<IdText value={displayField(output.evidenceId)} className="text-text" />}
                      state={
                        <span
                          data-testid={`output-receipt-state-${index}`}
                          className={`font-mono ui-micro ${receipt.className}`}
                        >
                          {receipt.text}
                        </span>
                      }
                      summary={
                        <span className="font-mono ui-micro text-text-muted">
                          {displayField(output.substrate)} · {displayField(output.locator)}
                        </span>
                      }
                      action={
                        <CopyContextButton compact buildText={() => buildExecutionEvidenceContext(execution, output)} />
                      }
                    />
                  );
                })}
              </div>
            )}
          </article>
        );
      })}
    </AuditGroup>
  );
}

function AuditRow({
  id,
  state,
  summary,
  at,
  recordRef,
  focused = false,
}: {
  readonly id: string;
  readonly state: string;
  readonly summary: string;
  readonly at: string;
  /** 该行的结构化引用(execution/<id> 等事件的引用对象):时间线聚焦的锚点。 */
  readonly recordRef?: string;
  readonly focused?: boolean;
}) {
  // 收口记录行(review/consent/witness):布局归共用原语 RecordRow——长 ID 截断、
  // 长正文留在自身列、断点按记录容器宽度;这里只组各域内容。
  return (
    <RecordRow
      domId={recordRef === undefined ? undefined : closeoutRecordDomId(recordRef)}
      focused={focused}
      id={<IdText value={id} className="text-text-muted" />}
      state={<span className="font-mono ui-micro text-text-faint">{state}</span>}
      summary={<p className="ui-meta leading-5 text-text">{summary}</p>}
      time={<Timestamp value={at} />}
      action={
        recordRef !== undefined ? (
          <CopyContextButton compact label="复制" title="复制完整记录引用" buildText={() => recordRef} />
        ) : undefined
      }
    />
  );
}
