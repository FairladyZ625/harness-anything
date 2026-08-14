import type { DecisionMutationFeedback as Feedback } from "../decision-actions.ts";

export function DecisionMutationFeedback({ feedback, onCheckReceipt }: { feedback?: Feedback; onCheckReceipt?: () => void }) {
  if (!feedback) return null;
  const tone = feedback.state === "success" ? "border-success/40 bg-success/10 text-success" : feedback.state === "error" ? "border-danger/40 bg-danger/10 text-danger" : "border-stale/40 bg-stale/10 text-stale";
  return (
    <div className={`mt-2 rounded-md border p-2 font-mono text-[11px] ${tone}`}>
      <div>{feedback.state} · {feedback.kind} · opId: {feedback.opId}</div>
      {(feedback.code || feedback.origin) && <div>code: {feedback.code ?? "—"} · origin: {feedback.origin ?? "—"}</div>}
      <div className="font-sans">{feedback.hint}</div>
      {feedback.state === "pending" && feedback.opId !== "awaiting-receipt" && onCheckReceipt && <button onClick={onCheckReceipt} className="mt-1 rounded border border-current px-2 py-1 font-sans text-[10px]">receipt-show（不重放 mutation）</button>}
      {feedback.receipt && (
        <div className="mt-1 break-all text-[10px] opacity-80">
          consentId: {feedback.receipt.consentId ?? "proposal/N/A"} · path: {feedback.receipt.path ?? "—"}<br />
          commitSha: {feedback.receipt.commitSha ?? "—"} · documentSha256: {feedback.receipt.documentSha256 ?? "—"} · worktreeVisible: {String(feedback.receipt.worktreeVisible ?? false)}
        </div>
      )}
    </div>
  );
}
