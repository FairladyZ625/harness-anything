// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EntityRefLink } from "../src/renderer/components/EntityRefLink.tsx";
import { IdText } from "../src/renderer/components/IdText.tsx";
import { DayDigest } from "../src/renderer/components/primitives/DayDigest.tsx";
import { RecordRow } from "../src/renderer/components/primitives/RecordRow.tsx";

/**
 * 长值展示契约(GUI 视觉规范 v2 §4.1,任务 3a 首个垂直切片):
 * 截断/收缩以**内联样式**落在组件内部——CSS 优先级高于任何调用方 class,
 * 同层 utility(whitespace-normal/overflow-visible/max-w-none)覆盖不了它;
 * className 断言没有分辨力,这里断言的是 style 属性与敌意类共存后的幸存。
 * 自定义 title 只作前缀,完整引用始终可达。happy-dom 不做真实布局——级联与
 * 窄容器溢出的最终裁决在 Electron 场景(task-closeout-long-values)的真实
 * Chromium computed-style 与容器测量;这里锁定 DOM 契约与行为出口。
 */

const LONG_ID = "review_9f2c7a41d8e6b35098ab7c2f1e4d5a6b";
const LONG_REF = `review/${LONG_ID}`;
const LONG_REASON =
  "评审发现收口证据不完整:gate witness 的 receiptId 与 execution 输出对不上," +
  "且路径清单里混入了不属于本切片的私有台账路径,要求补齐后重审。".repeat(4);
/** 敌意视觉类:与截断布局同层的 utility,修复前能直接覆盖核心约束。 */
const HOSTILE_CLASSES = "whitespace-normal overflow-visible max-w-none text-text-faint";

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

/** 截断/收缩的内联布局基:两片叶子(EntityRefLink/IdText)共用的同一份。 */
function expectRefLayoutHeld(node: HTMLElement) {
  expect(node.style.minWidth, "minWidth 内联").toBe("0");
  expect(node.style.maxWidth, "maxWidth 内联").toBe("100%");
  expect(node.style.overflow, "overflow 内联").toBe("hidden");
  expect(node.style.textOverflow, "textOverflow 内联").toBe("ellipsis");
  expect(node.style.whiteSpace, "whiteSpace 内联").toBe("nowrap");
}

describe("EntityRefLink:布局约束内联隔离(标准 §4.1 C1)", () => {
  it("默认渲染即带内联截断/收缩布局(mono 链接档),不再依赖 class 字符串", () => {
    const container = mount(createElement(EntityRefLink, { entityRef: LONG_REF, onNavigate: () => undefined }));
    const link = container.querySelector("button");
    expect(link).not.toBeNull();
    expectRefLayoutHeld(link!);
    expect(link!.className).toContain("font-mono");
    expect(link!.textContent).toBe(LONG_REF);
    expect(link!.getAttribute("title")).toBe(LONG_REF);
  });

  it("敌意同层 utility 类(whitespace-normal/overflow-visible/max-w-none)抹不掉截断", () => {
    const container = mount(
      createElement(EntityRefLink, {
        entityRef: LONG_REF,
        onNavigate: () => undefined,
        className: HOSTILE_CLASSES,
      }),
    );
    const link = container.querySelector("button")!;
    // 敌意类确实被挂上(证明用例真的注入了威胁面),但内联布局原样幸存。
    expect(link.className).toContain("whitespace-normal");
    expect(link.className).toContain("overflow-visible");
    expect(link.className).toContain("max-w-none");
    expectRefLayoutHeld(link);
  });

  it("children 收束显示时 title 仍保留完整引用", () => {
    const container = mount(
      createElement(EntityRefLink, { entityRef: LONG_REF, onNavigate: () => undefined }, "评审记录"),
    );
    const link = container.querySelector("button")!;
    expect(link.textContent).toBe("评审记录");
    expect(link.getAttribute("title")).toBe(LONG_REF);
  });

  it("自定义 title 只作前缀:完整引用始终可达(custom title + children 短名)", () => {
    const container = mount(
      createElement(EntityRefLink, { entityRef: LONG_REF, onNavigate: () => undefined, title: "独立评审" }, "评审"),
    );
    const link = container.querySelector("button")!;
    const title = link.getAttribute("title") ?? "";
    expect(title).toContain("独立评审");
    expect(title).toContain(LONG_REF);
    expect(link.textContent).toBe("评审");
  });

  it("自定义 title 与引用同值时不产生重复拼接", () => {
    const container = mount(
      createElement(EntityRefLink, { entityRef: LONG_REF, onNavigate: () => undefined, title: LONG_REF }),
    );
    expect(container.querySelector("button")!.getAttribute("title")).toBe(LONG_REF);
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
  it("默认即内联截断 + 悬停完整值 + mono 排版,不渲染成按钮", () => {
    const container = mount(createElement(IdText, { value: LONG_ID }));
    const leaf = container.querySelector("span");
    expect(leaf).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expectRefLayoutHeld(leaf!);
    expect(leaf!.className).toContain("font-mono");
    expect(leaf!.getAttribute("title")).toBe(LONG_ID);
    expect(leaf!.textContent).toBe(LONG_ID);
  });

  it("敌意同层 utility 类抹不掉截断", () => {
    const container = mount(createElement(IdText, { value: LONG_ID, className: HOSTILE_CLASSES }));
    const leaf = container.querySelector("span")!;
    expect(leaf.className).toContain("whitespace-normal");
    expectRefLayoutHeld(leaf);
  });

  it("自定义 title 只作前缀,完整值不丢", () => {
    const container = mount(createElement(IdText, { value: LONG_ID, title: "评审编号" }));
    const title = container.querySelector("span")!.getAttribute("title") ?? "";
    expect(title).toContain("评审编号");
    expect(title).toContain(LONG_ID);
  });

  it("与 EntityRefLink 共用同一份排版与内联布局基,不另立第二套", () => {
    const container = mount(
      createElement(
        "p",
        null,
        createElement(IdText, { value: LONG_ID }),
        createElement(EntityRefLink, { entityRef: LONG_REF, onNavigate: () => undefined }),
      ),
    );
    const [leaf, link] = [...container.querySelectorAll("span,button")];
    expect(leaf.className).toContain("font-mono ui-micro");
    expect(link.className).toContain("font-mono ui-micro");
    expect(leaf.getAttribute("style")).toBe(link.getAttribute("style"));
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
    const refLink = [...container.querySelectorAll("button")].find((button) => button.textContent === LONG_ID);
    expect(refLink).toBeDefined();
    expectRefLayoutHeld(refLink!);
    act(() => refLink!.click());
    expect(navigated).toEqual([LONG_REF]);
  });

  it("无结构化落点:编号走 IdText 展示叶,悬停完整值", () => {
    const container = mount(
      createElement(DayDigest, { day: "10-02", summary: "一句摘要", defaultOpen: true, paths: paths() }),
    );
    const leaf = [...container.querySelectorAll("span")].find((span) => span.textContent === LONG_ID);
    expect(leaf).toBeDefined();
    expectRefLayoutHeld(leaf!);
    expect(leaf!.getAttribute("title")).toBe(LONG_ID);
  });
});

describe("RecordRow:共用记录布局原语(标准 §4.1,容器响应)", () => {
  it("断点按记录自身容器宽度(@container + @min-[420px]),不使用 viewport 断点", () => {
    const container = mount(
      createElement(RecordRow, {
        id: createElement(IdText, { value: LONG_ID }),
        summary: LONG_REASON,
        time: createElement("span", null, "2026-10-02"),
        action: createElement("button", { type: "button" }, "复制"),
      }),
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("@container");
    const grid = row.firstElementChild as HTMLElement;
    // 堆叠档也必须是定宽轨道(minmax(0,1fr)/grid-cols-1):auto 轨道按 max-content
    // 取宽会让 max-width:100% 在不定宽下失效,长 ID 以自然宽撑破窄容器。
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("@min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]");
    expect(grid.className).not.toMatch(/(^|\s)sm:/u);
    // 长正文列:词内换行留在自身列;标识列可收缩。
    const [idCol, bodyCol, tailCol] = [...grid.children];
    expect(idCol.className).toContain("min-w-0");
    expect(bodyCol.className).toContain("break-words");
    expect(tailCol.className).toContain("shrink-0");
  });

  it("聚焦态沿用 DenseRow/DayDigest 的同一高亮语汇", () => {
    const container = mount(createElement(RecordRow, { id: "x", summary: "y", focused: true }));
    expect((container.firstElementChild as HTMLElement).className).toContain("bg-accent/10");
    expect(container.firstElementChild!.getAttribute("data-focused")).toBe("true");
  });
});

/** 收口页组件树实挂的最小 task 夹具:executions 走 snapshot 形状,输出在 executionEvidence。 */
function closeoutFixtureTask(executionEvidence: unknown[]) {
  return {
    taskId: "task_probe_long_review",
    title: "长评审文本探针",
    coordinationStatus: "in_review",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-10-02T00:00:00.000Z",
    reviews: [{ reviewId: LONG_ID, verdict: "returned", reason: LONG_REASON, reviewedAt: "2026-10-02T00:00:00.000Z" }],
    consents: [],
    codeDocWitnesses: [],
    gateWitnesses: [],
    gates: [],
    capabilities: [],
    executions: [{ executionId: "execution_probe_outputs_long_values", state: "settled", iteration: 0 }],
    executionEvidence,
  };
}

describe("收口页两消费者共用 RecordRow:记录行与 execution 输出行", () => {
  it("AuditRow 长正文留在自身列,布局经 RecordRow,不再 viewport sm 断点", async () => {
    // TaskCloseoutTab 依赖 react-query 与任务数据模型,收口行布局以组件树实挂验证;
    // 这里用动态 import 避免fast tier 拖入集成夹具。
    const { TaskCloseoutTab } = await import("../src/renderer/components/taskDetail/TaskCloseoutTab.tsx");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const task = closeoutFixtureTask([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = mount(
      createElement(QueryClientProvider, { client }, createElement(TaskCloseoutTab, { task: task as never })),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const row = container.querySelector('[id^="closeout-record-review-"]');
    expect(row).not.toBeNull();
    // 记录行本体是 RecordRow 的容器外壳:两消费者同一布局实现。
    expect(row!.className).toContain("@container");
    // ID 列:展示叶截断(内联)+ 悬停完整值,不再裸排固定 11rem 列。
    const idLeaf = row!.querySelector("span[title]");
    expect(idLeaf!.getAttribute("title")).toBe(LONG_ID);
    expectRefLayoutHeld(idLeaf as HTMLElement);
    // 正文列:长评审文本留在自身列,词内换行。
    const body = [...row!.querySelectorAll("p")].find((p) => p.textContent === LONG_REASON);
    expect(body).toBeDefined();
    expect(body!.parentElement!.className).toContain("break-words");
    // 列模板:自适应 minmax + 容器断点,不再有写死的 11rem/9rem 与 viewport sm。
    const grid = row!.firstElementChild as HTMLElement;
    expect(grid.className).toContain("@min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]");
    expect(grid.className).not.toContain("sm:grid-cols");
    expect(grid.className).not.toContain("11rem");
    expect(grid.className).not.toContain("9rem");
  });

  it("execution 输出行(evidence 回执)与收口记录行共用同一 RecordRow 布局", async () => {
    const { TaskCloseoutTab } = await import("../src/renderer/components/taskDetail/TaskCloseoutTab.tsx");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const LONG_LOCATOR = `packages/gui/src/renderer/${"long/path/segment/".repeat(8)}deep.tsx`;
    const task = closeoutFixtureTask([
      {
        executionId: "execution_probe_outputs_long_values",
        outputs: [
          {
            evidenceId: "evidence_probe_long_output_id_9f2c7a41d8e6b35098ab7c2f",
            substrate: "repository-path",
            locator: LONG_LOCATOR,
            isPassingReceipt: false,
            checkerReceiptRef: `checker-receipt/${"a".repeat(64)}`,
            checkerResult: "unknown",
            raw: {},
          },
        ],
      },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = mount(
      createElement(QueryClientProvider, { client }, createElement(TaskCloseoutTab, { task: task as never })),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const executionRow = container.querySelector('[data-testid="task-execution-execution_probe_outputs_long_values"]');
    expect(executionRow).not.toBeNull();
    // 输出行也经 RecordRow:容器外壳 + 同一容器断点列模板。
    const recordRows = [...executionRow!.querySelectorAll('[class*="@container"]')];
    expect(recordRows.length).toBeGreaterThan(0);
    for (const recordRow of recordRows) {
      const grid = recordRow.firstElementChild as HTMLElement;
      expect(grid.className).toContain("@min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]");
    }
    // 长 locator 留在输出记录行的正文列(词内换行),evidenceId 走展示叶截断
    // (execution 头部的 executionId 也是展示叶,按 title 区分到 evidence 那片)。
    const evidenceLeaf = [...executionRow!.querySelectorAll("span[title]")].find((span) =>
      span.getAttribute("title")!.includes("evidence_probe_long_output_id"),
    );
    expect(evidenceLeaf).toBeDefined();
    expectRefLayoutHeld(evidenceLeaf as HTMLElement);
    const locatorCol = recordRows[0]!.firstElementChild!.children[1];
    expect(locatorCol).not.toBeNull();
    expect(locatorCol!.textContent).toContain(LONG_LOCATOR);
  });
});
