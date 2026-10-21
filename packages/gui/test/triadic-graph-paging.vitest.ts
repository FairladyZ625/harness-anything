// harness-test-tier: fast
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { RelationGraphSuccess } from "../src/renderer/api-client.ts";
import { readCompleteRelationGraph } from "../src/renderer/triadic-data.ts";
import { assertPreloadPayload } from "../src/preload/allowlist.ts";
import {
  parseDaemonRpcParams,
  validateDaemonRelationGraph,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { harnessClient } from "../src/renderer/api-client.ts";

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
  it("drains 27,837 relations through the actual client payload and bridge contract across 56 pages", async () => {
    const calls: { repoId: string; limit: number; cursor?: string }[] = [];
    vi.stubGlobal("window", {
      harness: {
        request: async (method: string, payload: { repoId: string; limit: number; cursor?: string }) => {
          expect(method).toBe("getRelationGraph");
          assertPreloadPayload(method, payload);
          const { repoId, ...query } = payload;
          expect(parseDaemonRpcParams("repo.triadic.relationGraph", { repo: { repoId }, payload: query }).ok).toBe(
            true,
          );
          calls.push(payload);
          const offset = Number(query.cursor ?? 0),
            end = Math.min(offset + query.limit, 27_837),
            result = {
              ...page(
                {
                  edges: Array.from({ length: end - offset }, (_, index) => ({
                    relationId: `rel_${offset + index}`,
                    workspaceRevision: 1,
                    sourceRef: "task/source",
                    targetRef: `task/target_${offset + index}`,
                    relationType: "relates",
                    direction: "undirected",
                    strength: "weak",
                    origin: "declared",
                    state: "active",
                    targetObservedVersion: null,
                    currentTargetVersion: null,
                    freshness: "current",
                    rationale: "Graph pagination regression",
                    ownerRef: "task/source",
                    sourcePath: "events/relation.json",
                    recordIndex: 0,
                    current: true,
                  })),
                },
                end < 27_837 ? String(end) : null,
                query.cursor ?? null,
              ),
              status: "ready",
              watermark: 1,
              sourceRevision: 1,
            };
          expect(validateDaemonRelationGraph(result)).toEqual([]);
          return result;
        },
      },
    });
    try {
      const graph = await readCompleteRelationGraph((payload) =>
        harnessClient.getRelationGraph({ repoId: "canonical", ...payload }),
      );
      expect(calls).toHaveLength(56);
      expect(calls[0]).toEqual({ repoId: "canonical", limit: 500 });
      expect(calls.at(-1)).toEqual({ repoId: "canonical", limit: 500, cursor: "27500" });
      expect(graph.edges).toHaveLength(27_837);
      expect(graph.edges.at(-1)?.relationId).toBe("rel_27836");
      expect(graph.page?.nextCursor).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("读取后续页才能判定关系,并合并重复的关联实体", async () => {
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
    const graph = await readCompleteRelationGraph(async (payload) => {
      calls.push(payload);
      return calls.length === 1
        ? first
        : page(
            {
              edges: [edge("r3")],
              facts: [fact("fact/F-1"), fact("fact/F-2")],
              coverageRows: [coverage("decision/d1", "decision/d1/C1")],
            },
            null,
            "cursor-2",
          );
    });
    expect(calls).toEqual([{ limit: 500 }, { limit: 500, cursor: "cursor-2" }]);
    expect(graph.edges.map((row) => row.relationId)).toEqual(["r1", "r2", "r3"]);
    expect(graph.facts.map((row) => row.ref)).toEqual(["fact/F-1", "fact/F-2"]);
    expect(graph.coverageRows).toHaveLength(1);
    expect(graph.page?.nextCursor).toBeNull();
  });

  it("rejects a failed later page instead of publishing partial relations", async () => {
    let calls = 0;
    await expect(
      readCompleteRelationGraph(async () => {
        if (++calls === 1) return page({ edges: [edge("r1")] }, "next");
        throw new Error("unavailable");
      }),
    ).rejects.toThrow("unavailable");
  });

  it.each([
    ["again", "again"],
    ["first", "second", "first"],
  ])("rejects repeated continuation cursors %j", async (...cursors) => {
    // 游标由读面产生,写入边界无法约束;重复或循环续读仍须拒绝,不返回部分图。
    let calls = 0;
    await expect(
      readCompleteRelationGraph(async () => {
        const next = cursors[calls++];
        if (next === undefined) throw new Error("unexpected extra read");
        return page({ edges: [edge(`r${calls}`)] }, next);
      }),
    ).rejects.toThrow("relation graph: cursor did not advance");
    expect(calls).toBe(cursors.length);
  });

  it("没有分页信息的回答只读一次", async () => {
    let reads = 0;
    const graph = await readCompleteRelationGraph(async () => {
      reads += 1;
      const { page: _page, ...single } = page({ edges: [edge("r1")] }, null);
      return single;
    });
    expect(reads).toBe(1);
    expect(graph.edges.map((row) => row.relationId)).toEqual(["r1"]);
  });
});

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useActiveEdgesQuery, usePaletteFactsQuery } from "../src/renderer/triadic-data.ts";
import { useFactFacetStats } from "../src/renderer/entities-data.ts";
import { FactFacetLive, FactTypeVocabulary } from "../src/renderer/components/entityDoc/FactVocabularySections.tsx";

it("facet hooks fetch one page on mount and retain rows through explicit continuation and failure", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const facts = vi.spyOn(harnessClient, "getRelationFacts").mockImplementation(async (payload) => ({
    ok: true,
    facet: "facts",
    facts: [{ anchor: payload.cursor ? "fact/second" : "fact/first", text: "fact", category: "finding" }],
    domainTypes: [{ domainType: "architecture", registeredByFactId: "F-AAAABBBB", workspaceRevision: 1 }],
    warnings: [],
    page: { limit: 500, cursor: payload.cursor ?? null, nextCursor: payload.cursor ? null : "facts-next" },
  }));
  const edges = vi
    .spyOn(harnessClient, "getRelationGraph")
    .mockImplementation(async (payload) => page({}, payload.cursor ? null : "edges-next"));
  let current: { facts: ReturnType<typeof usePaletteFactsQuery>; edges: ReturnType<typeof useActiveEdgesQuery> };
  function Probe() {
    const stats = useFactFacetStats("repo", true);
    current = { facts: usePaletteFactsQuery("repo", true), edges: useActiveEdgesQuery("repo", true) };
    return createElement(
      "div",
      null,
      createElement(FactFacetLive, { stats }),
      createElement(FactTypeVocabulary, { stats }),
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"),
    root = createRoot(host);
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  };
  try {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    await settle();
    expect(facts).toHaveBeenCalledTimes(1);
    expect(edges).toHaveBeenCalledTimes(1);
    expect(facts.mock.calls[0][0]).toEqual({ repoId: "repo", facet: "facts", limit: 500 });
    expect(current!.facts.hasNextPage).toBe(true);
    expect(current!.edges.hasNextPage).toBe(true);
    expect(host.textContent).toContain("已加载 1 条 fact");
    expect(host.textContent).toContain("统计仅含已加载事实");
    expect(host.textContent).toContain("architecture");
    expect(host.textContent).toContain("fact/F-AAAABBBB");
    facts.mockRejectedValueOnce(new Error("page unavailable"));
    await act(async () => {
      await current!.facts.fetchNextPage();
    });
    await settle();
    expect(current!.facts.isError).toBe(true);
    expect(current!.facts.facts.map((row) => row.anchor)).toEqual(["fact/first"]);
    expect(current!.facts.hasNextPage).toBe(true);
    await act(async () => {
      host.querySelector("button")!.click();
      await current!.edges.fetchNextPage();
    });
    await settle();
    expect(facts.mock.calls.at(-1)![0].cursor).toBe("facts-next");
    expect(edges.mock.calls.at(-1)![0]).toMatchObject({
      facet: "edges",
      state: "active",
      limit: 500,
      cursor: "edges-next",
    });
    expect(current!.facts.facts.map((row) => row.anchor)).toEqual(["fact/first", "fact/second"]);
    expect(current!.facts.hasNextPage).toBe(false);
    expect(current!.edges.hasNextPage).toBe(false);
    expect(host.textContent).toContain("2 条 fact");
    expect(host.textContent).toContain("finding · 2");
    expect(host.textContent).not.toContain("统计仅含已加载事实");
    expect(host.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.restoreAllMocks();
  }
});
