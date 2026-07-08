import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import type { DecisionPackage } from "../schemas/decision-package.ts";
import type { EntityRelationRecord } from "./entity-relation.ts";

export interface DecisionDocumentTaskWrite {
  readonly taskId: string;
  readonly path: string;
  readonly body: string;
  readonly packageSlug?: string;
}

export type DecisionDocumentWriteMode =
  | { readonly kind: "snapshot"; readonly expectedWatermark?: string | null }
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

export function parseDecisionDocument(documentBody: string): DecisionDocumentPayload {
  const frontmatter = readFrontmatter(documentBody);
  if (!frontmatter) throw new Error("decision document missing frontmatter");
  return {
    decision: parseDecisionFrontmatter(frontmatter),
    body: documentBody.replace(/^---\n[\s\S]*?\n---\n?/u, "")
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
    applies_to: {
      modules: parseStringArray(readBlockScalar(frontmatter, "applies_to", "modules")),
      productLines: parseStringArray(readBlockScalar(frontmatter, "applies_to", "productLines"))
    },
    proposedBy: parseFlowObject(readScalar(frontmatter, "proposedBy", { required: true })) as DecisionPackage["proposedBy"],
    proposedAt: unquote(readScalar(frontmatter, "proposedAt", { required: true })),
    arbiter: parseFlowObject(readScalar(frontmatter, "arbiter", { required: true })) as DecisionPackage["arbiter"],
    ...(decidedAt ? { decidedAt } : {}),
    provenance: parseObjectList(frontmatter, "provenance") as DecisionPackage["provenance"],
    question: unquote(readScalar(frontmatter, "question", { required: true })),
    chosen: parseObjectList(frontmatter, "chosen") as DecisionPackage["chosen"],
    rejected: parseObjectList(frontmatter, "rejected") as DecisionPackage["rejected"],
    claims: parseObjectList(frontmatter, "claims") as DecisionPackage["claims"],
    relations: parseObjectList(frontmatter, "relations") as DecisionPackage["relations"]
  };
}

function readBlockScalar(frontmatter: string, blockName: string, key: string): string {
  return readIndentedBlock(frontmatter, blockName)
    .find((line) => line.trimStart().startsWith(`${key}:`))
    ?.replace(new RegExp(`^\\s*${key}:\\s*`, "u"), "")
    .trim() ?? "[]";
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
}

function parseObjectList(frontmatter: string, key: string): ReadonlyArray<Record<string, unknown>> {
  const items: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | null = null;
  for (const rawLine of readIndentedBlock(frontmatter, key)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("- ")) {
      if (current) items.push(current);
      const body = line.slice(2).trim();
      current = body.startsWith("{") ? parseFlowObject(body) : parseBlockObjectLine(body);
      continue;
    }
    if (!current) continue;
    for (const [entryKey, entryValue] of Object.entries(parseBlockObjectLine(line))) {
      current[entryKey] = entryValue;
    }
  }
  if (current) items.push(current);
  return items;
}

function readIndentedBlock(frontmatter: string, key: string): ReadonlyArray<string> {
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/u.test(line)) break;
    block.push(line);
  }
  return block;
}

function parseFlowObject(value: string): Record<string, unknown> {
  const body = value.trim().replace(/^\{\s*/u, "").replace(/\s*\}$/u, "");
  const result: Record<string, unknown> = {};
  for (const part of splitTopLevel(body)) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    result[key] = parseFlowValue(part.slice(separator + 1).trim());
  }
  return result;
}

function parseBlockObjectLine(value: string): Record<string, unknown> {
  const separator = value.indexOf(":");
  if (separator === -1) return {};
  const key = value.slice(0, separator).trim();
  return { [key]: parseFlowValue(value.slice(separator + 1).trim()) };
}

function parseFlowValue(value: string): unknown {
  if (value.startsWith("{")) return parseFlowObject(value);
  if (value.startsWith("[")) return parseStringArray(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return unquote(value);
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\"" && value[index - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  return tail ? [...parts, tail] : parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("\"")) return trimmed;
  try {
    return String(JSON.parse(trimmed));
  } catch {
    return trimmed.replace(/^"|"$/gu, "");
  }
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
