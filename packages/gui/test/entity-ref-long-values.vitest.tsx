// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EntityRefLink } from "../src/renderer/components/EntityRefLink.tsx";
import { IdText } from "../src/renderer/components/IdText.tsx";
import { DayDigest } from "../src/renderer/components/primitives/DayDigest.tsx";

/**
 * 长值展示契约(GUI 视觉规范 v2 §4.1,任务 3a 首个垂直切片):
 * 截断/收缩是组件内部的默认,className 叠加视觉但抹不掉布局约束;
 * 收束显示(children)不丢完整值(title);无导航落点的长值走展示叶 IdText,
 * 与 EntityRefLink 共用排版。jsdom/happy-dom 不做真实布局——溢出的最终裁决
 * 是 Electron 窄宽容器截图;这里锁定的是布局类契约与行为出口。
 */

const LONG_ID = "review_9f2c7a41d8e6b35098ab7c2f1e4d5a6b";
const LONG_REF = `review/${LONG_ID}`;
const LONG_REASON =
  "评审发现收口证据不完整:gate witness 的 receiptId 与 execution 输出对不上," +
  "且路径清单里混入了不属于本切片的私有台账路径,要求补齐后重审。".repeat(4);

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

const mounted: { root: Root; container: HTMLElement }[] = [];

function mount(node: React.ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(node));
  return container;
}

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

describe("EntityRefLink:布局约束内聚(标准 §4.1 C1)", () => {
  it("默认渲染即带截断/收缩布局(mono 链接档)", () => {
    const container = mount(createElement(EntityRefLink, { entityRef: LONG_REF, onNavigate: () => undefined }));
    const link = container.querySelector("button");
    expect(link).not.toBeNull();
    expect(link!.className).toContain("truncate");
    expect(link!.className).toContain("min-w-0");
    expect(link!.className).toContain("font-mono");
    expect(link!.textContent).toBe(LONG_REF);
    expect(link!.getAttribute("title")).toBe(LONG_REF);
  });

  it("调用方传 className 抹不掉截断/收缩(只叠加视觉)", () => {
    const container = mount(
      createElement(EntityRefLink, {
        entityRef: LONG_REF,
        onNavigate: () => undefined,
        className: "text-text-faint hover:text-accent",
      }),
    );
    const link = container.querySelector("button");
    expect(link!.className).toContain("truncate");
    expect(link!.className).toContain("min-w-0");
    expect(link!.className).toContain("text-text-faint");
  });

  it("children 收束显示时 title 仍保留完整引用", () => {
    const container = mount(
      createElement(EntityRefLink, { entityRef: LONG_REF, onNavigate: () => undefined }, "评审记录"),
    );
    const link = container.querySelector("button")!;
    expect(link.textContent).toBe("评审记录");
    expect(link.getAttribute("title")).toBe(LONG_REF);
  });

  it("键盘可达:原生 button,Enter 触发导航出口并带出完整 ref", () => {
    const navigated: string[] = [];
    const container = mount(
      createElement(EntityRefLink, { entityRef: LONG_REF, onNavigate: (ref) => navigated.push(ref) }),
    );
    const link = container.querySelector<HTMLButtonElement>("button")!;
    act(() => {
      link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      link.click();
    });
    expect(navigated).toEqual([LONG_REF]);
  });
});

describe("IdText:无导航落点的长值展示叶(标准 §4.1 C2)", () => {
  it("默认即截断 + 悬停完整值 + mono 排版,不渲染成按钮", () => {
    const container = mount(createElement(IdText, { value: LONG_ID }));
    const leaf = container.querySelector("span");
    expect(leaf).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(leaf!.className).toContain("truncate");
    expect(leaf!.className).toContain("min-w-0");
    expect(leaf!.className).toContain("font-mono");
    expect(leaf!.getAttribute("title")).toBe(LONG_ID);
    expect(leaf!.textContent).toBe(LONG_ID);
  });

  it("className 叠加视觉但抹不掉截断/收缩", () => {
    const container = mount(createElement(IdText, { value: LONG_ID, className: "text-text-muted" }));
    const leaf = container.querySelector("span")!;
    expect(leaf.className).toContain("truncate");
    expect(leaf.className).toContain("min-w-0");
    expect(leaf.className).toContain("text-text-muted");
  });

  it("与 EntityRefLink 共用同一份排版常量,不另立第二套", () => {
    const container = mount(
      createElement(
        "p",
        null,
        createElement(IdText, { value: LONG_ID }),
        createElement(EntityRefLink, { entityRef: LONG_REF, onNavigate: () => undefined, className: "" }),
      ),
    );
    const [leaf, link] = [...container.querySelectorAll("span,button")];
    expect(leaf.className).toContain("font-mono ui-micro");
    expect(link.className).toContain("min-w-0 max-w-full truncate");
  });
});

describe("DayDigest 行尾编号:同一落点在不同宽度容器共用截断实现", () => {
  const paths = (recordRef?: string, onOpenRecord?: (ref: string) => void) => [
    {
      name: "长标题任务行",
      steps: [{ label: "进行中", tone: "run" as const }],
      ref: LONG_ID,
      ...(recordRef !== undefined ? { recordRef } : {}),
      ...(onOpenRecord !== undefined ? { onOpenRecord } : {}),
    },
  ];

  it("有结构化落点:编号经 EntityRefLink 渲染成可激活路径,导航语义不被截断丢失", () => {
    const navigated: string[] = [];
    const container = mount(
      createElement(DayDigest, {
        day: "10-02",
        summary: "一句摘要",
        defaultOpen: true,
        paths: paths(LONG_REF, (ref) => navigated.push(ref)),
      }),
    );
    // 展开区里的行尾编号:无 onClick 的路径行,链接是行内可激活 button。
    const refLink = [...container.querySelectorAll("button")].find((button) => button.textContent === LONG_ID);
    expect(refLink).toBeDefined();
    expect(refLink!.className).toContain("truncate");
    act(() => refLink!.click());
    expect(navigated).toEqual([LONG_REF]);
  });

  it("无结构化落点:编号走 IdText 展示叶,悬停完整值", () => {
    const container = mount(
      createElement(DayDigest, { day: "10-02", summary: "一句摘要", defaultOpen: true, paths: paths() }),
    );
    const leaf = [...container.querySelectorAll("span")].find((span) => span.textContent === LONG_ID);
    expect(leaf).toBeDefined();
    expect(leaf!.className).toContain("truncate");
    expect(leaf!.getAttribute("title")).toBe(LONG_ID);
  });
});

describe("长正文容器(标准 §4.1 C3):正文 break-words 由容器统一承担", () => {
  it("AuditRow 长正文留在自身列:词内换行,不用固定 rem 列宽挤 ID 列", async () => {
    // TaskCloseoutTab 依赖 react-query 与任务数据模型,收口行布局以组件树实挂验证;
    // 这里用动态 import 避免fast tier 拖入集成夹具。
    const { TaskCloseoutTab } = await import("../src/renderer/components/taskDetail/TaskCloseoutTab.tsx");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const task = {
      taskId: "task_probe_long_review",
      title: "长评审文本探针",
      coordinationStatus: "in_review",
      closeoutReadiness: "incomplete",
      reviews: [
        { reviewId: LONG_ID, verdict: "returned", reason: LONG_REASON, reviewedAt: "2026-10-02T00:00:00.000Z" },
      ],
      consents: [],
      codeDocWitnesses: [],
      gateWitnesses: [],
      gates: [],
      capabilities: [],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = mount(
      createElement(QueryClientProvider, { client }, createElement(TaskCloseoutTab, { task: task as never })),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const row = container.querySelector('[id^="closeout-record-review-"]');
    expect(row).not.toBeNull();
    // ID 列:截断 + 悬停完整值(展示叶),不再裸排固定 11rem 列。
    const idLeaf = row!.querySelector("span[title]");
    expect(idLeaf!.getAttribute("title")).toBe(LONG_ID);
    expect(idLeaf!.className).toContain("truncate");
    // 正文列:长评审文本留在自身列,词内换行。
    const body = [...row!.querySelectorAll("p")].find((p) => p.textContent === LONG_REASON);
    expect(body).toBeDefined();
    expect(body!.className).toContain("break-words");
    expect(body!.className).toContain("min-w-0");
    // 列模板:自适应 minmax,不再有写死的 11rem/9rem。
    expect(row!.className).not.toContain("11rem");
    expect(row!.className).not.toContain("9rem");
    expect(row!.className).toContain("minmax(0,");
  });
});
