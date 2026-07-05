import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
  DecisionPackageSchema,
  type DecisionPackage,
  type DecisionState
} from "../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../kernel/src/layout/index.ts";
import { readFrontmatter, readScalar, resolveHarnessLayout } from "../../kernel/src/layout/index.ts";

export interface DecisionDocumentReadResult {
  readonly decision: DecisionPackage;
  readonly body: string;
  readonly path: string;
}

export interface DecisionDocumentListResult {
  readonly decisions: ReadonlyArray<DecisionDocumentReadResult>;
}

export function readDecisionDocument(rootInput: HarnessLayoutInput, decisionId: string): DecisionDocumentReadResult {
  const layout = resolveHarnessLayout(rootInput);
  const documentPath = layout.decisionDocumentPath(decisionId);
  const documentBody = readFileSync(documentPath, "utf8");
  const frontmatter = readFrontmatter(documentBody);
  if (!frontmatter) throw new Error(`decision document missing frontmatter: ${decisionId}`);
  const decision = Schema.decodeUnknownSync(DecisionPackageSchema)(parseDecisionFrontmatter(frontmatter));
  return {
    decision,
    body: documentBody.replace(/^---\n[\s\S]*?\n---\n?/u, ""),
    path: path.relative(layout.rootDir, documentPath).split(path.sep).join("/")
  };
}

export function listDecisionDocuments(rootInput: HarnessLayoutInput): DecisionDocumentListResult {
  const layout = resolveHarnessLayout(rootInput);
  if (!existsSync(layout.decisionsRoot)) return { decisions: [] };
  const decisions = readdirSync(layout.decisionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("decision-"))
    .map((entry) => entry.name.slice("decision-".length))
    .map((decisionId) => readDecisionDocument(rootInput, decisionId))
    .sort((left, right) => compareDecisionIds(left.decision.decision_id, right.decision.decision_id));
  return { decisions };
}

function compareDecisionIds(left: string, right: string): number {
  const leftLegacy = legacyDecisionNumber(left);
  const rightLegacy = legacyDecisionNumber(right);
  if (leftLegacy !== null && rightLegacy !== null && leftLegacy !== rightLegacy) return leftLegacy - rightLegacy;
  if (leftLegacy !== null && rightLegacy === null) return -1;
  if (leftLegacy === null && rightLegacy !== null) return 1;
  return left.localeCompare(right);
}

function legacyDecisionNumber(decisionId: string): number | null {
  const match = /(?:^|_)E(\d+)(?:_|$)/u.exec(decisionId);
  return match ? Number(match[1]) : null;
}

function parseDecisionFrontmatter(frontmatter: string): DecisionPackage {
  const decidedAt = unquote(readScalar(frontmatter, "decidedAt"));
  const watermark = readScalar(frontmatter, "_coordinatorWatermark");
  return {
    schema: "decision-package/v1",
    decision_id: readScalar(frontmatter, "decision_id", { required: true }),
    ...(watermark ? { _coordinatorWatermark: watermark } : {}),
    title: unquote(readScalar(frontmatter, "title", { required: true })),
    state: readScalar(frontmatter, "state", { required: true }) as DecisionState,
    riskTier: readScalar(frontmatter, "riskTier", { required: true }) as DecisionPackage["riskTier"],
    urgency: readScalar(frontmatter, "urgency", { required: true }) as DecisionPackage["urgency"],
    vertical: unquote(readScalar(frontmatter, "vertical", { required: true })),
    preset: unquote(readScalar(frontmatter, "preset", { required: true })),
    applies_to: {
      modules: parseStringArray(readBlockScalar(frontmatter, "applies_to", "modules")),
      productLines: parseStringArray(readBlockScalar(frontmatter, "applies_to", "productLines"))
    },
    proposedBy: parseActor(readScalar(frontmatter, "proposedBy", { required: true })),
    proposedAt: unquote(readScalar(frontmatter, "proposedAt", { required: true })),
    arbiter: parseActor(readScalar(frontmatter, "arbiter", { required: true })),
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

function parseActor(value: string): DecisionPackage["arbiter"] {
  return parseFlowObject(value) as DecisionPackage["arbiter"];
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
    const previous = value[index - 1];
    if (char === "\"" && previous !== "\\") inString = !inString;
    if (!inString && (char === "{" || char === "[")) depth += 1;
    if (!inString && (char === "}" || char === "]")) depth -= 1;
    if (!inString && depth === 0 && char === ",") {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function unquote(value: string): string {
  if (!value) return "";
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}
