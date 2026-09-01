/**
 * pane 方向焦点导航(PLT-TerminalWorkspace W1,Tabby 的方向导航语义)。
 *
 * 输入是各 pane 在页面上的矩形(渲染层用 `getBoundingClientRect()` 采集),
 * 输出是该方向上应接管焦点的 pane。选取顺序:先要求候选整体位于该方向之外侧,
 * 再优先与当前 pane 在正交轴上有重叠的(同一行/同一列),然后取该方向距离最近的,
 * 最后用正交轴中心距离拆平局。纯函数:不碰 DOM,便于对几何布局直接断言。
 */
export type PaneDirection = "left" | "right" | "up" | "down";

export interface PaneBox {
  readonly panelId: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 相邻判定容差(px):sash 借位与亚像素布局不应让相邻 pane 落选。 */
const tolerance = 1;

export function directionalPane(
  boxes: readonly PaneBox[],
  activePanelId: string | null,
  direction: PaneDirection,
): string | null {
  const active = boxes.find((box) => box.panelId === activePanelId);
  if (!active) return null;
  const ranked = boxes
    .filter((box) => box.panelId !== active.panelId && isBeyond(active, box, direction))
    .map((box) => ({ panelId: box.panelId, score: score(active, box, direction) }))
    .sort((left, right) => compare(left.score, right.score));
  return ranked[0]?.panelId ?? null;
}

function isBeyond(active: PaneBox, box: PaneBox, direction: PaneDirection): boolean {
  if (direction === "left") return box.right <= active.left + tolerance;
  if (direction === "right") return box.left >= active.right - tolerance;
  if (direction === "up") return box.bottom <= active.top + tolerance;
  return box.top >= active.bottom - tolerance;
}

/** [正交轴无重叠?, 该方向的间距, 正交轴中心距离] —— 依次比较,越小越优先。 */
function score(active: PaneBox, box: PaneBox, direction: PaneDirection): readonly [number, number, number] {
  const horizontal = direction === "left" || direction === "right";
  const gap =
    direction === "left"
      ? active.left - box.right
      : direction === "right"
        ? box.left - active.right
        : direction === "up"
          ? active.top - box.bottom
          : box.top - active.bottom;
  const overlap = horizontal
    ? Math.min(active.bottom, box.bottom) - Math.max(active.top, box.top)
    : Math.min(active.right, box.right) - Math.max(active.left, box.left);
  const crossDistance = horizontal
    ? Math.abs(center(active.top, active.bottom) - center(box.top, box.bottom))
    : Math.abs(center(active.left, active.right) - center(box.left, box.right));
  return [overlap > 0 ? 0 : 1, Math.abs(gap), crossDistance];
}

function compare(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function center(low: number, high: number): number {
  return (low + high) / 2;
}
