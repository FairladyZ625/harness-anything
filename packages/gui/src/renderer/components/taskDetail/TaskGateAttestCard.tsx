import { useState } from "react";
import { CheckCircle, ClockCounterClockwise, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { TaskRow } from "../../model/types.ts";
import { taskGateAttestations } from "../../model/attestation-pool.ts";
import type { TaskMutationFeedback } from "../../task-actions.ts";
import { t } from "../../i18n/index.tsx";

export type GateAttestMode = "approve" | "override";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent";

/** 打勾签注/特批的行内表单(任务卡与总池共用):评语输入 + 校验 + 提交,不出模态。 */
export function GateAttestForm({
  mode,
  pending,
  onSubmit,
  onCancel,
}: {
  readonly mode: GateAttestMode;
  readonly pending: boolean;
  readonly onSubmit: (rationale: string) => void;
  readonly onCancel: () => void;
}) {
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState<string | null>(null);
  const override = mode === "override";
  const submit = () => {
    const note = rationale.trim();
    // 特批理由 trim 后 ≥10 字符(daemon 权威校验);approve 评语可空。
    if (override && [...note].length < 10) {
      setError(t("components.taskGateAttestCard.overrideRationaleRequired"));
      return;
    }
    onSubmit(note);
  };
  return (
    <div
      className={`mt-1.5 rounded-md border p-2.5 ${override ? "border-danger/40 bg-danger/5" : "border-border bg-surface-raised/50"}`}
    >
      {override && <p className="ui-micro text-danger">{t("components.taskGateAttestCard.overrideHint")}</p>}
      <label className={`block ui-micro font-semibold ${override ? "mt-1.5 text-text-muted" : "text-text-muted"}`}>
        {t(
          override
            ? "components.taskGateAttestCard.overrideRationaleLabel"
            : "components.taskGateAttestCard.rationaleLabel",
        )}
      </label>
      <textarea
        value={rationale}
        onChange={(event) => setRationale(event.target.value)}
        placeholder={t(
          override
            ? "components.taskGateAttestCard.overrideRationalePlaceholder"
            : "components.taskGateAttestCard.rationalePlaceholder",
        )}
        rows={2}
        maxLength={199}
        disabled={pending}
        className={`mt-1 w-full rounded-md border bg-surface p-2 ui-meta leading-relaxed text-text outline-none transition-colors duration-100 focus:border-accent ${override ? "border-danger/50" : "border-border"}`}
      />
      {error && <div className="mt-1 ui-micro text-danger">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className={`rounded-md px-2 py-1 ui-micro text-text-faint transition-colors duration-100 hover:bg-surface-raised hover:text-text disabled:opacity-50 ${focusRing}`}
        >
          {t("components.taskGateAttestCard.cancel")}
        </button>
        <button
          type="button"
          data-testid={`gate-attest-submit-${mode}`}
          onClick={submit}
          disabled={pending}
          className={`rounded-md px-3 py-1 ui-micro font-semibold transition-colors duration-100 disabled:opacity-50 ${focusRing} ${override ? "bg-danger text-accent-fg hover:bg-danger/85" : "bg-accent text-accent-fg hover:bg-accent/85"}`}
        >
          {t(override ? "components.taskGateAttestCard.override" : "components.taskGateAttestCard.attest")}
        </button>
      </div>
    </div>
  );
}

/** attest 反馈的行内展示:错误码/原因原样透传,不吞、不乐观。 */
export function AttestFeedbackRow({ feedback }: { readonly feedback: TaskMutationFeedback | undefined }) {
  if (!feedback) return null;
  return (
    <div
      data-testid="task-attest-feedback"
      className={`mt-2 rounded border px-2 py-1.5 ui-micro ${feedback.state === "error" ? "border-danger/40 text-danger" : feedback.state === "pending" ? "border-stale/40 text-stale" : "border-status-done/40 text-text-muted"}`}
    >
      <span className="font-mono">
        {feedback.kind} · {feedback.state} · opId={feedback.opId}
      </span>
      {feedback.code && <span className="ml-1 font-mono">code={feedback.code}</span>}
      <p className="mt-0.5">{feedback.hint}</p>
    </div>
  );
}

/**
 * 收口页签的 Gate 签注卡:按投影状态动态渲染每个完成门(判据见
 * model/attestation-pool.ts,与 kernel 四形态同一条)。manual-attest 缺见证与
 * 自动已 pass 的 signoff_missing 给【打勾签注】+ 评语(approve,评语走 note);
 * 契约声明 allowOverride 的自动门失败给【特批放行】(override,理由走 rationale,
 * trim 后 ≥10 字符)。waived 是人为放行不是自动通过,单独标注;done/历史接受与
 * 未声明 allowOverride 的失败门只读展示。行内展开,不出全局模态。
 */
export function TaskGateAttestCard({
  task,
  feedback,
  onAttest,
}: {
  readonly task: TaskRow;
  readonly feedback?: TaskMutationFeedback;
  readonly onAttest?: (
    task: Pick<TaskRow, "taskId">,
    gateId: string,
    mode: GateAttestMode,
    rationale?: string,
  ) => Promise<TaskMutationFeedback>;
}) {
  const [openGate, setOpenGate] = useState<string | null>(null);
  const attestations = taskGateAttestations(task),
    approveGateIds = new Set(attestations.gates.map(({ gateId }) => gateId)),
    overrideGateIds = new Set(attestations.breakGlass.map(({ gateId }) => gateId)),
    attestFeedback = feedback?.kind === "attest" ? feedback : undefined,
    pending = attestFeedback?.state === "pending";

  if (task.gates.length === 0)
    return (
      <div data-testid="task-gate-attest-card">
        <h3 className="ui-body font-semibold text-text">Gate assessment</h3>
        <p className="mt-3 ui-meta text-text-faint">没有 completion gate。</p>
      </div>
    );
  return (
    <div data-testid="task-gate-attest-card">
      <h3 className="ui-body font-semibold text-text">Gate assessment · 签注</h3>
      <div className="mt-3 grid gap-2">
        {task.gates.map((gate) => {
          const signable = approveGateIds.has(gate.name),
            overridable = overrideGateIds.has(gate.name),
            mode: GateAttestMode | null = signable ? "approve" : overridable ? "override" : null,
            waived = gate.status === "waived";
          return (
            <div
              key={gate.name}
              data-testid={`task-gate-row-${gate.name}`}
              className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 ui-micro"
            >
              {waived ? (
                <WarningCircle weight="bold" className="mt-0.5 text-stale" />
              ) : gate.ok === true ? (
                <CheckCircle weight="bold" className="mt-0.5 text-status-done" />
              ) : gate.ok === false ? (
                <XCircle weight="bold" className="mt-0.5 text-danger" />
              ) : (
                <ClockCounterClockwise weight="bold" className="mt-0.5 text-stale" />
              )}
              <div>
                <p className="font-mono text-text-muted">
                  {gate.name}
                  {gate.status ? <span className="text-text-faint"> · {gate.status}</span> : null}
                </p>
                {waived && (
                  <p data-testid={`task-gate-waived-${gate.name}`} className="mt-0.5 ui-micro text-stale">
                    {t("components.taskGateAttestCard.waivedLabel")}
                  </p>
                )}
                {gate.detail ? <p className="mt-0.5 leading-5 text-text-faint">{gate.detail}</p> : null}
                {mode && (
                  <div className="mt-1.5">
                    {openGate === gate.name ? (
                      <GateAttestForm
                        mode={mode}
                        pending={pending}
                        onCancel={() => setOpenGate(null)}
                        onSubmit={(rationale) => {
                          setOpenGate(null);
                          void onAttest?.(task, gate.name, mode, rationale || undefined);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        data-testid={`task-gate-${mode}-${gate.name}`}
                        onClick={() => setOpenGate(gate.name)}
                        disabled={pending}
                        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-semibold transition-colors duration-100 disabled:opacity-50 ${focusRing} ${mode === "approve" ? "bg-accent text-accent-fg hover:bg-accent/85" : "border border-danger/50 text-danger hover:bg-danger/10"}`}
                      >
                        {mode === "approve" ? <CheckCircle weight="bold" /> : <XCircle weight="bold" />}
                        {t(
                          mode === "approve"
                            ? "components.taskGateAttestCard.attest"
                            : "components.taskGateAttestCard.override",
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <AttestFeedbackRow feedback={attestFeedback} />
    </div>
  );
}
