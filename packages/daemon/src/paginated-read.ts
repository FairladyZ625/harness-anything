/**
 * 排空式游标续读的同步循环(work-briefs 的议程扫取用):沿服务端游标把剩余页
 * 背靠背读完,与 #3869 落地的 gui 渲染侧排空循环(packages/gui/src/renderer/
 * paginated-read.ts)同一语义。那边不能直接复用这边、这边也不能直接复用那边:
 * gui 的 readPage 是真 RPC 必须逐页 await,而 daemon 读派发面是同步契约
 * (DaemonGuiReadHandlers),readPage 是投影纯函数——同族两形,语义只有一份。
 *
 *   - 终止条件用读者自己的信号:服务端 `nextCursor` 为空即最后一页——不是 cursor
 *     本身为空,流尾游标通常不为空;
 *   - 单调量:已消费的续读游标每轮严格增加;重复游标表示异常循环,抛错且不发布
 *     部分读面。合法数据量不受固定页数限制。
 */
export function drainCursorPagesSync<Page extends { readonly page?: { readonly nextCursor?: string | null } }>(
  readPage: (facets: { readonly cursor?: string }) => Page,
  label: string,
): [Page, ...Page[]] {
  const pages: Page[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // 终止:服务端 nextCursor 为空(最后一页);重复游标表示异常循环。
  while (true) {
    const page = readPage(cursor === undefined ? {} : { cursor });
    pages.push(page);
    const next = page.page?.nextCursor;
    if (!next) return pages as [Page, ...Page[]];
    if (cursors.has(next)) throw new Error(`${label}: cursor did not advance`);
    cursors.add(next);
    cursor = next;
  }
}
