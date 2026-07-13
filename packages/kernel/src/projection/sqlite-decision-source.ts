import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import { parseObjectList, parseStringArray, readBlockScalar, unquote } from "../markdown/flow-frontmatter.ts";
import type { DecisionPackage } from "../schemas/decision-package.ts";
import type { DecisionProjectionRow } from "./types.ts";
import { unresolvedEntityAttribution } from "./entity-attribution-projection.ts";

export function readDecisionProjectionRows(rootInput: HarnessLayoutInput): ReadonlyArray<DecisionProjectionRow> {
  const layout = resolveHarnessLayout(rootInput);
  return listDecisionDocumentPaths(layout.decisionsRoot)
    .map((documentPath) => decisionDocumentToProjectionRow(layout.rootDir, documentPath))
    .sort(compareDecisionRows);
}

export function readDecisionProjectionRowsForPaths(
  rootInput: HarnessLayoutInput,
  documentPaths: ReadonlyArray<string>
): ReadonlyArray<DecisionProjectionRow> {
  const layout = resolveHarnessLayout(rootInput);
  return uniqueDecisionDocumentPaths(documentPaths.map((documentPath) => path.resolve(documentPath)))
    .filter((documentPath) => existsSync(documentPath) && path.basename(documentPath) === "decision.md")
    .map((documentPath) => decisionDocumentToProjectionRow(layout.rootDir, documentPath))
    .sort(compareDecisionRows);
}

export function hashDecisionProjectionRows(rows: ReadonlyArray<DecisionProjectionRow>): string {
  return `sha256:${sha256Text(JSON.stringify([...rows].sort(compareDecisionRows).map(canonicalDecisionProjectionRow)))}`;
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
    ...(decision.riskTier ? { riskTier: decision.riskTier } : {}),
    ...(decision.urgency ? { urgency: decision.urgency } : {}),
    ...(decision.vertical ? { vertical: decision.vertical } : {}),
    ...(decision.preset ? { preset: decision.preset } : {}),
    ...(decision.decisionClass ? { decisionClass: decision.decisionClass } : {}),
    ...(decision.proposedAt ? { proposedAt: decision.proposedAt } : {}),
    ...(decision.provenance ? { provenance: decision.provenance } : {}),
    ...(decision.decidedAt ? { decidedAt: decision.decidedAt } : {}),
    attribution: unresolvedEntityAttribution()
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
  decisionClass: (frontmatter) => optional(readScalar(frontmatter, "decisionClass")) as DecisionPackage["decisionClass"],
  applies_to: (frontmatter) => ({
    modules: parseStringArray(readBlockScalar(frontmatter, "applies_to", "modules"), { tolerateInvalidArrays: true }),
    productLines: parseStringArray(readBlockScalar(frontmatter, "applies_to", "productLines"), { tolerateInvalidArrays: true })
  }),
  proposedAt: (frontmatter) => unquote(readScalar(frontmatter, "proposedAt")),
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

function uniqueDecisionDocumentPaths(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

function canonicalDecisionProjectionRow(row: DecisionProjectionRow): Omit<DecisionProjectionRow, "attribution"> {
  return {
    schema: row.schema,
    decisionId: row.decisionId,
    ...(row.legacyId ? { legacyId: row.legacyId } : {}),
    state: row.state,
    title: row.title,
    question: row.question,
    chosen: [...row.chosen],
    rejected: row.rejected.map((entry) => ({
      text: entry.text,
      whyNot: entry.whyNot
    })),
    path: row.path,
    moduleKeys: [...row.moduleKeys],
    productLineKeys: [...row.productLineKeys],
    ...(row.riskTier ? { riskTier: row.riskTier } : {}),
    ...(row.urgency ? { urgency: row.urgency } : {}),
    ...(row.vertical ? { vertical: row.vertical } : {}),
    ...(row.preset ? { preset: row.preset } : {}),
    ...(row.decisionClass ? { decisionClass: row.decisionClass } : {}),
    ...(row.proposedAt ? { proposedAt: row.proposedAt } : {}),
    ...(row.provenance ? { provenance: row.provenance.map((entry) => ({ ...entry })) } : {}),
    ...(row.decidedAt ? { decidedAt: row.decidedAt } : {})
  };
}
