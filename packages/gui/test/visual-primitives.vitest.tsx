// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach } from "vitest";
import { prefersReducedMotion } from "motion/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AppMotionConfig } from "../src/renderer/motion-config.tsx";
import { STATUS_TONE, StatusTag, TONE_COLOR, type StatusTone } from "../src/renderer/components/primitives/StatusTag";
import { DenseRow } from "../src/renderer/components/primitives/DenseRow";
import { SegBar } from "../src/renderer/components/primitives/SegBar";
import { Region } from "../src/renderer/components/primitives/Region";
import { FocusLayer } from "../src/renderer/components/primitives/FocusLayer";
import { Drawer } from "../src/renderer/components/primitives/Drawer";
import { Section } from "../src/renderer/components/primitives/Section";
import { DayDigest } from "../src/renderer/components/primitives/DayDigest";
import { StepChain } from "../src/renderer/components/primitives/StepChain";
import { ChainStrip } from "../src/renderer/components/primitives/ChainStrip";
import { PillFlow } from "../src/renderer/components/primitives/PillFlow";
import { Tabs } from "../src/renderer/components/primitives/Tabs";
import { FilterChips } from "../src/renderer/components/primitives/FilterChips";
import { PageHeader } from "../src/renderer/components/primitives/PageHeader";
import { CloseoutBadge, STATUS_META } from "../src/renderer/components/badges";
import { initialLocale, setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 视觉基线 v1 共享原语(gui-visual-language-standard §4,dec_AF44708E CH2)的行为面:
 * 渲染结构、状态色只取 token、FocusLayer/Drawer 的键盘交互、减少动态效果时
 * 进出场无动画(motion 的 reducedMotion="user" 生效,退出即时卸载)。
 *
 * 布局动画本身需要真实合成器,happy-dom 断言不了;所有覆盖层测试统一跑在
 * 「减少动态效果」臂下,顺带验证该臂下 AnimatePresence 退出即时完成。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  prefersReducedMotion.current = false;
});

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as typeof matchMedia,
  );
  prefersReducedMotion.current = matches;
}

function mount(node: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

/** 覆盖层(FocusLayer/Drawer)的挂载:包 AppMotionConfig 并打开减少动态效果。 */
function mountOverlay(node: React.ReactNode): { container: HTMLElement; root: Root } {
  stubReducedMotion(true);
  const mounted = mount(createElement(AppMotionConfig, null, node));
  return mounted;
}

function pressKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

describe("StatusTag", () => {
  it("状态词形态取 STATUS_META 的标签与状态色 token", () => {
    const { container, root } = mount(createElement(StatusTag, { status: "done" }));
    const tag = container.querySelector("span");
    expect(tag?.textContent).toBe(STATUS_META.done.label);
    expect(tag?.getAttribute("data-status-tone")).toBe("done");
    expect(tag?.getAttribute("style")).toContain("var(--color-status-done)");
    // happy-dom 的 CSS 解析不认识 color-mix 会丢声明;静态渲染保留原始串,底色断言走它。
    expect(renderToStaticMarkup(createElement(StatusTag, { status: "done" }))).toContain(
      "background:color-mix(in oklch, var(--color-status-done) 14%, transparent)",
    );
    act(() => root.unmount());
  });

  it("tone 形态渲染自定义标签,tone 色同样只取 token", () => {
    const { container, root } = mount(createElement(StatusTag, { tone: "bad", label: "CI 失败" }));
    const tag = container.querySelector("span");
    expect(tag?.textContent).toBe("CI 失败");
    expect(tag?.getAttribute("data-status-tone")).toBe("bad");
    expect(tag?.getAttribute("style")).toContain("var(--color-status-blocked)");
    act(() => root.unmount());
  });

  it("切换语言后状态标签文字跟随当前 locale(标签读取时求值,不在模块导入时固化)", () => {
    // F-D3DBB3FB:STATUS_META 曾用对象 spread 把 label getter 在导入时求值成当期
    // locale 的字符串,切换语言后所有 StatusTag 仍显示导入时的语言。
    const localeAtImport = initialLocale();
    try {
      setActiveLocale("zh-CN");
      const zh = renderToStaticMarkup(createElement(StatusTag, { status: "active" }));
      expect(zh).toContain("活跃");
      setActiveLocale("en-US");
      const en = renderToStaticMarkup(createElement(StatusTag, { status: "active" }));
      expect(en).toContain("Active");
      expect(en).not.toContain("活跃");
    } finally {
      // 本文件其余断言按导入时 locale 写;切换不能泄漏给后续用例。
      setActiveLocale(localeAtImport);
    }
  });

  it("状态词→tone 映射符合标准 §3:待人裁决/评审中=琥珀、阻塞=红、在做=青", () => {
    expect(STATUS_TONE).toEqual({
      planned: "plan",
      active: "active",
      submitted: "wait",
      in_review: "wait",
      blocked: "bad",
      done: "done",
      cancelled: "cancel",
      unknown: "neutral",
      archived: "neutral",
    });
  });

  it("TONE_COLOR 全部是 token 引用,没有裸色值", () => {
    for (const value of Object.values(TONE_COLOR)) {
      expect(value.startsWith("var(--color-")).toBe(true);
    }
  });
});

describe("CloseoutBadge", () => {
  it("does not render outside the closeout stage, while actionable readiness remains visible", () => {
    expect(renderToStaticMarkup(createElement(CloseoutBadge, { value: "not_required" }))).toBe("");
    expect(renderToStaticMarkup(createElement(CloseoutBadge, { value: "missing" }))).toContain("Material missing");
    expect(renderToStaticMarkup(createElement(CloseoutBadge, { value: "ready" }))).toContain("Ready for archiving");
  });
});

describe("DenseRow", () => {
  it("渲染序号、标签、标题、原因与等宽时间;无序号时省掉序号列", () => {
    const { container, root } = mount(
      createElement(DenseRow, {
        index: 1,
        tag: createElement(StatusTag, { tone: "wait", label: "待裁决" }),
        title: "边缘 RBAC 设计",
        reason: "卡住 2 个任务",
        time: "3 分",
      }),
    );
    const row = container.querySelector(".grid");
    expect(row?.textContent).toContain("边缘 RBAC 设计");
    expect(row?.textContent).toContain("卡住 2 个任务");
    expect(row?.textContent).toContain("待裁决");
    // v2(标准 §3):单行条目不低于 40px、正文字号,不再压成 25px 密行。
    expect(row?.className).toContain("min-h-10");
    expect(row?.className).toContain("ui-body");
    expect(row?.className).not.toContain("h-[25px]");
    act(() => root.unmount());

    const bare = mount(createElement(DenseRow, { title: "无序号行" }));
    // 没有标签就不留标签列,行首不空出缩进。
    expect(bare.container.querySelector(".grid")?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
    act(() => bare.root.unmount());
  });

  it("宽松模式两行:原因换行成第二行,高度 56px 档", () => {
    const { container, root } = mount(
      createElement(DenseRow, { title: "T-01", reason: "三份所有权判断并成一份", relaxed: true }),
    );
    const row = container.querySelector(".grid");
    expect(row?.className).toContain("min-h-14");
    const reason = row?.querySelector("span span:nth-child(2)");
    expect(reason?.className).toContain("block");
    act(() => root.unmount());
  });

  it("带 onClick 渲染 button 并带选中态标记", () => {
    const onClick = vi.fn();
    const { container, root } = mount(createElement(DenseRow, { title: "可点行", onClick, selected: true }));
    const button = container.querySelector("button");
    expect(button?.getAttribute("data-selected")).toBe("true");
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("行根节点带 w-full:高亮/选中态撑满所在列表列宽,不随内容收缩", () => {
    // S3 移交缺陷的回归锚:行高亮曾止于内容宽度。happy-dom 无布局,断言结构保证
    // (display:grid + width:100%),真实宽度由总览 e2e 截图复核。
    const clickable = mount(createElement(DenseRow, { title: "可点行", onClick: () => undefined }));
    expect(clickable.container.querySelector("button")?.className).toContain("w-full");
    act(() => clickable.root.unmount());
    const plain = mount(createElement(DenseRow, { title: "静态行" }));
    expect(plain.container.querySelector(".grid")?.className).toContain("w-full");
    act(() => plain.root.unmount());
  });
});

describe("StepChain", () => {
  it("箭头串起状态标签,单行横滚容器;步骤标签不收缩", () => {
    const { container, root } = mount(
      createElement(StepChain, {
        steps: [
          { label: "提交", tone: "wait" as StatusTone },
          { label: "打回", tone: "bad" as StatusTone },
          { label: "复跑", tone: "active" as StatusTone },
        ],
      }),
    );
    const chain = container.querySelector('[data-testid="step-chain"]')!;
    expect(chain.className).toContain("overflow-x-auto");
    expect(chain.className).toContain("chain-strip");
    expect(chain.className).not.toContain("flex-wrap");
    const tags = [...chain.querySelectorAll("[data-status-tone]")];
    expect(tags.map((tag) => tag.textContent)).toEqual(["提交", "打回", "复跑"]);
    // 标签与箭头都不被压缩:溢出由滚动承担,不是把内容挤碎。
    expect(tags[0]!.className).toContain("shrink-0");
    expect([...chain.querySelectorAll("span")].filter((node) => node.textContent === "→")).toHaveLength(2);
    act(() => root.unmount());
  });

  it("空序列渲染 null:不留空的步骤列", () => {
    const { container, root } = mount(createElement(StepChain, { steps: [] }));
    expect(container.querySelector('[data-testid="step-chain"]')).toBeNull();
    act(() => root.unmount());
  });
});

describe("ChainStrip", () => {
  /** happy-dom 无布局:溢出态经假 ResizeObserver + mock scrollWidth 驱动,几何本身在 Electron e2e 验。 */
  function installFakeResizeObserver() {
    const instances: { callback: ResizeObserverCallback }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          instances.push({ callback });
        }
        observe() {}
        disconnect() {}
      },
    );
    return {
      fire: () => instances.at(-1)?.callback([], {} as ResizeObserver),
    };
  }

  function stubOverflow(el: HTMLElement, scrollWidth: number, clientWidth: number) {
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
  }

  it("不溢出时不进 tab 序、不出溢出提示,滚动区带语义角色", () => {
    const { container, root } = mount(createElement(ChainStrip, { label: "进展步骤链" }, "短链"));
    const strip = container.querySelector("[data-chain-scroll]")!;
    expect(strip.getAttribute("role")).toBe("group");
    expect(strip.getAttribute("aria-label")).toBe("进展步骤链");
    expect(strip.getAttribute("tabindex")).toBeNull();
    expect(container.querySelector("[data-chain-hint]")).toBeNull();
    act(() => root.unmount());
  });

  it("溢出时变为原生可焦点 scroll region 并给右缘可见溢出提示", () => {
    const ro = installFakeResizeObserver();
    const { container, root } = mount(createElement(ChainStrip, { label: "继承组链" }, "长链"));
    const strip = container.querySelector("[data-chain-scroll]")! as HTMLSpanElement;
    stubOverflow(strip, 800, 300);
    act(() => ro.fire());
    expect(strip.getAttribute("tabindex")).toBe("0");
    const hint = container.querySelector("[data-chain-hint]")!;
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    // 回落为不溢出:tab 序与提示一起撤掉,短链不增加键盘噪音。
    stubOverflow(strip, 200, 300);
    act(() => ro.fire());
    expect(strip.getAttribute("tabindex")).toBeNull();
    expect(container.querySelector("[data-chain-hint]")).toBeNull();
    act(() => root.unmount());
  });

  it("聚焦链上方向键/Home/End 显式平移:Chromium 不保证焦点滚动区默认平移", () => {
    const ro = installFakeResizeObserver();
    const { container, root } = mount(createElement(ChainStrip, { label: "进展步骤链" }, "长链"));
    const strip = container.querySelector("[data-chain-scroll]")! as HTMLSpanElement;
    stubOverflow(strip, 900, 300);
    act(() => ro.fire());
    const scrollBy = vi.fn();
    const scrollTo = vi.fn();
    strip.scrollBy = scrollBy;
    strip.scrollTo = scrollTo;
    const press = (key: string) =>
      act(() => {
        strip.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    press("ArrowRight");
    press("ArrowLeft");
    press("Home");
    press("End");
    expect(scrollBy).toHaveBeenCalledWith({ left: 40 });
    expect(scrollBy).toHaveBeenCalledWith({ left: -40 });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0 });
    expect(scrollTo).toHaveBeenCalledWith({ left: 900 });
    // 未承接的键不拦截(不 preventDefault)。
    const other = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    act(() => strip.dispatchEvent(other));
    expect(other.defaultPrevented).toBe(false);
    act(() => root.unmount());
  });
});

describe("SegBar", () => {
  it("分段宽度按任务数、颜色按状态构成取 token", () => {
    const { container, root } = mount(createElement(SegBar, { counts: { done: 3, active: 1, cancelled: 0 } }));
    const segments = [...container.querySelectorAll("span")];
    expect(segments).toHaveLength(2);
    expect(segments[0]?.getAttribute("data-segment")).toBe("done");
    expect(segments[0]?.getAttribute("style")).toContain("width: 75%");
    expect(segments[0]?.getAttribute("style")).toContain("var(--color-status-done)");
    expect(segments[1]?.getAttribute("style")).toContain("var(--color-status-active)");
    act(() => root.unmount());
  });

  it("全部为零时不出分段", () => {
    const { container, root } = mount(createElement(SegBar, { counts: { done: 0, planned: 0 } }));
    expect(container.querySelector("span")).toBeNull();
    act(() => root.unmount());
  });
});

describe("Region", () => {
  it("玻璃面板 + 状态竖线 + 标题行(标题、状态标签、大数字)与页脚", () => {
    const { container, root } = mount(
      createElement(
        Region,
        {
          title: "等我处理",
          tag: createElement(StatusTag, { tone: "bad", label: "1 件急" }),
          big: 3,
          bigTone: "bad",
          edge: "bad",
          footer: "按注意力排序",
        },
        createElement("div", null, "行一"),
      ),
    );
    const section = container.querySelector("section");
    expect(section?.className).toContain("glass");
    expect(section?.className).toContain("status-edge");
    expect(section?.getAttribute("style")).toContain("--status-edge: var(--color-status-blocked)");
    expect(container.querySelector("h2")?.textContent).toBe("等我处理");
    expect(container.textContent).toContain("1 件急");
    const big = [...container.querySelectorAll("span")].find((node) => node.textContent === "3");
    expect(big?.getAttribute("style")).toContain("var(--color-status-blocked)");
    expect(container.textContent).toContain("按注意力排序");
    act(() => root.unmount());
  });

  it("内容溢出时保留全部行并在区域内部滚动,不显示「+N 条」", () => {
    const { container, root } = mount(
      createElement(
        Region,
        { title: "执行中" },
        createElement("div", { key: "a" }, "行一"),
        createElement("div", { key: "b" }, "行二"),
        createElement("div", { key: "c" }, "行三"),
      ),
    );
    expect(container.textContent).not.toContain("+2");
    expect(container.querySelector("section > div:nth-child(2) > div")?.className).toContain("overflow-y-auto");
    expect(container.querySelector("section > div:nth-child(2) > div")?.className).not.toContain("px-3.5");
    const rows = [...container.querySelectorAll("section div")].filter((node) =>
      /^行[一二三]$/u.test(node.textContent ?? ""),
    );
    expect(rows.map((row) => (row as HTMLElement).style.visibility)).toEqual(["", "", ""]);
    act(() => root.unmount());

    // padded 给正文、文档、按天进展留出与行同宽的边距(默认行体贴框,DenseRow 自带边距)。
    const padded = mount(createElement(Region, { title: "任务计划", padded: true }, createElement("p", null, "正文")));
    const body = padded.container.querySelector("section > div:nth-child(2) > div")!;
    expect(body.className).toContain("px-3.5");
    expect(body.className).toContain("overflow-y-auto");
    act(() => padded.root.unmount());

    const empty = mount(createElement(Region, { title: "空区域" }, "一句话"));
    // 单个文本子节点不是 Element,children 里没有可计数的行 → 不出 +N。
    expect(empty.container.textContent).not.toContain("条");
    act(() => empty.root.unmount());
  });
});

describe("FocusLayer", () => {
  const base = {
    open: true,
    sourceId: "region-mine",
    title: "等我处理",
    itemIds: ["a", "b", "c"],
    selectedId: "a",
    onSelect: () => undefined,
    onClose: () => undefined,
    list: createElement("div", null, "左列表"),
    detail: createElement("div", null, "右详情"),
  };

  it("打开时渲染 scrim、左列表与右详情;关闭时不渲染", () => {
    const { container, root } = mountOverlay(createElement(FocusLayer, base));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector("[data-focus-list]")?.textContent).toBe("左列表");
    expect(document.body.querySelector("[data-focus-detail]")?.textContent).toBe("右详情");
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("等我处理");
    act(() => root.unmount());

    const closed = mountOverlay(createElement(FocusLayer, { ...base, open: false }));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    act(() => closed.root.unmount());
  });

  it("左列表是纵向 flex 列:直接子行被默认拉伸撑满列宽(S3 移交缺陷的结构保证)", () => {
    const { root } = mountOverlay(createElement(FocusLayer, base));
    const list = document.body.querySelector("[data-focus-list]");
    expect(list?.className).toContain("flex");
    expect(list?.className).toContain("flex-col");
    act(() => root.unmount());
  });

  it("Esc 与点 scrim 收回", () => {
    const onClose = vi.fn();
    const { root } = mountOverlay(createElement(FocusLayer, { ...base, onClose }));
    pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      (document.body.querySelector(".glass-scrim") as HTMLElement).click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it("↑↓ 在列表中按序移动选中,边界收敛", () => {
    const calls: string[] = [];
    const track = (id: string) => calls.push(id);
    let selectedId: string | null = "a";
    const { root } = mountOverlay(createElement(FocusLayer, { ...base, selectedId, onSelect: track }));
    const rerender = () =>
      act(() =>
        root.render(
          createElement(AppMotionConfig, null, createElement(FocusLayer, { ...base, selectedId, onSelect: track })),
        ),
      );
    pressKey("ArrowDown");
    expect(calls).toEqual(["b"]);
    selectedId = "b";
    rerender();
    pressKey("ArrowUp");
    expect(calls).toEqual(["b", "a"]);
    selectedId = "a";
    rerender();
    // 已在首位:夹紧后与当前选中相同,不派发。
    pressKey("ArrowUp");
    expect(calls).toEqual(["b", "a"]);
    act(() => root.unmount());
  });

  it("only keyboard selection scrolls the committed row; refreshed data leaves user scroll alone", () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    let selectedId = "a";
    const props = () => ({
      ...base,
      selectedId,
      itemIds: [...base.itemIds],
      onSelect: (id: string) => {
        selectedId = id;
      },
      list: createElement(
        "div",
        null,
        ...base.itemIds.map((id) =>
          createElement("div", { key: id, "data-selected": id === selectedId || undefined }, id),
        ),
      ),
    });
    const { root } = mountOverlay(createElement(FocusLayer, props()));
    const refresh = () =>
      act(() => root.render(createElement(AppMotionConfig, null, createElement(FocusLayer, props()))));
    expect(scroll).not.toHaveBeenCalled();
    pressKey("ArrowDown");
    refresh();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.instances[0]?.textContent).toBe("b");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest", behavior: "instant" });
    refresh();
    selectedId = "c"; // Data reconciliation is not a keyboard navigation request.
    refresh();
    expect(scroll).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    scroll.mockRestore();
  });

  it("无选中时 ↓ 从第一项开始", () => {
    const onSelect = vi.fn();
    const { root } = mountOverlay(createElement(FocusLayer, { ...base, selectedId: null, onSelect }));
    pressKey("ArrowDown");
    expect(onSelect).toHaveBeenCalledWith("a");
    act(() => root.unmount());
  });

  it("关闭后随 AnimatePresence 即时卸载(减少动态效果:退出无动画)", async () => {
    const { root } = mountOverlay(createElement(FocusLayer, base));
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      root.render(createElement(AppMotionConfig, null, createElement(FocusLayer, { ...base, open: false })));
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector(".glass-scrim")).toBeNull();
    act(() => root.unmount());
  });
});

describe("Drawer", () => {
  it("模态:scrim 点击与 Esc 都关闭,内容在面板里", () => {
    const onClose = vi.fn();
    const { container, root } = mountOverlay(
      createElement(Drawer, { open: true, onClose, ariaLabel: "任务详情" }, createElement("p", null, "详情内容")),
    );
    const panel = container.querySelector("aside");
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    expect(panel?.textContent).toContain("详情内容");
    act(() => {
      (container.querySelector(".glass-scrim") as HTMLElement).click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    pressKey("Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it("非模态:压暗层不接指针事件,点外面关闭、点里面不关", () => {
    const onClose = vi.fn();
    const { container, root } = mountOverlay(
      createElement(Drawer, { open: true, onClose, modal: false }, createElement("h2", null, "标题")),
    );
    const backdrop = container.querySelector('[data-testid="drawer-backdrop"]') as HTMLElement;
    expect(backdrop.className).toContain("pointer-events-none");
    const panel = container.querySelector("aside") as HTMLElement;
    expect(panel.className).toContain("pointer-events-auto");
    expect(container.querySelector(".glass-scrim")).toBeNull();
    act(() => {
      panel.querySelector("h2")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    const outside = document.createElement("div");
    document.body.append(outside);
    act(() => {
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("关闭后即时卸载(减少动态效果:退出无动画)", async () => {
    const { container, root } = mountOverlay(createElement(Drawer, { open: true, onClose: () => undefined }, "内容"));
    expect(container.querySelector("aside")).not.toBeNull();
    await act(async () => {
      root.render(
        createElement(AppMotionConfig, null, createElement(Drawer, { open: false, onClose: () => undefined }, "内容")),
      );
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(container.querySelector("aside")).toBeNull();
    act(() => root.unmount());
  });
});

describe("Section", () => {
  it("默认区块:标题、计数、说明、右侧动作", () => {
    const { container, root } = mount(
      createElement(
        Section,
        {
          title: "最近进展",
          count: 12,
          note: "按天归并",
          action: createElement("button", { type: "button" }, "全部进展"),
        },
        createElement("div", null, "内容"),
      ),
    );
    expect(container.querySelector("h2")?.textContent).toBe("最近进展");
    expect(container.textContent).toContain("12");
    expect(container.textContent).toContain("按天归并");
    expect(container.querySelector("button")?.textContent).toBe("全部进展");
    act(() => root.unmount());
  });

  it("hero 用琥珀左粗边、warn 用红左粗边,颜色取 token", () => {
    const hero = mount(createElement(Section, { title: "等你裁决", count: 2, variant: "hero" }, "内容"));
    const heroSection = hero.container.querySelector("section");
    expect(heroSection?.getAttribute("style")).toContain("var(--color-status-submitted)");
    expect(heroSection?.className).toContain("border-l-[3px]");
    act(() => hero.root.unmount());

    const warn = mount(createElement(Section, { title: "没有 agent 在跑", variant: "warn" }, "内容"));
    expect(warn.container.querySelector("section")?.getAttribute("style")).toContain("var(--color-status-blocked)");
    act(() => warn.root.unmount());
  });
});

describe("DayDigest", () => {
  const paths = [
    {
      time: "19:49",
      name: "T-06 回归锚换真实输入",
      steps: [
        { label: "提交", tone: "wait" as StatusTone },
        { label: "#3083 合入", tone: "done" },
      ],
    },
    { time: "19:27", name: "worktree 缺 dist", steps: [{ label: "没有 agent 在跑", tone: "bad" }] },
  ];

  it("默认收起,点开显示每个任务一行的路径,StatusTag 用箭头串起", () => {
    const { container, root } = mount(createElement(DayDigest, { day: "今天", summary: "完成 5 个任务", paths }));
    expect(container.textContent).not.toContain("T-06 回归锚换真实输入");
    act(() => {
      (container.querySelector("button") as HTMLElement).click();
    });
    expect(container.textContent).toContain("T-06 回归锚换真实输入");
    expect(container.textContent).toContain("#3083 合入");
    expect(container.textContent).toContain("→");
    const tags = [...container.querySelectorAll("[data-status-tone]")];
    expect(tags.map((tag) => tag.getAttribute("data-status-tone"))).toEqual(["wait", "done", "bad"]);
    act(() => root.unmount());
  });

  it("defaultOpen 直接展开;路径可点", () => {
    const onClick = vi.fn();
    const { container, root } = mount(
      createElement(DayDigest, { day: "昨天", summary: "收口", paths: [{ ...paths[0]!, onClick }], defaultOpen: true }),
    );
    expect(container.textContent).toContain("#3083 合入");
    const pathButton = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("T-06"));
    act(() => pathButton?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("没有步骤的路径名字占满整行;有步骤时才给步骤列留宽", () => {
    const { container, root } = mount(
      createElement(DayDigest, {
        day: "今天",
        summary: "2 条记录",
        defaultOpen: true,
        paths: [{ time: "10:20", name: "Review review-w3: approved", steps: [] }, paths[1]!],
      }),
    );
    // 名字在标题组 span 里(窄容器断点用),按 truncate 类圈定而不数层级。
    const names = [...container.querySelectorAll("[data-day] span.truncate")];
    expect(names.map((name) => name.textContent)).toEqual(["Review review-w3: approved", "worktree 缺 dist"]);
    expect(names[0]!.className).toContain("flex-1");
    expect(names[0]!.className).not.toContain("max-w-[48%]");
    expect(names[1]!.className).toContain("max-w-[48%]");
    act(() => root.unmount());
  });

  it("步骤链单行组件内横滚:不换行不撑高行,时间不拆行;空步骤不渲染链", () => {
    const { container, root } = mount(
      createElement(DayDigest, {
        day: "今天",
        summary: "2 条记录",
        defaultOpen: true,
        paths: [
          {
            time: "13:17",
            name: "循环打回的长链",
            steps: Array.from({ length: 12 }, (_, index) =>
              index % 2 === 0
                ? { label: "提交", tone: "wait" as StatusTone }
                : { label: "打回", tone: "bad" as StatusTone },
            ),
          },
          { time: "09:40", name: "无步骤记录", steps: [] },
        ],
      }),
    );
    const chains = [...container.querySelectorAll('[data-testid="step-chain"]')];
    expect(chains).toHaveLength(1);
    const chain = chains[0]!;
    // 单行横滚契约:横向滚动容器,永不换行(flex-wrap 已删);箭头不收缩;
    // 滚动区语义角色带链全文,键盘聚焦时可朗读(溢出/平移几何在 Electron e2e 验)。
    expect(chain.className).toContain("overflow-x-auto");
    expect(chain.className).not.toContain("flex-wrap");
    expect(chain.getAttribute("role")).toBe("group");
    expect(chain.getAttribute("aria-label")).toContain("提交");
    expect(chain.querySelectorAll("[data-status-tone]")).toHaveLength(12);
    const arrows = [...chain.querySelectorAll("span")].filter((node) => node.textContent === "→");
    expect(arrows).toHaveLength(11);
    expect(arrows[0]!.className).toContain("flex-none");
    // 空步骤的路径不出链元素;时间列不拆行。
    expect(container.querySelectorAll('[data-testid="step-chain"]')).toHaveLength(1);
    const time = [...container.querySelectorAll("[data-day] span")].find((node) => node.textContent === "13:17");
    expect(time?.className).toContain("whitespace-nowrap");
    act(() => root.unmount());
  });

  it("窄容器(<32rem)标题与状态链转上下两行:行转纵向,标题组现形,名字放开限宽", () => {
    const { container, root } = mount(
      createElement(DayDigest, {
        day: "今天",
        summary: "1 条记录",
        defaultOpen: true,
        paths: [
          { time: "13:17", name: "窄面板里的长标题任务", steps: [{ label: "提交", tone: "wait" as StatusTone }] },
        ],
      }),
    );
    const day = container.querySelector("[data-day]")!;
    // 断点量的是天块自身宽度(@container),不是页面宽。
    expect(day.className).toContain("@container");
    // main 是片段,链经 ChainStrip 外层容器落在行里(无 onClick 时行是纯 div)。
    const chain = day.querySelector('[data-testid="step-chain"]')!;
    const row = chain.parentElement!.parentElement!;
    expect(row.className).toContain("@max-[32rem]:flex-col");
    const titleCell = row.querySelector("span.contents")!;
    expect(titleCell.className).toContain("@max-[32rem]:flex");
    const name = row.querySelector("span.truncate")!;
    expect(name.className).toContain("@max-[32rem]:max-w-none");
    act(() => root.unmount());
  });

  it("带结构化 recordRef 的行尾编号是实体链接(原生 button),点击带出 canonical 引用;缺省仍是纯文本", () => {
    const onOpenRecord = vi.fn();
    const { container, root } = mount(
      createElement(DayDigest, {
        day: "今天",
        summary: "2 条记录",
        defaultOpen: true,
        paths: [
          {
            time: "10:00",
            name: "开始执行",
            steps: [],
            ref: "execution-w3",
            recordRef: "execution/execution-w3",
            onOpenRecord,
          },
          { time: "10:20", name: "手写关键记录", steps: [], ref: "legacy-note" },
        ],
      }),
    );
    const tails = [...container.querySelectorAll<HTMLElement>("[data-day] span, [data-day] button")].filter(
      (node) => node.textContent === "execution-w3" || node.textContent === "legacy-note",
    );
    expect(tails.map((tail) => tail.tagName)).toEqual(["BUTTON", "SPAN"]);
    act(() => {
      (tails[0] as HTMLButtonElement).click();
    });
    expect(onOpenRecord).toHaveBeenCalledTimes(1);
    expect(onOpenRecord).toHaveBeenCalledWith("execution/execution-w3");
    act(() => root.unmount());
  });

  it("行可点且行尾也是实体链接时,不产生嵌套 button:两个动作各自是原生按钮", () => {
    const onOpenRecord = vi.fn();
    const onClick = vi.fn();
    const { container, root } = mount(
      createElement(DayDigest, {
        day: "今天",
        summary: "1 条记录",
        defaultOpen: true,
        paths: [
          {
            time: "10:00",
            name: "开始执行",
            steps: [],
            ref: "execution-w3",
            recordRef: "execution/execution-w3",
            onOpenRecord,
            onClick,
          },
        ],
      }),
    );
    // 行本身不再是 button(嵌套 button 是非法 HTML);主文字与行尾编号各自可点。
    // 圈定在路径容器([data-day] 的内层 div)里,天切换钮不在其中。
    const rowButtons = [...container.querySelectorAll<HTMLButtonElement>("[data-day] > div button")];
    expect(rowButtons).toHaveLength(2);
    expect(rowButtons.every((button) => button.closest("button") === button)).toBe(true);
    act(() => {
      rowButtons[0]!.click();
      rowButtons[1]!.click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onOpenRecord).toHaveBeenCalledWith("execution/execution-w3");
    act(() => root.unmount());
  });
});

describe("PillFlow", () => {
  it("渲染标签流,置顶带标记,可点项为 button", () => {
    const onClick = vi.fn();
    const { container, root } = mount(
      createElement(PillFlow, {
        items: [
          { label: "R-01 测试 runner 收窄环境", pinned: true },
          { label: "R-02 交棒先确认后继者", onClick },
          { label: "R-03 dispatch 流读取不随历史增长" },
        ],
      }),
    );
    const pills = [...container.querySelectorAll("span, button")].filter((node) => node.textContent?.includes("R-"));
    expect(pills).toHaveLength(3);
    expect(container.textContent).toContain("●");
    const button = container.querySelector("button");
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});

describe("Tabs", () => {
  it("下划线式:aria-selected、计数徽标与提示徽标,点击切换", () => {
    const onChange = vi.fn();
    const { container, root } = mount(
      createElement(Tabs, {
        ariaLabel: "工作分区",
        idPrefix: "workspace",
        value: "overview",
        onChange,
        tabs: [
          { key: "overview", label: "概况" },
          { key: "tasks", label: "任务", count: 7 },
          { key: "review", label: "评审", hint: "2 待你" },
        ],
      }),
    );
    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("role")).toBe("tablist");
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs[0]?.id).toBe("workspace-tab-overview");
    expect(tabs[0]?.getAttribute("aria-controls")).toBe("workspace-panel");
    expect(tabs[1]?.textContent).toContain("7");
    expect(tabs[2]?.textContent).toContain("2 待你");
    act(() => {
      (tabs[2] as HTMLElement).click();
    });
    expect(onChange).toHaveBeenCalledWith("review");
    act(() => root.unmount());
  });
});

describe("FilterChips", () => {
  it("每个带计数,选中态为青色(accent),点击切换", () => {
    const onChange = vi.fn();
    const { container, root } = mount(
      createElement(FilterChips, {
        value: "all",
        onChange,
        chips: [
          { key: "all", label: "全部", count: 9 },
          { key: "submitted", label: "待裁决", count: 2 },
        ],
      }),
    );
    const chips = [...container.querySelectorAll("button")];
    expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(chips[0]?.className).toContain("border-accent");
    expect(chips[1]?.textContent).toContain("2");
    act(() => {
      chips[1]?.click();
    });
    expect(onChange).toHaveBeenCalledWith("submitted");
    act(() => root.unmount());
  });
});

describe("PageHeader", () => {
  it("一行页头:页名 + 人话结论(弱色)+ 等宽计数,右侧动作靠右", () => {
    const { container, root } = mount(
      createElement(PageHeader, {
        title: "议程",
        note: "现在该你推进哪几件事",
        meta: "4/9",
        actions: createElement("button", { type: "button" }, "新建"),
        testId: "page-header",
      }),
    );
    const header = container.querySelector("header");
    expect(header?.getAttribute("data-testid")).toBe("page-header");
    expect(container.querySelector("h1")?.textContent).toBe("议程");
    expect(container.querySelector("h1")?.className).toContain("text-xl");
    const spans = [...container.querySelectorAll("header > span")];
    expect(spans[0]?.className).toContain("text-text-muted");
    expect(spans[1]?.className).toContain("font-mono");
    const actions = container.querySelector("header > div");
    expect(actions?.className).toContain("ml-auto");
    expect(actions?.textContent).toBe("新建");
    act(() => root.unmount());
  });

  it("页头是裸行:不带边框、面板底色或玻璃(评审第 7 条:08/11/12/15 各不相同)", () => {
    const { container, root } = mount(createElement(PageHeader, { title: "会话" }));
    const header = container.querySelector("header");
    expect(header?.className).not.toContain("border");
    expect(header?.className).not.toContain("bg-");
    expect(header?.className).not.toContain("glass");
    act(() => root.unmount());
  });
});
