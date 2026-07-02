import type { DecisionPackage } from "../schemas/decision-package.ts";

export interface DecisionDocumentPayload {
  readonly decision: DecisionPackage;
  readonly body?: string;
}

export function isDecisionDocumentPayload(payload: unknown): payload is DecisionDocumentPayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as { readonly decision?: unknown; readonly body?: unknown };
  if (!candidate.decision || typeof candidate.decision !== "object") return false;
  return candidate.body === undefined || typeof candidate.body === "string";
}

export function serializeDecisionDocument(payload: DecisionDocumentPayload, watermark: string): string {
  // This per-decision marker is the authoring op id. It is distinct from the
  // global write-watermark/v1 file that records committed coordinator state.
  const decision = { ...payload.decision, _coordinatorWatermark: watermark };
  return [
    "---",
    `schema: ${decision.schema}`,
    `decision_id: ${decision.decision_id}`,
    `_coordinatorWatermark: ${watermark}`,
    `title: ${quoteScalar(decision.title)}`,
    `state: ${decision.state}`,
    `riskTier: ${decision.riskTier}`,
    `urgency: ${decision.urgency}`,
    `vertical: ${quoteScalar(decision.vertical)}`,
    `preset: ${quoteScalar(decision.preset)}`,
    "applies_to:",
    `  modules: ${flowArray(decision.applies_to.modules)}`,
    `  productLines: ${flowArray(decision.applies_to.productLines)}`,
    `proposedBy: ${flowObject(decision.proposedBy)}`,
    `proposedAt: ${quoteScalar(decision.proposedAt)}`,
    `arbiter: ${flowObject(decision.arbiter)}`,
    ...(decision.decidedAt ? [`decidedAt: ${quoteScalar(decision.decidedAt)}`] : []),
    "provenance:",
    ...decision.provenance.map((entry) => `  - ${flowObject(entry)}`),
    `question: ${quoteScalar(decision.question)}`,
    "chosen:",
    ...decision.chosen.map((entry) => `  - ${flowObject(entry)}`),
    "rejected:",
    ...decision.rejected.map((entry) => `  - ${flowObject(entry)}`),
    "claims:",
    ...decision.claims.map((entry) => `  - ${flowObject(entry)}`),
    "relations:",
    ...decision.relations.map((entry) => `  - ${flowObject(entry)}`),
    "---",
    "",
    payload.body ?? `# ${decision.title}`,
    ""
  ].join("\n");
}

function flowArray(values: ReadonlyArray<string>): string {
  return `[${values.map(quoteScalar).join(", ")}]`;
}

function flowObject(value: Record<string, unknown>): string {
  return `{ ${Object.entries(value).map(([key, entry]) => `${key}: ${formatFlowValue(entry)}`).join(", ")} }`;
}

function formatFlowValue(value: unknown): string {
  if (typeof value === "string") return quoteScalar(value);
  if (Array.isArray(value)) return flowArray(value.map((entry) => String(entry)));
  if (value && typeof value === "object") return flowObject(value as Record<string, unknown>);
  return JSON.stringify(value);
}

function quoteScalar(value: string): string {
  return JSON.stringify(value);
}
