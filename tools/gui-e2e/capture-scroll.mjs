// capture.mjs 的 --scroll-to 解析:先按「标题优先」梯度选目标,再把目标对齐到视口顶部。
// 为什么不是一条 getByText(text).first():一条包含匹配取的是 DOM 里第一个可见节点,而页头
// 说明常常包含节标题里的词——2026-10-23 CEO 验收 #3924 时「在干活」命中页头副标题
// 「显示此刻正在干活的会话」,三张分节截图全是页顶。
// 为什么对齐顶部而不是「已可见就不动」:命中节标题时它往往露在视口下缘(或已在下缘可见),
// 只保证「可见」的话截图主体仍是上面的小节;分节截图要的是这一节从画面上方开始。
// 为什么要轮询:现场页的节标题依赖 daemon 读面,导航后一秒内可能还没渲染;一次 count() 就下
// 结论会把「还没加载」误报成「没有这个标题」,也会在数据到位后悄悄退到更低的匹配层(实测
// 改动首轮 `--scroll-to 在干活` 就落到「文字包含」——那一刻节标题尚未出现)。
const SCROLL_MATCH_TIERS = Object.freeze([
  { name: "标题精确", role: "heading", exact: true },
  { name: "文字精确", role: null, exact: true },
  // 节标题常带计数(「刚交付 0」)或说明,整词不等于标题全文;标题包含仍优先于任意文字包含。
  { name: "标题包含", role: "heading", exact: false },
  { name: "文字包含", role: null, exact: false },
]);

const DEFAULT_MATCH_TIMEOUT_MS = 10_000;
// 只命中文字层时,再给标题层多久出现的机会。现场页导航后节标题要等 daemon 读面,页头说明
// 却立刻可见——「先到先得」正是缺陷本身,所以文字层命中必须让标题层先跑完这个窗口。
const DEFAULT_HEADING_SETTLE_MS = 2_000;
const MATCH_POLL_MS = 100;

export { SCROLL_MATCH_TIERS };

/**
 * 按梯度取目标:标题层一旦出现立刻采用;只有文字层命中时先等 headingSettleMs,给尚未渲染
 * 的节标题一个出现的机会,窗口到了才退到文字层。整轮没命中就等下一轮,直到 timeoutMs。
 * 返回命中的层级与实际匹配数;失败时列出各级匹配数,让「没有这个标题」和「这个词到处都有」
 * 在报错里可区分。
 */
export async function resolveScrollTarget(
  page,
  text,
  { timeoutMs = DEFAULT_MATCH_TIMEOUT_MS, headingSettleMs = DEFAULT_HEADING_SETTLE_MS } = {},
) {
  const startedAt = Date.now();
  let attempts;
  for (;;) {
    attempts = [];
    let bestText = null;
    for (const tier of SCROLL_MATCH_TIERS) {
      const base =
        tier.role === "heading"
          ? page.getByRole("heading", { name: text, exact: tier.exact })
          : page.getByText(text, { exact: tier.exact });
      const matches = base.filter({ visible: true });
      const count = await matches.count();
      attempts.push(`${tier.name}=${count}`);
      if (count === 0) continue;
      // 同一层级多个匹配时取第一个(与 --click 的既有语义一致)。
      const hit = { locator: matches.first(), tier: tier.name, matches: count, attempts };
      if (tier.role === "heading") return hit;
      bestText ??= hit;
    }
    const elapsed = Date.now() - startedAt;
    if (bestText !== null && elapsed >= headingSettleMs) return bestText;
    if (elapsed >= timeoutMs) {
      if (bestText !== null) return bestText;
      break;
    }
    await page.waitForTimeout(MATCH_POLL_MS);
  }
  throw new Error(
    `--scroll-to 在 ${timeoutMs}ms 内找不到可见目标「${text}」(按 ${SCROLL_MATCH_TIERS.map(({ name }) => name).join("→")} 依次解析,末轮:${attempts.join(", ")})`,
  );
}

/**
 * 把目标对齐到它所在滚动口的顶部;instant 覆盖页面上的 smooth 滚动,截图前不再有滚动动画。
 * 返回对齐后的实测距离:最后一节可能到不了口顶(文档剩余高度不够),那是页面长度的限制,
 * 不是没滚——调用方据此如实记录,而不是假定「滚过了就一定在顶部」。
 * scrollTopGap>0 且到不了 = 这一节上方已经滚到底,画面顶部仍是本节内容的一部分。
 */
export async function scrollTargetToTop(locator) {
  return locator.evaluate((element) => {
    element.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
    // 最近的滚动上下文:overflow auto/scroll 且内容确实超出;没有就是文档本身。
    let scroller = null;
    for (let node = element.parentElement; node instanceof globalThis.Element; node = node.parentElement) {
      const style = globalThis.getComputedStyle(node);
      if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight - node.clientHeight > 1) {
        scroller = node;
        break;
      }
    }
    if (scroller === null) scroller = globalThis.document.scrollingElement;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    // 文档滚动时它的 rect.top 等于负的 scrollY,视口顶就是 0;元素滚动口用它自己的 rect。
    const portTop = scroller === globalThis.document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    return {
      gapPx: Math.round(element.getBoundingClientRect().top - portTop),
      atMaxScroll: scroller.scrollTop >= maxScroll - 1,
    };
  });
}
