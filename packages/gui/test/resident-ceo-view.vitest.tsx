// harness-test-tier: contract
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { ResidentCeoProfileRead } from "../src/renderer/api-client.ts";

const api = vi.hoisted(() => ({
  getResidentCeo: vi.fn(),
  configureResidentCeo: vi.fn(),
  startResidentCeo: vi.fn(),
  stopResidentCeo: vi.fn(),
  chatResidentCeo: vi.fn(),
  listInstances: vi.fn(),
}));

vi.mock("../src/renderer/api-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/api-client.ts")>()),
  harnessClient: api,
}));
vi.mock("../src/renderer/runtime-instance-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/runtime-instance-client.ts")>()),
  runtimeInstanceClient: { list: api.listInstances },
}));

import { ResidentCeoView } from "../src/renderer/views/ResidentCeoView.tsx";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

const mounted: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const profile: ResidentCeoProfileRead = {
  schema: "resident-ceo-profile/v1",
  principalPersonId: "person-owner",
  runtimeInstanceId: "instance-one",
  model: "model-one",
  heartbeatIntervalSec: 300,
  persistentSessionId: "provider-session-one",
  status: "running",
  lastWake: null,
  updatedAt: "2026-11-24T00:00:00.000Z",
};

describe("resident CEO view", () => {
  it("shows saved status, lets the owner continue the configured conversation, and displays its reply", async () => {
    api.getResidentCeo.mockResolvedValue({ ok: true, profile });
    api.listInstances.mockResolvedValue({
      instances: [
        {
          instanceId: "instance-one",
          name: "Local provider",
          enabled: true,
          models: ["model-one"],
          defaultModel: "model-one",
        },
      ],
    });
    api.chatResidentCeo.mockResolvedValue({ ok: true, profile, response: "The current plan is ready." });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(["resident-ceo", "repo-one"], { ok: true, profile });
    queryClient.setQueryData(["runtime-instances", "machine", "repo-one"], {
      instances: [
        {
          instanceId: "instance-one",
          name: "Local provider",
          enabled: true,
          models: ["model-one"],
          defaultModel: "model-one",
        },
      ],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ResidentCeoView, { repoId: "repo-one" }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="resident-ceo-status"]')?.textContent).toBe("Running");
    expect(container.querySelector('[data-testid="resident-ceo-phase1-boundary"]')?.textContent).toContain(
      "read-only assessment and advisory reply",
    );
    const input = container.querySelector('input[aria-label="Send message"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Review the plan");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.chatResidentCeo).toHaveBeenCalledWith({ repoId: "repo-one", message: "Review the plan" });
    expect(container.querySelector('[data-testid="resident-ceo-reply"]')?.textContent).toBe(
      "The current plan is ready.",
    );
  });
});
