// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskMaterializationControl } from "../src/renderer/components/taskDetail/TaskMaterializationControl.tsx";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const mounted: Root[] = [];
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => mounted.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "harness");
  resetGuiTransportForTest();
});

async function mount(available: boolean | null, locale: "en-US" | "zh-CN" = "zh-CN", failed = false, pending = false) {
  setActiveLocale(locale);
  resetGuiTransportForTest();
  let materialized = false;
  let attempts = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "showTask")
      return {
        schema: "command-receipt/v2",
        ok: true,
        outcome: "applied",
        command: "task-show",
        opId: "show",
        evidence: JSON.stringify({
          reworkTargets: [],
          task: {},
          materializationState: materialized ? "materialized" : "skipped_by_node_policy",
        }),
      };
    if (method === "explainEntityActions")
      return {
        schema: "entity-action-explanation/v1",
        subjects: [
          {
            actions: [
              { action: { id: "materialize" }, available, nextActions: available ? [] : ["Request permission"] },
            ],
          },
        ],
      };
    if (method === "materializeTask") {
      materialized = pending;
      attempts++;
      return {
        schema: "command-receipt/v2",
        ok: !failed,
        outcome: failed ? "op_rejected" : pending && attempts === 1 ? "pending" : "applied",
        ...(pending && attempts === 1
          ? {
              warnings: ["Local materialization conflicts: context.md"],
              guidance: [{ kind: "run-command", args: { command: "ha doc status" } }],
            }
          : {}),
        command: "doc-materialize",
        opId: "materialize",
        ...(failed ? { error: { code: "authorization_denied", hint: "Access revoked" } } : {}),
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  Object.defineProperty(window, "harness", { configurable: true, value: { request } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(TaskMaterializationControl, { repoId: "materialize-test", taskId: "task_history" }),
      ),
    ),
  );
  await act(async () => {
    await vi.waitFor(() => expect(container.querySelector("button")).not.toBeNull());
  });
  return { container, request, button: container.querySelector<HTMLButtonElement>("button")! };
}

describe("Task materialization consumes authoritative availability", () => {
  it.each([false, null])("disables a refused or unevaluated action (%s)", async (available) => {
    const { button, request } = await mount(available);
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(request.mock.calls.filter(([method]) => method === "materializeTask")).toEqual([]);
  });
  it.each(["zh-CN", "en-US"] as const)(
    "sends the declared host-local action and exposes the locale (%s)",
    async (locale) => {
      const { container, button, request } = await mount(true, locale);
      await act(async () => {
        await vi.waitFor(() => expect(button.disabled).toBe(false));
      });
      expect(container.textContent).toContain(locale === "zh-CN" ? "物化到本地" : "Materialize locally");
      await act(async () => button.click());
      expect(request).toHaveBeenCalledWith("materializeTask", { repoId: "materialize-test", taskId: "task_history" });
    },
  );
  it("shows server refusal after availability was allowed", async () => {
    const { container, button } = await mount(true, "en-US", true);
    await act(async () => {
      await vi.waitFor(() => expect(button.disabled).toBe(false));
      button.click();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("Access revoked"),
      );
    });
  });
  it("keeps conflict feedback and retry visible after a partial restore materializes the task plan", async () => {
    const { container, button, request } = await mount(true, "en-US", false, true);
    await act(async () => {
      await vi.waitFor(() => expect(button.disabled).toBe(false));
      button.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain("Local files pending"));
    });
    expect(container.textContent).toContain("context.md");
    expect(container.textContent).toContain("ha doc status");
    const retry = container.querySelector<HTMLButtonElement>("button")!;
    expect(retry.textContent).toContain("Retry materialization");
    expect(retry.disabled).toBe(false);
    await act(async () => retry.click());
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector("button")).toBeNull());
    });
    expect(request.mock.calls.filter(([method]) => method === "materializeTask")).toHaveLength(2);
  });
});
