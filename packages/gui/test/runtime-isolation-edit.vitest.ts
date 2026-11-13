// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { RuntimeCard } from "../src/renderer/components/runtime/RuntimeCard.tsx";
import type { RuntimeInstanceUpdateInput } from "../src/renderer/runtime-instance-client.ts";
import type { RuntimeInstanceSummary } from "@harness-anything/daemon/client";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

const installations = [
  {
    installationId: "installation-codex",
    kindId: "codex",
    version: "0.147.0",
    observedAt: "2026-09-14T00:00:00.000Z",
  },
] as const;

function runtimeInstance(
  kindId: "codex" | "agy",
  isolationState: "enforced" | "operator-environment",
): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId: `${kindId}-edit`,
    name: `${kindId === "codex" ? "Codex" : "Agy"} Edit`,
    kindId,
    installationId: installations[0].installationId,
    providerId: kindId === "codex" ? "openai" : "google",
    models: [kindId === "codex" ? "gpt-5.6-sol" : "gemini-3.1-pro-low"],
    defaultModel: kindId === "codex" ? "gpt-5.6-sol" : "gemini-3.1-pro-low",
    enabled: true,
    permissionMode: "bypass",
    authMode: "subscription",
    authState: "authenticated",
    authReadiness: { status: "ready", code: null, hint: null },
    isolationState,
    configuration: {},
  };
}

const mounted: { root: Root; container: HTMLElement }[] = [];

async function renderCard(
  instance: RuntimeInstanceSummary,
  onUpdate: (input: RuntimeInstanceUpdateInput) => Promise<unknown>,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(RuntimeCard, {
        instance,
        installations: [...installations],
        agents: [],
        liveSessions: 0,
        busy: false,
        onSelectRuntime: () => undefined,
        projectAllowed: true,
        projectSettingsBusy: false,
        onSetProjectAllowed: () => undefined,
        onSelectAgent: () => undefined,
        onAuth: () => undefined,
        onValidate: () => undefined,
        onSetEnabled: () => undefined,
        onUpdate,
        onDelete: () => undefined,
        onSelfTest: async () => null,
      }),
    );
  });
  mounted.push({ root, container });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="runtime-provider-edit"]')!.click());
  return container;
}

afterEach(async () => {
  for (const { root } of mounted.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function pickSelect(container: HTMLElement, testId: string, value: string): Promise<void> {
  const field = container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
  if (!field) throw new Error(`missing ${testId}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submitPermissions(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(
    'form[data-testid="runtime-provider-editor"] button[type="submit"]',
  );
  if (!button) throw new Error("missing permissions submit button");
  await act(async () => button.click());
}

describe("RuntimeCard isolation editing follows the declared capability states", () => {
  it("saves permission and search edits in the same form and locks API-key isolation", async () => {
    const onUpdate = vi.fn(async () => ({ ok: false }));
    const container = await renderCard({ ...runtimeInstance("codex", "enforced"), authMode: "api-key" }, onUpdate);
    expect(container.querySelector<HTMLSelectElement>('[data-testid="runtime-provider-isolation"]')?.disabled).toBe(
      true,
    );
    expect(container.textContent).toContain("API key requires dedicated environment");
    await pickSelect(container, "runtime-provider-permission-mode", "workspace-write");
    await pickSelect(container, "runtime-provider-web-search", "cached");
    await submitPermissions(container);
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "workspace-write", isolationState: "enforced", webSearch: "cached" }),
    );
    expect(container.querySelector('[data-testid="runtime-instance-permissions"]')).toBeNull();
  });

  it.each([
    {
      authMode: "subscription" as const,
      providerId: "openai",
      configuration: { baseUrl: "https://gateway.example/v1" },
      blocked: true,
    },
    {
      authMode: "api-key" as const,
      providerId: "openai",
      configuration: { baseUrl: "https://gateway.example/v1", wire_api: "chat" },
      blocked: true,
    },
    { authMode: "subscription" as const, providerId: "custom", configuration: {}, blocked: true },
    {
      authMode: "api-key" as const,
      providerId: "custom",
      configuration: { baseUrl: "https://gateway.example/v1", wire_api: "responses" },
      blocked: false,
    },
  ])(
    "offers only search tiers the write boundary can admit: $authMode $providerId $configuration",
    async ({ blocked, ...context }) => {
      const container = await renderCard(
        { ...runtimeInstance("codex", "enforced"), ...context },
        vi.fn(async () => ({ ok: false })),
      );
      const select = container.querySelector<HTMLSelectElement>('[data-testid="runtime-provider-web-search"]')!;
      expect(select.querySelector<HTMLOptionElement>('[value="disabled"]')?.disabled).toBe(false);
      expect(select.querySelector<HTMLOptionElement>('[value="cached"]')?.disabled).toBe(blocked);
      expect(select.querySelector<HTMLOptionElement>('[value="live"]')?.disabled).toBe(blocked);
    },
  );

  it("shows a codex instance's current isolation state and submits edits with the update payload", async () => {
    const onUpdate = vi.fn(async () => ({ ok: false }));
    const container = await renderCard(runtimeInstance("codex", "enforced"), onUpdate);
    const isolation = container.querySelector<HTMLSelectElement>('[data-testid="runtime-provider-isolation"]');
    expect(isolation).not.toBeNull();
    expect(isolation?.value).toBe("enforced");
    await pickSelect(container, "runtime-provider-isolation", "operator-environment");
    await submitPermissions(container);
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "codex-edit",
        permissionMode: "bypass",
        isolationState: "operator-environment",
      }),
    );
  });

  it("round-trips: an instance read back at the submitted state renders that state", async () => {
    const container = await renderCard(runtimeInstance("codex", "operator-environment"), async () => ({ ok: false }));
    expect(container.querySelector<HTMLSelectElement>('[data-testid="runtime-provider-isolation"]')?.value).toBe(
      "operator-environment",
    );
  });

  it("offers no isolation choice for a kind that declares a single state", async () => {
    const onUpdate = vi.fn(async () => ({ ok: false }));
    const container = await renderCard(runtimeInstance("agy", "operator-environment"), onUpdate);
    expect(container.querySelector('[data-testid="runtime-provider-isolation"]')).toBeNull();
    await submitPermissions(container);
    expect(onUpdate.mock.calls[0]?.[0]).not.toHaveProperty("isolationState");
  });
});
