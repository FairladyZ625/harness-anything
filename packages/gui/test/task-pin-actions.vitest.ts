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
              schema: "task/v1",
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
});
