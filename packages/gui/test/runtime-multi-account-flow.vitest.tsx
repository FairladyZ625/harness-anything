// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProvidersView } from "../src/renderer/views/ProvidersView.tsx";
import { AgentCard } from "../src/renderer/components/runtime/AgentCard.tsx";
import { runtimeInstanceClient } from "../src/renderer/runtime-instance-client.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { agentEntityClient } from "../src/renderer/agent-entity-client.ts";
import { decisionProviderClient } from "../src/renderer/decision-provider-client.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { assertPreloadPayload } from "../src/preload/allowlist.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { RuntimeInstanceSummary } from "@harness-anything/daemon/protocol";

const hydrogen = "gemini-4-hydrogen-low",
  carbon = "gemini-4-carbon-high";
const installation = {
  installationId: "agy-install",
  kindId: "agy",
  version: "1.1.15",
  observedAt: "2026-11-14T00:00:00Z",
  models: [hydrogen, carbon],
  defaultModel: hydrogen,
};
const receipt = { schema: "command-receipt/v2", ok: true };
let root: Root | undefined, client: QueryClient | undefined;
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  client?.clear();
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function field<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!node) throw new Error(`Missing ${id}`);
  return node;
}
async function change(id: string, value: string) {
  const input = field<HTMLInputElement | HTMLSelectElement>(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function click(id: string) {
  await act(async () => field<HTMLButtonElement>(id).click());
}
async function settled(check: () => void) {
  await act(async () => {
    await vi.waitFor(check);
  });
}
async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root!.render(createElement(QueryClientProvider, { client: client! }, element)));
}
function ProvidersHarness() {
  const [ref, setRef] = useState<string | null>(null);
  return createElement(ProvidersView, {
    repoId: "demo",
    focusedEntityRef: ref,
    onSelectEntity: setRef,
    onBack: () => setRef(null),
  });
}
function mockReadSurfaces() {
  vi.spyOn(agentEntityClient, "listAgents").mockResolvedValue([]);
  vi.spyOn(agentRuntimeClient, "overview").mockResolvedValue({
    schema: "agent-runtime-overview/v1",
    sessions: [],
    instances: [],
    installations: [],
  } as never);
  vi.spyOn(decisionProviderClient, "list").mockResolvedValue([]);
  vi.spyOn(harnessClient, "getSettings").mockResolvedValue({
    schema: "settings-read/v1",
    revision: 7,
    settings: { runtime: { allowedInstances: [] } },
    values: {},
  } as never);
  vi.spyOn(harnessClient, "updateSettings").mockResolvedValue(receipt as never);
}
describe("multi-account provider workflow", () => {
  it("creates an independent account, opens native login, refreshes its own models and quota, and saves an exact subset and tier", async () => {
    mockReadSurfaces();
    let instance: RuntimeInstanceSummary | null = null;
    vi.spyOn(runtimeInstanceClient, "list").mockImplementation(async () => ({
      instances: instance ? [instance] : [],
      installations: [installation],
      subscriptionIsolationKinds: ["agy"],
    }));
    const create = vi.spyOn(runtimeInstanceClient, "create").mockImplementation(async (input, repoId) => {
      assertPreloadPayload("createRuntimeInstance", { ...input, repoId });
      instance = {
        schemaVersion: 2,
        instanceId: input.instanceId,
        name: input.name,
        kindId: input.kindId,
        installationId: input.installationId,
        providerId: input.providerId,
        models: input.models,
        defaultModel: input.defaultModel ?? input.models[0]!,
        enabled: true,
        tier: input.tier,
        credentialSource: "instance",
        permissionMode: null,
        isolationState: "enforced",
        configuration: {},
        authMode: "subscription",
        authState: "unauthenticated",
        authReadiness: { status: "not-ready", code: "runtime_subscription_required", hint: "Sign in" },
      };
      return receipt;
    });
    const auth = vi.spyOn(runtimeInstanceClient, "auth").mockResolvedValue({
      schema: "terminal-control-receipt/v1",
      outcome: "applied",
      sessionId: "login-test",
    } as never);
    const probe = vi.spyOn(runtimeInstanceClient, "probe").mockImplementation(async () => {
      instance = {
        ...instance!,
        authState: "authenticated",
        authReadiness: { status: "ready", code: null, hint: null },
        availableModels: [hydrogen, "gemini-3.8-flash"],
        providerHealth: {
          nodeId: "test-node",
          failureStreak: 0,
          cooldownUntil: "2026-11-14T12:00:00Z",
          frozen: false,
          frozenUntil: null,
          reason: "quota_exhausted",
          lastFailureAt: null,
          lastResetAt: null,
        },
      };
      return instance;
    });
    const update = vi.spyOn(runtimeInstanceClient, "update").mockImplementation(async (input, repoId) => {
      assertPreloadPayload("updateRuntimeInstance", { ...input, repoId });
      instance = { ...instance!, models: input.models!, defaultModel: input.defaultModel!, tier: input.tier };
      return receipt;
    });
    await mount(createElement(ProvidersHarness));
    await click("runtime-new-runtimes");
    await click("provider-type-llm");
    await click("new-runtime-kind-agy");
    await change("new-runtime-id", "agy-pro");
    await change("new-runtime-name", "AGY Pro");
    await change("new-runtime-credential-source", "instance");
    await change("new-runtime-tier", "2");
    expect(field<HTMLSelectElement>("new-runtime-isolation").disabled).toBe(true);
    await click("new-runtime-create");
    await settled(() => expect(auth).toHaveBeenCalledWith("demo", "agy-pro", "login"));
    expect(create.mock.calls[0]).toEqual([
      {
        instanceId: "agy-pro",
        name: "AGY Pro",
        kindId: "agy",
        installationId: "agy-install",
        providerId: "google",
        models: [hydrogen, carbon],
        defaultModel: hydrogen,
        authMode: "subscription",
        isolationState: "enforced",
        credentialSource: "instance",
        tier: 2,
        agy: {},
      },
      "demo",
    ]);
    await settled(() => expect(document.querySelector('[data-testid="runtime-account-refresh"]')).not.toBeNull());
    await click("runtime-account-refresh");
    await settled(() => expect(probe).toHaveBeenCalledWith("agy-pro", "demo"));
    await settled(() =>
      expect(document.querySelector('[data-testid="runtime-card-health"]')?.textContent).toContain("quota_exhausted"),
    );
    await click("runtime-provider-edit");
    const labels = [...field("runtime-provider-models").querySelectorAll("label")];
    expect(labels.some((label) => label.textContent === "gemini-3.8-flash")).toBe(true);
    // Account models replace the installation's Ultra catalog. The old authored Carbon selection remains removable.
    await act(async () =>
      labels
        .find((label) => label.textContent === carbon)!
        .querySelector<HTMLInputElement>("input")!
        .click(),
    );
    await change("runtime-provider-tier", "3");
    await click("runtime-provider-save");
    await settled(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]).toEqual([
      {
        instanceId: "agy-pro",
        name: "AGY Pro",
        installationId: "agy-install",
        models: [hydrogen],
        defaultModel: hydrogen,
        isolationState: "enforced",
        credentialSource: "instance",
        tier: 3,
        effort: "",
      },
      "demo",
    ]);
    expect(document.querySelector('[data-testid="runtime-provider-editor"]')).toBeNull();
  });
  it.each(["en-US", "zh-CN"] as const)(
    "saves sticky, lru and repository inheritance in the Agent editor (%s)",
    async (locale) => {
      setActiveLocale(locale);
      const onSave = vi.fn();
      await mount(
        createElement(AgentCard, {
          detail: {
            id: "worker",
            name: "Worker",
            role: "worker",
            runtimes: [{ type: "agy", model: hydrogen }],
            instructions: "Work",
            skills: [],
            prompts: [],
            preset: null,
            revision: 7,
            retirement: null,
            instance: null,
            permissionMode: null,
            hostAccess: "isolated",
            hostAccessSource: "declared",
            selectionStrategy: "sticky",
          },
          row: null,
          squads: [],
          instances: [],
          busy: false,
          onSave,
          onDispatch: () => undefined,
          onSelectRuntime: () => undefined,
          onSelectAgent: () => undefined,
        }),
      );
      expect(field<HTMLSelectElement>("agent-selection-strategy").value).toBe("sticky");
      await change("agent-selection-strategy", "lru");
      await click("agent-save");
      expect(onSave.mock.calls[0]?.[0].selectionStrategy).toBe("lru");
      assertPreloadPayload("saveAgent", { repoId: "demo", declaration: onSave.mock.calls[0]![0], expectedVersion: 7 });
      await change("agent-selection-strategy", "");
      await click("agent-save");
      expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("selectionStrategy");
      expect(document.body.textContent).not.toContain("agentRuntime.selection");
      setActiveLocale("en-US");
    },
  );
});

it("does not let a cached automatic account probe mask a later manual model/quota refresh", async () => {
  mockReadSurfaces();
  let instance: RuntimeInstanceSummary = {
    schemaVersion: 2,
    instanceId: "agy-pro",
    name: "AGY Pro",
    kindId: "agy",
    installationId: installation.installationId,
    providerId: "google",
    models: [hydrogen],
    defaultModel: hydrogen,
    enabled: true,
    tier: 1,
    credentialSource: "operator",
    permissionMode: null,
    isolationState: "enforced",
    configuration: {},
    authMode: "subscription",
    authState: "unknown",
    authReadiness: { status: "not-ready", code: "runtime_auth_not_checked", hint: null },
  };
  vi.spyOn(runtimeInstanceClient, "list").mockImplementation(async () => ({
    instances: [instance],
    installations: [installation],
    subscriptionIsolationKinds: ["agy"],
  }));
  const probe = vi.spyOn(runtimeInstanceClient, "probe").mockImplementation(async () => {
    instance = {
      ...instance,
      authState: "authenticated",
      authReadiness: { status: "ready", code: null, hint: null },
      availableModels: [hydrogen, probe.mock.calls.length === 1 ? "old-catalog-model" : "fresh-catalog-model"],
      providerHealth: {
        nodeId: "test-node",
        failureStreak: 0,
        cooldownUntil: probe.mock.calls.length === 1 ? null : "2026-11-14T12:00:00Z",
        frozen: false,
        frozenUntil: null,
        reason: probe.mock.calls.length === 1 ? null : "quota_exhausted",
        lastFailureAt: null,
        lastResetAt: null,
      },
    };
    return instance;
  });
  await mount(createElement(ProvidersHarness));
  await settled(() => expect(probe).toHaveBeenCalledTimes(1));
  await settled(() => expect(field<HTMLButtonElement>("runtime-account-refresh").disabled).toBe(false));
  await click("runtime-account-refresh");
  await settled(() => expect(probe).toHaveBeenCalledTimes(2));
  await settled(() => expect(field("runtime-card-health").textContent).toContain("quota_exhausted"));
  await click("runtime-provider-edit");
  expect(field("runtime-provider-models").textContent).toContain("fresh-catalog-model");
  expect(field("runtime-provider-models").textContent).not.toContain("old-catalog-model");
  expect(field<HTMLSelectElement>("runtime-provider-default-model").value).toBe(hydrogen);
});
