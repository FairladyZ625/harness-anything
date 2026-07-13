import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { parseObjectList, parseStringArray, readBlockScalar, unquote } from "../markdown/flow-frontmatter.ts";
import type { DecisionPackage } from "../schemas/decision-package.ts";
import type { EntityRelationRecord } from "./entity-relation.ts";

export interface DecisionDocumentTaskWrite {
  readonly taskId: string;
  readonly path: string;
  readonly body: string;
  readonly packageSlug?: string;
}

export type DecisionDocumentWriteMode =
  | { readonly kind: "snapshot"; readonly expectedWatermark?: string | null; readonly appendBody?: string }
  | { readonly kind: "append_relation"; readonly relation: EntityRelationRecord };

export interface DecisionDocumentPayload {
  readonly decision: DecisionPackage;
  readonly body?: string;
  readonly taskWrites?: ReadonlyArray<DecisionDocumentTaskWrite>;
  readonly writeMode?: DecisionDocumentWriteMode;
}

export function isDecisionDocumentPayload(payload: unknown): payload is DecisionDocumentPayload {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as { readonly decision?: unknown; readonly body?: unknown };
  if (!candidate.decision || typeof candidate.decision !== "object") return false;
  return candidate.body === undefined || typeof candidate.body === "string";
}

export function serializeDecisionDocument(payload: DecisionDocumentPayload, watermark: string, preservedBodyTail?: string): string {
  // This per-decision marker is the authoring op id. It is distinct from the
  // global write-watermark/v1 file that records committed coordinator state.
  const decision = { ...payload.decision, _coordinatorWatermark: watermark };
  const frontmatter = [
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
    ...(decision.decisionClass ? [`decisionClass: ${decision.decisionClass}`] : []),
    "applies_to:",
    `  modules: ${flowArray(decision.applies_to.modules)}`,
    `  productLines: ${flowArray(decision.applies_to.productLines)}`,
    `proposedAt: ${quoteScalar(decision.proposedAt)}`,
    ...(decision.decidedAt ? [`decidedAt: ${quoteScalar(decision.decidedAt)}`] : []),
    ...(decision.contentPins !== undefined ? [
      "contentPins:",
      ...decision.contentPins.map((entry) => `  - ${flowObject(entry)}`)
    ] : []),
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
    "---"
  ].join("\n");
  if (preservedBodyTail !== undefined) return `${frontmatter}${preservedBodyTail}`;
  return `${frontmatter}\n\n${payload.body ?? `# ${decision.title}`}\n`;
}

export function parseDecisionDocument(documentBody: string): DecisionDocumentPayload {
  const frontmatter = readFrontmatter(documentBody);
  if (!frontmatter) throw new Error("decision document missing frontmatter");
  return {
    decision: parseDecisionFrontmatter(frontmatter),
    body: documentBody.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/u, "")
  };
}

export function readDecisionWatermark(documentBody: string): string | null {
  const frontmatter = readFrontmatter(documentBody);
  if (!frontmatter) return null;
  return readScalar(frontmatter, "_coordinatorWatermark") || null;
}

function parseDecisionFrontmatter(frontmatter: string): DecisionPackage {
  const decidedAt = unquote(readScalar(frontmatter, "decidedAt"));
  const watermark = readScalar(frontmatter, "_coordinatorWatermark");
  const contentPins = parseObjectList(frontmatter, "contentPins") as DecisionPackage["contentPins"];
  return {
    schema: "decision-package/v1",
    decision_id: readScalar(frontmatter, "decision_id", { required: true }),
    ...(watermark ? { _coordinatorWatermark: watermark } : {}),
    title: unquote(readScalar(frontmatter, "title", { required: true })),
    state: readScalar(frontmatter, "state", { required: true }) as DecisionPackage["state"],
    riskTier: readScalar(frontmatter, "riskTier", { required: true }) as DecisionPackage["riskTier"],
    urgency: readScalar(frontmatter, "urgency", { required: true }) as DecisionPackage["urgency"],
    vertical: unquote(readScalar(frontmatter, "vertical", { required: true })),
    preset: unquote(readScalar(frontmatter, "preset", { required: true })),
    ...(readScalar(frontmatter, "decisionClass") ? {
      decisionClass: readScalar(frontmatter, "decisionClass") as DecisionPackage["decisionClass"]
    } : {}),
    applies_to: {
      modules: parseStringArray(readBlockScalar(frontmatter, "applies_to", "modules")),
      productLines: parseStringArray(readBlockScalar(frontmatter, "applies_to", "productLines"))
    },
    proposedAt: unquote(readScalar(frontmatter, "proposedAt", { required: true })),
    ...(decidedAt ? { decidedAt } : {}),
    ...(hasTopLevelKey(frontmatter, "contentPins") ? { contentPins } : {}),
    provenance: parseObjectList(frontmatter, "provenance") as DecisionPackage["provenance"],
    question: unquote(readScalar(frontmatter, "question", { required: true })),
    chosen: parseObjectList(frontmatter, "chosen") as DecisionPackage["chosen"],
    rejected: parseObjectList(frontmatter, "rejected") as DecisionPackage["rejected"],
    claims: parseObjectList(frontmatter, "claims") as DecisionPackage["claims"],
    relations: parseObjectList(frontmatter, "relations") as DecisionPackage["relations"]
  };
}

function hasTopLevelKey(frontmatter: string, key: string): boolean {
  return new RegExp(`^${key}:\\s*$`, "mu").test(frontmatter);
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
