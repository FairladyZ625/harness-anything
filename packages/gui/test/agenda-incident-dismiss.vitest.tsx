// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GuiActionResult } from "../src/api/renderer-dto.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { runtimeCommandClient } from "../src/renderer/runtime-command-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { AgendaWorkbenchItem } from "../src/renderer/model/agenda-workbench.ts";
import { AgendaInboxActions } from "../src/renderer/views/agenda/AgendaInboxActions.tsx";

let host: HTMLDivElement;
let root: Root;
let cache: QueryClient;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(harnessClient, "getTaskDispatches").mockResolvedValue({
    ok: true,
    status: "ready",
    dispatches: [],
    page: { limit: 50, cursor: null, nextCursor: null, truncated: false },
  } as never);
});
afterEach(() => {
  act(() => root.unmount());
  cache.clear();
  host.remove();
  vi.restoreAllMocks();
});

function render(ruling = false) {
  const item: AgendaWorkbenchItem = {
    key: "incident",
    bucket: "inbox",
    quiet: false,
    taskId: "task_incident",
    workRootId: null,
    asks: [],
    row: {
      id: "dispatch_incident",
      group: "adjudicate",
      title: "Incident",
      hint: "",
      since: null,
      scoreRef: null,
      target: "task/task_incident",
      ruling: {
        taskId: "task_incident",
        title: "Incident",
        work: null,
        pinned: false,
        dispatchId: "dispatch_incident",
        executionId: "execution_incident",
        attention: "question",
        question: "Close this incident?",
        options: ruling ? ["Continue"] : [],
        askedAt: "2026-11-15T00:00:00.000Z",
        blockingAssessment: { state: "clear" } as never,
      },
    },
  };
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(AgendaInboxActions, {
          repoId: "repo",
          item,
          tasks: [],
          onNavigateEntity: vi.fn(),
          onRetain: vi.fn(),
        }),
      ),
    ),
  );
}
function click(testId: string) {
  act(() => host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
}
const receipt = (outcome: GuiActionResult["outcome"], extra: object = {}): GuiActionResult => ({
  schema: "command-receipt/v2",
  ok: outcome !== "op_rejected",
  command: "runtime-incident-dismiss",
  opId: "op-host-local",
  outcome,
  status: "settled_no_write",
  ...extra,
});

// F-HOSTLOCAL-DISMISS: real host-local receipts never carry canonical proof.
it.each(["applied", "no_changes"] as const)("reports a settled host-local %s as Incident closed", async (outcome) => {
  const dismiss = vi.spyOn(harnessClient, "dismissRuntimeIncident").mockResolvedValue(receipt(outcome));
  const showReceipt = vi.spyOn(harnessClient, "showReceipt");
  const spawn = vi.spyOn(runtimeCommandClient, "spawn");
  render();
  click("agenda-incident-dismiss");
  await act(async () => vi.waitFor(() => expect(host.textContent).toContain("事故已关闭")));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-testid="agenda-ruling-check-receipt"]')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('[data-testid="agenda-incident-dismiss"]')!.disabled).toBe(true);
  expect(showReceipt).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it("preserves a host rejection without reporting a close or offering a canonical receipt check", async () => {
  vi.spyOn(harnessClient, "dismissRuntimeIncident").mockResolvedValue(
    receipt("op_rejected", { status: undefined, code: "content_not_ready", rejectionExplanation: "Claim in flight" }),
  );
  render();
  click("agenda-incident-dismiss");
  await act(async () => vi.waitFor(() => expect(host.textContent).toContain("content_not_ready")));
  expect(host.textContent).toContain("Claim in flight");
  expect(host.textContent).not.toContain("事故已关闭");
  expect(host.querySelector('[data-testid="agenda-ruling-check-receipt"]')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('[data-testid="agenda-incident-dismiss"]')!.disabled).toBe(false);
});

it("still requires canonical proof for ruling answers and never starts a continuation without it", async () => {
  vi.spyOn(harnessClient, "resolveTaskEscalation").mockResolvedValue(receipt("applied"));
  const spawn = vi.spyOn(runtimeCommandClient, "spawn");
  render(true);
  click("agenda-ruling-option-0");
  click("agenda-ruling-submit");
  await act(async () =>
    vi.waitFor(() => expect(host.querySelector('[data-testid="agenda-ruling-check-receipt"]')).not.toBeNull()),
  );
  expect(host.textContent).not.toContain("答复已落库");
  expect(host.textContent).not.toContain("事故已关闭");
  expect(spawn).not.toHaveBeenCalled();
});
