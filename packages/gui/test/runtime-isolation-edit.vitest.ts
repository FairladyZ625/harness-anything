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
  onUpdate: (input: RuntimeInstanceUpdateInput) => void,
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
    'form[data-testid="runtime-instance-permissions"] button[type="submit"]',
  );
  if (!button) throw new Error("missing permissions submit button");
  await act(async () => button.click());
}

describe("RuntimeCard isolation editing follows the declared capability states", () => {
  it("shows a codex instance's current isolation state and submits edits with the update payload", async () => {
    const onUpdate = vi.fn();
    const container = await renderCard(runtimeInstance("codex", "enforced"), onUpdate);
    const isolation = container.querySelector<HTMLSelectElement>('[data-testid="runtime-instance-isolation"]');
    expect(isolation).not.toBeNull();
    expect(isolation?.value).toBe("enforced");
    await pickSelect(container, "runtime-instance-isolation", "operator-environment");
    await submitPermissions(container);
    expect(onUpdate).toHaveBeenCalledWith({
      instanceId: "codex-edit",
      permissionMode: "bypass",
      isolationState: "operator-environment",
    });
  });

  it("round-trips: an instance read back at the submitted state renders that state", async () => {
    const container = await renderCard(runtimeInstance("codex", "operator-environment"), () => undefined);
    expect(container.querySelector<HTMLSelectElement>('[data-testid="runtime-instance-isolation"]')?.value).toBe(
      "operator-environment",
    );
  });

  it("offers no isolation choice for a kind that declares a single state", async () => {
    const onUpdate = vi.fn();
    const container = await renderCard(runtimeInstance("agy", "operator-environment"), onUpdate);
    expect(container.querySelector('[data-testid="runtime-instance-isolation"]')).toBeNull();
    await submitPermissions(container);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
