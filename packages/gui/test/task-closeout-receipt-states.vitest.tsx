// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { currentLocale, setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 收口页 Execution 输出区的回执状态显示契约(task_3c3bd2eaa89460dbae843fa737):
 * 三种状态互不混淆——有检查器(通过/未通过,语义色)、没有检查器(文档类产出的
 * 常态,receiptRef=null,中性灰)与数据确实缺失(投影没返回字段,警示色「未投影」)。
 * 计数行不得把「无检查器」读成「未通过」;未提交 execution 的 commit 显示
 * 「未提交」而不是「未投影」。断言走 zh-CN 与 en-US 两个 locale,文案全部来自
 * i18n,不再有「none / 无 receipt」这类中英夹杂。
 */

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = [];

async function mountCloseout(task: unknown): Promise<HTMLElement> {
  // i18n/index.tsx 首次被动态 import 时有模块级副作用(按系统 locale 重置 activeLocale),
  // 在 import 之后重放测试想要的 locale,避免 happy-dom 的 en-US 盖掉设置。
  const locale = currentLocale();
  const { TaskCloseoutTab } = await import("../src/renderer/components/taskDetail/TaskCloseoutTab.tsx");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  setActiveLocale(locale);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(TaskCloseoutTab, { task: task as never })),
    );
  });
  return container;
}

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
});

function submission(outputs: readonly string[], commitSha: string | null) {
  return {
    completionClaim: "claim",
    deliverables: [],
    outputs,
    verificationNotes: [],
    knownGaps: [],
    residualRisks: [],
    commitSha,
  };
}

function execution(executionId: string, extras: Record<string, unknown> = {}) {
  return {
    schema: "execution/v1",
    executionId,
    taskId: "task_receipt_states",
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "worker" } },
    claimedAt: "2026-10-09T08:00:00.000Z",
    submittedAt: "2026-10-09T08:30:00.000Z",
    closedAt: null,
    ...extras,
  };
}

function fixtureTask(executions: readonly unknown[], executionEvidence: readonly unknown[]) {
  return {
    taskId: "task_receipt_states",
    title: "回执状态显示探针",
    coordinationStatus: "in_review",
    closeoutReadiness: "incomplete",
    lastKnownAt: "2026-10-09T09:00:00.000Z",
    reviews: [],
    consents: [],
    codeDocWitnesses: [],
    gateWitnesses: [],
    gates: [],
    capabilities: [],
    executions,
    executionEvidence,
  };
}

const SHA = "a".repeat(40);

/** 一条 execution 携带五种回执形态:通过/未通过/有回执无结论/无检查器/投影缺字段。 */
const MIXED_OUTPUTS = [
  {
    evidenceId: "evidence_pass",
    locator: "artifacts/pass.txt",
    substrate: "repository-path",
    checkerReceiptRef: "receipt/pass",
    checkerResult: "pass",
  },
  {
    evidenceId: "evidence_fail",
    locator: "artifacts/fail.txt",
    substrate: "repository-path",
    checkerReceiptRef: "receipt/fail",
    checkerResult: "fail",
  },
  {
    evidenceId: "evidence_noresult",
    locator: "https://example.test/log",
    substrate: "uri",
    checkerReceiptRef: "receipt/noresult",
    checkerResult: "unknown",
  },
  {
    evidenceId: "evidence_nochecker",
    locator: "artifacts/design.md",
    substrate: "repository-path",
    checkerReceiptRef: null,
    checkerResult: "unknown",
  },
  { evidenceId: "evidence_missing", locator: "artifacts/unprojected.txt", substrate: "repository-path" },
];

function outputStateSpans(container: HTMLElement, executionId: string): readonly HTMLElement[] {
  const article = container.querySelector(`[data-testid="task-execution-${executionId}"]`);
  expect(article).not.toBeNull();
  const spans = [...article!.querySelectorAll<HTMLElement>('[data-testid^="output-receipt-state-"]')];
  return spans;
}

function headerMeta(container: HTMLElement, executionId: string): HTMLElement {
  const article = container.querySelector(`[data-testid="task-execution-${executionId}"]`)!;
  return article.querySelector('[data-testid="execution-outputs-count"]') as HTMLElement;
}

describe("收口页 Execution 输出回执:三种状态互不混淆(zh-CN)", () => {
  it("行级:通过绿/未通过红/有回执无结论橙/无检查器中性灰/缺字段橙「未投影」", async () => {
    const container = await mountCloseout(
      fixtureTask(
        [
          execution("execution-mixed", {
            submission: submission(
              [
                "artifacts/pass.txt",
                "artifacts/fail.txt",
                "https://example.test/log",
                "artifacts/design.md",
                "artifacts/unprojected.txt",
              ],
              SHA,
            ),
          }),
        ],
        [{ executionId: "execution-mixed", origin: "native", outputs: MIXED_OUTPUTS }],
      ),
    );
    const spans = outputStateSpans(container, "execution-mixed");
    expect(spans.map((span) => span.textContent)).toEqual([
      "receipt/pass · 通过",
      "receipt/fail · 未通过",
      "receipt/noresult · 结果未知",
      "无检查器回执",
      "未投影",
    ]);
    expect(spans[0]!.className).toContain("text-status-done");
    expect(spans[1]!.className).toContain("text-status-unknown");
    expect(spans[2]!.className).toContain("text-stale");
    expect(spans[3]!.className).toContain("text-text-faint");
    expect(spans[3]!.className).not.toContain("text-stale");
    expect(spans[4]!.className).toContain("text-stale");
  });

  it("计数行:混合回执如实分桶,不再把无检查器算作未通过", async () => {
    const container = await mountCloseout(
      fixtureTask(
        [
          execution("execution-mixed", {
            submission: submission(
              MIXED_OUTPUTS.map(({ locator }) => locator),
              SHA,
            ),
          }),
        ],
        [{ executionId: "execution-mixed", origin: "native", outputs: MIXED_OUTPUTS }],
      ),
    );
    expect(headerMeta(container, "execution-mixed").textContent).toBe(
      "5 个产出 · 1 通过 · 1 未通过 · 1 结果未知 · 1 无检查器 · 1 未投影",
    );
  });

  it("计数行:全部无检查器(文档类产出常态)显示「均无检查器」,不显示通过数", async () => {
    const outputs = [
      "artifacts/design.md",
      "artifacts/explainer.html",
      "artifacts/pr-body.md",
      "artifacts/research.md",
    ].map((locator, index) => ({
      evidenceId: `evidence_doc_${index}`,
      locator,
      substrate: "repository-path",
      checkerReceiptRef: null,
      checkerResult: "unknown",
    }));
    const container = await mountCloseout(
      fixtureTask(
        [
          execution("execution-docs", {
            submission: submission(
              outputs.map(({ locator }) => locator),
              null,
            ),
          }),
        ],
        [{ executionId: "execution-docs", origin: "native", outputs }],
      ),
    );
    expect(headerMeta(container, "execution-docs").textContent).toBe("4 个产出 · 均无检查器");
    const spans = outputStateSpans(container, "execution-docs");
    for (const span of spans) {
      expect(span.textContent).toBe("无检查器回执");
      expect(span.className).toContain("text-text-faint");
      expect(span.className).not.toContain("text-stale");
    }
  });

  it("未提交 execution:commit 显示「未提交」,不是「未投影」", async () => {
    const container = await mountCloseout(
      fixtureTask(
        [execution("execution-unsubmitted", { state: "claimed", submittedAt: null, submission: null })],
        [{ executionId: "execution-unsubmitted", origin: "native", outputs: [] }],
      ),
    );
    const article = container.querySelector('[data-testid="task-execution-execution-unsubmitted"]')!;
    const commitLine = [...article.querySelectorAll("span")].find((span) => span.textContent?.includes("commit"));
    expect(commitLine?.textContent).toContain("commit 未提交");
    expect(commitLine?.textContent).not.toContain("未投影");
  });

  it("全区块:不再出现「none / 无 receipt」「unknown / 未投影」中英夹杂", async () => {
    const container = await mountCloseout(
      fixtureTask(
        [
          execution("execution-mixed", {
            submission: submission(
              MIXED_OUTPUTS.map(({ locator }) => locator),
              SHA,
            ),
          }),
          execution("execution-unsubmitted", { state: "claimed", submittedAt: null, submission: null }),
        ],
        [
          { executionId: "execution-mixed", origin: "native", outputs: MIXED_OUTPUTS },
          { executionId: "execution-unsubmitted", origin: "native", outputs: [] },
        ],
      ),
    );
    expect(container.textContent).not.toContain("none / 无 receipt");
    expect(container.textContent).not.toContain("unknown / 未投影");
  });
});

describe("收口页 Execution 输出回执(en-US)", () => {
  it("行级与计数行走同一 i18n 面,英文同样如实分桶", async () => {
    setActiveLocale("en-US");
    try {
      const container = await mountCloseout(
        fixtureTask(
          [
            execution("execution-mixed", {
              submission: submission(
                MIXED_OUTPUTS.map(({ locator }) => locator),
                SHA,
              ),
            }),
            execution("execution-unsubmitted", { state: "claimed", submittedAt: null, submission: null }),
          ],
          [
            { executionId: "execution-mixed", origin: "native", outputs: MIXED_OUTPUTS },
            { executionId: "execution-unsubmitted", origin: "native", outputs: [] },
          ],
        ),
      );
      const spans = outputStateSpans(container, "execution-mixed");
      expect(spans.map((span) => span.textContent)).toEqual([
        "receipt/pass · passed",
        "receipt/fail · failed",
        "receipt/noresult · no result",
        "no checker receipt",
        "not projected",
      ]);
      expect(headerMeta(container, "execution-mixed").textContent).toBe(
        "5 outputs · 1 passed · 1 failed · 1 no result · 1 unchecked · 1 not projected",
      );
      const article = container.querySelector('[data-testid="task-execution-execution-unsubmitted"]')!;
      const commitLine = [...article.querySelectorAll("span")].find((span) => span.textContent?.includes("commit"));
      expect(commitLine?.textContent).toContain("commit uncommitted");
    } finally {
      setActiveLocale("zh-CN");
    }
  });

  it("全部无检查器:en 计数「none checked」", async () => {
    setActiveLocale("en-US");
    try {
      const outputs = [
        {
          evidenceId: "evidence_doc_0",
          locator: "artifacts/design.md",
          substrate: "repository-path",
          checkerReceiptRef: null,
          checkerResult: "unknown",
        },
      ];
      const container = await mountCloseout(
        fixtureTask(
          [execution("execution-docs", { submission: submission(["artifacts/design.md"], null) })],
          [{ executionId: "execution-docs", origin: "native", outputs }],
        ),
      );
      expect(headerMeta(container, "execution-docs").textContent).toBe("1 outputs · none checked");
    } finally {
      setActiveLocale("zh-CN");
    }
  });
});
