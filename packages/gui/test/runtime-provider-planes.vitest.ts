// harness-test-tier: contract
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openRuntimeInstanceStore } from "../../daemon/src/agent-runtime-instances.ts";
import { applyRuntimeAuthMode, applyRuntimeKind, buildRuntimeInstanceCreatePayload, runtimeInstanceFormReady, type CreateInstanceFormState } from "../src/renderer/runtime-instance-form.ts";
import { runtimeInstanceClient } from "../src/renderer/runtime-instance-client.ts";
import { planeAllowsApiKey, planeAllowsBaseUrl, planeAllowsEffort, planeAllowsPermissions, planeAuthMode, planeAuthModes, planeUsesApiOverride, RUNTIME_KIND_IDS } from "../src/renderer/runtime-provider-planes.ts";
import { runtimeDockGroups, runtimeDockLiveCount, runtimeDockRows, type RuntimePanoramaRow } from "../src/renderer/runtime-panorama.ts";
import { squadChartLayout } from "../src/renderer/components/runtime/SquadCard.tsx";
import { orchestrationEntries } from "../src/renderer/components/runtime/RuntimeRail.tsx";
import { subscriptionCreationNeedsLogin } from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";

const form: CreateInstanceFormState = { instanceId: "one", name: "One", kindId: "claude", installationId: "install", providerId: "anthropic", model: "claude-opus", reasoningEffort: "", baseUrl: "", authMode: "subscription", apiKey: "", wireApi: "", requiresOpenAiAuth: false, permissionMode: "bypass", isolation: "operator-environment" };
const dispatchRow = { dispatchId: "dispatch-1", taskId: "task-a", executionId: "execution-1", runtimeSessionId: "runtime-1", instanceId: "codex-one", agentId: "luna", agentName: "Luna", delegatedByAgentId: "fable", delegatedByAgentName: "Fable", squadId: "core-squad", providerSessionId: null, eventStreamRef: null, startedAt: "2026-08-20T03:00:00.000Z", endedAt: null, outcome: null, status: "running", taskTitle: "Review the runtime", squad: { id: "core-squad", name: "Core Squad", leader: "fable", workers: ["luna"], roster: "fable » luna" } } as const satisfies RuntimePanoramaRow;

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
    expect(planeAllowsEffort("claude")).toBe(false);
  });
  it("keeps codex's two call paths separate and its models codex-only", () => {
    expect(planeUsesApiOverride("codex")).toBe(false);
    expect(planeAuthModes("codex")).toEqual(["subscription", "api-key"]);
    expect(planeAllowsBaseUrl("codex", "api-key")).toBe(true);
    expect(planeAllowsEffort("codex")).toBe(true);
    expect(planeAllowsPermissions("codex")).toBe(true);
  });
  it("covers every runtime kind the contract accepts", () => { expect([...RUNTIME_KIND_IDS].sort()).toEqual(["agy", "claude", "codex"]); });
  it("clears every field the new plane cannot express when the provider changes", () => {
    const configured = applyRuntimeAuthMode({ ...form, baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKey: "sk-live" }, "api-key");
    expect(configured).toMatchObject({ authMode: "api-key", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKey: "" });
    const moved = applyRuntimeKind(configured, "agy", { permissionMode: undefined, isolation: "operator-environment" });
    expect(moved).toMatchObject({ kindId: "agy", providerId: "google", authMode: "subscription", baseUrl: "", apiKey: "", wireApi: "", requiresOpenAiAuth: false, installationId: "", permissionMode: undefined });
    expect(applyRuntimeKind({ ...form, reasoningEffort: "xhigh" }, "claude", { permissionMode: "bypass", isolation: "operator-environment" }).reasoningEffort).toBe("");
  });
  it("turning the claude API override off again drops the key and the endpoint", () => {
    const off = applyRuntimeAuthMode({ ...form, authMode: "api-key", baseUrl: "https://third.party/api", apiKey: "sk-live" }, "subscription");
    expect(off).toMatchObject({ authMode: "subscription", baseUrl: "", apiKey: "" });
  });
  it("refuses to submit an api-key instance with no key", () => {
    expect(runtimeInstanceFormReady({ ...form, authMode: "api-key" }, "install")).toBe(false);
    expect(runtimeInstanceFormReady({ ...form, authMode: "api-key", apiKey: "sk-live" }, "install")).toBe(true);
    expect(runtimeInstanceFormReady(form, "")).toBe(false);
    expect(runtimeInstanceFormReady({ ...form, model: "  " }, "install", { models: ["claude-sonnet-4-6"], defaultModel: "claude-sonnet-4-6" })).toBe(true);
  });
  it("creates with a detected default when the model override stays blank", () => {
    const detected = { models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol" } as const, blank = { ...form, kindId: "codex" as const, model: "", installationId: "codex-install", providerId: "openai", permissionMode: "bypass" as const, isolation: "operator-environment" as const };
    expect(runtimeInstanceFormReady(blank, "codex-install", detected)).toBe(true);
    expect(buildRuntimeInstanceCreatePayload(blank, "codex-install", detected)).toMatchObject({ models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol" });
  });
  it("creates through the renderer bridge and daemon store with a blank model override", async () => {
    const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-blank-model-")), detected = { installationId: "codex-install", kindId: "codex" as const, executablePath: "/opt/runtime-test/codex", version: "0.147.0", observedAt: "2026-08-22T00:00:00.000Z", models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol" }, blank = { ...form, instanceId: "blank-model", name: "Blank model", kindId: "codex" as const, model: "", installationId: detected.installationId, providerId: "openai", permissionMode: "bypass" as const, isolation: "operator-environment" as const };
    try {
      const store = openRuntimeInstanceStore({ userRoot, discover: () => [detected] }), unavailable = async () => ({}), createRuntimeInstance = async (payload: Record<string, unknown>) => store.command({ kind: "runtime-instance-create", ...payload } as never);
      vi.stubGlobal("window", { harness: { listRuntimeInstances: unavailable, showRuntimeInstance: unavailable, createRuntimeInstance, updateRuntimeInstance: unavailable, deleteRuntimeInstance: unavailable, validateRuntimeInstanceAuth: unavailable, signInRuntimeInstance: unavailable, reauthRuntimeInstance: unavailable, signOutRuntimeInstance: unavailable } });
      const receipt = await runtimeInstanceClient.create(buildRuntimeInstanceCreatePayload(blank, detected.installationId, detected)), created = receipt.instance as { readonly instanceId: string; readonly models: readonly string[]; readonly defaultModel: string };
      expect(created).toMatchObject({ instanceId: "blank-model", models: detected.models, defaultModel: detected.defaultModel });
      console.info(`BLANK_MODEL_CREATE_RECEIPT ${JSON.stringify({ modelInput: blank.model, instanceId: created.instanceId, models: created.models, defaultModel: created.defaultModel, ok: receipt.ok })}`);
    } finally { vi.unstubAllGlobals(); rmSync(userRoot, { recursive: true, force: true }); }
  });
  it("opens the subscription login path only after the daemon reports unauthenticated", () => {
    const subscription = { authMode: "subscription" } as const, api = { authMode: "api-key" } as const;
    expect(subscriptionCreationNeedsLogin(subscription, { authState: "authenticated" })).toBe(false);
    expect(subscriptionCreationNeedsLogin(subscription, { authState: "unknown" })).toBe(false);
    expect(subscriptionCreationNeedsLogin(subscription, { authState: "unauthenticated" })).toBe(true);
    expect(subscriptionCreationNeedsLogin(api, { authState: "unauthenticated" })).toBe(false);
  });
  it("builds create payloads per kind without cross-kind fields or stray keys", () => {
    const sidecar = buildRuntimeInstanceCreatePayload({ instanceId: "codex-sidecar", name: "Codex sidecar", kindId: "codex", installationId: "codex-install", providerId: "codex_local_access", model: "gpt-5.6-terra, gpt-5.6-sol", reasoningEffort: " high ", baseUrl: "http://localhost:50818/v1", authMode: "api-key", apiKey: "  sk-sidecar  ", wireApi: "responses", requiresOpenAiAuth: true, permissionMode: "workspace-write", isolation: "enforced" }, "codex-install");
    expect(sidecar).toEqual({ instanceId: "codex-sidecar", name: "Codex sidecar", installationId: "codex-install", providerId: "codex_local_access", models: ["gpt-5.6-terra", "gpt-5.6-sol"], authMode: "api-key", apiKey: "sk-sidecar", kindId: "codex", isolationState: "enforced", permissionMode: "workspace-write", codex: { reasoningEffort: "high", baseUrl: "http://localhost:50818/v1", wireApi: "responses", requiresOpenAiAuth: true } });
    const codexOperator = buildRuntimeInstanceCreatePayload({ instanceId: "codex-operator", name: "Codex operator", kindId: "codex", installationId: "codex-install", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "", baseUrl: "", authMode: "subscription", apiKey: "", wireApi: "", requiresOpenAiAuth: false, permissionMode: "bypass", isolation: "operator-environment" }, "codex-install");
    expect(codexOperator).toEqual({ instanceId: "codex-operator", name: "Codex operator", installationId: "codex-install", providerId: "openai", models: ["gpt-5.6-sol"], authMode: "subscription", kindId: "codex", isolationState: "operator-environment", permissionMode: "bypass", codex: {} });
    const glm = buildRuntimeInstanceCreatePayload({ ...form, instanceId: "glm-53", name: "GLM 5.3", model: "glm-5.3-air", authMode: "api-key", apiKey: "sk-glm", baseUrl: "https://open.bigmodel.cn/api/anthropic" }, "claude-install");
    expect(glm).toEqual({ instanceId: "glm-53", name: "GLM 5.3", installationId: "claude-install", providerId: "anthropic", models: ["glm-5.3-air"], authMode: "api-key", apiKey: "sk-glm", kindId: "claude", isolationState: "operator-environment", permissionMode: "bypass", claude: { baseUrl: "https://open.bigmodel.cn/api/anthropic" } });
    expect("codex" in glm).toBe(false);
    const agy = buildRuntimeInstanceCreatePayload({ ...form, kindId: "agy", instanceId: "agy-one", name: "agy one", providerId: "google", model: "gemini-3.1-pro-low", permissionMode: undefined }, "agy-install");
    expect(agy).toEqual({ instanceId: "agy-one", name: "agy one", installationId: "agy-install", providerId: "google", models: ["gemini-3.1-pro-low"], kindId: "agy", authMode: "subscription", agy: {} });
    expect("permissionMode" in agy).toBe(false); expect("isolationState" in agy).toBe(false);
    expect(() => buildRuntimeInstanceCreatePayload({ ...form, kindId: "agy", authMode: "api-key", apiKey: "sk" }, "agy-install")).toThrow(/subscription OAuth only/u);
  });
});

describe("sessions dock projection", () => {
  it("groups by squad first, then agent, and keeps unattributed sessions visible", () => {
    const rows = runtimeDockRows([dispatchRow, { ...dispatchRow, dispatchId: "dispatch-2", runtimeSessionId: "runtime-2", squadId: undefined, squad: null, status: "succeeded", outcome: "succeeded" }], [{ runtimeSessionId: "runtime-9", instanceId: "claude-one", liveness: "live", activity: { lastObservedAt: "2026-08-20T04:00:00.000Z" } }]);
    expect(rows.map((row) => row.runtimeSessionId)).toEqual(["runtime-1", "runtime-2", "runtime-9"]);
    expect(rows[0]!.delegation).toBe("Fable → Luna");
    expect(rows[2]).toMatchObject({ agentId: null, taskId: null, status: "running", delegation: null });
    const groups = runtimeDockGroups(rows);
    expect(groups.map((group) => group.kind)).toEqual(["squad", "agent", "unattributed"]);
    expect(groups[0]!.label).toBe("Core Squad");
    expect(groups[1]!.label).toBe("Luna");
    expect(runtimeDockLiveCount(rows)).toBe(2);
  });
  it("counts dispatches per task and floats the running tasks to the top of the rail", () => {
    const rows = runtimeDockRows([{ ...dispatchRow, taskId: "task-b", taskTitle: "Second", status: "succeeded", runtimeSessionId: "runtime-3" }, dispatchRow, { ...dispatchRow, runtimeSessionId: "runtime-4", status: "failed" }], []);
    expect(orchestrationEntries(rows)).toEqual([{ taskId: "task-a", title: "Review the runtime", dispatches: 2, running: 1 }, { taskId: "task-b", title: "Second", dispatches: 1, running: 0 }]);
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
