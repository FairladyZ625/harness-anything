import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import type { DecisionPackage } from "../schemas/decision-package.ts";
import type { DecisionProjectionRow } from "./types.ts";

export function readDecisionProjectionRows(rootInput: HarnessLayoutInput): ReadonlyArray<DecisionProjectionRow> {
  const layout = resolveHarnessLayout(rootInput);
  return listDecisionDocumentPaths(layout.decisionsRoot)
    .map((documentPath) => decisionDocumentToProjectionRow(layout.rootDir, documentPath))
    .sort(compareDecisionRows);
}

export function hashDecisionProjectionRows(rows: ReadonlyArray<DecisionProjectionRow>): string {
  return `sha256:${sha256Text(JSON.stringify([...rows].sort(compareDecisionRows)))}`;
}

export function compareDecisionRows(a: DecisionProjectionRow, b: DecisionProjectionRow): number {
  const left = a.legacyId ? legacyNumber(a.legacyId) : undefined;
  const right = b.legacyId ? legacyNumber(b.legacyId) : undefined;
  if (left !== undefined && right !== undefined && left !== right) return left - right;
  if (left !== undefined && right === undefined) return -1;
  if (left === undefined && right !== undefined) return 1;
  return a.decisionId.localeCompare(b.decisionId);
}

function decisionDocumentToProjectionRow(rootDir: string, documentPath: string): DecisionProjectionRow {
  const body = readFileSync(documentPath, "utf8");
  const frontmatter = readFrontmatter(body) ?? "";
  const decision = readDecisionSourceFields(frontmatter);
  const legacyId = legacyIdFromDecisionId(decision.decision_id);
  return {
    schema: "d4-decision-row/v1",
    decisionId: decision.decision_id,
    ...(legacyId ? { legacyId } : {}),
    state: decision.state,
    title: decision.title || decision.decision_id,
    question: decision.question,
    chosen: decision.chosen.map((entry) => entry.text),
    rejected: decision.rejected.map((entry) => ({
      text: entry.text,
      whyNot: entry.why_not
    })),
    path: relativeSourcePath(rootDir, documentPath),
    moduleKeys: decision.applies_to.modules,
    productLineKeys: decision.applies_to.productLines,
    ...(decision.decidedAt ? { decidedAt: decision.decidedAt } : {})
  };
}

type DecisionSourceFieldReaders = {
  readonly [Field in keyof DecisionPackage]: (frontmatter: string) => DecisionPackage[Field];
};

const decisionSourceFieldReaders = {
  schema: () => "decision-package/v1",
  decision_id: (frontmatter) => readScalar(frontmatter, "decision_id", { required: true }),
  _coordinatorWatermark: (frontmatter) => optional(unquote(readScalar(frontmatter, "_coordinatorWatermark"))),
  title: (frontmatter) => unquote(readScalar(frontmatter, "title")),
  state: (frontmatter) => (readScalar(frontmatter, "state") || "unknown") as DecisionPackage["state"],
  riskTier: (frontmatter) => readScalar(frontmatter, "riskTier") as DecisionPackage["riskTier"],
  urgency: (frontmatter) => readScalar(frontmatter, "urgency") as DecisionPackage["urgency"],
  vertical: (frontmatter) => unquote(readScalar(frontmatter, "vertical")),
  preset: (frontmatter) => unquote(readScalar(frontmatter, "preset")),
  applies_to: (frontmatter) => ({
    modules: parseStringArray(readBlockScalar(frontmatter, "applies_to", "modules")),
    productLines: parseStringArray(readBlockScalar(frontmatter, "applies_to", "productLines"))
  }),
  proposedBy: (frontmatter) => parseFlowObject(readScalar(frontmatter, "proposedBy")) as DecisionPackage["proposedBy"],
  proposedAt: (frontmatter) => unquote(readScalar(frontmatter, "proposedAt")),
  arbiter: (frontmatter) => parseFlowObject(readScalar(frontmatter, "arbiter")) as DecisionPackage["arbiter"],
  decidedAt: (frontmatter) => optional(unquote(readScalar(frontmatter, "decidedAt"))),
  provenance: (frontmatter) => parseObjectList(frontmatter, "provenance") as DecisionPackage["provenance"],
  question: (frontmatter) => unquote(readScalar(frontmatter, "question")),
  chosen: (frontmatter) => parseObjectList(frontmatter, "chosen") as DecisionPackage["chosen"],
  rejected: (frontmatter) => parseObjectList(frontmatter, "rejected") as DecisionPackage["rejected"],
  claims: (frontmatter) => parseObjectList(frontmatter, "claims") as DecisionPackage["claims"],
  relations: (frontmatter) => parseObjectList(frontmatter, "relations") as DecisionPackage["relations"]
} satisfies DecisionSourceFieldReaders;

function readDecisionSourceFields(frontmatter: string): DecisionPackage {
  return Object.fromEntries(
    Object.entries(decisionSourceFieldReaders)
      .map(([field, reader]) => [field, reader(frontmatter)])
      .filter(([, value]) => value !== undefined)
  ) as DecisionPackage;
}

function listDecisionDocumentPaths(decisionsRoot: string): ReadonlyArray<string> {
  if (!existsSync(decisionsRoot)) return [];
  const stat = statSync(decisionsRoot);
  if (stat.isFile()) return path.basename(decisionsRoot) === "decision.md" ? [decisionsRoot] : [];
  if (!stat.isDirectory()) return [];
  return readdirSync(decisionsRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
    .flatMap((entry) => listDecisionDocumentPaths(path.join(decisionsRoot, entry.name)))
    .sort();
}

function readBlockScalar(frontmatter: string, blockName: string, key: string): string {
  return readIndentedBlock(frontmatter, blockName)
    .find((line) => line.trimStart().startsWith(`${key}:`))
    ?.replace(new RegExp(`^\\s*${key}:\\s*`, "u"), "")
    .trim() ?? "[]";
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
    result[key] = parseDecisionScalar(part.slice(separator + 1).trim());
  }
  return result;
}

function parseBlockObjectLine(value: string): Record<string, unknown> {
  const separator = value.indexOf(":");
  if (separator === -1) return {};
  const key = value.slice(0, separator).trim();
  return { [key]: parseDecisionScalar(value.slice(separator + 1).trim()) };
}

function parseDecisionScalar(value: string): unknown {
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

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function unquote(value: string): string {
  if (!value) return "";
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

function optional(value: string): string | undefined {
  return value ? value : undefined;
}

function relativeSourcePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function legacyIdFromDecisionId(decisionId: string): string | undefined {
  const match = /(?:^|_)E(\d+)(?:_|$)/u.exec(decisionId);
  return match ? `E${Number(match[1])}` : undefined;
}

function legacyNumber(value: string): number | undefined {
  const match = /^E?(\d+)$/iu.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : undefined;
}
