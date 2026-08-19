// harness-test-tier: integration
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRuntimeProjection } from "../src/renderer/views/agent-runtime-view.tsx";
import { RuntimeControlPanel } from "../src/renderer/components/RuntimeControlPanel.tsx";
import { AuthModeFields, buildRuntimeInstanceCreatePayload, InstanceDetail, RuntimeInstanceManagerPanel, visibleRuntimeInstances } from "../src/renderer/components/RuntimeInstanceManagerPanel.tsx";
import { EntityLayersRows } from "../src/renderer/components/EntityLayersPanel.tsx";
import { assertPreloadPayload } from "../src/preload/allowlist.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { openAgentRuntimePane } from "../src/renderer/agent-runtime-client.ts";
import { submitRuntimeSpawn } from "../src/renderer/runtime-control.ts";

beforeAll(() => setActiveLocale("en-US"));

const definition = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "codex-review", installationId: "installation-codex", kindId: "codex", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: "https://api.example.test/", authMode: "api-key" } as const;
const session = { runtimeSessionId: "runtime-session", providerSessionId: "provider-session", instanceId: definition.instanceId, installationId: definition.installationId, kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/test", definitionSnapshot: definition, liveness: "unknown", attachCapability: "supported", streamCursor: "stream:4", associations: [{ taskId: "task-runtime", executionId: "execution-runtime", holder: { personId: "person-owner", executorId: "runtime-session:runtime-session" }, lease: { phase: "held", expiresAt: "2026-08-13T01:00:00.000Z" } }], activity: { lastObservedAt: "2026-08-13T00:00:00.000Z", outcome: null, resultRef: null } } as const;
const installation = { installationId: "installation-codex", kindId: "codex", protocolFamily: "codex", version: "1.0.0", attachCapability: "supported", lastObservedAt: "2026-08-13T00:00:00.000Z" } as const, instance = { schemaVersion: 2, instanceId: definition.instanceId, name: "Codex Review", kindId: "codex", installationId: definition.installationId, providerId: "openai", models: [definition.model], defaultModel: definition.model, enabled: true, codex: { reasoningEffort: definition.reasoningEffort, baseUrl: definition.baseUrl, baseUrlConfigured: true, wire_api: null, requires_openai_auth: null, http_headers: null }, authMode: definition.authMode, authState: "configured", authReadiness: { status: "ready", code: null, hint: null }, isolationState: "enforced" } as const;
afterEach(() => vi.unstubAllGlobals());
describe("agent runtime renderer", () => {
  it("submits spawn once, polls only the receipt, and waits for the canonical session", async () => {
    const spawn = vi.fn(async () => ({ schema: "command-receipt/v2", ok: true, command: "runtime-spawn", outcome: "pending", opId: "runtime-op", runtimeSessionId: "runtime-new", dispatchId: "dispatch-new", revision: 5, evidence: "event-object:runtime-op", visibility: "center", proof: { committedRevision: 5, appliedCut: 4, durable: true, canonicalVisible: false, worktreeVisible: null }, nextAction: "poll" })), showReceipt = vi.fn(async () => ({ schema: "command-receipt/v2", ok: true, command: "receipt-show", outcome: "applied", opId: "runtime-op", revision: 5, evidence: "event-object:runtime-op", visibility: "center", proof: { committedRevision: 5, appliedCut: 5, durable: true, canonicalVisible: true, worktreeVisible: null }, nextAction: null })), overview = vi.fn(async () => ({ ok: true, status: "ready", installations: [], instances: [], sessions: [{ ...session, runtimeSessionId: "runtime-new" }], watermark: 5, sourceRevision: 5 })), onPending = vi.fn();
    const result = await submitRuntimeSpawn({ runtimeInstanceId: "codex-review", cwd: { scope: "repo-root" }, prompt: "Inspect", taskId: null, idempotencyKey: "once" }, { spawn, showReceipt, overview, onPending }, async () => undefined);
    expect(result.state).toBe("applied"); expect(result.opId).toBe("runtime-op"); expect(onPending).toHaveBeenCalledWith(expect.objectContaining({ state: "pending", opId: "runtime-op" })); expect(spawn).toHaveBeenCalledOnce(); expect(showReceipt).toHaveBeenCalledOnce(); expect(overview).toHaveBeenCalledOnce();
  });
  it("renders one instance-backed spawn choice without recombinable installation or credential inputs", () => {
    const markup = renderToStaticMarkup(createElement(RuntimeControlPanel, { overview: { ok: true, status: "ready", installations: [installation], instances: [instance], sessions: [], watermark: 4, sourceRevision: 4 }, tasks: [{ taskId: "task-runtime", title: "Runtime task" }], busy: false, settlement: null, onSpawn: async () => undefined }));
    expect(markup).toContain("Codex Review"); expect(markup).toContain("gpt-5.6-sol"); expect(markup).toContain("installation-codex"); expect(markup).not.toMatch(/Runtime kind|Runtime profile|type="password"|name="(?:credential|token|apiKey)"/u);
  });
  it("renders liveness, holder/lease, activity, and frozen provenance from contract DTOs", () => { const markup = renderToStaticMarkup(createElement(AgentRuntimeProjection, { overview: { ok: true, status: "ready", installations: [installation], instances: [instance], sessions: [session], watermark: 4, sourceRevision: 4 }, selectedId: session.runtimeSessionId, detail: session, frames: [], attachStatus: "attached", onSelect: () => undefined, onClose: () => undefined }));
    expect(markup).toContain("unknown"); expect(markup).toContain("person-owner"); expect(markup).toContain("held · 2026-08-13T01:00:00.000Z"); expect(markup).toContain("codex-review"); expect(markup).toContain("gpt-5.6-sol"); expect(markup).toContain("Last activity"); expect(markup).not.toContain("secret"); });
  it("renders live, stale, unknown, and exited as distinct session states", () => { const sessions = (["live", "stale", "unknown", "exited"] as const).map((liveness, index) => ({ ...session, runtimeSessionId: `runtime-${index}`, liveness })), markup = renderToStaticMarkup(createElement(AgentRuntimeProjection, { overview: { ok: true, status: "ready", installations: [], instances: [], sessions, watermark: 4, sourceRevision: 4 }, selectedId: null, detail: null, frames: [], attachStatus: "detached", onSelect: () => undefined, onClose: () => undefined })); for (const state of ["live", "stale", "unknown", "exited"]) expect(markup).toContain(`>${state}<`); });
  it("closing an attach pane invokes detach only", () => { const detach = vi.fn(), attachAgentRuntime = vi.fn(() => detach); vi.stubGlobal("window", { harness: { getAgentRuntimeOverview: vi.fn(), getAgentRuntimeSession: vi.fn(), getAgentRuntimeEvents: vi.fn(), attachAgentRuntime } }); const pane = openAgentRuntimePane("repo-a", "runtime-session", "stream:4", () => undefined); pane.close(); expect(attachAgentRuntime).toHaveBeenCalledWith({ repoId: "repo-a", runtimeSessionId: "runtime-session", afterCursor: "stream:4" }, expect.any(Function)); expect(detach).toHaveBeenCalledOnce(); expect(Object.keys(window.harness ?? {})).not.toContain("killAgentRuntime"); });
  it("contains no renderer repo read, private WebSocket, or polling path", async () => { const { readFile } = await import("node:fs/promises"), source = `${await readFile(new URL("../src/renderer/agent-runtime-client.ts", import.meta.url), "utf8")}\n${await readFile(new URL("../src/renderer/views/agent-runtime-view.tsx", import.meta.url), "utf8")}`; expect(source).not.toMatch(/WebSocket|setInterval|setTimeout|RepoCell|\.harness\//u); });
  it("renders machine instance CRUD and visible auth failure; subscription mode takes no key input", () => {
    const notReady = { ...instance, authReadiness: { status: "not-ready", code: "runtime_credential_unavailable", hint: "The configured runtime API credential is unavailable." } } as const;
    const markup = renderToStaticMarkup(createElement(RuntimeInstanceManagerPanel, { instances: [notReady], installations: [installation], busy: false, feedback: null, onRefresh: async () => undefined, onCreate: async () => undefined, onShow: async () => undefined, onDelete: async () => undefined, onValidate: async () => undefined, onSubscriptionAction: async () => undefined }));
    expect(markup).toContain("Runtime instances"); expect(markup).toContain("runtime_credential_unavailable"); expect(markup).toContain("The configured runtime API credential is unavailable."); expect(markup).toContain("API key");
    expect(markup).toContain("own interactive login");
    expect(markup).not.toMatch(/type="password"|name="(?:apiKey|credentialRef|token|secret)"|executablePath|\/opt\/runtime-test/u);
  });
  it("renders the three identity layers and keeps kind-specific fields separated", () => {
    const codex = { schemaVersion: 2, instanceId: "w4c-verify-codex", name: "W4c 修复后对照实例", kindId: "codex", installationId: "codex-install", providerId: "openai", models: ["gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", enabled: true, authMode: "subscription", authState: "configured", authReadiness: { status: "ready", code: null, hint: null }, isolationState: "enforced", codex: { reasoningEffort: "high", baseUrl: "https://api.example.test", baseUrlConfigured: true, wire_api: "responses", requires_openai_auth: true, http_headers: { "x-client": "harness" } } } as const;
    const claude = { ...codex, instanceId: "claude-one", name: "Claude one", kindId: "claude", claude: { baseUrl: "https://claude.example.test" } } as const;
    const markup = renderToStaticMarkup(createElement(RuntimeInstanceManagerPanel, { instances: [codex, claude] as never, installations: [], busy: false, feedback: null, onRefresh: async () => undefined, onCreate: async () => undefined, onShow: async () => undefined, onDelete: async () => undefined, onValidate: async () => undefined, onSetEnabled: async () => undefined, onSubscriptionAction: async () => undefined }));
    const codexDetail = renderToStaticMarkup(createElement(InstanceDetail, { detail: codex as never, onClose: () => undefined })); const claudeDetail = renderToStaticMarkup(createElement(InstanceDetail, { detail: claude as never, onClose: () => undefined }));
    expect(codexDetail).toContain("codex.reasoningEffort"); expect(codexDetail).toContain("codex.http_headers"); expect(codexDetail).not.toContain("claude.baseUrl"); expect(claudeDetail).toContain("claude.baseUrl"); expect(claudeDetail).not.toContain("codex.reasoningEffort"); expect(markup).toContain("W4c 修复后对照实例");
    const identities = renderToStaticMarkup(createElement(EntityLayersRows, { agents: [{ id: "fable", name: "fable", runtimeType: "claude", layer: "user", validity: "valid", issues: [] }, { id: "luna", name: "luna", runtimeType: "codex", layer: "user", validity: "valid", issues: [] }, { id: "sol", name: "sol", runtimeType: "codex", layer: "user", validity: "valid", issues: [] }, { id: "terra", name: "terra", runtimeType: "codex", layer: "user", validity: "valid", issues: [] }], squads: [{ id: "core-squad", name: "Core Squad", leader: "fable", workers: ["luna", "sol", "terra"], layer: "user", validity: "valid", issues: [] }] }));
    for (const text of ["fable", "luna", "sol", "terra", "Core Squad", "leader=fable"]) expect(identities).toContain(text);
  });
  it("expands the agent and squad declarations behind showAgent/showSquad", () => {
    const agentPane = { id: "fable", agent: { id: "fable", name: "fable", runtimeType: "claude", instructions: "Lead the squad. Decide before dispatch.", skills: ["review", "triage"], prompts: ["daily-plan"], preset: null } } as const;
    const squadPane = { id: "core-squad", squad: { id: "core-squad", name: "Core Squad", leader: "fable", workers: ["luna", "sol", "terra"], roster: "fable » luna, sol, terra" } } as const;
    const expanded = renderToStaticMarkup(createElement(EntityLayersRows, { agents: [{ id: "fable", name: "fable", runtimeType: "claude", layer: "user", validity: "valid", issues: [] }], squads: [{ id: "core-squad", name: "Core Squad", leader: "fable", workers: ["luna", "sol", "terra"], layer: "user", validity: "valid", issues: [] }], openAgentId: "fable", openSquadId: "core-squad", agentDetail: agentPane, squadDetail: squadPane }));
    for (const text of ["runtime_type", "claude", "review, triage", "daily-plan", "Lead the squad. Decide before dispatch.", "workers", "luna, sol, terra", "fable » luna, sol, terra"]) expect(expanded).toContain(text);
    const collapsed = renderToStaticMarkup(createElement(EntityLayersRows, { agents: [{ id: "fable", name: "fable", runtimeType: "claude", layer: "user", validity: "valid", issues: [] }], squads: [{ id: "core-squad", name: "Core Squad", leader: "fable", workers: ["luna", "sol", "terra"], layer: "user", validity: "valid", issues: [] }] }));
    expect(collapsed).not.toContain("runtime_type"); expect(collapsed).not.toContain("Lead the squad. Decide before dispatch."); expect(collapsed).not.toContain("fable » luna, sol, terra");
  });
  it("keeps the Agent/Squad payload path open at the preload boundary", () => {
    expect(assertPreloadPayload("showAgent", { repoId: "repo-a", agentId: "fable" })).toBe(true);
    expect(assertPreloadPayload("showSquad", { repoId: "repo-a", squadId: "core-squad" })).toBe(true);
    expect(assertPreloadPayload("listAgents", { repoId: "repo-a" })).toBe(true);
    expect(assertPreloadPayload("listSquads", { repoId: "repo-a" })).toBe(true);
    expect(() => assertPreloadPayload("listAgents", { repoId: "repo-a", agentId: "fable" })).toThrow(/not allowed/u);
  });
  it("takes the API key only as a masked one-shot input tied to api-key mode", () => {
    const apiKeyField = renderToStaticMarkup(createElement(AuthModeFields, { authMode: "api-key", apiKey: "", onApiKeyChange: () => undefined }));
    expect(apiKeyField).toMatch(/type="password"/u); expect(apiKeyField).toContain('autoComplete="off"'); expect(apiKeyField).toContain('value=""'); expect(apiKeyField).not.toMatch(/name="/u);
    const subscriptionField = renderToStaticMarkup(createElement(AuthModeFields, { authMode: "subscription", apiKey: "", onApiKeyChange: () => undefined }));
    expect(subscriptionField).not.toMatch(/type="password"/u); expect(subscriptionField).toContain("own interactive login");
  });
  it("builds create payloads per kind without cross-kind fields or stray keys", () => {
    const sidecar = buildRuntimeInstanceCreatePayload({ instanceId: "codex-sidecar", name: "Codex sidecar", kindId: "codex", installationId: "codex-install", providerId: "codex_local_access", model: "gpt-5.6-terra", reasoningEffort: " high ", baseUrl: "http://localhost:50818/v1", authMode: "api-key", apiKey: "  sk-sidecar  ", wireApi: "responses", requiresOpenAiAuth: true }, "codex-install");
    expect(sidecar).toEqual({ instanceId: "codex-sidecar", name: "Codex sidecar", installationId: "codex-install", providerId: "codex_local_access", model: "gpt-5.6-terra", authMode: "api-key", apiKey: "sk-sidecar", kindId: "codex", codex: { reasoningEffort: "high", baseUrl: "http://localhost:50818/v1", wireApi: "responses", requiresOpenAiAuth: true } });
    const claude = buildRuntimeInstanceCreatePayload({ instanceId: "claude-one", name: "Claude one", kindId: "claude", installationId: "claude-install", providerId: "anthropic", model: "claude-opus", reasoningEffort: "high", baseUrl: "", authMode: "subscription", apiKey: "", wireApi: "responses", requiresOpenAiAuth: true }, "claude-install");
    expect(claude).toEqual({ instanceId: "claude-one", name: "Claude one", installationId: "claude-install", providerId: "anthropic", model: "claude-opus", authMode: "subscription", kindId: "claude", claude: {} });
    expect("codex" in claude).toBe(false); expect("apiKey" in claude).toBe(false);
  });
  it("hides disabled instances by default while retaining them in all mode", () => {
    const enabled = { ...instance, instanceId: "enabled-instance", enabled: true } as const;
    const disabled = { ...instance, instanceId: "disabled-instance", enabled: false } as const;
    expect(visibleRuntimeInstances([enabled, disabled], false).map((row) => row.instanceId)).toEqual(["enabled-instance"]);
    expect(visibleRuntimeInstances([enabled, disabled], true).map((row) => row.instanceId)).toEqual(["enabled-instance", "disabled-instance"]);
  });
});
