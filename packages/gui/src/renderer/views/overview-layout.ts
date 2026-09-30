/**
 * 总览区域布局(dec_B3D40712A6B050D83F1C2EF78D CH1,原型 overview-prototype.html v4 的 `layout()`
 * 逐行移植):按权重从重到轻把区域放进当前最矮的一列;列宽按列权重的 0.6 次方分配并夹在
 * 24%–46%(含 works 的列下限 30%);区域高度不超过内容所需,列内富余按权重分给各区域
 * (上限 = 宽松行布满的 1.08 倍),分不完的给列尾。宽度 <900px 退化为单列纵排。
 *
 * 纯函数、无 DOM:页面把 daemon 的区域权重(S1)与各区域行数喂进来,拿到每个区域的
 * {left, top, width, height} 与 slim/tall 标记后自行落到 Region 原语上。
 */

export type RegionKey = "ci" | "mine" | "stuck" | "run" | "review" | "queue" | "recent" | "works";

/** 行高与头部/页脚像素(与 DenseRow 25px 行、宽松 44px 行同一档)。 */
export const REGION_ROW_PX = 25;
export const REGION_ROW_RELAXED_PX = 44;
const HEADER_PX = 34;
const FOOTER_PX = 24;
/** 评审与合并区域顶部的分段计数条(原型 .flow)占的高度。 */
const TOP_BLOCK_PX = 44;
/** 单列(窄屏)模式下单区域高度上限;超过则区域内部滚动由页面接管。 */
const SINGLE_COLUMN_MAX_PX = 420;
const GAP_PX = 8;
/** 列数切换的宽度档位(标准 §2.1:≥900 一屏两列起,≥1400 三列)。 */
const COLUMNS_AT = { three: 1400, two: 900 } as const;

export interface RegionBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface RegionLayout {
  /** 实际列数;1 = 窄屏单列纵排。 */
  readonly columns: number;
  /** 按权重从重到轻的落位顺序。 */
  readonly order: readonly RegionKey[];
  readonly boxes: Readonly<Partial<Record<RegionKey, RegionBox>>>;
  /** 高度不足 60px 的区域收成一行(隐藏行体与页脚,原型 .tile.slim)。 */
  readonly slim: ReadonlySet<RegionKey>;
  /** 富余足够、切到宽松两行行的区域(原型 .tile.tall,仅 mine/stuck)。 */
  readonly tall: ReadonlySet<RegionKey>;
  /** 单列模式下板的总高(页面据此放开滚动);两/三列为 null(板撑满视口)。 */
  readonly boardHeight: number | null;
}

/** 区域内容所需高度:头部 + 可选顶部计数条 + 行数 × 行高 + 页脚。 */
export function regionNeed(rowCount: number, options: { readonly top?: boolean } = {}): number {
  return HEADER_PX + (options.top === true ? TOP_BLOCK_PX : 0) + rowCount * REGION_ROW_PX + FOOTER_PX;
}

/** 宽松行(原因换行成第二行)模式下的内容所需高度。 */
export function regionNeedRelaxed(rowCount: number): number {
  return HEADER_PX + rowCount * REGION_ROW_RELAXED_PX + FOOTER_PX;
}

export function layoutRegions(input: {
  /** 各区域权重(S1 regionWeights;CI 红时由页面给 60,绿时 0 → 区域不落位)。 */
  readonly weights: Readonly<Record<RegionKey, number>>;
  /** 各区域内容所需高度(regionNeed 的积)。 */
  readonly need: Readonly<Record<RegionKey, number>>;
  /** mine/stuck 的宽松行所需高度(regionNeedRelaxed 的积)。 */
  readonly needRelaxed: Readonly<Record<RegionKey, number>>;
  readonly board: { readonly width: number; readonly height: number };
}): RegionLayout {
  const weights = input.weights,
    need = input.need,
    gap = GAP_PX,
    keys = (Object.keys(weights) as RegionKey[])
      .filter((key) => weights[key] > 0)
      .sort((a, b) => weights[b]! - weights[a]!),
    boxes: Partial<Record<RegionKey, RegionBox>> = {},
    slim = new Set<RegionKey>(),
    tall = new Set<RegionKey>();
  const columns = input.board.width >= COLUMNS_AT.three ? 3 : input.board.width >= COLUMNS_AT.two ? 2 : 1;

  if (columns === 1) {
    let top = 0;
    for (const key of keys) {
      const height = Math.min(need[key] ?? regionNeed(0), SINGLE_COLUMN_MAX_PX);
      boxes[key] = { left: 0, top, width: input.board.width, height };
      top += height + gap;
    }
    return { columns, order: keys, boxes, slim, tall, boardHeight: Math.max(0, top - gap) };
  }

  // 1) 瀑布落位:按权重从重到轻,每个区域放进当前最矮的一列(同高取最左)。
  const totalWeight = keys.reduce((sum, key) => sum + weights[key]!, 0),
    perColumn = totalWeight / columns,
    cols = Array.from({ length: columns }, () => ({ keys: [] as RegionKey[], bottom: 0, weight: 0 })),
    heights = new Map<RegionKey, number>();
  for (const key of keys) {
    const column = cols.reduce((left, right) => (right.bottom < left.bottom - 1 ? right : left));
    const target = (input.board.height * weights[key]!) / perColumn,
      floor = key === "mine" && weights.mine! < 2 ? 36 : 64,
      height = Math.max(Math.min(need[key] ?? regionNeed(0), target), floor);
    heights.set(key, height);
    column.keys.push(key);
    column.bottom += height + gap;
    column.weight += weights[key]!;
  }

  // 2) 列宽:列权重的 0.6 次方分配,单列夹在 24%–46%(含 works 的列下限 30%),再归一到可用宽。
  const available = input.board.width - gap * (columns - 1),
    shares = cols.map((column) => Math.pow(column.weight, 0.6)),
    shareTotal = shares.reduce((sum, value) => sum + value, 0),
    clamped = shares.map((share, index) =>
      Math.min(0.46, Math.max(cols[index]!.keys.includes("works") ? 0.3 : 0.24, share / shareTotal)),
    ),
    clampedTotal = clamped.reduce((sum, value) => sum + value, 0),
    widths = clamped.map((share) => (share / clampedTotal) * available);

  // 3) 页面先铺满:列内富余先按权重让各区域长到内容所需(放得下全部行);还有富余时把 mine/stuck
  //    整个升到宽松两行形态;最后剩下的按权重摊给同列所有区域,每列都到板底,不在某一个区域留大块空白。
  const capacity = (key: RegionKey): number => need[key] ?? regionNeed(0);
  let left = 0;
  cols.forEach((column, index) => {
    let spare = Math.max(0, input.board.height - (column.bottom - gap)),
      open = [...column.keys];
    for (let round = 0; round < 6 && spare > 1 && open.length > 0; round += 1) {
      const openWeight = open.reduce((sum, key) => sum + weights[key]!, 0),
        next: RegionKey[] = [];
      let used = 0;
      for (const key of open) {
        const add = (spare * weights[key]!) / openWeight,
          current = heights.get(key)!;
        if (current + add >= capacity(key)) {
          used += Math.max(0, capacity(key) - current);
          heights.set(key, Math.max(current, capacity(key)));
        } else {
          heights.set(key, current + add);
          used += add;
          next.push(key);
        }
      }
      spare -= used;
      open = next;
    }
    for (const key of column.keys) {
      if (key !== "mine" && key !== "stuck") continue;
      const current = heights.get(key)!,
        relaxedNeed = input.needRelaxed[key] ?? regionNeedRelaxed(0);
      if (current >= need[key]! && relaxedNeed - current <= spare) {
        spare -= relaxedNeed - current;
        heights.set(key, relaxedNeed);
        tall.add(key);
      }
    }
    if (spare > 1) {
      const columnWeight = column.keys.reduce((sum, key) => sum + weights[key]!, 0);
      for (const key of column.keys) heights.set(key, heights.get(key)! + (spare * weights[key]!) / columnWeight);
    }
    let top = 0;
    for (const key of column.keys) {
      const height = heights.get(key)!,
        width = widths[index]!;
      if (height < 60) slim.add(key);
      boxes[key] = { left, top, width, height };
      top += height + gap;
    }
    left += widths[index]! + gap;
  });

  return { columns, order: keys, boxes, slim, tall, boardHeight: null };
}
