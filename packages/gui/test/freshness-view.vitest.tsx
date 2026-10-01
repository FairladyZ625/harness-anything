// harness-test-tier: integration
// @vitest-environment happy-dom
// 失真预警按决策分组收束(业主 2026-09-30 截图验收)的结构断言:组行形态、默认
// 展开/折叠、「还有 N 组 · 展开」、页头结论行与宽松两行行(不再把两行内容叠进
// 25px 单行)。G10 实体互链与三档色序断言仍在 entity-id-links.vitest.ts,不重复。
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FreshnessView } from "../src/renderer/views/FreshnessView.tsx";
import type { RelationCoverageRow } from "../src/api/renderer-dto.ts";
import type { DecisionRow } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const mounted: Root[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

function coverage(decisionId: string, claimId: string, reason: "refuted" | "no-live-evidence"): RelationCoverageRow {
  return {
    decisionRef: `decision/${decisionId}`,
    claimRef: `decision/${decisionId}/${claimId}`,
    status: "uncovered",
    covered: false,
    fulfillment: null,
    refutingFactRefs: [],
    relationPath: [],
    basisRevision: 7,
    freshnessReason: reason,
  };
}

function decision(id: string, claims: readonly string[]): DecisionRow {
  return {
    ...decisionProjectionFields("in_effect"),
    decisionId: id,
    title: `决策 ${id}`,
    state: "in_effect",
    question: "问什么?",
    chosen: [],
    rejected: [],
    claims: claims.map((claimId) => ({ id: claimId, text: `断言 ${id}/${claimId}`, evidence: [] })),
    judgmentConsents: [],
  };
}

async function mountFreshness(
  decisions: readonly DecisionRow[],
  coverageRows: readonly RelationCoverageRow[],
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      createElement(FreshnessView, {
        decisions: [...decisions],
        coverageRows: [...coverageRows],
        relationState: "ready",
        onNavigateEntity: () => undefined,
      }),
    );
  });
  return container;
}

/** 5 条决策、缺证断言数 4/3/2/1/1,全部「建议补证」;另 1 条被反驳置顶档。 */
const GROUPED_DECISIONS = [
  decision("dec-a", ["C1", "C2", "C3", "C4"]),
  decision("dec-b", ["C1", "C2", "C3"]),
  decision("dec-c", ["C1", "C2"]),
  decision("dec-d", ["C1"]),
  decision("dec-e", ["C1"]),
  decision("dec-refuted", ["C1"]),
];
const GROUPED_ROWS: readonly RelationCoverageRow[] = [
  ...GROUPED_DECISIONS.filter((row) => row.decisionId !== "dec-refuted").flatMap((row) =>
    row.claims.map((claim) => coverage(row.decisionId, claim.id, "no-live-evidence")),
  ),
  coverage("dec-refuted", "C1", "refuted"),
];

const claimRows = (container: HTMLElement, decisionId: string) =>
  [...container.querySelectorAll('[data-testid="freshness-row"]')].filter((row) =>
    row.textContent?.includes(decisionId),
  );

describe("FreshnessView:按决策分组收束(标准 §1.4 收束不堆叠)", () => {
  it("页头结论行说清多少条决策、多少条断言、先处理哪条", async () => {
    const container = await mountFreshness(GROUPED_DECISIONS, GROUPED_ROWS);
    const headline = container.querySelector('[data-testid="freshness-counts"]')?.textContent ?? "";
    // 12 条断言(11 缺证 + 1 反驳)、6 条决策;「先处理」指向最危险档(refuted)那条。
    expect(headline).toContain("12 / 12");
    expect(headline).toContain("6 条决策");
    expect(headline).toContain("先处理「决策 dec-refuted」");
  });

  it("页头统一摆法(标准 §2.3):裸页头一行,结论行在页头里,不带边框或底色", async () => {
    const container = await mountFreshness(GROUPED_DECISIONS, GROUPED_ROWS);
    const header = container.querySelector('[data-testid="freshness-view"] > header') as HTMLElement;
    expect(header).toBeTruthy();
    expect(header.className).not.toContain("border");
    expect(header.className).not.toContain("bg-");
    expect(header.querySelector("h1")?.className).toContain("text-xl");
    // 结论行紧跟页名(同一行),不再单独铺一条 tagline 段落。
    expect(header.querySelector('[data-testid="freshness-counts"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="freshness-view"] > header > p')).toBeNull();
  });

  it("档内按决策分组:一组一行(标题 + 断言数),缺证最多的组排最前", async () => {
    const container = await mountFreshness(GROUPED_DECISIONS, GROUPED_ROWS);
    const section = [...container.querySelectorAll("section")].find((node) =>
      node.querySelector("h2")?.textContent?.includes("建议补证"),
    );
    expect(section).toBeTruthy();
    const headers = [...section!.querySelectorAll('[data-testid^="freshness-group-dec-"]')];
    // v2(标准 §1.8):全部组直接铺开,不截前 3 组;排序按缺证断言数降序。
    expect(headers.map((node) => node.getAttribute("data-testid"))).toEqual([
      "freshness-group-dec-a",
      "freshness-group-dec-b",
      "freshness-group-dec-c",
      "freshness-group-dec-d",
      "freshness-group-dec-e",
    ]);
    expect(headers[0]!.textContent).toContain("4 条断言");
  });

  it("组默认全部展开、断言行直接可见;组头可收起(结构导航),不再有「还有 N 组 · 展开」", async () => {
    const container = await mountFreshness(GROUPED_DECISIONS, GROUPED_ROWS);
    // v2(标准 §1.8):没有「还有 N 组」截断行——空间让给组本身。
    expect(container.querySelector('[data-testid="freshness-more-no-live-evidence"]')).toBeNull();
    expect(claimRows(container, "dec-a")).toHaveLength(4);
    expect(claimRows(container, "dec-c")).toHaveLength(2);
    expect(claimRows(container, "dec-d")).toHaveLength(1);
    expect(claimRows(container, "dec-e")).toHaveLength(1);
    // 组头收起是结构导航:用户收起后该组断言行消失,其余组不受影响。
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="freshness-group-toggle-dec-a"]')!.click();
    });
    expect(claimRows(container, "dec-a")).toHaveLength(0);
    expect(claimRows(container, "dec-b")).toHaveLength(3);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="freshness-group-toggle-dec-a"]')!.click();
    });
    expect(claimRows(container, "dec-a")).toHaveLength(4);
  });

  it("断言行用宽松两行形态:断言结论一行、id 元数据第二行,不再叠进 25px 单行", async () => {
    const container = await mountFreshness(GROUPED_DECISIONS, GROUPED_ROWS);
    const row = claimRows(container, "dec-a")[0]!;
    // DenseRow 宽松档:min-h-14(56px,标准 §3 v2)两行,而非固定 h-[25px] 单行。
    const dense = row.firstElementChild as HTMLElement;
    expect(dense.className).toContain("min-h-14");
    expect(dense.className).not.toContain("h-[25px]");
    // 第一行断言结论,第二行 决策 id · 断言 id(两条信息都在,各自占行不叠加)。
    expect(dense.querySelector(".block.truncate.text-text")?.textContent).toContain("断言 dec-a/C1");
    const metaLine = dense.querySelector(".block.truncate.text-text-faint");
    expect(metaLine?.textContent).toContain("dec-a");
    expect(metaLine?.textContent).toContain("C1");
  });

  it("单决策多断言不折叠组:全部断言行直接可见(规模即 15 行也一次渲染)", async () => {
    const one = decision(
      "dec-solo",
      Array.from({ length: 15 }, (_, index) => `C${index}`),
    );
    const container = await mountFreshness(
      [one],
      one.claims.map((claim) => coverage("dec-solo", claim.id, "no-live-evidence")),
    );
    expect(container.querySelectorAll('[data-testid="freshness-row"]')).toHaveLength(15);
    expect(container.querySelector('[data-testid="freshness-more-no-live-evidence"]')).toBeNull();
  });

  it("无候选时页头不渲染结论行(不出现空的「先处理「」」)", async () => {
    const container = await mountFreshness([], []);
    expect(container.querySelector('[data-testid="freshness-counts"]')).toBeNull();
  });
});
