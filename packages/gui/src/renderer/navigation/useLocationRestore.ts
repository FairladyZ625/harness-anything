import { useEffect, useLayoutEffect, useRef } from "react";
import { consumeKnownError } from "../../api/error-consumption.ts";
import type { AppLocation } from "./viewHistory.ts";

/**
 * 回退保真(G10 清册验收句的后半):后退/前进不只回页面,还恢复**焦点与滚动**。
 *
 * 导航栈(viewHistory)恢复的是应用位置;本 hook 在它旁边补 DOM 层的位置:
 *   - 捕获:容器上的 scroll(捕获期)与 focusin 事件,按「结构路径」记进当前
 *     location 的快照。location 是不可变对象,天然是稳定键。
 *   - 恢复:location 变化后(React 已提交新视图),若新 location 有快照
 *     (即 back/forward 重访),按路径找回元素,恢复 scrollTop/scrollLeft 与
 *     焦点(preventScroll,不与滚动恢复互相打架)。
 *
 * 路径用 nth-of-type 结构路径而不是元素引用:同视图重渲染会换元素实例,
 * 结构不变即可找回;找不到(视图结构已变)就静默跳过 —— 恢复是尽力保真,
 * 不是硬约束。首次到访无快照,保持自然行为。
 */

interface ScrollEntry { readonly path: string; readonly top: number; readonly left: number }
interface RestoreSnapshot { scrolls: Map<string, ScrollEntry>; focusPath: string | null }

function structuralPath(element: Element, root: ParentNode): string | null {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current !== null && current !== root) {
    const parent: ParentNode | null = current.parentElement;
    if (parent === null) return null;
    const tag = current.tagName.toLowerCase();
    let index = 0;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === current) break;
      if (sibling.tagName.toLowerCase() === tag) index += 1;
    }
    segments.unshift(`${tag}:nth-of-type(${index + 1})`);
    current = current.parentElement;
  }
  return segments.length > 0 ? segments.join(" > ") : null;
}

function findByPath(root: ParentNode, path: string): Element | null {
  return root.querySelector(path);
}

function captureScrolls(root: ParentNode): Map<string, ScrollEntry> {
  const scrolls = new Map<string, ScrollEntry>();
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (element.scrollTop <= 0 && element.scrollLeft <= 0) continue;
    const path = structuralPath(element, root);
    if (path === null) continue;
    scrolls.set(path, { path, top: element.scrollTop, left: element.scrollLeft });
  }
  return scrolls;
}

export function useLocationRestore(location: AppLocation, container: ParentNode | null = null) {
  const snapshots = useRef(new Map<AppLocation, RestoreSnapshot>());
  const locationRef = useRef<AppLocation | null>(null);

  // 捕获:滚动/焦点事件持续更新当前 location 的快照(滚动后的最新位置才是要保真的)。
  useEffect(() => {
    if (container === null) return;
    const snapshotOf = (current: AppLocation): RestoreSnapshot => {
      const existing = snapshots.current.get(current);
      if (existing !== undefined) return existing;
      const created: RestoreSnapshot = { scrolls: new Map(), focusPath: null };
      snapshots.current.set(current, created);
      return created;
    };
    const onScroll = () => {
      const current = locationRef.current;
      if (current === null) return;
      const snapshot = snapshotOf(current);
      snapshot.scrolls = captureScrolls(container);
    };
    const onFocusIn = (event: Event) => {
      const current = locationRef.current;
      if (current === null) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const path = structuralPath(target, container);
      if (path === null) return;
      snapshotOf(current).focusPath = path;
    };
    container.addEventListener("scroll", onScroll, true);
    container.addEventListener("focusin", onFocusIn, true);
    return () => {
      container.removeEventListener("scroll", onScroll, true);
      container.removeEventListener("focusin", onFocusIn, true);
    };
  }, [container]);

  // 恢复:location 变化后,若重访的位置带快照,恢复滚动与焦点。
  useLayoutEffect(() => {
    const previous = locationRef.current;
    locationRef.current = location;
    if (container === null || previous === null || previous === location) return;
    const snapshot = snapshots.current.get(location);
    if (snapshot === undefined) return;
    for (const entry of snapshot.scrolls.values()) {
      const element = findByPath(container, entry.path);
      if (element === null) continue;
      element.scrollTop = entry.top;
      element.scrollLeft = entry.left;
    }
    if (snapshot.focusPath !== null) {
      const target = findByPath(container, snapshot.focusPath);
      if (target !== null && target instanceof HTMLElement) {
        try { target.focus({ preventScroll: true }); } catch (error) { consumeKnownError(error); }
      }
    }
  }, [location, container]);
}
