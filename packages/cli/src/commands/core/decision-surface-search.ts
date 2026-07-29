import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  parseDecisionDocument,
  resolveHarnessLayout,
  type HarnessLayoutInput
} from "@harness-anything/kernel";

export const decisionSurfaceCandidateThreshold = 20;

export interface DecisionSurfaceCandidate {
  readonly decisionId: string;
  readonly title: string;
  readonly state: string;
  readonly path: string;
}

export interface DecisionSurfaceMatch {
  readonly surface: string;
  readonly matchCount: number;
  readonly discriminative: boolean;
  readonly candidates: ReadonlyArray<DecisionSurfaceCandidate>;
}

export interface DecisionSurfaceAdmissionReport {
  readonly schema: "decision-surface-admission/v1";
  readonly threshold: number;
  readonly scannedDecisionCount: number;
  readonly skippedDecisionCount: number;
  readonly matches: ReadonlyArray<DecisionSurfaceMatch>;
  readonly candidates: ReadonlyArray<DecisionSurfaceCandidate>;
  readonly unavailable?: DecisionSurfaceUnavailableCode;
  readonly diagnostic?: string;
}

export type DecisionSurfaceUnavailableCode =
  | "invalid_surface_payload"
  | "decisions_root_unavailable"
  | "decision_search_unavailable";

export function searchDecisionSurfaces(
  rootInput: HarnessLayoutInput,
  surfaces: ReadonlyArray<string>,
  threshold = decisionSurfaceCandidateThreshold,
  options: { readonly excludeDecisionId?: string } = {}
): DecisionSurfaceAdmissionReport {
  const layout = resolveHarnessLayout(rootInput);
  const entries = readdirSync(layout.decisionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("decision-"));
  const skippedDocuments = new Set<string>();
  const excludedPath = options.excludeDecisionId
    ? path.resolve(layout.decisionDocumentPath(options.excludeDecisionId))
    : undefined;
  const documents = entries.flatMap((entry) => {
    const documentPath = path.join(layout.decisionsRoot, entry.name, "decision.md");
    const relativePath = path.relative(layout.rootDir, documentPath).split(path.sep).join("/");
    if (excludedPath === path.resolve(documentPath)) return [];
    try {
      if (!lstatSync(documentPath).isFile()) {
        skippedDocuments.add(relativePath);
        return [];
      }
      const source = readFileSync(documentPath, "utf8");
      const decision = parseDecisionDocument(source).decision;
      return [{
        relativePath,
        normalizedDocument: source.toLowerCase(),
        candidate: {
          decisionId: decision.decision_id,
          title: decision.title,
          state: decision.state,
          path: relativePath
        } satisfies DecisionSurfaceCandidate
      }];
    } catch {
      skippedDocuments.add(relativePath);
      return [];
    }
  });
  const matches = surfaces.map((surface): DecisionSurfaceMatch => {
    const matchingDocuments = documents.filter((document) =>
      document.normalizedDocument.includes(surface.toLowerCase()));
    const discriminative = matchingDocuments.length <= threshold;
    const candidates = discriminative
      ? matchingDocuments.map((document) => document.candidate)
        .sort((left, right) => left.decisionId.localeCompare(right.decisionId))
      : [];
    return { surface, matchCount: matchingDocuments.length, discriminative, candidates };
  });
  const candidates = [...new Map(matches
    .flatMap((match) => match.candidates)
    .map((candidate) => [candidate.decisionId, candidate])).values()];
  return {
    schema: "decision-surface-admission/v1",
    threshold,
    scannedDecisionCount: entries.length,
    skippedDecisionCount: skippedDocuments.size,
    matches,
    candidates
  };
}
