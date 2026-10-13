// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionConfigContext, prefersReducedMotion, useReducedMotionConfig } from "motion/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AuroraBackdrop, LiquidFilterDef } from "../src/renderer/components/GlassFoundation.tsx";
import { AppMotionConfig } from "../src/renderer/motion-config.tsx";

/**
 * S2 视觉基础的 DOM 侧:供放大层引用的 #liquid 位移滤镜 def、玻璃可见性前提的
 * 环境光层,以及 motion 库的 reducedMotion="user" 全局接线(与 CSS 侧
 * prefers-reduced-motion 全局规则同向)。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

function mount(node: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

describe("LiquidFilterDef", () => {
  it("renders a zero-size svg carrying the #liquid displacement filter", () => {
    const { container, root } = mount(createElement(LiquidFilterDef));
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("width")).toBe("0");
    expect(svg?.getAttribute("height")).toBe("0");
    expect(svg?.getAttribute("style")).toContain("position: absolute");
    const filter = svg?.querySelector("filter#liquid");
    expect(filter).not.toBeNull();
    expect(filter?.querySelector("feTurbulence")).not.toBeNull();
    expect(filter?.querySelector("feGaussianBlur")).not.toBeNull();
    expect(filter?.querySelector("feDisplacementMap")).not.toBeNull();
    act(() => root.unmount());
  });
});

describe("AuroraBackdrop", () => {
  it("renders the ambient light layer with exactly three blurred blobs", () => {
    const { container, root } = mount(createElement(AuroraBackdrop));
    const layer = container.querySelector(".aurora");
    expect(layer).not.toBeNull();
    expect(layer?.getAttribute("aria-hidden")).toBe("true");
    expect(layer?.children.length).toBe(3);
    act(() => root.unmount());
  });
});

describe("AppMotionConfig", () => {
  it("configures motion to defer to the user's reduced-motion preference", () => {
    // reducedMotion="user":系统偏好开 → 动画降级,关 → 不降级。motion 的
    // useReducedMotion 在挂载时捕获 prefersReducedMotion.current 且事后不更新
    // (上游 TODO 自认),所以两臂都用「先设状态、再挂载」验证,不做运行中翻转。
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as typeof matchMedia,
    );

    let resolved: boolean | string | null | undefined;
    let rawConfig: unknown;
    const Probe = () => {
      resolved = useReducedMotionConfig();
      rawConfig = useContext(MotionConfigContext)?.reducedMotion;
      return null;
    };
    const mountProbe = () => {
      const mounted = mount(createElement(AppMotionConfig, null, createElement(Probe)));
      act(() => mounted.root.unmount());
    };

    prefersReducedMotion.current = false;
    mountProbe();
    expect(rawConfig).toBe("user");
    expect(resolved).toBe(false);

    prefersReducedMotion.current = true;
    mountProbe();
    expect(resolved).toBe(true);

    prefersReducedMotion.current = false;
    mountProbe();
    expect(resolved).toBe(false);

    vi.unstubAllGlobals();
  });
});
