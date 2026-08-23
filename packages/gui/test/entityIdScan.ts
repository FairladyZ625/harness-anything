/**
 * G10 实体互链不变量 · DOM 扫描器。
 *
 * 判据的「形状」在这里:不看哪个组件/字段/变量渲染了文本,只看渲染产物 ——
 * 文本节点里出现实体标识(fixture 实体 ID 精确子串,或 canonical 引用形的
 * 机器 ID 启发式),而它没有任何可激活祖先(button/a/[role=link|button])。
 * React 18 的事件是根委托,onclick 属性不可靠,故只认结构性可激活元素。
 */

export interface DeadEntityIdFinding {
  /** 渲染面标识(视图名或额外表面名)。 */
  surface: string;
  /** 命中的实体标识。 */
  needle: string;
  /** 命中处的文本摘录。 */
  excerpt: string;
  /** 从文本节点向上的祖先链(用于人工定位渲染点)。 */
  ancestors: string;
}

const ACTIVATABLE_SELECTOR = "button, a, [role='link'], [role='button']";

/**
 * canonical 引用形回退针:kind/ + 机器风格 id(≥4 字符且含 _ 数字 -)。
 * 只为兜住非 fixture 实体的组合引用;单词形 id(如 prose 里的 task/list)
 * 不命中,避免把文案误判成引用。
 */
const CANONICAL_REF_PATTERN = /(?:task|decision|fact|agent|squad|provider|session)\/[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]/gu;

function looksLikeMachineId(idSegment: string): boolean {
  return idSegment.length >= 4 && /[_0-9-]/u.test(idSegment);
}

interface Occurrence { readonly start: number; readonly end: number; readonly needle: string; }

function collectOccurrences(text: string, fixtureNeedles: readonly string[]): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const needle of fixtureNeedles) {
    let index = text.indexOf(needle);
    while (index !== -1) {
      occurrences.push({ start: index, end: index + needle.length, needle });
      index = text.indexOf(needle, index + 1);
    }
  }
  for (const match of text.matchAll(CANONICAL_REF_PATTERN)) {
    const value = match[0];
    const idSegment = value.slice(value.indexOf("/") + 1);
    if (!looksLikeMachineId(idSegment)) continue;
    const start = match.index ?? 0;
    occurrences.push({ start, end: start + value.length, needle: value });
  }
  return occurrences;
}

function mergeOverlaps(occurrences: Occurrence[]): Occurrence[] {
  const sorted = [...occurrences].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Occurrence[] = [];
  for (const occurrence of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && occurrence.start < previous.end) continue;
    merged.push(occurrence);
  }
  return merged;
}

function ancestorChain(node: Node): string {
  const names: string[] = [];
  let current: HTMLElement | null = node.parentElement;
  while (current !== null && names.length < 8) {
    const identity = current.dataset?.testid;
    names.push(identity ? `${current.tagName.toLowerCase()}[data-testid=${identity}]` : current.tagName.toLowerCase());
    current = current.parentElement;
  }
  return names.join(" < ");
}

function walkTextNodes(node: Node, sink: Text[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    sink.push(node as Text);
    return;
  }
  for (const child of Array.from(node.childNodes)) walkTextNodes(child, sink);
}

/** 扫描一个已渲染容器;返回所有「实体 ID 被渲染成不可激活文本」的发现。 */
export function scanDeadEntityIds(
  container: ParentNode,
  surface: string,
  fixtureNeedles: readonly string[],
): DeadEntityIdFinding[] {
  const findings: DeadEntityIdFinding[] = [];
  const textNodes: Text[] = [];
  walkTextNodes(container, textNodes);
  for (const textNode of textNodes) {
    const text = textNode.data ?? "";
    if (!/(?:task|decision|fact|agent|squad|provider|session|g10)/iu.test(text)) continue;
    const occurrences = mergeOverlaps(collectOccurrences(text, fixtureNeedles));
    if (occurrences.length === 0) continue;
    const activatable = textNode.parentElement?.closest(ACTIVATABLE_SELECTOR) ?? null;
    if (activatable !== null) continue;
    for (const occurrence of occurrences) {
      const around = text.slice(Math.max(0, occurrence.start - 24), Math.min(text.length, occurrence.end + 24));
      findings.push({
        surface,
        needle: occurrence.needle,
        excerpt: around.trim(),
        ancestors: ancestorChain(textNode),
      });
    }
  }
  return findings;
}
