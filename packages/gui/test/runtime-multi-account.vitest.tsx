// harness-test-tier: contract
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildRuntimeInstanceCreatePayload,
  buildRuntimeInstanceUpdatePayload,
  runtimeInstanceEditForm,
  runtimeInstanceFormReady,
  type CreateInstanceFormState,
} from "../src/renderer/runtime-instance-form.ts";
import { RuntimeAccessFields } from "../src/renderer/components/runtime/RuntimeAccessFields.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const form: CreateInstanceFormState = {
  instanceId: "agy-pro",
  name: "AGY Pro",
  kindId: "agy",
  installationId: "agy-install",
  providerId: "google",
  models: ["gemini-4-hydrogen-low"],
  reasoningEffort: "",
  fast: false,
  baseUrl: "",
  authMode: "subscription",
  apiKey: "",
  wireApi: "",
  requiresOpenAiAuth: false,
  isolation: "enforced",
  credentialSource: "instance",
  independentCredentialsSupported: true,
  tier: 2,
};
const instance = {
  schemaVersion: 2 as const,
  instanceId: "agy-pro",
  name: "AGY Pro",
  kindId: "agy",
  installationId: "agy-install",
  providerId: "google",
  models: ["gemini-4-hydrogen-low"],
  availableModels: ["gemini-4-hydrogen-low", "gemini-4-carbon-high"],
  defaultModel: "gemini-4-hydrogen-low",
  enabled: true,
  tier: 3,
  credentialSource: "instance" as const,
  permissionMode: "bypass" as const,
  isolationState: "enforced" as const,
  configuration: {},
  authMode: "subscription" as const,
  authState: "authenticated" as const,
  authReadiness: { status: "ready" as const, code: null, hint: null },
};
let root: Root | undefined;
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
});
describe("subscription multi-account contracts (dec_DA1602487428A58E8B446ECE38)", () => {
  it("bootstraps independent accounts without authoring an installation model, and preserves explicit edit choices", () => {
    expect(
      buildRuntimeInstanceCreatePayload(form, "agy-install", {
        models: instance.availableModels,
        defaultModel: "gemini-4-carbon-high",
      }),
    ).toMatchObject({
      credentialSource: "instance",
      isolationState: "enforced",
      tier: 2,
      models: [],
      enabled: false,
    });
    const edit = runtimeInstanceEditForm(instance, true);
    expect(edit.tier).toBe(3);
    expect(buildRuntimeInstanceUpdatePayload(instance.instanceId, edit)).toMatchObject({
      tier: 3,
      credentialSource: "instance",
      models: instance.models,
    });
  });
  it("rejects unsupported independent accounts, API credentials and invalid priority layers", () => {
    for (const patch of [
      { independentCredentialsSupported: false },
      { authMode: "api-key" as const, apiKey: "test-key" },
      { isolation: "operator-environment" as const },
      { tier: 0 },
      { tier: 10 },
      { tier: 1.5 },
    ]) {
      expect(runtimeInstanceFormReady({ ...form, ...patch }, "agy-install")).toBe(false);
      expect(() => buildRuntimeInstanceCreatePayload({ ...form, ...patch }, "agy-install")).toThrow();
    }
  });
  it("allows an empty independent bootstrap but refuses an empty operator selection (dec_DA1602487428A58E8B446ECE38)", () => {
    expect(runtimeInstanceFormReady({ ...form, models: [] }, "agy-install", {})).toBe(true);
    expect(buildRuntimeInstanceCreatePayload({ ...form, models: [] }, "agy-install", {})).toMatchObject({
      models: [],
      enabled: false,
    });
    const operator = { ...form, credentialSource: "operator" as const, models: [] };
    expect(
      runtimeInstanceFormReady(operator, "agy-install", {
        models: instance.availableModels,
        defaultModel: instance.defaultModel,
      }),
    ).toBe(false);
    expect(() =>
      buildRuntimeInstanceCreatePayload(operator, "agy-install", {
        models: instance.availableModels,
        defaultModel: instance.defaultModel,
      }),
    ).toThrow();
  });
  it("offers independent login only when the selected daemon declares support and pins isolation", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const onChange = vi.fn();
    await act(async () =>
      root!.render(createElement(RuntimeAccessFields, { value: form, onChange, testIdPrefix: "account" })),
    );
    expect(container.querySelector('[data-testid="account-credential-source"]')).not.toBeNull();
    expect(container.querySelector<HTMLSelectElement>('[data-testid="account-isolation"]')?.disabled).toBe(true);
    await act(async () =>
      root!.render(
        createElement(RuntimeAccessFields, {
          value: { ...form, credentialSource: "operator", independentCredentialsSupported: false },
          onChange,
          testIdPrefix: "account",
        }),
      ),
    );
    expect(
      container.querySelector<HTMLOptionElement>('[data-testid="account-credential-source"] option[value="instance"]')
        ?.disabled,
    ).toBe(true);
  });
});
