import type { FactAnchorRow, RelationCoverageRow } from "../../api/renderer-dto";
import type { FactRef, RelationEdge } from "./types";

/**
 * Fact triage is a read-only projection over the kernel graph. It finds
 * candidates for a person to judge; it never mutates facts or decides a verdict.
 */
export type FactTriageSignalKind = "INVALIDATED" | "ORPHAN" | "LOW_CONFIDENCE" | "SUPERSEDED";

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

interface FactTriageIndex {
  readonly incomingByTargetAndKind: ReadonlyMap<string, ReadonlyArray<RelationEdge>>;
  readonly coveredDecisionIdsByFact: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly anchoredFactRefs: ReadonlySet<string>;
}

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
  return computeFactTriageSignalsWithIndex(fact, createFactTriageIndex(relations, coverageRows, factAnchors));
}

function computeFactTriageSignalsWithIndex(fact: FactRef, index: FactTriageIndex): FactTriageItem {
  const factRef = fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`;
  const signals: FactTriageSignal[] = [];

  // Kernel grammar (canonical direction): decision --refuted-by--> fact. The fact that
  // refutes a decision is the contradictory observation that deserves attention; the
  // edges here are current by construction (pipeline collection point); retired/deleted
  // edges remain audit history. The reverse
  // question goes through the domain query, never the retired invalidated-by alias.
  const refutingDecisionRefs = incoming(index, factRef, "refuted-by").map((edge) => edge.from);
  if (refutingDecisionRefs.length > 0) {
    signals.push({
      kind: "INVALIDATED",
      detail: `与 decision 冲突: ${[...new Set(refutingDecisionRefs)].join(", ")}`,
    });
  }

  // coverageRows is the kernel's canonical answer to “which fact currently
  // carries a decision claim?”. factAnchors supplies the complete fact universe.
  const citingDecisionIdSet = new Set(index.coveredDecisionIdsByFact.get(factRef) ?? []);
  for (const edge of incoming(index, factRef, "evidenced-by")) {
    const decisionId = decisionIdFromRef(edge.from);
    if (decisionId) citingDecisionIdSet.add(decisionId);
  }
  const citingDecisionIds = [...citingDecisionIdSet].sort();
  const isKnownFact = index.anchoredFactRefs.has(factRef);
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

  // Kernel grammar: fact --supersedes-fact--> old fact. Only the target is stale;
  // the source is the replacement and must not be penalized. Kernel criterion
  // (fact-liveness): retired/deleted edges are audit history and do not supersede;
  // currency was settled at the pipeline collection point.
  const supersedingRefs = incoming(index, factRef, "supersedes-fact").map((edge) => edge.from);
  if (supersedingRefs.length > 0) {
    signals.push({
      kind: "SUPERSEDED",
      detail: `已被取代: ${[...new Set(supersedingRefs)].join(", ")}`,
    });
  }

  return {
    fact,
    signals,
    severity: signals.reduce((max, signal) => Math.max(max, SIGNAL_SEVERITY[signal.kind]), 0),
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
  const index = createFactTriageIndex(relations, coverageRows, factAnchors);
  return rankFactTriage(facts.map((fact) => computeFactTriageSignalsWithIndex(fact, index)));
}

function createFactTriageIndex(
  relations: ReadonlyArray<RelationEdge>,
  coverageRows: ReadonlyArray<RelationCoverageRow>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
): FactTriageIndex {
  const incomingByTargetAndKind = new Map<string, RelationEdge[]>();
  for (const relation of relations) {
    const key = `${relation.to}\u0000${relation.kind}`;
    const edges = incomingByTargetAndKind.get(key);
    if (edges) edges.push(relation);
    else incomingByTargetAndKind.set(key, [relation]);
  }
  const coveredDecisionIdsByFact = new Map<string, string[]>();
  for (const row of coverageRows) {
    if (!row.covered || !row.coveringFactRef) continue;
    const decisionId = decisionIdFromRef(row.decisionRef);
    if (!decisionId) continue;
    const ids = coveredDecisionIdsByFact.get(row.coveringFactRef);
    if (ids) ids.push(decisionId);
    else coveredDecisionIdsByFact.set(row.coveringFactRef, [decisionId]);
  }
  return {
    incomingByTargetAndKind,
    coveredDecisionIdsByFact,
    anchoredFactRefs: new Set(factAnchors.map((row) => row.factRef)),
  };
}

function incoming(index: FactTriageIndex, targetRef: string, kind: RelationEdge["kind"]): ReadonlyArray<RelationEdge> {
  return index.incomingByTargetAndKind.get(`${targetRef}\u0000${kind}`) ?? [];
}
