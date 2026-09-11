// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import type { RelationGraphSuccess } from "../src/renderer/api-client.ts";
import { readRelationGraphPage } from "../src/renderer/triadic-data.ts";

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

describe("关系图按界限读取", () => {
  it("只读取首个有界页,保留 nextCursor 供显式后续读取", async () => {
    const calls: unknown[] = [];
    const first = page(
      {
        edges: [edge("r1"), edge("r2")],
        facts: [fact("fact/F-1")],
        factAnchors: [anchor("fact/F-1")],
        coverageRows: [coverage("decision/d1", "decision/d1/C1")],
      },
      "cursor-2",
    );
    const graph = await readRelationGraphPage(async (payload) => {
      calls.push(payload);
      return first;
    });
    expect(calls).toEqual([{ limit: 500 }]);
    expect(graph).toEqual(first);
    expect(graph.page?.nextCursor).toBe("cursor-2");
  });

  it("没有分页信息的回答只读一次", async () => {
    let reads = 0;
    const graph = await readRelationGraphPage(async () => {
      reads += 1;
      const { page: _page, ...single } = page({ edges: [edge("r1")] }, null);
      return single;
    });
    expect(reads).toBe(1);
    expect(graph.edges.map((row) => row.relationId)).toEqual(["r1"]);
  });
});
