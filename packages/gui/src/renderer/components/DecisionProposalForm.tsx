import { useState } from "react";
import type { RelationType } from "../../api/renderer-dto.ts";
import type { DecisionMutationFeedback, DecisionProposalInput } from "../decision-actions.ts";
import { KIND_LABEL } from "../graph/constants.ts";
import { DecisionMutationFeedback as FeedbackView } from "./DecisionMutationFeedback.tsx";

type Risk = DecisionProposalInput["riskTier"];
type Urgency = DecisionProposalInput["urgency"];
const inputClass = "w-full rounded border border-border bg-surface px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent";
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const columns = (value: string, count: number, label: string) => lines(value).map((line) => { const parts = line.split("|").map((part) => part.trim()); if (parts.length < count || parts.slice(0, count).some((part) => !part)) throw new Error(`${label} 每行需要 ${count} 列，以 | 分隔。`); return parts; });
const scopes = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

export function DecisionProposalForm({ feedback, onSubmit, onClose, onCheckReceipt }: {
  feedback?: DecisionMutationFeedback;
  onSubmit: (input: DecisionProposalInput) => Promise<DecisionMutationFeedback>;
  onClose: () => void;
  onCheckReceipt?: () => void;
}) {
  const [title, setTitle] = useState(""), [question, setQuestion] = useState(""), [risk, setRisk] = useState<Risk | "">(""), [urgency, setUrgency] = useState<Urgency | "">("");
  const [vertical, setVertical] = useState(""), [preset, setPreset] = useState(""), [decisionClass, setDecisionClass] = useState<DecisionProposalInput["decisionClass"]>("ordinary");
  const [modules, setModules] = useState(""), [productLines, setProductLines] = useState(""), [chosen, setChosen] = useState("CH1 |  | "), [rejected, setRejected] = useState("RJ1 |  | ");
  const [background, setBackground] = useState(""), [tradeoffs, setTradeoffs] = useState(""), [conclusion, setConclusion] = useState(""), [claims, setClaims] = useState(""), [fulfillments, setFulfillments] = useState(""), [relations, setRelations] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pending = feedback?.state === "pending";
  const submit = async () => {
    try {
      if (![title, question, vertical, preset, background, tradeoffs, conclusion].every((value) => value.trim())) throw new Error("title/question/vertical/preset 与正文三段均必填。");
      if (!risk || !urgency) throw new Error("risk 与 urgency 必须由人显式选择，不使用默认值。");
      const chosenRows = columns(chosen, 2, "chosen"), rejectedRows = columns(rejected, 3, "rejected"), claimRows = columns(claims, 3, "claims"), fulfillmentRows = columns(fulfillments, 2, "fulfillments"), relationRows = columns(relations, 4, "relations");
      const invalidRelation = relationRows.find((row) => !Object.hasOwn(KIND_LABEL, row[1]));
      if (invalidRelation) throw new Error(`未知 relation type:${invalidRelation[1]}`);
      const packet: DecisionProposalInput = {
        title: title.trim(), question: question.trim(), riskTier: risk, urgency, vertical: vertical.trim(), preset: preset.trim(), decisionClass,
        appliesTo: { modules: scopes(modules), productLines: scopes(productLines) },
        chosen: chosenRows.map(([id, text, rationale]) => ({ id, text, ...(rationale ? { rationale } : {}) })),
        rejected: rejectedRows.map(([id, text, whyNot]) => ({ id, text, whyNot })),
        body: `## 背景\n${background.trim()}\n\n## 权衡\n${tradeoffs.trim()}\n\n## 结论\n${conclusion.trim()}\n`,
        claims: claimRows.map(([id, text, loadBearing]) => { if (!(["true", "false"] as const).includes(loadBearing as "true" | "false")) throw new Error(`claim ${id} 的 loadBearing 必须为 true/false。`); return { id, text, loadBearing: loadBearing === "true" }; }),
        fulfillments: fulfillmentRows.map(([claimId, mode]) => { if (!(["evidenced", "delivered", "standing_policy"] as const).includes(mode as never)) throw new Error(`claim ${claimId} 的 fulfillment mode 无效。`); return { claimId, mode: mode as "evidenced" | "delivered" | "standing_policy" }; }),
        relations: relationRows.map(([anchor, type, target, rationale]) => ({ anchor, type: type as RelationType, target, rationale })),
      };
      setError(null); await onSubmit(packet);
    } catch (cause) { consumeKnownError(cause); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return (
    <section className="border-b border-border bg-surface-raised/30 px-4 py-3">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-[13px] font-semibold text-text">新建完整 proposal packet</h2><button onClick={onClose} className="text-[11px] text-text-faint">关闭</button></div>
      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
        <label className="text-[11px] text-text-faint">title<input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="text-[11px] text-text-faint">question<input className={inputClass} value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
        <label className="text-[11px] text-text-faint">risk · 人选<select className={inputClass} value={risk} onChange={(e) => setRisk(e.target.value as Risk | "")}><option value="" disabled>请选择</option><option>low</option><option>medium</option><option>high</option></select></label>
        <label className="text-[11px] text-text-faint">urgency · 人选<select className={inputClass} value={urgency} onChange={(e) => setUrgency(e.target.value as Urgency | "")}><option value="" disabled>请选择</option><option>low</option><option>medium</option><option>high</option></select></label>
        <label className="text-[11px] text-text-faint">vertical<input className={inputClass} value={vertical} onChange={(e) => setVertical(e.target.value)} /></label>
        <label className="text-[11px] text-text-faint">preset<input className={inputClass} value={preset} onChange={(e) => setPreset(e.target.value)} /></label>
        <label className="text-[11px] text-text-faint">decisionClass<select className={inputClass} value={decisionClass} onChange={(e) => setDecisionClass(e.target.value as typeof decisionClass)}><option value="ordinary">ordinary</option><option value="standing_policy">standing_policy</option></select></label>
        <label className="text-[11px] text-text-faint">appliesTo.modules · CSV<input className={inputClass} value={modules} onChange={(e) => setModules(e.target.value)} /></label>
        <label className="text-[11px] text-text-faint">appliesTo.productLines · CSV<input className={inputClass} value={productLines} onChange={(e) => setProductLines(e.target.value)} /></label>
      </div>
      <div className="mt-2 grid gap-2 lg:grid-cols-3">
        <PacketArea label="chosen · id | text | rationale?" value={chosen} onChange={setChosen} />
        <PacketArea label="rejected · id | text | whyNot" value={rejected} onChange={setRejected} />
        <PacketArea label="claims · id | text | loadBearing" value={claims} onChange={setClaims} />
        <PacketArea label="fulfillments · claimId | mode" value={fulfillments} onChange={setFulfillments} />
        <PacketArea label="relations · anchor | type | target | rationale" value={relations} onChange={setRelations} />
      </div>
      <div className="mt-2 grid gap-2 lg:grid-cols-3"><PacketArea label="正文 1/3 · 背景" value={background} onChange={setBackground} /><PacketArea label="正文 2/3 · 权衡" value={tradeoffs} onChange={setTradeoffs} /><PacketArea label="正文 3/3 · 结论" value={conclusion} onChange={setConclusion} /></div>
      {error && <div className="mt-2 text-[11px] text-danger">{error}</div>}
      <button onClick={submit} disabled={pending} className="mt-2 rounded bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg disabled:opacity-50">提交 proposal</button>
      <FeedbackView feedback={feedback} onCheckReceipt={onCheckReceipt} />
    </section>
  );
}

function PacketArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-[11px] text-text-faint">{label}<textarea rows={3} className={inputClass} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
function consumeKnownError(error: unknown): void { void error; }
