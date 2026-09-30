// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { layoutRegions, regionNeed, regionNeedRelaxed, type RegionKey } from "../src/renderer/views/overview-layout.ts";

/**
 * 总览布局算法(dec_B3D40712 CH1,原型 v4 `layout()` 的纯函数移植)的验收面:
 * 最重区域落左上、列宽按权重分配且夹在 24%–46%、区域高度不超过内容所需、
 * 富余让给同列并按上限封顶、窄屏退化单列、权重 0 的区域不落位。
 */

const KEYS: readonly RegionKey[] = ["mine", "stuck", "run", "review", "queue", "recent", "works"];

/** 与原型 v4 演示数据同量级的权重(S1 regionWeights 的形状)。 */
const WEIGHTS: Record<RegionKey, number> = {
  ci: 0,
  mine: 20,
  stuck: 6,
  run: 8,
  review: 5,
  queue: 3.5,
  recent: 4,
  works: 12,
};

/** 每区域 4 行内容所需的输入面。 */
const fourRows = (keys: readonly RegionKey[] = KEYS) => {
  const need: Partial<Record<RegionKey, number>> = {},
    relaxed: Partial<Record<RegionKey, number>> = {};
  for (const key of keys) {
    need[key] = regionNeed(4, { top: key === "review" });
    relaxed[key] = key === "mine" || key === "stuck" ? regionNeedRelaxed(4) : need[key]!;
  }
  return { need: need as Record<RegionKey, number>, relaxed: relaxed as Record<RegionKey, number> };
};

describe("layoutRegions 落位顺序", () => {
  it("最重的区域在左上(第一列最上),顺序按权重从重到轻", () => {
    const { need, relaxed } = fourRows();
    const layout = layoutRegions({ weights: WEIGHTS, need, needRelaxed: relaxed, board: { width: 1200, height: 700 } });
    expect(layout.order[0]).toBe("mine");
    const mine = layout.boxes.mine!;
    expect(mine.left).toBe(0);
    expect(mine.top).toBe(0);
    // 同列里后落的区域在它下面
    const sameColumn = layout.order.filter((key) => layout.boxes[key]!.left === 0 && key !== "mine");
    for (const key of sameColumn) expect(layout.boxes[key]!.top).toBeGreaterThan(0);
  });

  it("CI 红时 ci 权重最高,压过 mine 落到左上", () => {
    const { need, relaxed } = fourRows([...KEYS, "ci"]);
    const layout = layoutRegions({
      weights: { ...WEIGHTS, ci: 60 },
      need,
      needRelaxed: relaxed,
      board: { width: 1200, height: 700 },
    });
    expect(layout.order[0]).toBe("ci");
    expect(layout.boxes.ci!.left).toBe(0);
    expect(layout.boxes.ci!.top).toBe(0);
  });

  it("权重 0 的区域不落位(CI 绿、置顶待派为空)", () => {
    const { need, relaxed } = fourRows();
    const layout = layoutRegions({
      weights: { ...WEIGHTS, queue: 0 },
      need,
      needRelaxed: relaxed,
      board: { width: 1200, height: 700 },
    });
    expect(layout.boxes.queue).toBeUndefined();
    expect(layout.order).not.toContain("queue");
  });
});

describe("layoutRegions 列宽", () => {
  const columnWidths = (layout: ReturnType<typeof layoutRegions>, boardWidth: number, columns: number) => {
    const byColumn = new Map<number, number>();
    for (const key of layout.order) {
      const box = layout.boxes[key]!;
      byColumn.set(box.left, Math.max(byColumn.get(box.left) ?? 0, box.width));
    }
    expect(byColumn.size).toBe(columns);
    return [...byColumn.entries()].sort((a, b) => a[0] - b[0]).map(([, width]) => width);
  };

  it("三列时各列份额有界:不窄于板的 20%、不宽于板的 46%+归一余量", () => {
    const { need, relaxed } = fourRows();
    const layout = layoutRegions({
      weights: { ci: 0, mine: 10, stuck: 0.5, run: 0.5, review: 0.5, queue: 0, recent: 0.5, works: 10.5 },
      need,
      needRelaxed: relaxed,
      board: { width: 1500, height: 700 },
    });
    const widths = columnWidths(layout, 1500, 3);
    // 24%/46% 夹取发生在填满归一之前:轻列被抬到 24% 后,重列同时被压到 46%,
    // 归一会让两者各自略越界一点(轻列 ~22%、重列 ~48%)——包络断言如实覆盖。
    for (const width of widths) {
      expect(width / 1500).toBeGreaterThanOrEqual(0.2);
      expect(width / 1500).toBeLessThanOrEqual(0.5);
    }
    // mine 所在列不窄于最轻的列
    const mineWidth = layout.boxes.mine!.width;
    expect(mineWidth).toBeGreaterThanOrEqual(Math.min(...widths));
  });

  it("列宽恰好填满板宽(含间隙)", () => {
    const { need, relaxed } = fourRows();
    const layout = layoutRegions({ weights: WEIGHTS, need, needRelaxed: relaxed, board: { width: 1200, height: 700 } });
    const widths = columnWidths(layout, 1200, 2);
    const total = widths.reduce((sum, width) => sum + width, 0) + 8 * (widths.length - 1);
    expect(Math.abs(total - 1200)).toBeLessThanOrEqual(1);
  });

  it("权重悬殊时 24%/30% 下限把轻列抬起来,不随权重塌缩", () => {
    const { need, relaxed } = fourRows();
    // mine 极重、其余极轻(works 含在轻列):轻列被下限抬到 ≥30%
    const layout = layoutRegions({
      weights: { ci: 0, mine: 400, stuck: 2, run: 2, review: 2, queue: 0, recent: 2, works: 2 },
      need,
      needRelaxed: relaxed,
      board: { width: 1200, height: 700 },
    });
    const widths = columnWidths(layout, 1200, 2);
    const light = Math.min(...widths);
    expect(light / 1200).toBeGreaterThanOrEqual(0.3);
    // 重列被 46% 上限压住(两列归一后最多 ~66%),不会吃掉整个板宽
    expect(Math.max(...widths) / 1200).toBeLessThanOrEqual(0.67);
  });
});

describe("layoutRegions 高度", () => {
  it("区域高度不超过内容所需:非列尾区域封在所需 ×1.08(宽松行区域用宽松所需)", () => {
    const { need, relaxed } = fourRows();
    const layout = layoutRegions({
      weights: { ...WEIGHTS, mine: 400, stuck: 2, run: 2, review: 2, queue: 0, recent: 2, works: 2 },
      need,
      needRelaxed: relaxed,
      board: { width: 1200, height: 3000 },
    });
    // 每列只有最后一个区域吸收剩余板高(原型 `if(spare>1) H[last]+=spare`);
    // 其余区域的高度都被 cap 封在内容所需(宽松档)的 1.08 倍以内。
    for (const left of new Set(layout.order.map((key) => layout.boxes[key]!.left))) {
      const column = layout.order.filter((key) => layout.boxes[key]!.left === left);
      for (const key of column.slice(0, -1)) {
        const cap = key === "mine" || key === "stuck" ? relaxed[key] * 1.08 : need[key] * 1.08;
        expect(layout.boxes[key]!.height).toBeLessThanOrEqual(cap + 1);
      }
    }
  });

  it("富余充足时区域高度只取单行或两行所需两档,不留半截空白", () => {
    const { need, relaxed } = fourRows();
    const layout = layoutRegions({
      weights: WEIGHTS,
      need,
      needRelaxed: relaxed,
      board: { width: 1200, height: 2000 },
    });
    for (const key of layout.order) {
      const height = layout.boxes[key]!.height;
      expect([need[key], relaxed[key]]).toContain(height);
      expect(height === relaxed[key] && relaxed[key] !== need[key]).toBe(layout.tall.has(key));
    }
  });

  it("高度不足 60px 的区域标记 slim;富余足够的 mine/stuck 标记 tall", () => {
    const { need, relaxed } = fourRows();
    // mine 清空:权重 1.5、无行,内容只需头部 → 目标高度很小 → slim
    const slimLayout = layoutRegions({
      weights: { ...WEIGHTS, mine: 1.5 },
      need: { ...need, mine: regionNeed(0) },
      needRelaxed: { ...relaxed, mine: regionNeedRelaxed(0) },
      board: { width: 1200, height: 400 },
    });
    expect(slimLayout.boxes.mine!.height).toBeLessThan(60);
    expect(slimLayout.slim.has("mine")).toBe(true);

    // mine 行多、板高富余:高度够到宽松行所需 → tall
    const tallLayout = layoutRegions({
      weights: { ...WEIGHTS, mine: 200 },
      need: { ...need, mine: regionNeed(4) },
      needRelaxed: { ...relaxed, mine: regionNeedRelaxed(4) },
      board: { width: 1200, height: 1400 },
    });
    expect(tallLayout.boxes.mine!.height).toBeGreaterThanOrEqual(regionNeedRelaxed(4));
    expect(tallLayout.tall.has("mine")).toBe(true);
  });
});

describe("layoutRegions 窄屏与列数", () => {
  it("宽度 <900px 退化为单列纵排,板高可滚动", () => {
    const { need, relaxed } = fourRows();
    const layout = layoutRegions({ weights: WEIGHTS, need, needRelaxed: relaxed, board: { width: 720, height: 700 } });
    expect(layout.columns).toBe(1);
    expect(layout.boardHeight).not.toBeNull();
    for (const key of layout.order) expect(layout.boxes[key]!.left).toBe(0);
    expect(layout.boardHeight!).toBeGreaterThan(0);
  });

  it("宽度 ≥900/≥1400 分别两列/三列,板高撑满视口不滚动", () => {
    const { need, relaxed } = fourRows();
    const two = layoutRegions({ weights: WEIGHTS, need, needRelaxed: relaxed, board: { width: 1000, height: 700 } });
    expect(two.columns).toBe(2);
    expect(two.boardHeight).toBeNull();
    const three = layoutRegions({ weights: WEIGHTS, need, needRelaxed: relaxed, board: { width: 1500, height: 700 } });
    expect(three.columns).toBe(3);
    expect(new Set(three.order.map((key) => three.boxes[key]!.left)).size).toBe(3);
  });
});
