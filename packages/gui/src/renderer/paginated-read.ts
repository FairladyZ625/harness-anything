/**
 * 排空式游标续读的 gui 渲染侧 async 外壳(agenda 与 relation-graph 共用):终止
 * 信号、单调量与异常语义的唯一实现在 daemon 的 cursorStep
 * (@harness-anything/daemon/protocol,与 daemon 同步壳 drainCursorPagesSync 共用),
 * 这里只保留逐页 await 的外壳——queryFn 在一次刷新内沿服务端游标把剩余页背靠背
 * 拉完。与台账探针 readTaskList 同族(台账体量到 17 万行,预算耗尽带 pending 切面
 * 交还探针节拍;这两个小切面排空到读完为止)。合法数据量不受固定页数限制。
 */
import { cursorStep, type CursorPageReceipt } from "@harness-anything/daemon/protocol";

export async function drainCursorPages<Page extends { readonly page?: CursorPageReceipt }>(
  readPage: (facets: { readonly cursor?: string }) => Promise<Page>,
  label: string,
): Promise<[Page, ...Page[]]> {
  const pages: Page[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // 终止:cursorStep 在服务端末页(nextCursor 为空)返回 undefined;重复游标由它抛错。
  while (true) {
    const page = await readPage(cursor === undefined ? {} : { cursor });
    pages.push(page);
    // RelationGraphSuccess.page 在 gui 类型面可选(既有形状):缺收据按末页终止。
    const next = cursorStep(page.page ?? {}, cursors, label);
    if (next === undefined) return pages as [Page, ...Page[]];
    cursor = next;
  }
}
