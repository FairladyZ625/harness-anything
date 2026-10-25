// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentInbox,
  AnnotateDiffViewer,
  ApprovalCard,
  ToolCallCard,
  ToolCallGroup,
  formatBatchReviewPrompt,
  type DiffAnnotation,
  type DiffFile,
  type InboxItem,
  type ToolCallEntry,
} from "../src/renderer/components/agent-ui/index.ts";
import {
  sessionTranscriptTurns,
  toolCallGroups,
  type ToolCallGroup as ToolCallGroupModel,
} from "../src/renderer/session-transcript-model.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function mount(element: React.ReactElement) {
  act(() => root.render(element));
  return container;
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const press = (element: Element, key: string, options: KeyboardEventInit = {}) => {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
  });
};

describe("ToolCallCard", () => {
  const baseCall: ToolCallEntry = {
    key: "call-1",
    name: "Bash",
    summary: "npm run build",
    status: "succeeded",
    durationMs: 1_830,
    args: '{"command":"npm run build"}',
    result: "built in 1.8s",
    startedAt: null,
  };

  it("stays collapsed with name, summary, duration and status, then expands with arguments and result", () => {
    mount(<ToolCallCard call={baseCall} />);
    const toggle = byTestId("toolcall-card-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Bash");
    expect(toggle.textContent).toContain("npm run build");
    expect(byTestId("toolcall-card-elapsed").textContent).toBe("1.8s");
    expect(byTestId("toolcall-card-arguments")).toBeNull();
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const region = byTestId("toolcall-card-arguments").closest('[role="region"]');
    expect(region).not.toBeNull();
    expect(region!.getAttribute("aria-label")).toBe("Bash 详情");
    expect(byTestId("toolcall-card-arguments").textContent).toContain('"command"');
    expect(byTestId("toolcall-card-result").textContent).toContain("built in 1.8s");
  });

  it("truncates a huge payload for rendering while copy carries the full original text", async () => {
    const hugeArguments = `{"blob":"${"x".repeat(9_000)}"}`;
    const writes: string[] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async (text: string) => void writes.push(text) },
    });
    mount(<ToolCallCard call={{ ...baseCall, args: hugeArguments }} defaultExpanded />);
    const truncated = byTestId("toolcall-card-arguments-truncated");
    expect(truncated).not.toBeNull();
    expect(truncated.textContent).toContain("9011");
    // 预览体本身必须被截断,不渲染全部负载。
    const previewText = byTestId("toolcall-card-arguments").querySelector("pre")!.textContent ?? "";
    expect(previewText.length).toBeLessThan(2_400);
    await act(async () => {
      byTestId("toolcall-card-arguments-copy").click();
    });
    expect(writes).toEqual([hugeArguments]);
    vi.unstubAllGlobals();
  });

  it("offers retry on failed calls and reports which call was retried", () => {
    const onRetry = vi.fn();
    mount(
      <ToolCallCard
        call={{ ...baseCall, status: "failed", durationMs: 400, result: "exit 1" }}
        defaultExpanded
        onRetry={onRetry}
      />,
    );
    // 失败详情读领域字段 result(没有独立 error)。
    expect(byTestId("toolcall-card-error").textContent).toContain("exit 1");
    expect(byTestId("toolcall-card-result").textContent).toContain("exit 1");
    act(() => byTestId("toolcall-card-retry").click());
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ key: "call-1", status: "failed" }));
  });

  it("ticks elapsed time for a running call from startedAt", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const now = Date.parse("2026-10-20T10:00:00Z");
    vi.setSystemTime(now);
    mount(
      <ToolCallCard
        call={{ ...baseCall, status: "running", durationMs: null, startedAt: new Date(now - 5_000).toISOString() }}
      />,
    );
    expect(byTestId("toolcall-card-elapsed").textContent).toBe("5.0s");
    act(() => vi.advanceTimersByTime(2_000));
    expect(byTestId("toolcall-card-elapsed").textContent).toBe("7.0s");
  });
});

describe("ToolCallGroup", () => {
  const group: ToolCallGroupModel = {
    key: "turn-1:tools:0",
    turnKey: "turn-1",
    status: "failed",
    totalDurationMs: 1_880,
    calls: [
      {
        key: "a",
        name: "Read",
        summary: "读配置",
        status: "succeeded",
        durationMs: 120,
        args: '{"path":"vite.config.ts"}',
        result: null,
        startedAt: null,
      },
      {
        key: "b",
        name: "Bash",
        summary: "跑构建",
        status: "failed",
        durationMs: 1_700,
        args: "",
        result: "exit 1",
        startedAt: null,
      },
      {
        key: "c",
        name: "Grep",
        summary: "搜引用",
        status: "succeeded",
        durationMs: 60,
        args: "",
        result: null,
        startedAt: null,
      },
    ],
  };

  it("collapses a round of calls into one summary row and expands into individual cards", () => {
    mount(<ToolCallGroup group={group} />);
    const toggle = byTestId("toolcall-group-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(byTestId("toolcall-group-summary").textContent).toBe("已调用 3 个工具 · 耗时 1.9s");
    expect(toggle.textContent).toContain("失败 1");
    expect(byTestId("toolcall-card")).toBeNull();
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll('[data-testid="toolcall-card"]')).toHaveLength(3);
    // 组内单卡仍可继续展开。
    act(() => byTestId("toolcall-card-toggle").click());
    expect(byTestId("toolcall-card-arguments")).not.toBeNull();
  });

  it("renders the domain projection from toolCallGroups(sessionTranscriptTurns(...)) without an adapter", () => {
    const records = [
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:00.000Z",
        event: {
          type: "assistant",
          message: {
            id: "m-1",
            content: [
              { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
              { type: "tool_use", id: "t2", name: "Grep", input: { q: "x" } },
            ],
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:04.000Z",
        event: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "found 2" }] } },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:09.000Z",
        event: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file content" }] },
        },
      },
    ];
    const [projected] = toolCallGroups(sessionTranscriptTurns(records));
    mount(<ToolCallGroup group={projected!} defaultExpanded />);
    expect(byTestId("toolcall-group-summary").textContent).toBe("已调用 2 个工具 · 耗时 13s");
    expect(container.querySelectorAll('[data-testid="toolcall-card"]')).toHaveLength(2);
    expect(byTestId("toolcall-card-elapsed").textContent).toBe("9.0s");
    act(() => byTestId("toolcall-card-toggle").click());
    expect(byTestId("toolcall-card-arguments").textContent).toContain("a.ts");
    expect(byTestId("toolcall-card-result").textContent).toContain("file content");
  });
});

describe("ApprovalCard", () => {
  const pending = {
    title: "删除旧迁移脚本",
    risk: "high" as const,
    previewLines: ["rm scripts/legacy-migrate.sh"],
    previewKind: "command" as const,
  };

  it("shows the risk badge and preview, and approves via Enter / denies via Esc and Shift+Enter", () => {
    const onDecide = vi.fn();
    mount(<ApprovalCard {...pending} onDecide={onDecide} />);
    expect(byTestId("approval-risk").textContent).toBe("高风险");
    expect(byTestId("approval-preview").textContent).toContain("$ rm scripts/legacy-migrate.sh");
    press(byTestId("approval-card"), "Enter");
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ verdict: "approved", reason: "user" }));
    act(() => root.render(<ApprovalCard {...pending} risk="protected" onDecide={onDecide} />));
    expect(byTestId("approval-risk").textContent).toBe("受保护面");
    press(byTestId("approval-card"), "Escape");
    expect(onDecide).toHaveBeenLastCalledWith(expect.objectContaining({ verdict: "denied", reason: "user" }));
    act(() => root.render(<ApprovalCard {...pending} onDecide={onDecide} />));
    press(byTestId("approval-card"), "Enter", { shiftKey: true });
    expect(onDecide).toHaveBeenLastCalledWith(expect.objectContaining({ verdict: "denied", reason: "user" }));
    expect(onDecide).toHaveBeenCalledTimes(3);
  });

  it("counts down, freezes while attended, and auto-denies on expiry", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const onDecide = vi.fn();
    mount(<ApprovalCard {...pending} risk="low" timeoutMs={5_000} onDecide={onDecide} />);
    expect(byTestId("approval-countdown").textContent).toContain("5s");
    act(() => vi.advanceTimersByTime(3_000));
    expect(byTestId("approval-countdown").textContent).toContain("2s");
    // 聚焦卡片即暂停(悬停同通道),冻结期间倒计时不走。
    act(() => byTestId("approval-approve").focus());
    expect(byTestId("approval-countdown").hasAttribute("data-paused")).toBe(true);
    act(() => vi.advanceTimersByTime(5_000));
    expect(byTestId("approval-countdown").textContent).toContain("2s");
    expect(onDecide).not.toHaveBeenCalled();
    act(() => byTestId("approval-approve").blur());
    expect(byTestId("approval-countdown").hasAttribute("data-paused")).toBe(false);
    act(() => vi.advanceTimersByTime(2_000));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ verdict: "denied", reason: "timeout" }));
  });

  it("collapses to a single resolved line once decided and ignores further keyboard input", () => {
    const onDecide = vi.fn();
    mount(
      <ApprovalCard
        {...pending}
        risk="medium"
        timeoutMs={60_000}
        decided={{ verdict: "approved", at: "2026-10-20T10:00:00Z", reason: "user" }}
        onDecide={onDecide}
      />,
    );
    const card = byTestId("approval-card");
    expect(card.getAttribute("data-decided")).toBe("approved");
    expect(byTestId("approval-resolved").textContent).toContain("已批准");
    expect(byTestId("approval-resolved").textContent).toContain("删除旧迁移脚本");
    expect(byTestId("approval-approve")).toBeNull();
    press(card, "Enter");
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("returns focus to the resolved summary when a pending card collapses", () => {
    const onDecide = vi.fn();
    mount(<ApprovalCard {...pending} onDecide={onDecide} />);
    press(byTestId("approval-card"), "Enter");
    act(() =>
      root.render(
        <ApprovalCard
          {...pending}
          decided={{ verdict: "approved", at: "2026-10-20T10:00:00Z", reason: "user" }}
          onDecide={onDecide}
        />,
      ),
    );
    expect(document.activeElement).toBe(byTestId("approval-resolved"));
  });
});

describe("AgentInbox", () => {
  const items: readonly InboxItem[] = [
    {
      id: "t1",
      title: "重构 SessionsView",
      agentName: "glm-worker",
      lane: "needs-you",
      note: "等待审批:Bash npm run build",
      recentSteps: ["读样式", "改圆角"],
      actions: [
        { kind: "approve", onTrigger: vi.fn() },
        { kind: "open", onTrigger: vi.fn() },
      ],
    },
    { id: "t2", title: "补 E2E 用例", lane: "running", recentSteps: ["写夹具"] },
    { id: "t3", title: "文档校对", lane: "done" },
  ];
  const rerender = (next: readonly InboxItem[]) => {
    act(() => root.render(<AgentInbox items={next} />));
  };

  it("boards items into three counted lanes with Needs you first", () => {
    mount(<AgentInbox items={items} />);
    expect(byTestId("inbox-column-needs-you-count").textContent).toBe("1");
    expect(byTestId("inbox-column-running-count").textContent).toBe("1");
    expect(byTestId("inbox-column-done-count").textContent).toBe("1");
    expect(byTestId("inbox-column-needs-you").contains(byTestId("inbox-item-t1"))).toBe(true);
    expect(byTestId("inbox-item-t1-note").textContent).toContain("等待审批:Bash");
  });

  it("moves the card to the new lane when status changes", () => {
    mount(<AgentInbox items={items} />);
    rerender(items.map((item) => (item.id === "t1" ? { ...item, lane: "done" } : item)));
    expect(byTestId("inbox-column-needs-you-count").textContent).toBe("0");
    expect(byTestId("inbox-column-done-count").textContent).toBe("2");
    expect(byTestId("inbox-column-done").contains(byTestId("inbox-item-t1"))).toBe(true);
  });

  it("switches to a flat list with Needs you pinned on top", () => {
    mount(<AgentInbox items={items} />);
    act(() => byTestId("inbox-view-list").click());
    const rows = [...container.querySelectorAll('[data-testid^="inbox-item-"][data-lane]')];
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "inbox-item-t1",
      "inbox-item-t2",
      "inbox-item-t3",
    ]);
  });

  it("expands recent steps inline, runs actions with the item, and returns focus on Esc", () => {
    const approve = vi.fn();
    mount(
      <AgentInbox
        items={[
          {
            ...items[0],
            actions: [{ kind: "approve", onTrigger: approve }],
          },
          ...items.slice(1),
        ]}
      />,
    );
    const toggle = byTestId("inbox-item-t1-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const steps = byTestId("inbox-item-t1-steps");
    expect(steps.querySelectorAll("li")).toHaveLength(2);
    act(() => byTestId("inbox-item-t1-action-approve").click());
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
    const region = byTestId("inbox-item-t1-steps").closest('[role="region"]')!;
    press(region, "Escape");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });
});

describe("AnnotateDiffViewer", () => {
  const files: readonly DiffFile[] = [
    {
      filePath: "src/renderer/App.tsx",
      lines: [
        { kind: "context", oldLineNo: 1, newLineNo: 1, text: 'import { render } from "react";' },
        { kind: "remove", oldLineNo: 2, text: "const config = null;" },
        { kind: "add", newLineNo: 2, text: "const config = loadConfig();" },
        { kind: "add", newLineNo: 3, text: "export default config;" },
      ],
    },
  ];

  const addDraft = (addTestId: string, body: string) => {
    act(() => byTestId(addTestId).click());
    const text = byTestId("annotate-composer-text") as HTMLTextAreaElement;
    // React 受控 textarea 要走原生 value setter,直接赋值会被值追踪器去重而不触发 onChange。
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      nativeSetter.call(text, body);
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => byTestId("annotate-composer-save").click());
  };

  it("without onBatchSend renders a pure viewer: diff rows only, no annotate or packaging chrome", () => {
    mount(<AnnotateDiffViewer files={files} />);
    // 差异本身仍完整可查看(收口契约:W2-2 起返工走自动评审循环,无手动回送)。
    expect(byTestId("annotate-file-0").textContent).toContain("src/renderer/App.tsx");
    expect(byTestId("annotate-file-0").textContent).toContain("const config = loadConfig();");
    expect(byTestId("annotate-add-new-2")).toBeNull();
    expect(byTestId("annotate-actionbar-top")).toBeNull();
    expect(byTestId("annotate-actionbar-bottom")).toBeNull();
    expect(byTestId("annotate-send")).toBeNull();
    expect(byTestId("annotate-clear")).toBeNull();
    expect(byTestId("annotate-pending-count")).toBeNull();
    expect(byTestId("annotate-drafts")).toBeNull();
    // 查看器里聚焦行按 c 不再打开批注 composer。
    const row = container.querySelector('[data-diff-line="new-3"]')!;
    act(() => row.focus());
    press(row, "c");
    expect(byTestId("annotate-composer")).toBeNull();
  });

  it("renders gutter add triggers in the annotator shape", () => {
    mount(<AnnotateDiffViewer files={files} onBatchSend={vi.fn()} />);
    expect(byTestId("annotate-add-new-2")).not.toBeNull();
    expect(byTestId("annotate-add-old-2")).not.toBeNull();
    expect(byTestId("annotate-add-new-3")).not.toBeNull();
  });

  it("stashes multiple line annotations without firing the callback, then batch-sends once", () => {
    const onBatchSend = vi.fn();
    mount(<AnnotateDiffViewer files={files} onBatchSend={onBatchSend} />);
    addDraft("annotate-add-new-2", "这里应该带默认值兜底");
    expect(byTestId("annotate-composer")).toBeNull();
    expect(byTestId("annotate-pending-count").textContent).toBe("1");
    addDraft("annotate-add-new-3", "导出挪到文件末尾");
    expect(byTestId("annotate-pending-count").textContent).toBe("2");
    // 约束:写批注不触发回调,只有打包回送才触发一次。
    expect(onBatchSend).not.toHaveBeenCalled();
    act(() => byTestId("annotate-send").click());
    expect(onBatchSend).toHaveBeenCalledTimes(1);
    const [prompt, annotations] = onBatchSend.mock.calls[0] as [string, readonly DiffAnnotation[]];
    expect(prompt).toContain("请按以下 2 条批注一次性完成修订");
    expect(prompt).toContain("### src/renderer/App.tsx:2-2");
    expect(prompt).toContain("2 | const config = loadConfig();");
    expect(prompt).toContain("批注:");
    expect(prompt).toContain("这里应该带默认值兜底");
    expect(prompt).toContain("### src/renderer/App.tsx:3-3");
    expect(prompt).toContain("导出挪到文件末尾");
    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toMatchObject({ filePath: "src/renderer/App.tsx", lineStart: 2, lineEnd: 2 });
    expect(byTestId("annotate-pending-count").textContent).toBe("0");
    expect(byTestId("annotate-send").hasAttribute("disabled")).toBe(true);
  });

  it("opens the composer from the focused row with the c key and cancels with Esc", () => {
    mount(<AnnotateDiffViewer files={files} onBatchSend={vi.fn()} />);
    const row = container.querySelector('[data-diff-line="new-3"]')!;
    act(() => row.focus());
    press(row, "c");
    expect(byTestId("annotate-composer").getAttribute("data-target")).toBe("src/renderer/App.tsx:3");
    press(byTestId("annotate-composer-text"), "Escape");
    expect(byTestId("annotate-composer")).toBeNull();
    expect(byTestId("annotate-pending-count").textContent).toBe("0");
  });

  it("renders split pairs and annotates from the new side", () => {
    mount(<AnnotateDiffViewer files={files} />);
    act(() => byTestId("annotate-mode-split").click());
    // context 行两栏同现;remove(旧行2)与 add(新行2)并排。
    expect(container.querySelector('[data-diff-line="old-2"]')).not.toBeNull();
    expect(container.querySelector('[data-diff-line="new-2"]')).not.toBeNull();
    const onBatchSend = vi.fn();
    act(() => root.render(<AnnotateDiffViewer files={files} mode="split" onBatchSend={onBatchSend} />));
    addDraft("annotate-add-new-2", "带默认值");
    act(() => byTestId("annotate-send").click());
    expect(onBatchSend.mock.calls[0][1][0]).toMatchObject({ lineStart: 2, lineEnd: 2 });
  });

  it("deletes a stashed draft", () => {
    mount(<AnnotateDiffViewer files={files} onBatchSend={vi.fn()} />);
    addDraft("annotate-add-new-2", "待删除");
    expect(byTestId("annotate-pending-count").textContent).toBe("1");
    act(() => byTestId("annotate-draft-ann-0-delete").click());
    expect(byTestId("annotate-pending-count").textContent).toBe("0");
  });
});

describe("formatBatchReviewPrompt", () => {
  it("orders deterministically by file path then line and keeps bodies verbatim", () => {
    const annotations: readonly DiffAnnotation[] = [
      { id: "b", filePath: "docs/z.md", lineStart: 9, lineEnd: 9, snippet: "tail", body: "第二行批注\n带换行" },
      { id: "a", filePath: "src/a.ts", lineStart: 4, lineEnd: 4, snippet: "const a = 1;", body: "改成 const" },
      { id: "c", filePath: "src/a.ts", lineStart: 2, lineEnd: 2, snippet: "import x;", body: "删掉未用导入" },
    ];
    const prompt = formatBatchReviewPrompt(annotations);
    const a = prompt.indexOf("### src/a.ts:2-2");
    const b = prompt.indexOf("### src/a.ts:4-4");
    const c = prompt.indexOf("### docs/z.md:9-9");
    // 字典序 docs < src;同文件内按行号升序。
    expect(c).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(c);
    expect(b).toBeGreaterThan(a);
    expect(prompt).toContain("带换行");
  });
});

describe("agentUi i18n (en-US)", () => {
  it("renders approval, inbox, tool-call and diff chrome in en-US after the locale switch", () => {
    setActiveLocale("en-US");
    mount(<ApprovalCard title="Drop legacy script" risk="high" previewLines={["rm old.sh"]} previewKind="command" />);
    expect(byTestId("approval-risk").textContent).toBe("High risk");
    expect(byTestId("approval-approve").textContent).toBe("Approve");
    expect(byTestId("approval-deny").textContent).toBe("Deny");
    act(() => root.render(<AgentInbox items={[{ id: "t1", title: "Refactor view", lane: "needs-you" }]} />));
    expect(byTestId("inbox-column-needs-you").textContent).toContain("Needs you");
    expect(byTestId("inbox-view-list").textContent).toBe("List");
    act(() =>
      root.render(
        <ToolCallGroup
          group={{
            key: "g",
            turnKey: "t",
            status: "succeeded",
            totalDurationMs: 120,
            calls: [
              {
                key: "a",
                name: "Read",
                summary: "read config",
                status: "succeeded",
                durationMs: 120,
                args: "",
                result: null,
                startedAt: null,
              },
            ],
          }}
        />,
      ),
    );
    expect(byTestId("toolcall-group-summary").textContent).toBe("Tool calls: 1 · 120ms");
    act(() => root.render(<AnnotateDiffViewer files={[]} onBatchSend={vi.fn()} />));
    expect(byTestId("annotate-mode-split").textContent).toBe("Split");
    expect(byTestId("annotate-send").textContent).toContain("Batch send to agent");
  });

  it("formats the batch prompt header and comment label in en-US", () => {
    setActiveLocale("en-US");
    const prompt = formatBatchReviewPrompt([
      { id: "a", filePath: "src/a.ts", lineStart: 2, lineEnd: 2, snippet: "import x;", body: "drop unused import" },
    ]);
    expect(prompt).toContain("Apply every note below (1 in total)");
    expect(prompt).toContain("Note:");
    expect(prompt).toContain("drop unused import");
  });
});
