// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow, DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";
import { computeSpotlightLayout } from "../src/renderer/graph/threeLane.ts";
import { laneForKind } from "../src/renderer/graph/threeLane.ts";
import { defaultAxisFilter, defaultKindFilter } from "../src/renderer/graph/relationVisual.ts";

/**
 * GraphView entity resolution regression (migrated from fact-triage graph layout test).
 * Verifies fact anchors render without inventing bodies — now via computeSpotlightLayout.
 */

function task(): TaskRow {
  return {
    taskId: "task_a", title: "Task A", projectId: "proj",
    coordinationStatus: "active", rawStatus: "active", freshness: "fresh",
    packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "kernel",
    lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
  };
}

function dec(): DecisionRow {
  return {
    decisionId: "dec_1", title: "D1", state: "active", question: "Q?",
    chosen: [{ id: "CH1", text: "c", evidence: [] }], rejected: [],
    claims: [{ id: "CH1", text: "c" }], proposedAt: "2026-08-01T00:00:00.000Z",
  } as DecisionRow;
}

const baseFilters = {
  axes: defaultAxisFilter(),
  kinds: defaultKindFilter(),
  modules: new Set<string>(),
  types: new Set(["decision", "task", "fact"]),
  flowMode: "focus" as const,
};

describe("graph entity resolution (fact anchors without inventing bodies)", () => {
  it("renders task/decision/fact nodes from real relations, no ghost invention", () => {
    const factAnchor = {
      factRef: "fact/task_a/F-001", taskId: "task_a", factId: "F-001",
      sourcePath: "event:fact/task_a/F-001",
    };
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
      { from: "task/task_a", to: "fact/task_a/F-001", kind: "produces", provenance: "local-document" },
      { from: "decision/dec_1/CH1", to: "fact/task_a/F-001", kind: "evidenced-by", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [dec()], [], [factAnchor], relations, [], baseFilters,
    );
    const entityNodes = result.nodes.filter((n) => n.type !== "laneBackground");
    // ego(dec_1) + task_a(derives→execution lane). fact/F-001 only reached via
    // produces(task→fact, focus not involved) so NOT auto-included as ego neighbor.
    // evidenced-by(dec_1/CH1 → fact) has focus involvement → fact included.
    const taskNodes = entityNodes.filter((n) => n.type === "task");
    const factNodes = entityNodes.filter((n) => n.type === "fact");
    const decNodes = entityNodes.filter((n) => n.type === "decision");
    expect(decNodes.length).toBeGreaterThanOrEqual(1);
    expect(taskNodes.length).toBe(1);
    expect(factNodes.length).toBe(1);
  });

  it("does not invent fact bodies for anchors absent from facts projection", () => {
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "task/task_a", kind: "derives", provenance: "local-document" },
      { from: "decision/dec_1/CH1", to: "fact/task_a/F-ghost", kind: "evidenced-by", provenance: "local-document" },
    ];
    const result = computeSpotlightLayout(
      "decision/dec_1", [task()], [dec()], [], [], relations, [], baseFilters,
    );
    // F-ghost has no fact body and no factAnchor → not invented.
    const ghostFact = result.nodes.find((n) => n.id === "fact/task_a/F-ghost");
    expect(ghostFact).toBeUndefined();
  });

  it("laneForKind maps all relation kinds to a lane", () => {
    const kinds: RelationEdge["kind"][] = [
      "refines", "narrows", "supersedes", "supports",
      "evidenced-by", "evidences", "supersedes-fact", "invalidated-by", "refuted-by",
      "derives", "depends-on", "blocks", "produces", "relates", "implements",
    ];
    for (const kind of kinds) {
      const lane = laneForKind(kind);
      expect(["authority", "evidence", "execution"]).toContain(lane);
    }
  });
});
