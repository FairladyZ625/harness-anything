// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import type { RelationGraphSuccess } from "../src/renderer/api-client.ts";
import { readWholeRelationGraph } from "../src/renderer/triadic-data.ts";

type Edge = RelationGraphSuccess["edges"][number];
type Fact = RelationGraphSuccess["facts"][number];
type Anchor = RelationGraphSuccess["factAnchors"][number];
type Coverage = RelationGraphSuccess["coverageRows"][number];

const edge = (relationId: string) => ({ relationId, sourceRef: `decision/${relationId}`, targetRef: "task/t" }) as Edge;
const fact = (ref: string) => ({ ref, factId: ref.slice(5), statement: ref }) as Fact;
const anchor = (factRef: string) => ({ factRef, factId: factRef.slice(5), sourcePath: "x.md" }) as Anchor;
const coverage = (decisionRef: string, claimRef: string) => ({ decisionRef, claimRef }) as Coverage;
const page = (
  rows: Partial<Pick<RelationGraphSuccess, "edges" | "facts" | "factAnchors" | "coverageRows">>,
  nextCursor: string | null,
  cursor: string | null = null,
): RelationGraphSuccess => ({
  ok: true,
  edges: [],
  facts: [],
  factAnchors: [],
  coverageRows: [],
  warnings: [],
  ...rows,
  page: { limit: 500, cursor, nextCursor },
});

describe("完整关系图按 nextCursor 翻页合并", () => {
  it("翻到 nextCursor 为空为止,四类行按主键去重", async () => {
    const calls: unknown[] = [];
    const pages = [
      page(
        {
          edges: [edge("r1"), edge("r2")],
          facts: [fact("fact/F-1")],
          factAnchors: [anchor("fact/F-1")],
          coverageRows: [coverage("decision/d1", "decision/d1/C1")],
        },
        "cursor-2",
      ),
      page(
        {
          edges: [edge("r2"), edge("r3")],
          facts: [fact("fact/F-1"), fact("fact/F-2")],
          factAnchors: [anchor("fact/F-2")],
          coverageRows: [coverage("decision/d1", "decision/d1/C1"), coverage("decision/d1", "decision/d1/C2")],
        },
        null,
        "cursor-2",
      ),
    ];
    const graph = await readWholeRelationGraph(async (payload) => {
      calls.push(payload);
      return pages[calls.length - 1]!;
    });
    expect(calls).toEqual([{ limit: 500 }, { limit: 500, cursor: "cursor-2" }]);
    expect(graph.edges.map((row) => row.relationId)).toEqual(["r1", "r2", "r3"]);
    expect(graph.facts.map((row) => row.ref)).toEqual(["fact/F-1", "fact/F-2"]);
    expect(graph.factAnchors.map((row) => row.factRef)).toEqual(["fact/F-1", "fact/F-2"]);
    expect(graph.coverageRows.map((row) => row.claimRef)).toEqual(["decision/d1/C1", "decision/d1/C2"]);
    expect(graph.page).toEqual({ limit: 500, cursor: "cursor-2", nextCursor: null });
  });

  it("没有分页信息的回答只读一次", async () => {
    let reads = 0;
    const graph = await readWholeRelationGraph(async () => {
      reads += 1;
      const { page: _page, ...single } = page({ edges: [edge("r1")] }, null);
      return single;
    });
    expect(reads).toBe(1);
    expect(graph.edges.map((row) => row.relationId)).toEqual(["r1"]);
  });
});
