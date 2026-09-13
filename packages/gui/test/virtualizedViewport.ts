/**
 * happy-dom 没有布局引擎,`offsetWidth/offsetHeight` 恒为 0;@tanstack/virtual 的
 * `observeElementRect` 挂载时同步读一次真实 rect,0×0 会把窗口清空(一个组都不渲染)。
 * vitest.setup.ts 对所有 DOM 环境测试统一打这个补丁,把视口固定成显式尺寸;
 * ResizeObserver 上报前按该尺寸出首屏。窗口化测试的上界公式也用同一常量。
 */
export const HAPPY_DOM_VIEWPORT_PX = 800;

export function stubVirtualizedViewport(height: number = HAPPY_DOM_VIEWPORT_PX, width = 360): void {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => height });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => width });
}
