/**
 * 排空式游标续读的唯一循环(agenda 与 relation-graph 共用):queryFn 在一次刷新内
 * 沿服务端游标把剩余页背靠背拉完,与台账探针 readTaskList 同族(台账体量到 17 万行,
 * 预算耗尽带 pending 切面交还探针节拍;这两个小切面排空到读完为止)。
 *
 *   - 终止条件用读者自己的信号:服务端 `nextCursor` 为空即最后一页——不是 cursor
 *     本身为空,流尾游标通常不为空;
 *   - 单调量:已读页数每轮严格 +1,`CURSOR_READ_PAGE_BUDGET` 是硬上界。服务端游标
 *     异常循环时 fail-closed 抛错:部分切面不能冒充完整读,内存也随页数有界。
 */
export const CURSOR_READ_PAGE_BUDGET = 50;

export async function drainCursorPages<Page extends { readonly page?: { readonly nextCursor?: string | null } }>(
  readPage: (facets: { readonly cursor?: string }) => Promise<Page>,
  label: string,
): Promise<[Page, ...Page[]]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  // 终止:服务端 nextCursor 为空(最后一页);页预算兜底游标异常循环。
  while (true) {
    if (pages.length >= CURSOR_READ_PAGE_BUDGET)
      throw new Error(`${label}: cursor did not drain within the ${CURSOR_READ_PAGE_BUDGET}-page read budget`);
    const page = await readPage(cursor === undefined ? {} : { cursor });
    pages.push(page);
    const next = page.page?.nextCursor;
    if (!next) return pages as [Page, ...Page[]];
    cursor = next;
  }
}
