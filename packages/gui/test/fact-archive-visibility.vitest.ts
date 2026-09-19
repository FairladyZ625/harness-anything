// harness-test-tier: integration
// @vitest-environment happy-dom
//
// 已归档 Fact 的 GUI 默认退场(task 对齐 dec_62CAE6CA,与 `ha graph` 的
// include-archived 语义同口径):关系图(行/锚点/触及边)、三元视图行映射与
// facts 切面(⌘K 索引/实体页统计共用一条读)默认不显示已归档 Fact;
// 「已归档 Fact」开关打开后整体回来并带「已归档」标记,偏好按本机记忆。
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GraphView } from "../src/renderer/views/GraphView.tsx";
import { buildPaletteIndex } from "../src/renderer/components/CommandPalette.tsx";
import { buildTriadicRendererData, usePaletteFactsQuery } from "../src/renderer/triadic-data.ts";
import { applyFactArchiveVisibility } from "../src/renderer/model/triadic.ts";
import { partitionFacts } from "../src/renderer/graph/territory.ts";
import { harnessClient, type RelationGraphSuccess } from "../src/renderer/api-client.ts";
import {
  FactArchiveVisibilityProvider,
  factArchivePreferenceStorage,
  readFactArchiveShowArchived,
  writeFactArchiveShowArchived,
} from "../src/renderer/fact-archive-preferences.tsx";
import type { FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

const AT = "2026-09-19T00:00:00.000Z";

function task(): TaskRow {
  return {
    taskId: "task_live",
    title: "宿主任务",
    projectId: "repo",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "gui",
    lastKnownAt: AT,
    gates: [],
    docs: [],
    ...projectedTaskFields("active"),
  };
}

function factRef(anchor: string, archived: boolean): FactRef {
  return {
    anchor,
    taskId: "task_live",
    category: "finding",
    text: `${anchor} 的观察`,
    at: AT,
    confidence: "high",
    ...(archived ? { archived: true } : {}),
  };
}

const LIVE = "fact/F-LIVE";
const ARCHIVED = "fact/F-ARCH";
const fixtures = {
  facts: [factRef(LIVE, false), factRef(ARCHIVED, true)],
  factAnchors: [{ factRef: ARCHIVED, taskId: "task_live", factId: "F-ARCH", sourcePath: "harness/facts/F-ARCH.md" }],
  relations: [
    { from: "task/task_live", to: LIVE, kind: "produces", provenance: "local-document" },
    { from: "task/task_live", to: ARCHIVED, kind: "produces", provenance: "local-document" },
  ] as RelationEdge[],
};

function relationGraphFixture(): RelationGraphSuccess {
  return {
    ok: true,
    edges: [],
    coverageRows: [],
    factAnchors: fixtures.factAnchors,
    facts: fixtures.facts.map((fact) => ({
      schema: "task-fact-row/v1" as const,
      ref: fact.anchor,
      taskId: fact.taskId,
      factId: fact.anchor.slice("fact/".length),
      statement: fact.text,
      source: "test-fixture",
      observedAt: fact.at,
      confidence: "high" as const,
      memoryClass: "episodic" as const,
      memoryTags: [],
      provenance: [],
      liveness: "standing" as const,
      invalidated: false,
      archived: fact.archived === true,
    })),
    warnings: [],
  };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
});

describe("fact archive visibility — graph feed cut (ha graph parity)", () => {
  it("drops archived fact rows, their anchors and touching edges by default", () => {
    const cut = applyFactArchiveVisibility({
      facts: fixtures.facts,
      factAnchors: fixtures.factAnchors,
      relations: fixtures.relations,
      includeArchived: false,
    });
    expect(cut.facts.map((fact) => fact.anchor)).toEqual([LIVE]);
    // 锚点不随行退场会让 anchor-only chip 原样回来,断头边同理。
    expect(cut.factAnchors).toEqual([]);
    expect(cut.relations.map((edge) => edge.to)).toEqual([LIVE]);
  });

  it("keeps everything untouched when the toggle is on or nothing is archived", () => {
    const shown = applyFactArchiveVisibility({
      facts: fixtures.facts,
      factAnchors: fixtures.factAnchors,
      relations: fixtures.relations,
      includeArchived: true,
    });
    expect(shown.facts).toHaveLength(2);
    expect(shown.factAnchors).toHaveLength(1);
    expect(shown.relations).toHaveLength(2);

    const noArchived = applyFactArchiveVisibility({
      facts: [fixtures.facts[0]!],
      factAnchors: [],
      relations: fixtures.relations.slice(0, 1),
      includeArchived: false,
    });
    expect(noArchived.facts).toHaveLength(1);
    expect(noArchived.relations).toHaveLength(1);
  });
});

describe("fact archive visibility — triadic row mapping keeps the archived flag", () => {
  it("carries archived through buildTriadicRendererData instead of dropping it", () => {
    const projected = buildTriadicRendererData({
      graph: relationGraphFixture(),
      decisions: { ok: true, decisions: [], warnings: [] },
    });
    const byAnchor = new Map(projected.facts.map((fact) => [fact.anchor, fact]));
    expect(byAnchor.get(ARCHIVED)?.archived).toBe(true);
    expect(byAnchor.get(LIVE)?.archived).toBe(false);
  });
});

describe("fact archive visibility — territory chips hide by default, mark when shown", () => {
  it("labels archived fact chips 已归档 (marker wins over category)", () => {
    const zones = partitionFacts(fixtures.facts, fixtures.factAnchors, [task()], fixtures.relations);
    const chips = zones.flatMap((zone) => zone.chips);
    const archived = chips.find((chip) => chip.navRef === ARCHIVED);
    const live = chips.find((chip) => chip.navRef === LIVE);
    expect(archived?.sub).toBe("已归档");
    expect(live?.sub).toBe("finding");
  });
});

describe("fact archive visibility — palette index marks archived rows", () => {
  it("prefixes the sub label so an archived fact cannot pass as a live one", () => {
    const entries = buildPaletteIndex(
      [],
      [],
      [
        { anchor: "F-LIVE", text: "live", category: "lesson" },
        { anchor: "F-ARCH", text: "archived", category: "lesson", archived: true },
      ],
    );
    expect(entries.find((entry) => entry.ref === "fact/F-ARCH")?.sub).toBe("已归档 · lesson");
    expect(entries.find((entry) => entry.ref === "fact/F-LIVE")?.sub).toBe("lesson");
  });
});

describe("fact archive visibility — preference storage", () => {
  it("round-trips through a storage stub and falls back to hidden on garbage", () => {
    const stub = {
      value: null as string | null,
      getItem() {
        return stub.value;
      },
      setItem(_: string, value: string) {
        stub.value = value;
      },
    };
    expect(readFactArchiveShowArchived(stub)).toBe(false);
    writeFactArchiveShowArchived(stub, true);
    expect(readFactArchiveShowArchived(stub)).toBe(true);
    stub.value = "{not json";
    expect(readFactArchiveShowArchived(stub)).toBe(false);
    expect(readFactArchiveShowArchived(null)).toBe(false);
  });
});

/** 挂一个读面探针:断言桥真正送达切面 hook 的行,而不是内部函数被调用过。 */
function FactsProbe() {
  const query = usePaletteFactsQuery("repo", true);
  return createElement("div", {
    "data-testid": "facts-probe",
    "data-count": String(query.facts.length),
    "data-archived-count": String(query.archivedCount),
    "data-refs": query.facts.map((fact) => fact.anchor).join(","),
  });
}

async function mountProbe(withProvider: boolean): Promise<{ div: HTMLElement; root: Root }> {
  const factsSpy = vi.spyOn(harnessClient, "getRelationFacts").mockImplementation(async () => ({
    ok: true as const,
    facet: "facts" as const,
    facts: [
      { anchor: LIVE, text: "live", category: "finding" as const },
      { anchor: ARCHIVED, text: "archived", category: "finding" as const, archived: true },
    ],
    domainTypes: [],
    warnings: [],
    page: { limit: 500, cursor: null, nextCursor: null },
  }));
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  // react-query 的解析要一个宏任务才能落到 DOM(与 graph-view-regression 的 settle 同款,
  // 单次离散冲刷,不是墙钟轮询)。
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        withProvider
          ? createElement(FactArchiveVisibilityProvider, null, createElement(FactsProbe))
          : createElement(FactsProbe),
      ),
    );
  });
  await settle();
  factsSpy.mockRestore();
  return { div, root };
}

describe("fact archive visibility — facts facet (⌘K index + entity stats share one read)", () => {
  it("hides archived rows by default and still reports how many are hidden", async () => {
    window.localStorage.clear();
    const { div, root } = await mountProbe(false);
    const probe = div.querySelector("[data-testid='facts-probe']") as HTMLElement;
    expect(probe.dataset.refs).toBe(LIVE);
    expect(probe.dataset.archivedCount).toBe("1");
    await act(async () => {
      root.unmount();
    });
  });

  it("shows archived rows when the persisted preference is on", async () => {
    writeFactArchiveShowArchived(factArchivePreferenceStorage(), true);
    const { div, root } = await mountProbe(true);
    const probe = div.querySelector("[data-testid='facts-probe']") as HTMLElement;
    expect(probe.dataset.refs).toBe(`${LIVE},${ARCHIVED}`);
    await act(async () => {
      root.unmount();
    });
    window.localStorage.clear();
  });
});

async function mountGraph(): Promise<{ div: HTMLElement; root: Root }> {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  await act(async () => {
    root.render(
      createElement(
        FactArchiveVisibilityProvider,
        null,
        createElement(GraphView, {
          tasks: [task()],
          decisions: [],
          facts: fixtures.facts,
          factAnchors: fixtures.factAnchors,
          relations: fixtures.relations,
          focusRef: null,
          viewMode: "territory",
          onViewModeChange: () => {},
        } as never),
      ),
    );
  });
  return { div, root };
}

describe("fact archive visibility — graph page", () => {
  it("hides the archived fact chip by default and restores it with the marker after the toggle", async () => {
    window.localStorage.clear();
    const { div, root } = await mountGraph();
    const chipRefs = () =>
      [...div.querySelectorAll("[data-testid='territory-chip']")].map(
        (chip) => (chip as HTMLElement).dataset.navRef ?? "",
      );
    // 默认:宿主 task 与活 fact 在,已归档 fact(行与锚点)不在。
    expect(chipRefs()).toEqual(["task/task_live", LIVE]);

    const toggle = div.querySelector("[data-testid='fact-archive-toggle']") as HTMLElement;
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toContain("隐藏");
    await act(async () => {
      toggle.click();
    });

    expect(chipRefs()).toContain(ARCHIVED);
    const archivedChip = [...div.querySelectorAll("[data-testid='territory-chip']")].find(
      (chip) => (chip as HTMLElement).dataset.navRef === ARCHIVED,
    );
    expect(archivedChip?.textContent).toContain("已归档");
    expect(window.localStorage.getItem("harness:gui:show-archived-facts")).toBe("true");
    await act(async () => {
      root.unmount();
    });
  });
});
