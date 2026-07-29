import { readFileSync, readdirSync } from "node:fs";
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
  readonly matches: ReadonlyArray<DecisionSurfaceMatch>;
  readonly candidates: ReadonlyArray<DecisionSurfaceCandidate>;
  readonly unavailable?: string;
}

export function searchDecisionSurfaces(
  rootInput: HarnessLayoutInput,
  surfaces: ReadonlyArray<string>,
  threshold = decisionSurfaceCandidateThreshold
): DecisionSurfaceAdmissionReport {
  const layout = resolveHarnessLayout(rootInput);
  const documents = readdirSync(layout.decisionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("decision-"))
    .map((entry) => {
      const documentPath = path.join(layout.decisionsRoot, entry.name, "decision.md");
      const source = readFileSync(documentPath, "utf8");
      return {
        documentPath,
        relativePath: path.relative(layout.rootDir, documentPath).split(path.sep).join("/"),
        source,
        normalizedDocument: source.toLocaleLowerCase()
      };
    });
  const candidateCache = new Map<string, DecisionSurfaceCandidate>();
  const candidateFor = (document: typeof documents[number]): DecisionSurfaceCandidate => {
    const cached = candidateCache.get(document.documentPath);
    if (cached) return cached;
    const decision = parseDecisionDocument(document.source).decision;
    const candidate = {
      decisionId: decision.decision_id,
      title: decision.title,
      state: decision.state,
      path: document.relativePath
    } satisfies DecisionSurfaceCandidate;
    candidateCache.set(document.documentPath, candidate);
    return candidate;
  };
  const matches = normalizeDecisionSurfaces(surfaces).map((surface): DecisionSurfaceMatch => {
    const matchingDocuments = documents.filter((document) =>
      document.normalizedDocument.includes(surface.toLocaleLowerCase()));
    const discriminative = matchingDocuments.length <= threshold;
    const candidates = discriminative
      ? matchingDocuments.map(candidateFor).sort((left, right) => left.decisionId.localeCompare(right.decisionId))
      : [];
    return { surface, matchCount: matchingDocuments.length, discriminative, candidates };
  });
  const candidates = [...new Map(matches
    .flatMap((match) => match.candidates)
    .map((candidate) => [candidate.decisionId, candidate])).values()];
  return {
    schema: "decision-surface-admission/v1",
    threshold,
    scannedDecisionCount: documents.length,
    matches,
    candidates
  };
}

export function normalizeDecisionSurfaces(surfaces: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Map(surfaces
    .map((surface) => surface.trim())
    .filter(Boolean)
    .map((surface) => [surface.toLocaleLowerCase(), surface])).values()];
}
