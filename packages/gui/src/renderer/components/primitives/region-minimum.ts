/**
 * 区域的最小可用高度(标准 §2.1:每个区域至少露出前三条完整行,不足三条则全部):
 * 取 Region 原语实际渲染出的标题行、行体里前三条的底边与页脚,不按行高常数估。
 * 量的是内容的自然位置而不是分配到的高度,所以被压矮的区域不会把自己的下限越量越小;
 * offset 几何不含 motion 的临时缩放。全局总览与 RegionBoard 共用。
 */
export function regionMinimumHeight(
  section: HTMLElement,
  rowsOf: (body: HTMLElement) => readonly Element[],
): number | undefined {
  const header = section.children[0] as HTMLElement | undefined,
    body = section.children[1]?.firstElementChild as HTMLElement | null | undefined,
    footer = section.children[2] as HTMLElement | undefined;
  if (header === undefined || body === null || body === undefined) return undefined;
  const rows = rowsOf(body),
    last = rows[Math.min(rows.length, 3) - 1] as HTMLElement | undefined;
  if (last === undefined) return undefined;
  return (
    header.offsetHeight +
    last.offsetTop +
    last.offsetHeight -
    body.offsetTop +
    (footer?.offsetHeight ?? 0) +
    (section.offsetHeight - section.clientHeight) +
    1
  );
}
