// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { EdgeInvitePanel } from "../src/renderer/views/settings/EdgeInvitePanel.tsx";

/**
 * 「邀请边缘节点」面板(task gui-edge-invite)的行为判据:
 * ①签发 = 三个输入直达 access 通道的 edge-join-create,回执链接显示一次 + 有效期;
 * ②「完成」后链接从 DOM 与内存消失,行只剩 joinId 侧事实与状态——链接不可再取出;
 * ③状态按 inviteId 轮询,pending → consumed 变化如实呈现,终态后不再发请求;
 * ④拒绝按 access 面口径显示说明;复制走隔离的模拟剪贴板断言(不动系统剪贴板)。
 */
vi.mock("motion/react", async (original) => {
  const actual = await original<typeof import("motion/react")>();
  return {
    ...actual,
    motion: { div: "div", span: "span" },
    AnimatePresence: ({ children }: { readonly children: unknown }) => children,
    useReducedMotion: () => false,
  };
});

const LINK = "harness-edge://join/eyJ2ZXJzaW9uIjoxLCJjZW50ZXJVcmwiOiJodHRwczovL2NlbnRlci50ZXN0In0";

function issuedReply(inviteId = "invite-1") {
  return {
    ok: true,
    joinId: inviteId,
    state: "pending",
    expiresAt: "2026-10-21T00:00:00.000Z",
    inviteLink: LINK,
  };
}

function statusReply(inviteId: string, status: "pending" | "consumed" | "expired") {
  return {
    ok: true,
    inviteId,
    status,
    personId: "person-gui",
    nodeId: "edge-a",
    expiresAt: "2026-10-21T00:00:00.000Z",
    consumedAt: status === "consumed" ? "2026-10-18T12:00:00.000Z" : null,
  };
}

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Harness {
  readonly container: HTMLElement;
  readonly issue: ReturnType<typeof vi.fn>;
  readonly status: ReturnType<typeof vi.fn>;
}

async function mountPanel(
  options: {
    readonly issueResult?: unknown;
    readonly statusResults?: readonly unknown[];
  } = {},
): Promise<Harness> {
  const statusQueue = [...(options.statusResults ?? [statusReply("invite-1", "pending")])];
  const issue =
      options.issueResult === undefined ? vi.fn(async () => issuedReply()) : vi.fn(async () => options.issueResult),
    // 逐次出队,队尾保留:前 N 次按脚本回,之后永远回最后一个。
    status = vi.fn(async () => (statusQueue.length > 1 ? statusQueue.shift()! : statusQueue[0]));
  // CopyContextButton 收尾用 window.setTimeout;整替 window 时按仓库 settle 习惯给回宏任务入口。
  vi.stubGlobal("window", {
    setTimeout: (handler: TimerHandler, ms?: number) => globalThis.setTimeout(handler, ms),
    harness: { access: { issueEdgeJoin: issue, edgeJoinStatus: status } },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(EdgeInvitePanel)));
  });
  await settle();
  return { container, issue, status };
}

/** 一次宏任务刷新(page-regions 的 settle 习惯):真时钟走 setTimeout(0),假时钟走时间推进。 */
let flushMacrotask: () => Promise<void> = async () => {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
};

async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1)
    await act(async () => {
      await Promise.resolve();
      await flushMacrotask();
    });
}

async function fill(container: HTMLElement, testId: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  expect(input, `${testId} not rendered`).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await settle();
}

describe("EdgeInvitePanel", () => {
  it("issues through the access bridge, shows the link once with its expiry", async () => {
    const { container, issue, status } = await mountPanel();
    await fill(container, "edge-invite-node-id", "edge-a");
    await fill(container, "edge-invite-center-url", "https://center.test");
    await fill(container, "edge-invite-spki", "sha256:pin");
    await click(container, "edge-invite-issue");
    expect(issue).toHaveBeenCalledWith({
      nodeId: "edge-a",
      centerUrl: "https://center.test",
      spkiSha256: "sha256:pin",
    });
    const link = container.querySelector('[data-testid="edge-invite-link-edge-a"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain(LINK);
    expect(container.textContent).toContain("2026-10-21");
    expect(status).toHaveBeenCalledWith({ inviteId: "invite-1" });
    expect(container.textContent).toContain("Pending");
  });

  it("drops the link on Done: the row survives by joinId facts only, the link is gone for good", async () => {
    const { container } = await mountPanel();
    await fill(container, "edge-invite-node-id", "edge-a");
    await fill(container, "edge-invite-center-url", "https://center.test");
    await fill(container, "edge-invite-spki", "sha256:pin");
    await click(container, "edge-invite-issue");
    expect(container.querySelector('[data-testid="edge-invite-link-edge-a"]')).not.toBeNull();
    await click(container, "edge-invite-done-edge-a");
    expect(container.querySelector('[data-testid="edge-invite-link-edge-a"]')).toBeNull();
    expect(container.textContent).not.toContain(LINK);
    expect(container.querySelector('[data-testid="edge-invite-row-edge-a"]')).not.toBeNull();
    // The two center facts stay for the next invitation in the same session; only the node name resets.
    expect(container.querySelector<HTMLInputElement>('[data-testid="edge-invite-node-id"]')!.value).toBe("");
    expect(container.querySelector<HTMLInputElement>('[data-testid="edge-invite-center-url"]')!.value).toBe(
      "https://center.test",
    );
  });

  it("shows the pending → consumed transition and stops polling at a terminal state", async () => {
    // 假时钟推进区间取数;React 的渲染调度走 MessageChannel 真宏任务,两样都要让渡。
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    flushMacrotask = async () => {
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      await vi.advanceTimersByTimeAsync(1);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const { container, status } = await mountPanel({
        statusResults: [
          statusReply("invite-1", "pending"),
          statusReply("invite-1", "pending"),
          statusReply("invite-1", "consumed"),
        ],
      });
      await fill(container, "edge-invite-node-id", "edge-a");
      await fill(container, "edge-invite-center-url", "https://center.test");
      await fill(container, "edge-invite-spki", "sha256:pin");
      await click(container, "edge-invite-issue");
      expect(container.textContent).toContain("Pending");
      expect(container.textContent).not.toContain("Consumed");
      // 轮询节奏来自 QUERY_PACING_MS.edgeJoinStatus;用假时钟推这个间隔,不睡墙钟。
      for (let index = 0; index < 2; index += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        await settle(4);
      }
      expect(container.textContent).toContain("Consumed");
      const callsAtTerminal = status.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await settle(4);
      expect(status.mock.calls.length).toBe(callsAtTerminal);
    } finally {
      vi.useRealTimers();
      flushMacrotask = async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      };
    }
  });

  it("surfaces a daemon refusal with its explanation instead of a link", async () => {
    const { container } = await mountPanel({
      issueResult: {
        ok: false,
        code: "authorization_denied",
        error: { code: "authorization_denied", hint: "Sign in as an access administrator." },
      },
    });
    await fill(container, "edge-invite-node-id", "edge-a");
    await fill(container, "edge-invite-center-url", "https://center.test");
    await fill(container, "edge-invite-spki", "sha256:pin");
    await click(container, "edge-invite-issue");
    expect(container.querySelector('[data-testid="edge-invite-feedback"]')!.textContent).toContain(
      "Sign in as an access administrator.",
    );
    expect(container.querySelector('[data-testid="edge-invite-list"]')).toBeNull();
  });

  it("requires all three fields before calling the daemon", async () => {
    const { container, issue } = await mountPanel();
    await fill(container, "edge-invite-node-id", "edge-a");
    await click(container, "edge-invite-issue");
    expect(issue).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="edge-invite-feedback"]')!.textContent).toContain(
      "Node name, center address, and certificate pin",
    );
  });

  it("copies the invitation through an isolated simulated clipboard", async () => {
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (text && writes.push(text)) },
    });
    try {
      const { container } = await mountPanel();
      await fill(container, "edge-invite-node-id", "edge-a");
      await fill(container, "edge-invite-center-url", "https://center.test");
      await fill(container, "edge-invite-spki", "sha256:pin");
      await click(container, "edge-invite-issue");
      await click(container, "edge-invite-copy-edge-a");
      expect(writes).toEqual([LINK]);
    } finally {
      Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: undefined });
    }
  });
});
