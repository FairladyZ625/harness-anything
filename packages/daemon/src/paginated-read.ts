/**
 * 排空式游标续读:策略的唯一实现(cursorStep)与 daemon 读面的同步外壳
 * (drainCursorPagesSync)都在本文件;gui 渲染侧的 async 外壳
 * (packages/gui/src/renderer/paginated-read.ts)经 @harness-anything/daemon/protocol
 * 引用同一份 cursorStep。gui 的 readPage 是真 RPC 必须逐页 await,daemon 读派发面
 * 是同步契约(DaemonGuiReadHandlers),readPage 是投影纯函数——sync/async 是两个
 * 调用面的固有形状,而终止信号、单调量与异常语义只在 cursorStep 定义一份。
 *
 *   - 终止条件用读者自己的信号:服务端 `nextCursor` 为空即最后一页——不是 cursor
 *     本身为空,流尾游标通常不为空;
 *   - 单调量:已消费的续读游标每轮严格增加;重复游标表示异常循环,抛错且不发布
 *     部分读面。合法数据量不受固定页数限制。
 */

/** 服务端每页带回的分页收据。daemon 读面协议保证 page 必填;gui 的既有读类型(如 RelationGraphSuccess)仍是可选。 */
export type CursorPageReceipt = {
  readonly nextCursor?: string | null;
};

/**
 * 排空策略的唯一实现:对刚读到的一页收据,返回下一续读游标;末页(nextCursor 为
 * 空)返回 undefined 让调用壳终止;重复游标表示异常循环,抛 `cursor did not advance`。
 */
export function cursorStep(receipt: CursorPageReceipt, consumed: Set<string>, label: string): string | undefined {
  const next = receipt.nextCursor;
  if (!next) return undefined;
  if (consumed.has(next)) throw new Error(`${label}: cursor did not advance`);
  consumed.add(next);
  return next;
}

export function drainCursorPagesSync<Page extends { readonly page: CursorPageReceipt }>(
  readPage: (facets: { readonly cursor?: string }) => Page,
  label: string,
): [Page, ...Page[]] {
  const pages: Page[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // 终止:cursorStep 在服务端末页(nextCursor 为空)返回 undefined;重复游标由它抛错。
  while (true) {
    const page = readPage(cursor === undefined ? {} : { cursor });
    pages.push(page);
    const next = cursorStep(page.page, cursors, label);
    if (next === undefined) return pages as [Page, ...Page[]];
    cursor = next;
  }
}
