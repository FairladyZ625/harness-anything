import { useEffect, useState } from "react";
import { CheckCircle, ClockClockwise, ProhibitInset } from "@phosphor-icons/react";
import { decisionHasReachableEvidence, type DecisionAction, type DecisionMutationFeedback } from "../decision-actions.ts";
import type { DecisionRow, RelationEdge } from "../model/types.ts";
import { DecisionMutationFeedback as FeedbackView } from "./DecisionMutationFeedback.tsx";

export interface JudgmentOpenRequest { readonly action: DecisionAction; readonly nonce: number }

const actionLabel: Record<DecisionAction, string> = { accept: "Accept", reject: "Reject", defer: "Defer" };
const validRationale = (value: string) => [...value.trim()].length >= 1 && [...value.trim()].length <= 199;

export function DecisionJudgmentPanel({ decision, relations, feedback, openRequest, onSubmit, onCheckReceipt }: {
  decision: DecisionRow;
  relations: ReadonlyArray<RelationEdge>;
  feedback?: DecisionMutationFeedback;
  openRequest?: JudgmentOpenRequest;
  onSubmit: (decision: DecisionRow, action: DecisionAction, input: { readonly rationale: string; readonly judgmentOnlyRationale?: string }) => Promise<DecisionMutationFeedback>;
  onCheckReceipt?: () => void;
}) {
  const [action, setAction] = useState<DecisionAction | null>(openRequest?.action ?? null);
  const [rationale, setRationale] = useState("");
  const [judgmentOnly, setJudgmentOnly] = useState("");
  const [error, setError] = useState<string | null>(null);
  const evidenceReachable = decisionHasReachableEvidence(decision, relations);
  const pending = feedback?.state === "pending";
  useEffect(() => { if (openRequest) setAction(openRequest.action); }, [openRequest]);

  const submit = async () => {
    if (!action || !validRationale(rationale)) { setError("rationale 必须为 1..199 个字符。"); return; }
    if (action === "accept" && !evidenceReachable && !validRationale(judgmentOnly)) { setError("没有 active claim evidence；accept 必须补 1..199 字 judgment-only rationale。"); return; }
    setError(null);
    const result = await onSubmit(decision, action, { rationale: rationale.trim(), ...(action === "accept" && !evidenceReachable ? { judgmentOnlyRationale: judgmentOnly.trim() } : {}) });
    if (result.state === "success") { setAction(null); setRationale(""); setJudgmentOnly(""); }
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex gap-2">
        {(["accept", "reject", "defer"] as DecisionAction[]).map((item) => (
          <button key={item} onClick={() => { setAction(item); setError(null); }} disabled={pending}
            className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors duration-100 disabled:opacity-50 ${item === "accept" ? "bg-accent text-accent-fg hover:bg-accent/85" : "border border-border text-text hover:border-border-strong hover:bg-surface-raised"}`}>
            {item === "accept" ? <CheckCircle weight="bold" /> : item === "reject" ? <ProhibitInset weight="bold" /> : <ClockClockwise weight="bold" />}
            {actionLabel[item]}
          </button>
        ))}
      </div>
      {action && (
        <div className="mt-2 rounded-md border border-border bg-surface-raised/50 p-2.5">
          <label className="block text-[11px] font-semibold text-text-muted">{actionLabel[action]} rationale · 1..199</label>
          <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={2} maxLength={199} disabled={pending}
            className="mt-1 w-full rounded-md border border-border bg-surface p-2 text-[12px] leading-relaxed text-text outline-none transition-colors duration-100 focus:border-accent" />
          {action === "accept" && !evidenceReachable && (
            <label className="mt-2 block text-[11px] font-semibold text-stale">
              judgment-only rationale · 1..199（当前无可达 active claim evidence）
              <textarea value={judgmentOnly} onChange={(event) => setJudgmentOnly(event.target.value)} rows={2} maxLength={199} disabled={pending}
                className="mt-1 w-full rounded-md border border-stale/50 bg-surface p-2 text-[12px] leading-relaxed text-text outline-none transition-colors duration-100 focus:border-stale" />
            </label>
          )}
          {error && <div className="mt-1 text-[11px] text-danger">{error}</div>}
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={() => setAction(null)} disabled={pending} className="rounded-md px-2 py-1 text-[11px] text-text-faint transition-colors duration-100 hover:bg-surface-raised hover:text-text">取消</button>
            <button onClick={submit} disabled={pending} className="rounded-md bg-accent px-3 py-1 text-[11px] font-semibold text-accent-fg transition-colors duration-100 hover:bg-accent/85 disabled:opacity-50">确认 {actionLabel[action]}</button>
          </div>
        </div>
      )}
      <FeedbackView feedback={feedback} onCheckReceipt={onCheckReceipt} />
    </div>
  );
}
