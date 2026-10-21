/**
 * 排空式游标续读的唯一循环(agenda 与 relation-graph 共用):queryFn 在一次刷新内
 * 沿服务端游标把剩余页背靠背拉完,与台账探针 readTaskList 同族(台账体量到 17 万行,
 * 预算耗尽带 pending 切面交还探针节拍;这两个小切面排空到读完为止)。
 *
 *   - 终止条件用读者自己的信号:服务端 `nextCursor` 为空即最后一页——不是 cursor
 *     本身为空,流尾游标通常不为空;
 *   - 单调量:已消费的续读游标每轮严格增加;重复游标表示异常循环,抛错且不发布
 *     部分切面。合法数据量不受固定页数限制。
 */
export async function drainCursorPages<Page extends { readonly page?: { readonly nextCursor?: string | null } }>(
  readPage: (facets: { readonly cursor?: string }) => Promise<Page>,
  label: string,
): Promise<[Page, ...Page[]]> {
  const pages: Page[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // 终止:服务端 nextCursor 为空(最后一页);页预算兜底游标异常循环。
  while (true) {
    const page = await readPage(cursor === undefined ? {} : { cursor });
    pages.push(page);
    const next = page.page?.nextCursor;
    if (!next) return pages as [Page, ...Page[]];
    if (cursors.has(next)) throw new Error(`${label}: cursor did not advance`);
    cursors.add(next);
    cursor = next;
  }
}
