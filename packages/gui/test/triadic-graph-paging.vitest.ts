// harness-test-tier: fast
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
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

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useActiveEdgesQuery, usePaletteFactsQuery } from "../src/renderer/triadic-data.ts";
import { harnessClient } from "../src/renderer/api-client.ts";

it("facet hooks fetch one page on mount and retain rows through explicit continuation and failure", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const facts = vi.spyOn(harnessClient, "getRelationFacts").mockImplementation(async (payload) => ({
    ok: true,
    facet: "facts",
    facts: [{ anchor: payload.cursor ? "fact/second" : "fact/first", text: "fact", category: "finding" }],
    domainTypes: [],
    warnings: [],
    page: { limit: 500, cursor: payload.cursor ?? null, nextCursor: payload.cursor ? null : "facts-next" },
  }));
  const edges = vi
    .spyOn(harnessClient, "getRelationGraph")
    .mockImplementation(async (payload) => page({}, payload.cursor ? null : "edges-next"));
  let current: { facts: ReturnType<typeof usePaletteFactsQuery>; edges: ReturnType<typeof useActiveEdgesQuery> };
  function Probe() {
    current = { facts: usePaletteFactsQuery("repo", true), edges: useActiveEdgesQuery("repo", true) };
    return null;
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
    facts.mockRejectedValueOnce(new Error("page unavailable"));
    await act(async () => {
      await current!.facts.fetchNextPage();
    });
    await settle();
    expect(current!.facts.isError).toBe(true);
    expect(current!.facts.facts.map((row) => row.anchor)).toEqual(["fact/first"]);
    expect(current!.facts.hasNextPage).toBe(true);
    await act(async () => {
      await current!.facts.fetchNextPage();
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
  } finally {
    await act(async () => root.unmount());
    client.clear();
    vi.restoreAllMocks();
  }
});
