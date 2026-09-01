// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocalDocLayer } from "../src/renderer/local-doc/LocalDocLayer.tsx";
import { DocReader } from "../src/renderer/components/DocReader.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 本机文档浮面(task_89d324b5):详情页 Markdown 的项目外本机文件链接点击后,
 * 在 GUI 内打开阅读;不可读时按 typed code 出页内错误态 —— 全程不触发文档导航
 * (锚点 click 被 preventDefault,这是白屏根因的根修验证)。
 */
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
afterEach(() => vi.restoreAllMocks());

const mounted: { root: Root; container: HTMLElement }[] = [];

async function renderLocalDocLayer(children: () => React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(LocalDocLayer, null, children())));
  });
  mounted.push({ root, container });
  return container;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function unmountAll() {
  await act(async () => {
    for (const { root } of mounted.splice(0)) root.unmount();
  });
}

/**
 * 点击锚点并观察「是否发生了未被拦截的导航式点击」:见证监听挂在 document 的冒泡
 * 段 —— React 根容器的处理器先跑,preventDefault 之后见证者看到的才是最终状态。
 */
async function clickAnchor(anchor: HTMLAnchorElement): Promise<boolean> {
  let navigated = false;
  const witness = (event: MouseEvent) => {
    if (!event.defaultPrevented) navigated = true;
  };
  document.addEventListener("click", witness);
  try {
    await act(async () => {
      anchor.click();
    });
  } finally {
    document.removeEventListener("click", witness);
  }
  return navigated;
}

function stubLocalDocBridge(read: (input: { readonly path: string }) => Promise<unknown>) {
  vi.stubGlobal("window", Object.assign(window, { harness: { localDoc: { read } } }));
}

const EXTERNAL_DOC = "/Users/ce/Notes/outside-spec.md";

describe("markdown local-file links open in the GUI reader overlay", () => {
  it("clicks a project-external absolute path link and renders the document body", async () => {
    const read = vi.fn(async () => ({
      ok: true,
      path: EXTERNAL_DOC,
      content: "# 外部文档\n\n在 GUI 内读到了。",
      sizeBytes: 24,
    }));
    stubLocalDocBridge(read);
    const div = await renderLocalDocLayer(() =>
      createElement(DocReader, { content: `详情见 [外部规范](${EXTERNAL_DOC})。` }),
    );
    const anchor = div.querySelector<HTMLAnchorElement>(`a[href="${EXTERNAL_DOC}"]`);
    expect(anchor).not.toBeNull();
    expect(await clickAnchor(anchor!)).toBe(false);
    expect(read).toHaveBeenCalledWith({ path: EXTERNAL_DOC });
    await flush();
    const overlay = div.querySelector("[data-testid='local-doc-overlay']");
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain("外部文档");
    await unmountAll();
  });

  it("renders the real resolved path returned by the main process", async () => {
    stubLocalDocBridge(async () => ({ ok: true, path: "/private/etc/real.md", content: "body", sizeBytes: 4 }));
    const div = await renderLocalDocLayer(() => createElement(DocReader, { content: `[x](/tmp/link.md)` }));
    await act(async () => {
      div.querySelector<HTMLAnchorElement>("a[href='/tmp/link.md']")!.click();
    });
    await flush();
    expect(div.querySelector("[data-testid='local-doc-path']")!.textContent).toContain("/private/etc/real.md");
    await unmountAll();
  });

  it("shows a typed in-page error for a missing file instead of crashing", async () => {
    stubLocalDocBridge(async () => ({
      ok: false,
      code: "not_found",
      path: EXTERNAL_DOC,
      message: "ENOENT",
    }));
    const div = await renderLocalDocLayer(() => createElement(DocReader, { content: `[missing](${EXTERNAL_DOC})` }));
    await act(async () => {
      div.querySelector<HTMLAnchorElement>(`a[href="${EXTERNAL_DOC}"]`)!.click();
    });
    await flush();
    const error = div.querySelector("[data-testid='local-doc-error-not_found']");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("文件不存在");
    expect(div.querySelector("[data-testid='local-doc-overlay']")).not.toBeNull();
    await unmountAll();
  });

  it("never navigates and never reads for web links", async () => {
    const read = vi.fn();
    stubLocalDocBridge(read);
    const div = await renderLocalDocLayer(() =>
      createElement(DocReader, { content: "[site](https://example.invalid/a.md)" }),
    );
    const anchor = div.querySelector<HTMLAnchorElement>("a[href='https://example.invalid/a.md']");
    expect(anchor).not.toBeNull();
    expect(await clickAnchor(anchor!)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    await unmountAll();
  });

  it("routes package-relative links through the host navigation callback", async () => {
    const read = vi.fn();
    stubLocalDocBridge(read);
    const onOpenPackageDoc = vi.fn();
    const div = await renderLocalDocLayer(() =>
      createElement(DocReader, {
        content: "[报告](artifacts/report.md)",
        packageBasePath: "tasks/pkg_1/task_plan.md",
        onOpenPackageDoc,
      }),
    );
    await clickAnchor(div.querySelector<HTMLAnchorElement>("a[href='artifacts/report.md']")!);
    expect(onOpenPackageDoc).toHaveBeenCalledWith("tasks/pkg_1/artifacts/report.md");
    expect(read).not.toHaveBeenCalled();
    await unmountAll();
  });
});
