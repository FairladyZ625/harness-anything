export interface CoverageDecision {
  readonly ref: string;
  readonly state: string;
  readonly decisionClass: string;
  readonly appliesTo: { readonly modules: readonly string[]; readonly productLines: readonly string[] };
  readonly claims: readonly { readonly ref: string; readonly loadBearing: boolean; readonly fulfillment: "evidenced" | "delivered" | "standing-policy" | "standing_policy" | null }[];
}
export interface CoverageTask { readonly ref: string; readonly status: string }
export interface CoverageRelation { readonly relationId: string; readonly sourceRef: string; readonly targetRef: string; readonly relationType: string; readonly state: string }
export interface CoverageResult { readonly decisionRef: string; readonly claimRef: string; readonly status: "covered" | "uncovered"; readonly fulfillment: "evidenced" | "delivered" | "standing-policy" | null; readonly coveringFactRef?: string; readonly refutingFactRefs: readonly string[]; readonly relationPath: readonly string[] }

/** The one claim-coverage judgment shared by event projection and cold rebuild. */
export function coverageOf(decisions: readonly CoverageDecision[], facts: readonly { readonly ref: string }[], tasks: readonly CoverageTask[], relations: readonly CoverageRelation[]): readonly CoverageResult[] {
  const active = relations.filter(({ state }) => state === "active"), superseded = new Set(active.filter(({ relationType }) => relationType === "supersedes-fact").map(({ targetRef }) => targetRef)), live = new Set(facts.filter(({ ref }) => !superseded.has(ref)).map(({ ref }) => ref)), done = new Set(tasks.filter(({ status }) => status === "done").map(({ ref }) => ref)), bySource = new Map<string, CoverageRelation[]>(), refutingBySource = new Map<string, { readonly edge: CoverageRelation; readonly index: number }[]>();
  for (const [index, edge] of active.entries()) {
    bySource.set(edge.sourceRef, [...bySource.get(edge.sourceRef) ?? [], edge]);
    if (edge.relationType === "refuted-by") refutingBySource.set(edge.sourceRef, [...refutingBySource.get(edge.sourceRef) ?? [], { edge, index }]);
  }
  const rows: CoverageResult[] = [];
  for (const decision of decisions) for (const claim of decision.claims.filter(({ loadBearing }) => loadBearing)) {
    const fulfillment = claim.fulfillment === "standing_policy" ? "standing-policy" : claim.fulfillment, sources = decision.ref === claim.ref ? [decision.ref] : [decision.ref, claim.ref], refutingFactRefs = sources.flatMap((source) => refutingBySource.get(source) ?? []).sort((left, right) => left.index - right.index).filter(({ edge }) => live.has(edge.targetRef)).map(({ edge }) => edge.targetRef), result = coveragePath(decision, claim.ref, fulfillment, bySource, live, done);
    rows.push({ decisionRef: decision.ref, claimRef: claim.ref, status: refutingFactRefs.length === 0 && result.covered ? "covered" : "uncovered", fulfillment, ...(result.coveringFactRef ? { coveringFactRef: result.coveringFactRef } : {}), refutingFactRefs, relationPath: result.path });
  }
  return rows;
}

function coveragePath(decision: CoverageDecision, claimRef: string, mode: CoverageResult["fulfillment"], bySource: ReadonlyMap<string, readonly CoverageRelation[]>, live: ReadonlySet<string>, done: ReadonlySet<string>): { readonly covered: boolean; readonly path: readonly string[]; readonly coveringFactRef?: string } {
  if (mode === "standing-policy") return { covered: decision.state === "in_effect" && decision.decisionClass === "standing_policy" && decision.appliesTo.modules.length + decision.appliesTo.productLines.length > 0, path: [decision.ref] };
  if (mode === "delivered") { const edge = [...bySource.get(decision.ref) ?? [], ...bySource.get(claimRef) ?? []].find((candidate) => candidate.relationType === "derives" && done.has(candidate.targetRef)); return { covered: Boolean(edge), path: edge ? [edge.relationId] : [] }; }
  if (mode !== "evidenced") return { covered: false, path: [] };
  const queue: Array<{ readonly ref: string; readonly path: readonly string[] }> = [{ ref: claimRef, path: [] }], seen = new Set<string>();
  while (queue.length) { const current = queue.shift()!; if (seen.has(current.ref)) continue; seen.add(current.ref); for (const edge of bySource.get(current.ref) ?? []) { const path = [...current.path, edge.relationId]; if (edge.relationType === "evidenced-by" && live.has(edge.targetRef)) return { covered: true, path, coveringFactRef: edge.targetRef }; if (edge.targetRef.startsWith("decision/")) queue.push({ ref: edge.targetRef, path }); } }
  return { covered: false, path: [] };
}
