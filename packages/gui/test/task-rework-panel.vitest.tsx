// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { TaskReworkPanel } from "../src/renderer/components/taskDetail/TaskReworkPanel.tsx";
import type { GuiActionResult } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
const mounted: Array<{ root: Root; client: QueryClient }> = [];
afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const task = {
  taskId: "task-rework",
  title: "Rework",
  projectId: "repo-a",
  origin: "native",
  gates: [],
  docs: [],
  ...projectedTaskFields("active"),
} as unknown as TaskRow;
const first = { executionId: "execution-review-cut", submissionDigest: `sha256:${"a".repeat(64)}` };
const second = { executionId: "execution-returned-cut", submissionDigest: `sha256:${"b".repeat(64)}` };
const receipt = (extra: object = {}) =>
  ({
    schema: "command-receipt/v2",
    ok: true,
    command: "task-rework",
    outcome: "applied",
    opId: "op-rework",
    proof: { durable: true, canonicalVisible: true, committedRevision: 9, appliedCut: 9 },
    ...extra,
  }) as GuiActionResult;
const arrangement = (ready = false) => ({
  id: "arrangement-one",
  ...second,
  iteration: 1,
  actor: { principal: { personId: "person-owner" }, executor: null },
  source: "local",
  reason: "Owner arranges this round.",
  ready,
});
async function mount(
  data: { reworkTargets: (typeof first)[]; task: object | null },
  rework = vi.fn(async (_input: unknown) => receipt()),
) {
  const show = vi.fn(async () => receipt({ evidence: JSON.stringify(data) }));
  vi.stubGlobal("window", {
    harness: { showTask: show, reworkTask: rework },
    document,
    localStorage: window.localStorage,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mounted.push({ root, client });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TaskReworkPanel task={task} onNavigateEntity={() => undefined} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector('[data-testid="task-rework-state"]')).not.toBeNull());
  });
  return { host, show, rework };
}
function input(host: HTMLElement, id: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
it("reads canonical targets, sends the selected cut/digest to task-rework, and suppresses a second in-flight request", async () => {
  let resolve!: (value: GuiActionResult) => void;
  const dispatch = vi.fn(
    (_input: unknown) =>
      new Promise<GuiActionResult>((done) => {
        resolve = done;
      }),
  );
  const data = { reworkTargets: [first, second], task: {} },
    view = await mount(data, dispatch);
  expect(view.show).toHaveBeenCalledWith({ repoId: "repo-a", taskId: task.taskId });
  const select = view.host.querySelector<HTMLSelectElement>('[data-testid="task-rework-target"]')!;
  await act(async () => {
    select.value = second.executionId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    input(view.host, "task-rework-reason", "This round belongs to the owner.");
    input(view.host, "task-rework-agent", "registered-worker");
  });
  expect(view.host.querySelector('[data-testid="task-rework-digest"]')!.textContent).toContain(second.submissionDigest);
  await act(async () => {
    view.host.querySelector<HTMLButtonElement>('[data-testid="task-rework-submit"]')!.click();
  });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({
    repoId: "repo-a",
    taskId: task.taskId,
    takeover: true,
    ...second,
    reason: "This round belongs to the owner.",
    agentId: "registered-worker",
  });
  const form = view.host.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  await act(async () => {
    data.task = { executionArrangement: arrangement(true) };
    resolve(receipt({ continuation: { mode: "fresh", outcome: "no_changes" } }));
  });
  await act(async () => {
    await vi.waitFor(() => expect(view.host.textContent).toContain("本轮交接已完成"));
  });
  expect(view.host.querySelector('[data-testid="task-rework-feedback"]')!.textContent).toContain("success");
  expect(view.host.textContent).not.toContain("code=undefined");
});
it.each(["runtime_process_group_unproven", "remote_disconnected"])(
  "shows %s from the continuation and rereads the accepted incomplete arrangement",
  async (code) => {
    const data = { reworkTargets: [second], task: {} };
    const dispatch = vi.fn(async (_input: unknown) => {
      data.task = { executionArrangement: arrangement() };
      return receipt({
        continuation: { outcome: "op_rejected", code, rejectionExplanation: "The old execution has not stopped." },
      });
    });
    const view = await mount(data, dispatch);
    await act(async () => {
      input(view.host, "task-rework-reason", "Owner request.");
    });
    await act(async () => {
      view.host.querySelector<HTMLButtonElement>('[data-testid="task-rework-submit"]')!.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(view.host.textContent).toContain(code));
    });
    expect(view.host.querySelector('[data-testid="task-rework-feedback"]')!.getAttribute("role")).toBe("alert");
    expect(view.host.textContent).toContain("The old execution has not stopped.");
    expect(view.host.textContent).toContain("交接尚未完成");
    expect(view.host.textContent).not.toContain("本轮交接已完成");
    expect(view.show.mock.calls.length).toBeGreaterThan(1);
  },
);
it("does not offer a fabricated target when the canonical list is empty", async () => {
  const view = await mount({ reworkTargets: [], task: null });
  expect(view.host.textContent).toContain("当前没有可接管的提交");
  expect(view.host.querySelector("form")).toBeNull();
  expect(view.rework).not.toHaveBeenCalled();
});
it("preserves a stale-cut rejection instead of replacing the digest or claiming a successful handoff", async () => {
  const dispatch = vi.fn(async (_input: unknown) =>
    receipt({
      ok: false,
      outcome: "op_rejected",
      code: "invalid_transition",
      rejectionExplanation: "The submission digest changed.",
    }),
  );
  const view = await mount({ reworkTargets: [first], task: {} }, dispatch);
  await act(async () => {
    input(view.host, "task-rework-reason", "Owner request.");
  });
  await act(async () => {
    view.host.querySelector<HTMLButtonElement>('[data-testid="task-rework-submit"]')!.click();
  });
  await act(async () => {
    await vi.waitFor(() => expect(view.host.textContent).toContain("invalid_transition"));
  });
  expect(view.host.textContent).toContain("The submission digest changed.");
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0]).toMatchObject(first);
});
