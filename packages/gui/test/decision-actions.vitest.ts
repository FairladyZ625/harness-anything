// harness-test-tier: contract
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GuiActionResult } from "../src/api/renderer-dto.ts";
import { useDecisionActions } from "../src/renderer/decision-actions.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

const receipt = (over: Partial<GuiActionResult> = {}): GuiActionResult =>
  ({
    schema: "command-receipt/v2",
    ok: true,
    command: "decision-judge",
    outcome: "applied",
    opId: "op-decision-1",
    consentId: "djc_decision000000000000000",
    path: "decisions/decision-dec_test/decision.md",
    commitSha: "abc123",
    documentSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    worktreeVisible: false,
    proof: { committedRevision: 5, appliedCut: 5, durable: true, canonicalVisible: true },
    ...over,
  }) as unknown as GuiActionResult;

describe("useDecisionActions write channel", () => {
  // R6(F4):回执三件套(durable + canonicalVisible + committedRevision===appliedCut)加上
  // completeDecisionReceipt 的字段校验已是落定证明:applied 分支直接发布 success,
  // 不再强制 staleTime:0 重读整份 decisions 并逐条扫描 state/consent。
  it("settles an accepted decision from the receipt alone without rereading the decision list", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const accept = vi.fn(async () => receipt()),
      reads = vi.fn();
    vi.spyOn(harnessClient, "acceptDecision").mockImplementation(accept);
    vi.spyOn(harnessClient, "getDecisions").mockImplementation(reads);

    let actions: ReturnType<typeof useDecisionActions> | undefined;
    try {
      await act(async () => {
        root.render(
          createElement(QueryClientProvider, {
            client,
            children: createElement(function Probe() {
              actions = useDecisionActions("repo-a");
              return null;
            }),
          }),
        );
      });

      const feedback = await actions!.judge({ decisionId: "dec_test" } as never, "accept", { rationale: "ok" });
      expect(accept).toHaveBeenCalledTimes(1);
      expect(feedback).toMatchObject({ state: "success", kind: "accept" });
      expect(reads).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.restoreAllMocks();
    }
  });

  // 回执 applied 但 proof 未断言 canonical 可见 → 仍是不锁死控件的 pending,
  // 与 task 通道的 canonical_not_visible 同一族落定。
  it("keeps an unproven receipt pending without rereading the list", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const accept = vi.fn(async () =>
        receipt({
          proof: { committedRevision: 5, appliedCut: 5, durable: true, canonicalVisible: false },
        }),
      ),
      reads = vi.fn();
    vi.spyOn(harnessClient, "acceptDecision").mockImplementation(accept);
    vi.spyOn(harnessClient, "getDecisions").mockImplementation(reads);

    let actions: ReturnType<typeof useDecisionActions> | undefined;
    try {
      await act(async () => {
        root.render(
          createElement(QueryClientProvider, {
            client,
            children: createElement(function Probe() {
              actions = useDecisionActions("repo-a");
              return null;
            }),
          }),
        );
      });

      const feedback = await actions!.judge({ decisionId: "dec_test" } as never, "accept", { rationale: "ok" });
      expect(feedback).toMatchObject({ state: "pending", kind: "accept", code: "canonical_not_visible" });
      expect(reads).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.restoreAllMocks();
    }
  });
});
