// harness-test-tier: contract
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GuiActionResult } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { useTaskActions } from "../src/renderer/task-actions.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { taskQueryKeys } from "../src/renderer/task-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

const receipt = (over: Partial<GuiActionResult> = {}): GuiActionResult =>
  ({
    schema: "command-receipt/v2",
    ok: true,
    command: "task-amend",
    outcome: "applied",
    opId: "op-pin-1",
    revision: 9,
    // A fresh write receipt: projection visible, worktree follower not yet caught up.
    proof: { committedRevision: 9, appliedCut: 9, durable: true, canonicalVisible: true, worktreeVisible: false },
    ...over,
  }) as unknown as GuiActionResult;

const emptyList = {
  ok: true,
  status: "ready",
  rows: [],
  invalidRows: [],
  watermark: 0,
  sourceRevision: 0,
  warnings: [],
} as const;

describe("useTaskActions pin write channel", () => {
  it("pins and unpins through the daemon pin action, settling each write from its receipt alone", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const task = (pinned: boolean): TaskRow => ({
      taskId: "task-pin",
      title: "Pin me",
      projectId: "repo-a",
      coordinationStatus: "planned",
      canonicalStatus: "planned",
      rawStatus: "planned/implementation",
      freshness: "fresh",
      packageDisposition: "active",
      closeoutReadiness: "not_required",
      engine: "local",
      source: "local-document",
      module: "core",
      lastKnownAt: "2026-08-30T00:00:00.000Z",
      gates: [],
      docs: [],
      ...(pinned ? { pinned: true } : {}),
    });
    const pin = vi.fn(async () => receipt()),
      unpin = vi.fn(async () => receipt()),
      // R6:回执三件套(durable + canonicalVisible + committedRevision===appliedCut)已是
      // 落定证明,写入通道不再强制 staleTime:0 整表重读——这里必须保持零调用。
      reads = vi.fn(async () => emptyList);
    vi.spyOn(harnessClient, "pinTask").mockImplementation(pin);
    vi.spyOn(harnessClient, "unpinTask").mockImplementation(unpin);
    vi.spyOn(harnessClient, "getTasks").mockImplementation(reads);

    let actions: ReturnType<typeof useTaskActions> | undefined;
    try {
      await act(async () => {
        root.render(
          createElement(QueryClientProvider, {
            client,
            children: createElement(function Probe() {
              actions = useTaskActions("repo-a");
              return null;
            }),
          }),
        );
      });
      client.setQueryData(taskQueryKeys.list("repo-a"), { ok: true, status: "ready", rows: [] });

      let feedback = await actions!.setTaskPin(task(false), true);
      expect(pin).toHaveBeenCalledWith({ repoId: "repo-a", taskId: "task-pin" });
      expect(feedback).toMatchObject({ state: "success", kind: "pin" });

      feedback = await actions!.setTaskPin(task(true), false);
      expect(unpin).toHaveBeenCalledWith({ repoId: "repo-a", taskId: "task-pin" });
      expect(feedback).toMatchObject({ state: "success", kind: "pin" });
      expect(reads).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.restoreAllMocks();
    }
  });

  // 回执 applied 且 proof 完整时,回执本身就是落定证明:即使 GUI 列表投影还停在旧版本
  // (实测 canonical 追平要约 2s),也直接发布 success——旧实现在这里强制 staleTime:0
  // 重读整表并逐行扫描,列表一滞后就把已落定的写入错报成 projection_not_visible。
  // 列表的新状态由挂载中的台账探针正常 refetch 带上来(R6 删除回读校验)。
  it("settles an applied pin from the receipt alone while the list projection lags", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const task = (pinned: boolean): TaskRow => ({
      taskId: "task-pin",
      title: "Pin me",
      projectId: "repo-a",
      coordinationStatus: "planned",
      canonicalStatus: "planned",
      rawStatus: "planned/implementation",
      freshness: "fresh",
      packageDisposition: "active",
      closeoutReadiness: "not_required",
      engine: "local",
      source: "local-document",
      module: "core",
      lastKnownAt: "2026-08-30T00:00:00.000Z",
      gates: [],
      docs: [],
      ...(pinned ? { pinned: true } : {}),
    });
    const pin = vi.fn(async () => receipt()),
      unpin = vi.fn(async () => receipt()),
      reads = vi.fn(async () => emptyList);
    vi.spyOn(harnessClient, "pinTask").mockImplementation(pin);
    vi.spyOn(harnessClient, "unpinTask").mockImplementation(unpin);
    vi.spyOn(harnessClient, "getTasks").mockImplementation(reads);

    let actions: ReturnType<typeof useTaskActions> | undefined;
    try {
      await act(async () => {
        root.render(
          createElement(QueryClientProvider, {
            client,
            children: createElement(function Probe() {
              actions = useTaskActions("repo-a");
              return null;
            }),
          }),
        );
      });
      client.setQueryData(taskQueryKeys.list("repo-a"), { ok: true, status: "ready", rows: [] });

      const lagging = await actions!.setTaskPin(task(false), true);
      expect(lagging).toMatchObject({ state: "success", kind: "pin" });
      expect(pin).toHaveBeenCalledTimes(1);
      expect(reads).not.toHaveBeenCalled();

      // 同一条任务的下一次 unpin 意图必须真的发出去,而不是拿回上一次那个 promise。
      const again = await actions!.setTaskPin(task(true), false);
      expect(unpin).toHaveBeenCalledTimes(1);
      expect(again).toMatchObject({ state: "success", kind: "pin" });

      // 实测真机落在另一条同类落定上:回执 outcome=applied,但 proof 还没断言
      // canonical 可见(code=canonical_not_visible)。它同样不得锁死控件。
      vi.mocked(harnessClient.pinTask).mockClear();
      const unproven = receipt({
        proof: { committedRevision: 9, appliedCut: 9, durable: true, canonicalVisible: false, worktreeVisible: true },
      });
      vi.spyOn(harnessClient, "pinTask").mockImplementation(async () => unproven);
      const invisible = await actions!.setTaskPin(task(false), true);
      expect(invisible).toMatchObject({ state: "pending", kind: "pin", code: "canonical_not_visible" });
      await actions!.setTaskPin(task(false), true);
      expect(harnessClient.pinTask).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.restoreAllMocks();
    }
  });

  // 归属真正未知的回执(pending/indeterminate)照旧挡住重放:锁只在「回执已 applied」时放开。
  it("still blocks a replay while the receipt's own fate is unknown", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const task = { taskId: "task-pin" };
    const pin = vi.fn(async () => receipt({ outcome: "pending", opId: "op-pin-pending" }));
    vi.spyOn(harnessClient, "pinTask").mockImplementation(pin);
    const showReceipt = vi.spyOn(harnessClient, "showReceipt");

    let actions: ReturnType<typeof useTaskActions> | undefined;
    try {
      await act(async () => {
        root.render(
          createElement(QueryClientProvider, {
            client,
            children: createElement(function Probe() {
              actions = useTaskActions("repo-a");
              return null;
            }),
          }),
        );
      });
      const first = await actions!.setTaskPin(task, true);
      expect(first).toMatchObject({ state: "pending", kind: "pin" });
      expect(first.code).not.toBe("projection_not_visible");
      await actions!.setTaskPin(task, true);
      expect(pin).toHaveBeenCalledTimes(1);
      // The write receipt is shown as returned: no follow-up receipt read on the writer queue.
      expect(showReceipt).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.restoreAllMocks();
    }
  });
});
