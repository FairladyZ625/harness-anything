// harness-test-tier: contract
// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GuiActionResult } from "../src/api/renderer-dto.ts";
import type { TaskListSuccess } from "../src/renderer/api-client.ts";
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
    proof: { committedRevision: 9, appliedCut: 9, durable: true, canonicalVisible: true, worktreeVisible: true },
    ...over,
  }) as unknown as GuiActionResult;

describe("useTaskActions pin write channel", () => {
  it("pins and unpins through the daemon pin action and re-reads the projection", async () => {
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
    const list = (pinned: boolean): TaskListSuccess => ({
      ok: true,
      status: "ready",
      rows: [
        {
          taskId: "task-pin",
          createdAt: null,
          updatedAt: "2026-08-30T00:00:00.000Z",
          generation: "v1",
          snapshot: {
            revision: 9,
            task: {
              schema: "task/v2",
              taskId: "task-pin",
              title: "Pin me",
              pinned,
            },
            executions: [],
            reviews: [],
            consents: [],
            codeDocWitnesses: [],
            gateWitnesses: [],
            lease: null,
          },
        } as never,
      ],
      invalidRows: [],
      watermark: 9,
      sourceRevision: 9,
      warnings: [],
    });
    const pin = vi.fn(async () => receipt()),
      unpin = vi.fn(async () => receipt()),
      reads = vi.fn().mockResolvedValueOnce(list(true)).mockResolvedValueOnce(list(false));
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
      client.setQueryData(taskQueryKeys.list("repo-a"), list(false));

      let feedback = await actions!.setTaskPin(task(false), true);
      expect(pin).toHaveBeenCalledWith({ repoId: "repo-a", taskId: "task-pin" });
      expect(feedback).toMatchObject({ state: "success", kind: "pin" });

      feedback = await actions!.setTaskPin(task(true), false);
      expect(unpin).toHaveBeenCalledWith({ repoId: "repo-a", taskId: "task-pin" });
      expect(feedback).toMatchObject({ state: "success", kind: "pin" });
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.restoreAllMocks();
    }
  });

  // 回执 applied 但重读还没看到目标 cut(实测 canonical 追平要约 2s)时,写入**不是**在飞:
  // 旧实现把这条也留在 in-flight 锁里,于是 pin 一次之后 unpin 再也发不出去——控件永久死掉,
  // 而且界面一句话都不说。这一条守住「投影滞后不锁控件」,同时不放开真正归属未知的回执。
  it("keeps the pin control usable after a receipt whose projection has not caught up", async () => {
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
    const list = (pinned: boolean): TaskListSuccess => ({
      ok: true,
      status: "ready",
      rows: [
        {
          taskId: "task-pin",
          createdAt: null,
          updatedAt: "2026-08-30T00:00:00.000Z",
          generation: "v1",
          snapshot: {
            revision: 9,
            task: { schema: "task/v2", taskId: "task-pin", title: "Pin me", pinned },
            executions: [],
            reviews: [],
            consents: [],
            codeDocWitnesses: [],
            gateWitnesses: [],
            lease: null,
          },
        } as never,
      ],
      invalidRows: [],
      watermark: 9,
      sourceRevision: 9,
      warnings: [],
    });
    const pin = vi.fn(async () => receipt()),
      unpin = vi.fn(async () => receipt()),
      // 第一次重读还停在 pin 之前的那一版 → 落定成 projection_not_visible。
      reads = vi.fn().mockResolvedValueOnce(list(false)).mockResolvedValueOnce(list(false));
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
      client.setQueryData(taskQueryKeys.list("repo-a"), list(false));

      const lagging = await actions!.setTaskPin(task(false), true);
      expect(lagging).toMatchObject({ state: "pending", kind: "pin", code: "projection_not_visible" });
      expect(pin).toHaveBeenCalledTimes(1);

      // 同一条任务的下一次 pin 意图必须真的发出去,而不是拿回上一次那个 promise。
      const again = await actions!.setTaskPin(task(true), false);
      expect(unpin).toHaveBeenCalledTimes(1);
      expect(again).toMatchObject({ kind: "pin" });

      // 实测真机落在另一条同类落定上:回执 outcome=applied,但 proof 还没断言
      // canonical 可见(code=canonical_not_visible)。它同样不得锁死控件。
      vi.mocked(harnessClient.pinTask).mockClear();
      const unproven = receipt({
        proof: { committedRevision: 9, appliedCut: 9, durable: true, canonicalVisible: false, worktreeVisible: true },
      });
      vi.spyOn(harnessClient, "pinTask").mockImplementation(async () => unproven);
      vi.spyOn(harnessClient, "showReceipt").mockImplementation(async () => unproven as never);
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
    vi.spyOn(harnessClient, "showReceipt").mockImplementation(
      async () => receipt({ outcome: "pending", opId: "op-pin-pending" }) as never,
    );

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
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      vi.restoreAllMocks();
    }
  });
});
