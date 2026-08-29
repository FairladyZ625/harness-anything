// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DecisionRow, RelationEdge } from "../src/renderer/model/types.ts";
import {
  buildGenealogyEdges,
  collectLineage,
  computeLayout,
  dayKeyOf,
  decisionIdOf,
  findGenealogyCycles,
  timeMsOf,
} from "../src/renderer/graph/genealogy.ts";
import { ParticipantsSidebar } from "../src/renderer/views/genealogy/ParticipantsSidebar.tsx";

function dec(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_a",
    title: "A",
    state: "active",
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as DecisionRow;
}

function edge(from: string, to: string, kind: RelationEdge["kind"]): RelationEdge {
  return { from, to, kind, provenance: "local-document" };
}

describe("genealogy edge building", () => {
  it("keeps only decision↔decision refines/narrows/supersedes/supports edges", () => {
    const byId = new Map([
      ["dec_a", dec()],
      ["dec_b", dec({ decisionId: "dec_b" })],
      ["dec_c", dec({ decisionId: "dec_c" })],
    ]);
    const relations = [
      edge("decision/dec_a", "decision/dec_b", "refines"),
      edge("decision/dec_a", "decision/dec_c", "supports"),
      edge("decision/dec_a", "task/task_x", "derives"),
      edge("decision/dec_a/CH1", "fact/F-1", "evidenced-by"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    expect(geo).toHaveLength(2);
    expect(geo.map((e) => e.kind).sort()).toEqual(["refines", "supports"]);
  });

  it("drops edges whose endpoints are not in the decision map", () => {
    const byId = new Map([["dec_a", dec()]]);
    const relations = [edge("decision/dec_a", "decision/dec_ghost", "refines")];
    expect(buildGenealogyEdges(relations, byId)).toHaveLength(0);
  });

  it("deduplicates same from/to/kind triples", () => {
    const byId = new Map([
      ["dec_a", dec()],
      ["dec_b", dec({ decisionId: "dec_b" })],
    ]);
    const relations = [
      edge("decision/dec_a", "decision/dec_b", "refines"),
      edge("decision/dec_a", "decision/dec_b", "refines"),
    ];
    expect(buildGenealogyEdges(relations, byId)).toHaveLength(1);
  });
});

describe("genealogy lineage traversal", () => {
  it("assigns depth 0 to focus, +1 to descendants, -1 to ancestors (canonical direction)", () => {
    // Canonical: source <verb> target. source=refiner=descendant, target=refined=ancestor.
    // dec_focus refines dec_root → dec_root is ancestor (depth -1).
    // dec_child supersedes dec_focus → dec_child is descendant (depth +1).
    const byId = new Map([
      ["dec_root", dec({ decisionId: "dec_root" })],
      ["dec_focus", dec({ decisionId: "dec_focus" })],
      ["dec_child", dec({ decisionId: "dec_child" })],
    ]);
    const relations = [
      edge("decision/dec_focus", "decision/dec_root", "refines"),
      edge("decision/dec_child", "decision/dec_focus", "supersedes"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    const depth = collectLineage("dec_focus", geo);
    expect(depth.get("dec_focus")).toBe(0);
    expect(depth.get("dec_root")).toBe(-1);
    expect(depth.get("dec_child")).toBe(1);
  });
});

describe("genealogy cycle detection", () => {
  it("detects a cycle among genealogy edges", () => {
    const byId = new Map([
      ["dec_a", dec()],
      ["dec_b", dec({ decisionId: "dec_b" })],
      ["dec_c", dec({ decisionId: "dec_c" })],
    ]);
    const relations = [
      edge("decision/dec_a", "decision/dec_b", "refines"),
      edge("decision/dec_b", "decision/dec_c", "refines"),
      edge("decision/dec_c", "decision/dec_a", "refines"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    const cycles = findGenealogyCycles(geo);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
  });

  it("returns no cycles for a clean DAG", () => {
    const byId = new Map([
      ["dec_a", dec()],
      ["dec_b", dec({ decisionId: "dec_b" })],
    ]);
    const relations = [edge("decision/dec_a", "decision/dec_b", "refines")];
    const geo = buildGenealogyEdges(relations, byId);
    expect(findGenealogyCycles(geo)).toHaveLength(0);
  });
});

describe("genealogy layout", () => {
  it("returns EMPTY_LAYOUT for null focus", () => {
    const layout = computeLayout(null, [], new Map(), 900);
    expect(layout.nodes).toHaveLength(0);
  });

  it("places focus at center for an isolated decision", () => {
    const focus = dec();
    const byId = new Map([["dec_a", focus]]);
    const layout = computeLayout(focus, [], byId, 900);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]!.id).toBe("dec_a");
  });

  it("arranges a 3-generation lineage into 3 rank columns", () => {
    // Canonical: focus refines root (root=ancestor); child supersedes focus (child=descendant).
    const byId = new Map([
      ["dec_root", dec({ decisionId: "dec_root", title: "Root" })],
      ["dec_focus", dec({ decisionId: "dec_focus", title: "Focus" })],
      ["dec_child", dec({ decisionId: "dec_child", title: "Child" })],
    ]);
    const relations = [
      edge("decision/dec_focus", "decision/dec_root", "refines"),
      edge("decision/dec_child", "decision/dec_focus", "supersedes"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    const layout = computeLayout(byId.get("dec_focus")!, geo, byId, 900);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.ticks).toHaveLength(3);
  });

  it("folds same-day nodes in a column into a cluster", () => {
    const day = "2026-08-01T00:00:00.000Z";
    const byId = new Map([
      ["dec_focus", dec({ decisionId: "dec_focus" })],
      ["dec_c1", dec({ decisionId: "dec_c1", proposedAt: day })],
      ["dec_c2", dec({ decisionId: "dec_c2", proposedAt: day })],
    ]);
    // c1/c2 both refine focus → both are ancestors of focus (same rank).
    const relations = [
      edge("decision/dec_focus", "decision/dec_c1", "refines"),
      edge("decision/dec_focus", "decision/dec_c2", "refines"),
    ];
    const geo = buildGenealogyEdges(relations, byId);
    const layout = computeLayout(byId.get("dec_focus")!, geo, byId, 900);
    const clusters = layout.nodes.filter((n) => n.isCluster);
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.clusterSize).toBe(2);
    // Expand the cluster.
    const expanded = computeLayout(byId.get("dec_focus")!, geo, byId, 900, {
      expandedDays: new Set([clusters[0]!.dayKey!]),
    });
    expect(expanded.nodes.filter((n) => n.isCluster)).toHaveLength(0);
  });
});

describe("genealogy time helpers", () => {
  it("decisionIdOf extracts id from decision/<id>/claim ref", () => {
    expect(decisionIdOf("decision/dec_x")).toBe("dec_x");
    expect(decisionIdOf("decision/dec_x/CH1")).toBe("dec_x");
    expect(decisionIdOf("task/task_x")).toBeNull();
  });

  it("timeMsOf returns null when no timestamps", () => {
    const { proposedAt: _proposedAt, decidedAt: _decidedAt, ...withoutTime } = dec();
    expect(timeMsOf(withoutTime)).toBeNull();
    expect(timeMsOf(dec({ proposedAt: "2026-08-01T00:00:00.000Z" }))).toBeGreaterThan(0);
  });

  it("dayKeyOf slices the date portion", () => {
    expect(dayKeyOf(dec({ proposedAt: "2026-08-13T10:00:00Z" }))).toBe("2026-08-13");
    const { proposedAt: _proposedAt, decidedAt: _decidedAt, ...withoutTime } = dec();
    expect(dayKeyOf(withoutTime)).toBe("NO_TIME");
  });
});

// 参与者侧栏 = 「出现在任意谱系边端点上的决策」去重,规模随台账谱系边被动累积
// (本仓实测 252 行,见 ParticipantsSidebar 的 ROW_BATCH_SIZE 注释)。分批让 DOM 节点数
// 与决策总量脱钩;标题计数报真实总数,按钮报出剩余条数,搜索仍在全量上过滤。
describe("genealogy participants sidebar: row set renders in full", () => {
  const noop = () => {};
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  function sidebarRow(patch: Partial<DecisionRow>): DecisionRow {
    // state 必须是 DecisionStateBadge 认识的词(单元夹具里的 "active" 不进 DOM 渲染路径)。
    return { ...dec({ state: "in_effect" as DecisionRow["state"], ...patch }) } as DecisionRow;
  }

  async function renderSidebar(participants: ReadonlyArray<DecisionRow>) {
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ParticipantsSidebar, {
          participants,
          focusId: null,
          lineageSize: new Map(),
          onFocus: noop,
        }),
      );
    });
    const scope = () => container.querySelector('[data-testid="genealogy-participants-rows"]')!;
    return {
      container,
      rows: () => [...scope().querySelectorAll<HTMLButtonElement>(":scope > button")],
      more: () => container.querySelector<HTMLButtonElement>('[data-testid="genealogy-participants-more"]'),
      header: () => container.querySelector("aside > div")!.textContent ?? "",
      input: () => container.querySelector<HTMLInputElement>("input")!,
      async type(text: string) {
        const input = container.querySelector<HTMLInputElement>("input")!;
        await act(async () => {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
          set.call(input, text);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      },
      unmount() {
        act(() => {
          root.unmount();
        });
        container.remove();
      },
    };
  }

  // 完整渲染(2026-08-25 泽宇裁决:性能顾虑用按需渲染解决,不转嫁给用户点击):
  // 全量行进 DOM,离屏行靠 content-visibility 跳过布局与绘制;标题计数报真实总数。
  it("renders every participant row up front with no reveal button", async () => {
    const participants = Array.from({ length: 45 }, (_, index) =>
      sidebarRow({ decisionId: `dec_${index}`, title: `Decision ${index}` }),
    );
    const view = await renderSidebar(participants);
    try {
      expect(view.rows()).toHaveLength(45);
      expect(view.more()).toBeNull();
      expect(view.header()).toMatch(/参与者\s*45/u);
    } finally {
      view.unmount();
    }
  });

  it("renders a small participant set in full", async () => {
    const participants = Array.from({ length: 5 }, (_, index) =>
      sidebarRow({ decisionId: `dec_${index}`, title: `Decision ${index}` }),
    );
    const view = await renderSidebar(participants);
    try {
      expect(view.rows()).toHaveLength(5);
      expect(view.more()).toBeNull();
    } finally {
      view.unmount();
    }
  });

  // 搜索语义不许变:needle 过滤发生在**全量** participants 上。
  // 做成「只搜已渲染行」的话,这里会渲染成「无匹配」——用户会以为搜不到。
  it("filters the full participant list and renders every hit", async () => {
    const participants = [
      ...Array.from({ length: 12 }, (_, index) =>
        sidebarRow({ decisionId: `dec_alpha_${index}`, title: `Alpha ${index}` }),
      ),
      ...Array.from({ length: 18 }, (_, index) =>
        sidebarRow({ decisionId: `dec_probe_${index}`, title: `Probe ${index}` }),
      ),
    ];
    const view = await renderSidebar(participants);
    try {
      await view.type("probe");
      // 命中的 18 行全部可见,不需要任何点击。
      const rows = view.rows().map((row) => row.textContent ?? "");
      expect(rows).toHaveLength(18);
      for (const text of rows) expect(text).toContain("Probe");
      // 标题计数仍是全量参与者总数,不随搜索收窄。
      expect(view.header()).toMatch(/参与者\s*30/u);
    } finally {
      view.unmount();
    }
  });

  // 换词 = 换掉行集全部组员;渲染始终是全量的,不存在「回到第一批」的中间态。
  it("renders the new filtered set in full when the query changes", async () => {
    const participants = [
      ...Array.from({ length: 12 }, (_, index) =>
        sidebarRow({ decisionId: `dec_alpha_${index}`, title: `Alpha ${index}` }),
      ),
      ...Array.from({ length: 18 }, (_, index) =>
        sidebarRow({ decisionId: `dec_probe_${index}`, title: `Probe ${index}` }),
      ),
    ];
    const view = await renderSidebar(participants);
    try {
      expect(view.rows()).toHaveLength(30);
      await view.type("probe");
      expect(view.rows()).toHaveLength(18);
      expect(view.more()).toBeNull();
    } finally {
      view.unmount();
    }
  });
});
