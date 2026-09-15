// harness-test-tier: contract
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openRuntimeInstanceStore } from "../../daemon/src/agent-runtime-instances.ts";
import {
  applyRuntimeAuthMode,
  applyRuntimeKind,
  buildRuntimeInstanceCreatePayload,
  buildRuntimeInstanceUpdatePayload,
  runtimeInstanceEditForm,
  runtimeInstanceFormReady,
  runtimeInstanceIdAvailable,
  type CreateInstanceFormState,
} from "../src/renderer/runtime-instance-form.ts";
import { runtimeInstanceClient } from "../src/renderer/runtime-instance-client.ts";
import {
  baseUrlAvailability,
  planeAllowsApiKey,
  planeAllowsBaseUrl,
  planeAllowsEffort,
  planeAllowsPermissions,
  planeAuthMode,
  planeAuthModes,
  planeBaseUrlEndpoint,
  planeRequiresBaseUrl,
  planeUsesApiOverride,
  runtimeProviderPlane,
  RUNTIME_KIND_IDS,
} from "../src/renderer/runtime-provider-planes.ts";
import { squadChartLayout } from "../src/renderer/components/runtime/SquadCard.tsx";
import { subscriptionCreationNeedsLogin } from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";

const form: CreateInstanceFormState = {
  instanceId: "one",
  name: "One",
  kindId: "claude",
  installationId: "install",
  providerId: "anthropic",
  model: "claude-opus",
  reasoningEffort: "",
  fast: false,
  baseUrl: "",
  authMode: "subscription",
  apiKey: "",
  wireApi: "",
  requiresOpenAiAuth: false,
  permissionMode: "bypass",
  isolation: "operator-environment",
};

describe("provider edit form", () => {
  const apiCodex = {
    schemaVersion: 2,
    instanceId: "codex-edit",
    name: "Codex Edit",
    kindId: "codex",
    installationId: "codex-install",
    providerId: "openai",
    models: ["gpt-5.6-sol"],
    defaultModel: "gpt-5.6-sol",
    enabled: true,
    permissionMode: "bypass",
    isolationState: "enforced",
    configuration: {
      reasoningEffort: null,
      fast: true,
      baseUrl: "https://old.example/v1",
      baseUrlConfigured: true,
      wire_api: null,
      requires_openai_auth: null,
      http_headers: null,
    },
    authMode: "api-key",
    authState: "configured",
    authReadiness: { status: "ready", code: null, hint: null },
  } as const;
  const claude = {
    schemaVersion: 2,
    instanceId: "claude-edit",
    name: "Claude Edit",
    kindId: "claude",
    installationId: "claude-install",
    providerId: "anthropic",
    models: ["claude-opus"],
    defaultModel: "claude-opus",
    enabled: true,
    permissionMode: "bypass",
    isolationState: "operator-environment",
    configuration: { effort: "high", baseUrl: null, baseUrlConfigured: false },
    authMode: "subscription",
    authState: "authenticated",
    authReadiness: { status: "ready", code: null, hint: null },
  } as const;
  it("seeds the edit form with the current base URL and keeps it editable", () => {
    const form = runtimeInstanceEditForm(apiCodex);
    expect(form.baseUrl).toBe("https://old.example/v1");
    expect(form.baseUrlEditable).toBe(true);
    const renamed = buildRuntimeInstanceUpdatePayload("codex-edit", { ...form, name: "Codex Edited" });
    expect(renamed).toMatchObject({
      instanceId: "codex-edit",
      baseUrl: "https://old.example/v1",
    });
    expect("fast" in renamed).toBe(false);
    expect(buildRuntimeInstanceUpdatePayload("codex-edit", { ...form, fast: false })).toMatchObject({ fast: false });
  });
  it("sends the edited base URL and an explicit empty value clears it", () => {
    const form = runtimeInstanceEditForm(apiCodex);
    expect(
      buildRuntimeInstanceUpdatePayload("codex-edit", { ...form, baseUrl: "https://new.example/v1" }).baseUrl,
    ).toBe("https://new.example/v1");
    expect(buildRuntimeInstanceUpdatePayload("codex-edit", { ...form, baseUrl: "" }).baseUrl).toBe("");
  });
  it("omits the base URL entirely for planes without an API mode", () => {
    const subscription = runtimeInstanceEditForm({ ...apiCodex, authMode: "subscription" });
    expect(subscription.baseUrlEditable).toBe(false);
    expect("baseUrl" in buildRuntimeInstanceUpdatePayload("codex-edit", subscription)).toBe(false);
    const agy = runtimeInstanceEditForm({
      ...apiCodex,
      kindId: "agy",
      configuration: { effort: "high" },
      authMode: "subscription",
    });
    expect(agy.baseUrlEditable).toBe(false);
    expect("baseUrl" in buildRuntimeInstanceUpdatePayload("codex-edit", agy)).toBe(false);
  });
  it("omits the base URL for an api-key instance whose kind declares no endpoint", () => {
    const devin = runtimeInstanceEditForm({
      ...apiCodex,
      kindId: "devin",
      installationId: "devin-install",
      configuration: {},
      authMode: "api-key",
    });
    expect(devin.baseUrlEditable).toBe(false);
    expect(devin.baseUrl).toBe("");
    expect("baseUrl" in buildRuntimeInstanceUpdatePayload("devin-edit", devin)).toBe(false);
  });
  it("seeds the claude edit form with the current effort and edits it through the update payload", () => {
    const form = runtimeInstanceEditForm(claude);
    expect(form.effortEditable).toBe(true);
    expect(form.effort).toBe("high");
    expect(buildRuntimeInstanceUpdatePayload("claude-edit", { ...form, effort: "xhigh" }).effort).toBe("xhigh");
    // An explicit empty effort clears back to the provider default.
    expect(buildRuntimeInstanceUpdatePayload("claude-edit", { ...form, effort: "" }).effort).toBe("");
    // An untouched effort survives an unrelated edit.
    expect(buildRuntimeInstanceUpdatePayload("claude-edit", form).effort).toBe("high");
  });
  it("seeds and edits codex and agy effort through the same update payload field", () => {
    const codex = runtimeInstanceEditForm(apiCodex);
    expect(codex.effortEditable).toBe(true);
    expect(codex.effort).toBe("");
    expect(buildRuntimeInstanceUpdatePayload("codex-edit", { ...codex, effort: "xhigh" }).effort).toBe("xhigh");
    // An explicit empty effort clears back to the provider default.
    expect(buildRuntimeInstanceUpdatePayload("codex-edit", { ...codex, effort: "" }).effort).toBe("");
    const codexConfigured = runtimeInstanceEditForm({
      ...apiCodex,
      configuration: { ...apiCodex.configuration, reasoningEffort: "high" },
    });
    expect(codexConfigured.effort).toBe("high");
    // An untouched effort survives an unrelated edit.
    expect(buildRuntimeInstanceUpdatePayload("codex-edit", codexConfigured).effort).toBe("high");
    const agy = runtimeInstanceEditForm({
      ...apiCodex,
      kindId: "agy",
      configuration: { effort: "high" },
      authMode: "subscription",
    });
    expect(agy.effortEditable).toBe(true);
    expect(agy.effort).toBe("high");
    expect(buildRuntimeInstanceUpdatePayload("agy-edit", { ...agy, effort: "low" }).effort).toBe("low");
    expect(buildRuntimeInstanceUpdatePayload("agy-edit", { ...agy, effort: "" }).effort).toBe("");
  });
  it("omits effort for kinds that declare no effort field", () => {
    const zcode = runtimeInstanceEditForm({
      ...apiCodex,
      kindId: "zcode",
      installationId: "zcode-install",
      configuration: { baseUrl: null, baseUrlConfigured: false },
    });
    expect(zcode.effortEditable).toBe(false);
    expect("effort" in buildRuntimeInstanceUpdatePayload("zcode-edit", zcode)).toBe(false);
  });
});

describe("provider planes (2026-08-20 adjudication)", () => {
  it("gives agy a login-only plane with no API mode to construct", () => {
    expect(planeAuthModes("agy")).toEqual(["subscription"]);
    expect(planeUsesApiOverride("agy")).toBe(false);
    expect(planeAllowsBaseUrl("agy", "subscription")).toBe(false);
    expect(planeAllowsBaseUrl("agy", "api-key")).toBe(false);
    expect(planeAllowsApiKey("agy", "api-key")).toBe(false);
    expect(planeAllowsPermissions("agy")).toBe(false);
    expect(planeAuthMode("agy", "api-key")).toBe("subscription");
  });
  it("keeps claude as one instance whose API override switches the same instance over", () => {
    expect(planeUsesApiOverride("claude")).toBe(true);
    expect(planeAuthModes("claude")).toEqual(["subscription", "api-key"]);
    expect(planeAllowsBaseUrl("claude", "subscription")).toBe(false);
    expect(planeAllowsBaseUrl("claude", "api-key")).toBe(true);
    expect(planeAllowsApiKey("claude", "api-key")).toBe(true);
    expect(planeAllowsEffort("claude")).toBe(true);
  });
  it("offers claude only the enum values the launcher forwards as typed", () => {
    expect(runtimeProviderPlane("claude").effort).toBe("enum");
    // `minimal` is excluded on purpose: the launcher silently rewrites it to `low`.
    expect(runtimeProviderPlane("claude").effortValues).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
  it("keeps codex's two call paths separate and its models codex-only", () => {
    expect(planeUsesApiOverride("codex")).toBe(false);
    expect(planeAuthModes("codex")).toEqual(["subscription", "api-key"]);
    expect(planeAllowsBaseUrl("codex", "api-key")).toBe(true);
    expect(planeAllowsEffort("codex")).toBe(true);
    expect(planeAllowsPermissions("codex")).toBe(true);
  });
  it("keeps zcode's login and API-key paths separate, with one pinned model per instance", () => {
    expect(planeUsesApiOverride("zcode")).toBe(false);
    expect(planeAuthModes("zcode")).toEqual(["subscription", "api-key"]);
    expect(planeAllowsBaseUrl("zcode", "subscription")).toBe(false);
    expect(planeAllowsBaseUrl("zcode", "api-key")).toBe(true);
    expect(planeAllowsApiKey("zcode", "api-key")).toBe(true);
    expect(planeAllowsEffort("zcode")).toBe(false);
    expect(planeAllowsPermissions("zcode")).toBe(true);
  });
  it("declares endpoint configurability per kind instead of deriving it from auth modes", () => {
    expect(planeBaseUrlEndpoint("claude")).toBe("optional");
    expect(planeBaseUrlEndpoint("codex")).toBe("optional");
    expect(planeBaseUrlEndpoint("zcode")).toBe("optional");
    for (const kindId of ["agy", "devin", "cursor", "codex-acp", "claude-acp", "gemini", "opencode"] as const)
      expect(planeBaseUrlEndpoint(kindId)).toBe("none");
  });
  it("hides the base URL field on api-key call paths that have no endpoint (G2)", () => {
    // Negative control: devin's api-key path keeps the key field but offers no endpoint,
    // so the previously shown dead Base URL input is gone while the key input stays.
    expect(planeAllowsBaseUrl("devin", "api-key")).toBe(false);
    expect(planeAllowsBaseUrl("devin", "subscription")).toBe(false);
    expect(planeAllowsApiKey("devin", "api-key")).toBe(true);
    for (const kindId of ["cursor", "codex-acp", "claude-acp", "gemini", "opencode"] as const)
      expect(planeAllowsBaseUrl(kindId, "api-key")).toBe(false);
    // Positive control: kinds with a real endpoint keep the field on their api-key path.
    expect(planeAllowsBaseUrl("zcode", "api-key")).toBe(true);
    expect(planeAllowsBaseUrl("claude", "api-key")).toBe(true);
    expect(planeAllowsBaseUrl("codex", "api-key")).toBe(true);
  });
  it("covers the three-value endpoint vocabulary, including required", () => {
    expect(baseUrlAvailability("none", "api-key")).toBe("none");
    expect(baseUrlAvailability("optional", "api-key")).toBe("optional");
    expect(baseUrlAvailability("required", "api-key")).toBe("required");
    for (const endpoint of ["none", "optional", "required"] as const)
      expect(baseUrlAvailability(endpoint, "subscription")).toBe("none");
    // No current kind declares "required"; the mapping is what gates the form.
    for (const kindId of RUNTIME_KIND_IDS) {
      expect(planeRequiresBaseUrl(kindId, "api-key")).toBe(false);
      expect(planeRequiresBaseUrl(kindId, "subscription")).toBe(false);
    }
  });
  it("covers every runtime kind the contract accepts", () => {
    expect([...RUNTIME_KIND_IDS].sort()).toEqual([
      "agy",
      "claude",
      "claude-acp",
      "codex",
      "codex-acp",
      "cursor",
      "devin",
      "gemini",
      "opencode",
      "zcode",
    ]);
  });
  it("clears every field the new plane cannot express when the provider changes", () => {
    const configured = applyRuntimeAuthMode(
      { ...form, baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKey: "sk-live" },
      "api-key",
    );
    expect(configured).toMatchObject({
      authMode: "api-key",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "",
    });
    const moved = applyRuntimeKind(configured, "agy", { permissionMode: undefined, isolation: "operator-environment" });
    expect(moved).toMatchObject({
      kindId: "agy",
      providerId: "google",
      authMode: "subscription",
      baseUrl: "",
      apiKey: "",
      wireApi: "",
      requiresOpenAiAuth: false,
      installationId: "",
      permissionMode: undefined,
    });
    expect(
      applyRuntimeKind({ ...form, reasoningEffort: "xhigh" }, "zcode", {
        permissionMode: "bypass",
        isolation: "enforced",
      }).reasoningEffort,
    ).toBe("");
    expect(
      applyRuntimeKind({ ...form, reasoningEffort: "xhigh" }, "claude", {
        permissionMode: "bypass",
        isolation: "operator-environment",
      }).reasoningEffort,
    ).toBe("xhigh");
  });
  it("turning the claude API override off again drops the key and the endpoint", () => {
    const off = applyRuntimeAuthMode(
      { ...form, authMode: "api-key", baseUrl: "https://third.party/api", apiKey: "sk-live" },
      "subscription",
    );
    expect(off).toMatchObject({ authMode: "subscription", baseUrl: "", apiKey: "" });
  });
  it("refuses to submit an api-key instance with no key", () => {
    expect(runtimeInstanceFormReady({ ...form, authMode: "api-key" }, "install")).toBe(false);
    expect(runtimeInstanceFormReady({ ...form, authMode: "api-key", apiKey: "sk-live" }, "install")).toBe(true);
    expect(runtimeInstanceFormReady(form, "")).toBe(false);
    expect(
      runtimeInstanceFormReady({ ...form, model: "  " }, "install", {
        models: ["claude-sonnet-4-6"],
        defaultModel: "claude-sonnet-4-6",
      }),
    ).toBe(true);
  });
  it("creates with a detected default when the model override stays blank", () => {
    const detected = { models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol" } as const,
      blank = {
        ...form,
        kindId: "codex" as const,
        model: "",
        installationId: "codex-install",
        providerId: "openai",
        permissionMode: "bypass" as const,
        isolation: "operator-environment" as const,
      };
    expect(runtimeInstanceFormReady(blank, "codex-install", detected)).toBe(true);
    expect(buildRuntimeInstanceCreatePayload(blank, "codex-install", detected)).toMatchObject({
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      defaultModel: "gpt-5.6-sol",
    });
  });
  it("submits a selected model set with its first selected model as the default", () => {
    const selected = { ...form, models: ["claude-sonnet-4-6", "claude-opus"], model: "" };
    expect(buildRuntimeInstanceCreatePayload(selected, "claude-install")).toMatchObject({
      models: ["claude-sonnet-4-6", "claude-opus"],
      defaultModel: "claude-sonnet-4-6",
    });
    expect(runtimeInstanceFormReady({ ...selected, models: [] }, "install")).toBe(false);
  });
  it("treats the stable trimmed instance id as the duplicate identity", () => {
    expect([
      runtimeInstanceIdAvailable(" codex-work ", ["codex-work", "claude-work"]),
      runtimeInstanceIdAvailable("codex-new", ["codex-work", "claude-work"]),
    ]).toEqual([false, true]);
  });
  it("creates and shows detected or explicitly selected models through the renderer bridge and daemon store", async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-blank-model-")),
      detected = {
        installationId: "codex-install",
        kindId: "codex" as const,
        executablePath: "/opt/runtime-test/codex",
        version: "0.147.0",
        observedAt: "2026-08-22T00:00:00.000Z",
        models: ["gpt-5.6-sol", "gpt-5.6-terra"],
        defaultModel: "gpt-5.6-sol",
      },
      blank = {
        ...form,
        instanceId: "blank-model",
        name: "Blank model",
        kindId: "codex" as const,
        model: "",
        installationId: detected.installationId,
        providerId: "openai",
        permissionMode: "bypass" as const,
        isolation: "operator-environment" as const,
      };
    try {
      const store = openRuntimeInstanceStore({ userRoot, discover: () => [detected] }),
        unavailable = async () => ({}),
        createRuntimeInstance = async (payload: Record<string, unknown>) =>
          store.command({ kind: "runtime-instance-create", ...payload } as never),
        showRuntimeInstance = async (payload: { readonly instanceId: string }) =>
          store.command({ kind: "runtime-instance-show", ...payload } as never);
      vi.stubGlobal("window", {
        harness: {
          listRuntimeInstances: unavailable,
          showRuntimeInstance,
          createRuntimeInstance,
          updateRuntimeInstance: unavailable,
          deleteRuntimeInstance: unavailable,
          signInRuntimeInstance: unavailable,
          signOutRuntimeInstance: unavailable,
        },
      });
      const receipt = await runtimeInstanceClient.create(
          buildRuntimeInstanceCreatePayload(blank, detected.installationId, detected),
        ),
        created = receipt.instance as {
          readonly instanceId: string;
          readonly models: readonly string[];
          readonly defaultModel: string;
        };
      expect(created).toMatchObject({
        instanceId: "blank-model",
        models: detected.models,
        defaultModel: detected.defaultModel,
      });
      const selected = {
        ...blank,
        instanceId: "selected-models",
        name: "Selected models",
        models: ["gpt-5.6-terra", "gpt-5.6-sol"],
        model: "",
      };
      await runtimeInstanceClient.create(
        buildRuntimeInstanceCreatePayload(selected, detected.installationId, detected),
      );
      const shown = (await runtimeInstanceClient.show(selected.instanceId)).instance as {
        readonly instanceId: string;
        readonly models: readonly string[];
        readonly defaultModel: string;
      };
      expect(shown).toMatchObject({
        instanceId: "selected-models",
        models: ["gpt-5.6-terra", "gpt-5.6-sol"],
        defaultModel: "gpt-5.6-terra",
      });
      console.info(
        `BLANK_MODEL_CREATE_RECEIPT ${JSON.stringify({ modelInput: blank.model, instanceId: created.instanceId, models: created.models, defaultModel: created.defaultModel, ok: receipt.ok })}`,
      );
    } finally {
      vi.unstubAllGlobals();
      rmSync(userRoot, { recursive: true, force: true });
    }
  });
  it("opens the subscription login path only after the daemon reports unauthenticated", () => {
    const subscription = { authMode: "subscription" } as const,
      api = { authMode: "api-key" } as const;
    expect(subscriptionCreationNeedsLogin(subscription, { authState: "authenticated" })).toBe(false);
    expect(subscriptionCreationNeedsLogin(subscription, { authState: "unknown" })).toBe(false);
    expect(subscriptionCreationNeedsLogin(subscription, { authState: "unauthenticated" })).toBe(true);
    expect(subscriptionCreationNeedsLogin(api, { authState: "unauthenticated" })).toBe(false);
  });
  it("builds create payloads per kind without cross-kind fields or stray keys", () => {
    const sidecar = buildRuntimeInstanceCreatePayload(
      {
        instanceId: "codex-sidecar",
        name: "Codex sidecar",
        kindId: "codex",
        installationId: "codex-install",
        providerId: "codex_local_access",
        model: "gpt-5.6-terra, gpt-5.6-sol",
        reasoningEffort: " high ",
        fast: true,
        baseUrl: "http://localhost:50818/v1",
        authMode: "api-key",
        apiKey: "  sk-sidecar  ",
        wireApi: "responses",
        requiresOpenAiAuth: true,
        permissionMode: "workspace-write",
        isolation: "enforced",
      },
      "codex-install",
    );
    expect(sidecar).toEqual({
      instanceId: "codex-sidecar",
      name: "Codex sidecar",
      installationId: "codex-install",
      providerId: "codex_local_access",
      models: ["gpt-5.6-terra", "gpt-5.6-sol"],
      authMode: "api-key",
      apiKey: "sk-sidecar",
      kindId: "codex",
      isolationState: "enforced",
      permissionMode: "workspace-write",
      codex: {
        reasoningEffort: "high",
        fast: true,
        baseUrl: "http://localhost:50818/v1",
        wireApi: "responses",
        requiresOpenAiAuth: true,
      },
    });
    const codexOperator = buildRuntimeInstanceCreatePayload(
      {
        instanceId: "codex-operator",
        name: "Codex operator",
        kindId: "codex",
        installationId: "codex-install",
        providerId: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "",
        fast: false,
        baseUrl: "",
        authMode: "subscription",
        apiKey: "",
        wireApi: "",
        requiresOpenAiAuth: false,
        permissionMode: "bypass",
        isolation: "operator-environment",
      },
      "codex-install",
    );
    expect(codexOperator).toEqual({
      instanceId: "codex-operator",
      name: "Codex operator",
      installationId: "codex-install",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
      kindId: "codex",
      isolationState: "operator-environment",
      permissionMode: "bypass",
      codex: {},
    });
    const glm = buildRuntimeInstanceCreatePayload(
      {
        ...form,
        instanceId: "glm-53",
        name: "GLM 5.3",
        model: "glm-5.3-air",
        reasoningEffort: " high ",
        authMode: "api-key",
        apiKey: "sk-glm",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
      },
      "claude-install",
    );
    expect(glm).toEqual({
      instanceId: "glm-53",
      name: "GLM 5.3",
      installationId: "claude-install",
      providerId: "anthropic",
      models: ["glm-5.3-air"],
      authMode: "api-key",
      apiKey: "sk-glm",
      kindId: "claude",
      isolationState: "operator-environment",
      permissionMode: "bypass",
      claude: { effort: "high", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
    });
    expect("codex" in glm).toBe(false);
    const agy = buildRuntimeInstanceCreatePayload(
      {
        ...form,
        kindId: "agy",
        instanceId: "agy-one",
        name: "agy one",
        providerId: "google",
        model: "gemini-3.1-pro-low",
        permissionMode: undefined,
      },
      "agy-install",
    );
    expect(agy).toEqual({
      instanceId: "agy-one",
      name: "agy one",
      installationId: "agy-install",
      providerId: "google",
      models: ["gemini-3.1-pro-low"],
      kindId: "agy",
      authMode: "subscription",
      agy: {},
    });
    expect("permissionMode" in agy).toBe(false);
    expect("isolationState" in agy).toBe(false);
    expect(() =>
      buildRuntimeInstanceCreatePayload({ ...form, kindId: "agy", authMode: "api-key", apiKey: "sk" }, "agy-install"),
    ).toThrow();
  });
});

describe("squad org chart geometry", () => {
  it("centres the commander and spreads worker slots without collapsing at one worker", () => {
    expect(squadChartLayout(0)).toMatchObject({ width: 380, height: 188, slotWidth: 150, startX: 190 });
    expect(squadChartLayout(1)).toMatchObject({ width: 380, startX: 190 });
    const wide = squadChartLayout(4);
    expect(wide.width).toBe(650);
    expect(wide.startX).toBe(100);
    expect(wide.startX + 3 * wide.slotWidth).toBe(wide.width - 100);
  });
});
