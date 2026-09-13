// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { RuntimeCard } from "../src/renderer/components/runtime/RuntimeCard.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const codexInstallations = [
  { installationId: "codex-install-a", kindId: "codex", version: "1.0.0", observedAt: "2026-08-23T00:00:00.000Z" },
] as const;
const codexInstance = {
  schemaVersion: 2,
  instanceId: "codex-effort-edit",
  name: "Codex Effort Edit",
  kindId: "codex",
  installationId: "codex-install-a",
  providerId: "openai",
  models: ["model-a"],
  defaultModel: "model-a",
  enabled: true,
  permissionMode: "bypass",
  isolationState: "enforced",
  configuration: { reasoningEffort: "high", baseUrl: null, baseUrlConfigured: false },
  authMode: "subscription",
  authState: "authenticated",
  authReadiness: { status: "ready", code: null, hint: null },
} as const;
const agyInstallations = [
  { installationId: "agy-install-a", kindId: "agy", version: "1.0.0", observedAt: "2026-08-23T00:00:00.000Z" },
] as const;
const agyInstance = {
  ...codexInstance,
  instanceId: "agy-effort-edit",
  name: "AGY Effort Edit",
  kindId: "agy",
  installationId: "agy-install-a",
  providerId: "google",
  isolationState: "operator-environment",
  configuration: { effort: "high" },
} as const;
const apiCodexInstance = {
  ...codexInstance,
  instanceId: "codex-api-edit",
  name: "Codex API Edit",
  authMode: "api-key" as const,
  configuration: {
    ...(codexInstance as { readonly configuration: object }).configuration,
    baseUrl: "https://old-gateway.example/v1",
    baseUrlConfigured: true,
  },
} as const;

const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function mountProviderCard(
  onUpdate: ReturnType<typeof vi.fn>,
  instance: typeof codexInstance,
  installations: readonly object[],
) {
  const client = new QueryClient(),
    container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(
      createElement(RuntimeCard, {
        instance,
        installations,
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
      } as never),
    );
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  expect(element, `missing data-testid=${testId}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}

async function click(testId: string) {
  await act(async () => {
    byTestId(testId).click();
  });
  await flushEffects();
}

async function input(testId: string, value: string) {
  await act(async () => {
    const field = byTestId(testId) as HTMLInputElement,
      setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flushEffects();
}

async function select(testId: string, value: string) {
  await act(async () => {
    const field = byTestId(testId) as HTMLSelectElement;
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flushEffects();
}

describe("provider edit dialog field controls", () => {
  it("edits the base URL of an API-mode provider in place and can clear it back", async () => {
    const onUpdate = vi.fn();
    await mountProviderCard(onUpdate, apiCodexInstance, codexInstallations);

    await click("runtime-provider-edit");
    expect((byTestId("runtime-provider-base-url") as HTMLInputElement).value).toBe("https://old-gateway.example/v1");
    await input("runtime-provider-base-url", "https://new-gateway.example/v1");
    await click("runtime-provider-save");
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "codex-api-edit",
        baseUrl: "https://new-gateway.example/v1",
      }),
    );

    onUpdate.mockClear();
    await click("runtime-provider-edit");
    await input("runtime-provider-base-url", "");
    await click("runtime-provider-save");
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "" }));
  });

  it("keeps the base URL field disabled on a subscription provider", async () => {
    const onUpdate = vi.fn();
    await mountProviderCard(onUpdate, codexInstance, codexInstallations);
    await click("runtime-provider-edit");
    expect((byTestId("runtime-provider-base-url") as HTMLInputElement).disabled).toBe(true);
    await click("runtime-provider-cancel");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("edits codex reasoning effort as free text in place and can clear it back", async () => {
    const onUpdate = vi.fn();
    await mountProviderCard(onUpdate, codexInstance, codexInstallations);
    await click("runtime-provider-edit");
    expect((byTestId("runtime-provider-effort") as HTMLInputElement).value).toBe("high");
    await input("runtime-provider-effort", "xhigh");
    await click("runtime-provider-save");
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "codex-effort-edit", effort: "xhigh" }),
    );

    onUpdate.mockClear();
    await click("runtime-provider-edit");
    await input("runtime-provider-effort", "");
    await click("runtime-provider-save");
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ effort: "" }));
  });

  it("edits agy effort from the plane enum and never offers launcher-rewritten values", async () => {
    const onUpdate = vi.fn();
    await mountProviderCard(onUpdate, agyInstance, agyInstallations);
    await click("runtime-provider-edit");
    const effortSelect = byTestId("runtime-provider-effort") as HTMLSelectElement;
    expect([...effortSelect.options].map((option) => option.value)).toEqual(["", "low", "medium", "high"]);
    await select("runtime-provider-effort", "low");
    await click("runtime-provider-save");
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "agy-effort-edit", effort: "low" }));
  });
});
