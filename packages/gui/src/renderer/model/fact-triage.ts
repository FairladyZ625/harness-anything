import type {
  FactAnchorRow,
  RelationCoverageRow,
} from "../../api/renderer-dto";
import type { FactRef, RelationEdge } from "./types";

/**
 * Fact triage is a read-only projection over the kernel graph. It finds
 * candidates for a person to judge; it never mutates facts or decides a verdict.
 */
export type FactTriageSignalKind =
  | "INVALIDATED"
  | "ORPHAN"
  | "LOW_CONFIDENCE"
  | "SUPERSEDED";

export interface FactTriageSignal {
  kind: FactTriageSignalKind;
  detail: string;
}

export interface FactTriageItem {
  fact: FactRef;
  signals: FactTriageSignal[];
  severity: number;
  citingDecisionIds: string[];
}

/** Listed order is the product priority for the triage queue. */
export const SIGNAL_SEVERITY: Record<FactTriageSignalKind, number> = {
  INVALIDATED: 100,
  ORPHAN: 80,
  LOW_CONFIDENCE: 50,
  SUPERSEDED: 40,
};

export const SIGNAL_LABEL: Record<FactTriageSignalKind, string> = {
  INVALIDATED: "矛盾 fact",
  ORPHAN: "孤儿 fact",
  LOW_CONFIDENCE: "低 confidence",
  SUPERSEDED: "已被取代",
};

function decisionIdFromRef(ref: string): string | undefined {
  if (!ref.startsWith("decision/")) return undefined;
  return ref.split("/")[1];
}

export function computeFactTriageSignals(
  fact: FactRef,
  relations: RelationEdge[],
  coverageRows: ReadonlyArray<RelationCoverageRow>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
): FactTriageItem {
  const factRef = `fact/${fact.anchor}`;
  const signals: FactTriageSignal[] = [];

  // Kernel grammar: fact --invalidated-by--> decision. The source fact is the
  // contradictory observation that deserves attention.
  const invalidatedDecisions = relations
    .filter(
      (relation) =>
        relation.from === factRef && relation.kind === "invalidated-by",
    )
    .map((relation) => relation.to);
  if (invalidatedDecisions.length > 0) {
    signals.push({
      kind: "INVALIDATED",
      detail: `与 decision 冲突: ${[...new Set(invalidatedDecisions)].join(", ")}`,
    });
  }

  // coverageRows is the kernel's canonical answer to “which fact currently
  // carries a decision claim?”. factAnchors supplies the complete fact universe.
  const citingDecisionIdSet = new Set(
    coverageRows
        .filter(
          (row) =>
            row.status === "covered" && row.coveringFactRef === factRef,
        )
        .map((row) => decisionIdFromRef(row.decisionRef))
        .filter((id): id is string => Boolean(id)),
  );
  for (const relation of relations) {
    const decisionRef =
      relation.kind === "evidenced-by" && relation.to === factRef
        ? relation.from
        : relation.kind === "supports" && relation.from === factRef
          ? relation.to
          : undefined;
    const decisionId = decisionRef
      ? decisionIdFromRef(decisionRef)
      : undefined;
    if (decisionId) citingDecisionIdSet.add(decisionId);
  }
  const citingDecisionIds = [...citingDecisionIdSet].sort();
  const isKnownFact = factAnchors.some((row) => row.factRef === factRef);
  if (isKnownFact && citingDecisionIds.length === 0) {
    signals.push({
      kind: "ORPHAN",
      detail: "factAnchors 中存在，但没有 coverageRows claim 由它承重",
    });
  }

  if (fact.confidence === "low") {
    signals.push({
      kind: "LOW_CONFIDENCE",
      detail: "fact 投影记录的 confidence=low，需复核观察质量",
    });
  }

  // Kernel grammar: decision/fact --supersedes-fact--> old fact. Only the
  // target is stale; the source is the replacement and must not be penalized.
  const supersedingRefs = relations
    .filter(
      (relation) =>
        relation.to === factRef && relation.kind === "supersedes-fact",
    )
    .map((relation) => relation.from);
  if (supersedingRefs.length > 0) {
    signals.push({
      kind: "SUPERSEDED",
      detail: `已被取代: ${[...new Set(supersedingRefs)].join(", ")}`,
    });
  }

  return {
    fact,
    signals,
    severity: signals.reduce(
      (max, signal) => Math.max(max, SIGNAL_SEVERITY[signal.kind]),
      0,
    ),
    citingDecisionIds,
  };
}

export function rankFactTriage(items: FactTriageItem[]): FactTriageItem[] {
  return [...items]
    .filter((item) => item.severity > 0)
    .sort((a, b) => {
      if (b.severity !== a.severity) return b.severity - a.severity;
      if (b.fact.at !== a.fact.at) return b.fact.at.localeCompare(a.fact.at);
      return a.fact.anchor.localeCompare(b.fact.anchor);
    });
}

export function buildFactTriage(
  facts: FactRef[],
  relations: RelationEdge[],
  coverageRows: ReadonlyArray<RelationCoverageRow>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
): FactTriageItem[] {
  return rankFactTriage(
    facts.map((fact) =>
      computeFactTriageSignals(fact, relations, coverageRows, factAnchors),
    ),
  );
}
