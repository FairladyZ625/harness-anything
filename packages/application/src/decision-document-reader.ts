import * as fs from "node:fs";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  DecisionPackageSchema,
  type DecisionPackage
} from "@harness-anything/kernel";
import type { HarnessLayoutInput } from "@harness-anything/kernel";
import { parseDecisionDocument, readFrontmatter, resolveHarnessLayout } from "@harness-anything/kernel";
import { isNodeErrorCode } from "./node-errors.ts";

export interface DecisionDocumentReadResult {
  readonly decision: DecisionPackage;
  readonly body: string;
  readonly path: string;
}

export interface DecisionDocumentListResult {
  readonly decisions: ReadonlyArray<DecisionDocumentReadResult>;
}

export function readDecisionDocument(rootInput: HarnessLayoutInput, decisionId: string): Effect.Effect<DecisionDocumentReadResult, unknown> {
  return Effect.tryPromise(async () => {
    const layout = resolveHarnessLayout(rootInput);
    const documentPath = layout.decisionDocumentPath(decisionId);
    const documentBody = await fs.promises.readFile(documentPath, "utf8");
    if (!readFrontmatter(documentBody)) throw new Error(`decision document missing frontmatter: ${decisionId}`);
    // Single parser policy: the kernel parser is the only authority for decision
    // frontmatter. A hand-copied field list here previously drifted (it lacked
    // decisionClass), which made standing-policy decisions impossible to
    // supersede through the daemon field-change validator.
    const parsed = parseDecisionDocument(documentBody);
    const decision = Schema.decodeUnknownSync(DecisionPackageSchema)(parsed.decision);
    return {
      decision,
      body: parsed.body ?? "",
      path: path.relative(layout.rootDir, documentPath).split(path.sep).join("/")
    };
  });
}

export function listDecisionDocuments(rootInput: HarnessLayoutInput): Effect.Effect<DecisionDocumentListResult, unknown> {
  return Effect.gen(function* () {
    const layout = resolveHarnessLayout(rootInput);
    const entries = yield* Effect.tryPromise(() => fs.promises.readdir(layout.decisionsRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (isNodeErrorCode(error, "ENOENT")) return [];
      throw error;
    }));
    const decisions = yield* Effect.forEach(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("decision-"))
      .map((entry) => entry.name.slice("decision-".length)), (decisionId) => readDecisionDocument(rootInput, decisionId));
    return {
      decisions: decisions.toSorted((left, right) => compareDecisionIds(left.decision.decision_id, right.decision.decision_id))
    };
  });
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
