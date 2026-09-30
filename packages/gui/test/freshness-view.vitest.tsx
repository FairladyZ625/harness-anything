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
    ),
  groupHeader = (container: HTMLElement, decisionId: string) =>
    container.querySelector(`[data-testid="freshness-group-${decisionId}"]`);

describe("FreshnessView:按决策分组收束(标准 §1.4 收束不堆叠)", () => {
  it("页头结论行说清多少条决策、多少条断言、先处理哪条", async () => {
    const container = await mountFreshness(GROUPED_DECISIONS, GROUPED_ROWS);
    const headline = container.querySelector('[data-testid="freshness-counts"]')?.textContent ?? "";
    // 12 条断言(11 缺证 + 1 反驳)、6 条决策;「先处理」指向最危险档(refuted)那条。
    expect(headline).toContain("12 / 12");
    expect(headline).toContain("6 条决策");
    expect(headline).toContain("先处理「决策 dec-refuted」");
  });

  it("档内按决策分组:一组一行(标题 + 断言数),缺证最多的组排最前", async () => {
    const container = await mountFreshness(GROUPED_DECISIONS, GROUPED_ROWS);
    const section = [...container.querySelectorAll("section")].find((node) =>
      node.querySelector("h2")?.textContent?.includes("建议补证"),
    );
    expect(section).toBeTruthy();
    const headers = [...section!.querySelectorAll('[data-testid^="freshness-group-dec-"]')];
    // 默认只露前 3 组(缺证最多):dec-a(4)→dec-b(3)→dec-c(2);dec-d/dec-e 收进展开行。
    expect(headers.map((node) => node.getAttribute("data-testid"))).toEqual([
      "freshness-group-dec-a",
      "freshness-group-dec-b",
      "freshness-group-dec-c",
    ]);
    expect(headers[0]!.textContent).toContain("4 条断言");
  });

  it("默认只展开最急的前 3 组,其余收成一行「还有 N 组 · 展开」;点开才露组", async () => {
    const container = await mountFreshness(GROUPED_DECISIONS, GROUPED_ROWS);
    // 前 3 组的断言行默认可见;后 2 组连组头都不渲染。
    expect(claimRows(container, "dec-a")).toHaveLength(4);
    expect(claimRows(container, "dec-c")).toHaveLength(2);
    expect(groupHeader(container, "dec-d")).toBeNull();
    expect(claimRows(container, "dec-d")).toHaveLength(0);
    const more = container.querySelector('[data-testid="freshness-more-no-live-evidence"]');
    expect(more?.textContent).toContain("还有 2 组 · 展开");
    await act(async () => {
      more!.click();
    });
    expect(groupHeader(container, "dec-d")).not.toBeNull();
    expect(groupHeader(container, "dec-e")).not.toBeNull();
    // 展开露出的组默认收起(断言行不可见),点组头才展开自己的断言行。
    expect(claimRows(container, "dec-d")).toHaveLength(0);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="freshness-group-toggle-dec-d"]')!.click();
    });
    expect(claimRows(container, "dec-d")).toHaveLength(1);
    // 用户收起过前 3 组中的某一组:该组断言行消失(用户选择优先于默认展开)。
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="freshness-group-toggle-dec-a"]')!.click();
    });
    expect(claimRows(container, "dec-a")).toHaveLength(0);
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
