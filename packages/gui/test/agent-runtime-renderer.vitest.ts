// harness-test-tier: integration
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentCard, agentDeclarationFrom, agentDraftFrom } from "../src/renderer/components/runtime/AgentCard.tsx";
import { NewRuntimeDialog } from "../src/renderer/components/runtime/NewRuntimeDialog.tsx";
import { TextInput } from "../src/renderer/components/runtime/parts.tsx";
import { RuntimeCard } from "../src/renderer/components/runtime/RuntimeCard.tsx";
import { RuntimeInspector } from "../src/renderer/components/runtime/RuntimeInspector.tsx";
import { RuntimeRail } from "../src/renderer/components/runtime/RuntimeRail.tsx";
import { SessionDetailView } from "../src/renderer/components/runtime/SessionsPanel.tsx";
import { SquadCard } from "../src/renderer/components/runtime/SquadCard.tsx";
import { visibleRuntimeInstances } from "../src/renderer/runtime-instance-form.ts";
import { assertPreloadPayload } from "../src/preload/allowlist.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { openAgentRuntimePane } from "../src/renderer/agent-runtime-client.ts";
import { submitRuntimeSpawn } from "../src/renderer/runtime-control.ts";
import { readPanorama } from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";

beforeAll(() => setActiveLocale("en-US"));

const definition = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "codex-review", installationId: "installation-codex", kindId: "codex", providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: "https://api.example.test/", authMode: "api-key" } as const;
const session = { runtimeSessionId: "runtime-session", providerSessionId: "provider-session", instanceId: definition.instanceId, installationId: definition.installationId, kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/test", definitionSnapshot: definition, liveness: "unknown", attachCapability: "supported", streamCursor: "stream:4", associations: [{ taskId: "task-runtime", executionId: "execution-runtime", holder: { personId: "person-owner", executorId: "runtime-session:runtime-session" }, lease: { phase: "held", expiresAt: "2026-08-13T01:00:00.000Z" } }], activity: { lastObservedAt: "2026-08-13T00:00:00.000Z", outcome: null, exitCode: null, resultRef: null } } as const;
const installation = { installationId: "installation-codex", kindId: "codex", version: "1.0.0", observedAt: "2026-08-13T00:00:00.000Z", models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol" } as const;
const instance = { schemaVersion: 2, instanceId: definition.instanceId, name: "Codex Review", kindId: "codex", installationId: definition.installationId, providerId: "openai", models: [definition.model], defaultModel: definition.model, enabled: true, permissionMode: "bypass", codex: { reasoningEffort: definition.reasoningEffort, baseUrl: definition.baseUrl, baseUrlConfigured: true, wire_api: null, requires_openai_auth: null, http_headers: { "x-client": "harness" } }, authMode: definition.authMode, authState: "configured", authReadiness: { status: "ready", code: null, hint: null }, isolationState: "enforced" } as const;
const claudeInstance = { ...instance, instanceId: "claude-one", name: "Claude One", kindId: "claude", authMode: "subscription", isolationState: "operator-environment", claude: { baseUrl: null, baseUrlConfigured: false } } as never;
const agyInstance = { ...instance, instanceId: "agy-one", name: "Agy One", kindId: "agy", authMode: "subscription", permissionMode: null, isolationState: "operator-environment", agy: { effort: "high" } } as never;
const agentRows = [{ id: "fable", name: "fable", runtimeType: "claude", role: "commander", layer: "user", validity: "valid", issues: [] }, { id: "luna", name: "luna", runtimeType: "codex", role: "worker", layer: "user", validity: "valid", issues: [] }, { id: "sol", name: "sol", runtimeType: "codex", role: "worker", layer: "user", validity: "valid", issues: [] }, { id: "terra", name: "terra", runtimeType: "codex", role: "worker", layer: "user", validity: "valid", issues: [] }] as const;
const squadRows = [{ id: "core-squad", name: "Core Squad", leader: "fable", workers: ["luna", "sol", "terra"], layer: "user", validity: "valid", issues: [] }] as const;
const agentDetail = { id: "fable", name: "fable", runtimeType: "claude", role: "commander", instructions: "Lead the squad. Decide before dispatch.", model: null, skills: [{ id: "review", path: "/Users/test/.claude/skills/review" }, { id: "triage", path: "/repo/skills/triage" }], prompts: ["daily-plan"], preset: null } as const;
const availableSkills = [{ id: "review", path: "/Users/test/.claude/skills/review", source: "user" }, { id: "triage", path: "/repo/skills/triage", source: "project" }] as const, presets = [{ id: "standard-task", title: "Standard task", description: "Default implementation loop" }] as const;
const squadDetail = { id: "core-squad", name: "Core Squad", leader: "fable", workers: ["luna", "sol", "terra"], roster: "fable » luna, sol, terra" } as const;
const noop = () => undefined;
const runtimeCard = (row: typeof instance | typeof claudeInstance) => renderToStaticMarkup(createElement(RuntimeCard, { instance: row, agents: agentRows as never, liveSessions: 0, busy: false, onSelectAgent: noop, onAuth: noop, onValidate: noop, onSetEnabled: noop, onUpdate: noop, onDelete: noop }));
const detailView = (overrides: Partial<Parameters<typeof SessionDetailView>[0]> = {}) => renderToStaticMarkup(createElement(SessionDetailView, { session, row: null, result: null, frames: [], attach: "attached", busy: false, onCancel: noop, onOpenTask: noop, ...overrides } as never));

afterEach(() => vi.unstubAllGlobals());
describe("agent runtime renderer", () => {
  it("submits spawn once, polls only the receipt, and waits for the canonical session", async () => {
    const spawn = vi.fn(async () => ({ schema: "command-receipt/v2", ok: true, command: "runtime-spawn", outcome: "pending", opId: "runtime-op", runtimeSessionId: "runtime-new", dispatchId: "dispatch-new", revision: 5, evidence: "event-object:runtime-op", visibility: "center", proof: { committedRevision: 5, appliedCut: 4, durable: true, canonicalVisible: false, worktreeVisible: null }, nextAction: "poll" })), showReceipt = vi.fn(async () => ({ schema: "command-receipt/v2", ok: true, command: "receipt-show", outcome: "applied", opId: "runtime-op", revision: 5, evidence: "event-object:runtime-op", visibility: "center", proof: { committedRevision: 5, appliedCut: 5, durable: true, canonicalVisible: true, worktreeVisible: null }, nextAction: null })), overview = vi.fn(async () => ({ ok: true, status: "ready", installations: [], instances: [], sessions: [{ ...session, runtimeSessionId: "runtime-new" }], watermark: 5, sourceRevision: 5 })), onPending = vi.fn();
    const result = await submitRuntimeSpawn({ runtimeInstanceId: "codex-review", cwd: { scope: "repo-root" }, prompt: "Inspect", taskId: null, idempotencyKey: "once" }, { spawn, showReceipt, overview, onPending }, async () => undefined);
    expect(result.state).toBe("applied"); expect(result.opId).toBe("runtime-op"); expect(onPending).toHaveBeenCalledWith(expect.objectContaining({ state: "pending", opId: "runtime-op" })); expect(spawn).toHaveBeenCalledOnce(); expect(showReceipt).toHaveBeenCalledOnce(); expect(overview).toHaveBeenCalledOnce();
  });
  it("renders one instance-backed carrier card without recombinable installation or credential inputs", () => {
    const markup = runtimeCard(instance);
    expect(markup).toContain("Codex Review"); expect(markup).toContain("gpt-5.6-sol"); expect(markup).toContain("installation-codex");
    expect(markup).not.toMatch(/Runtime kind|Runtime profile|type="password"|name="(?:credential|token|apiKey)"/u);
  });
  it("renders liveness, holder/lease, activity, and frozen provenance from contract DTOs", () => {
    const markup = detailView();
    expect(markup).toContain("unknown"); expect(markup).toContain("person-owner"); expect(markup).toContain("held · 2026-08-13T01:00:00.000Z");
    expect(markup).toContain("codex-review"); expect(markup).toContain("gpt-5.6-sol"); expect(markup).toContain("last activity"); expect(markup).toContain("2026-08-13T00:00:00.000Z");
    expect(markup).not.toContain("secret");
  });
  it("renders live, stale, unknown, and exited as distinct session states", () => { for (const state of ["live", "stale", "unknown", "exited"] as const) expect(detailView({ session: { ...session, liveness: state } })).toContain(`>${state}<`); });
  it("shows the session result text once the daemon projects one, and says so when it has not", () => {
    expect(detailView({ result: "Provider final report text." })).toContain("Provider final report text.");
    expect(detailView()).toContain("This session has no result text yet.");
  });
  it("shows the cancel control only while a session is live", () => {
    expect(detailView({ session: { ...session, liveness: "live" } })).toContain('data-testid="agent-runtime-cancel"');
    expect(detailView({ session: { ...session, liveness: "exited" } })).not.toContain('data-testid="agent-runtime-cancel"');
  });
  it("closing an attach pane invokes detach only", () => { const detach = vi.fn(), attachAgentRuntime = vi.fn(() => detach); vi.stubGlobal("window", { harness: { getAgentRuntimeOverview: vi.fn(), getAgentRuntimeSession: vi.fn(), getAgentRuntimeEvents: vi.fn(), attachAgentRuntime } }); const pane = openAgentRuntimePane("repo-a", "runtime-session", "stream:4", () => undefined); pane.close(); expect(attachAgentRuntime).toHaveBeenCalledWith({ repoId: "repo-a", runtimeSessionId: "runtime-session", afterCursor: "stream:4" }, expect.any(Function)); expect(detach).toHaveBeenCalledOnce(); expect(Object.keys(window.harness ?? {})).not.toContain("killAgentRuntime"); });
  it("contains no renderer repo read, private WebSocket, or polling path", async () => { const { readFile } = await import("node:fs/promises"), source = `${await readFile(new URL("../src/renderer/agent-runtime-client.ts", import.meta.url), "utf8")}\n${await readFile(new URL("../src/renderer/components/runtime/SessionsPanel.tsx", import.meta.url), "utf8")}`; expect(source).not.toMatch(/WebSocket|setInterval|setTimeout|RepoCell|\.harness\//u); });
  it("surfaces an authentication failure on the carrier card instead of hiding it", () => {
    const notReady = { ...instance, authReadiness: { status: "not-ready", code: "runtime_credential_unavailable", hint: "The configured runtime API credential is unavailable." } } as const;
    const markup = runtimeCard(notReady);
    expect(markup).toContain("runtime_credential_unavailable"); expect(markup).toContain("The configured runtime API credential is unavailable.");
    expect(markup).toContain("API key"); expect(markup).toContain("The key lives in the OS keychain");
    expect(markup).not.toMatch(/type="password"|name="(?:apiKey|credentialRef|token|secret)"|executablePath|\/opt\/runtime-test/u);
  });
  it("renders ready, not-checked, and unauthenticated as distinct auth states", () => {
    const unchecked = { ...claudeInstance, authState: "unknown", authReadiness: { status: "not-ready", code: "runtime_auth_not_checked", hint: "Authentication has not been verified in this daemon generation." } } as never;
    const unauthenticated = { ...claudeInstance, authState: "unauthenticated", authReadiness: { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in the operator environment." } } as never;
    expect(runtimeCard(instance)).toContain('data-auth-status="ready"');
    const uncheckedMarkup = runtimeCard(unchecked); expect(uncheckedMarkup).toContain('data-auth-status="not-checked"'); expect(uncheckedMarkup).toContain("Authentication not checked");
    const unavailableMarkup = runtimeCard(unauthenticated); expect(unavailableMarkup).toContain('data-auth-status="not-ready"'); expect(unavailableMarkup).toContain("runtime_subscription_required");
  });
  it("shows a background probe transport error instead of silently keeping not-checked", () => {
    const unchecked = { ...claudeInstance, authState: "unknown", authReadiness: { status: "not-ready", code: "runtime_auth_not_checked", hint: "Authentication has not been verified in this daemon generation." } } as never;
    const markup = renderToStaticMarkup(createElement(RuntimeCard, { instance: unchecked, authProbeError: "connect ECONNREFUSED", agents: [], liveSessions: 0, busy: false, onSelectAgent: noop, onAuth: noop, onValidate: noop, onSetEnabled: noop, onUpdate: noop, onDelete: noop }));
    expect(markup).toContain('data-auth-status="probe-error"'); expect(markup).toContain("Authentication check failed: connect ECONNREFUSED");
  });
  it("offers the provider's own login actions on a subscription instance and none on an api-key instance", () => {
    const subscription = runtimeCard(claudeInstance);
    for (const action of ["Sign in", "Re-auth", "Sign out"]) expect(subscription).toContain(action);
    expect(subscription).not.toMatch(/type="password"/u);
    for (const action of ["Sign in", "Re-auth", "Sign out"]) expect(runtimeCard(instance)).not.toContain(action);
  });
  it("offers AGY's terminal login path only after a probe reports unauthenticated", () => {
    const authenticated = renderToStaticMarkup(createElement(RuntimeCard, { instance: { ...agyInstance, authState: "authenticated" }, agents: [], liveSessions: 0, busy: false, onSelectAgent: noop, onAuth: noop, onValidate: noop, onSetEnabled: noop, onUpdate: noop, onDelete: noop }));
    const unauthenticated = renderToStaticMarkup(createElement(RuntimeCard, { instance: { ...agyInstance, authState: "unauthenticated", authReadiness: { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in the operator environment." } }, agents: [], liveSessions: 0, busy: false, onSelectAgent: noop, onAuth: noop, onValidate: noop, onSetEnabled: noop, onUpdate: noop, onDelete: noop }));
    expect(authenticated).not.toMatch(/<button[^>]*>Sign in<\/button>/u);
    expect(unauthenticated).toMatch(/<button[^>]*>Sign in<\/button>/u);
  });
  it("keeps kind-specific runtime fields separated on the carrier card", () => {
    const codexMarkup = runtimeCard(instance), claudeMarkup = runtimeCard(claudeInstance);
    expect(codexMarkup).toContain("codex.reasoningEffort"); expect(codexMarkup).toContain("codex.http_headers"); expect(codexMarkup).toContain("x-client=harness"); expect(codexMarkup).not.toContain("claude.baseUrl");
    expect(claudeMarkup).toContain("claude.baseUrl"); expect(claudeMarkup).not.toContain("codex.reasoningEffort");
  });
  it("renders the three identity layers in the rail and the members in the inspector", () => {
    const rail = renderToStaticMarkup(createElement(RuntimeRail, { instances: [instance, claudeInstance] as never, agents: agentRows as never, squads: squadRows as never, orchestration: [{ taskId: "task-runtime", title: "Review the runtime", dispatches: 2, running: 1 }], sessions: [], selection: null, open: { runtimes: true, agents: true, squads: true, orchestration: true, sessions: true }, liveByInstance: new Map(), onToggle: noop, onSelect: noop, onNew: noop }));
    for (const text of ["Runtimes", "Agents", "Squads", "Orchestration", "Sessions", "Codex Review", "fable", "luna", "sol", "terra", "Core Squad", "Review the runtime"]) expect(rail).toContain(text);
    const inspector = renderToStaticMarkup(createElement(RuntimeInspector, { selection: { type: "squad", id: "core-squad" }, instances: [instance] as never, agents: agentRows as never, squads: squadRows as never, rows: [], onSelect: noop, onSelectSession: noop }));
    for (const text of ["fable", "luna", "sol", "terra", "commander", "worker"]) expect(inspector).toContain(text);
  });
  it("renders the agent and squad declarations behind showAgent/showSquad", () => {
    const agent = renderToStaticMarkup(createElement(AgentCard, { detail: agentDetail, row: agentRows[0] as never, squads: squadRows as never, instances: [claudeInstance] as never, availableSkills, presets, busy: false, onSave: noop, onDispatch: noop, onSelectSquad: noop, onSelectRuntime: noop }));
    for (const text of ["Lead the squad. Decide before dispatch.", "commander", "claude", "review", "triage", "daily-plan", "Core Squad"]) expect(agent).toContain(text);
    expect(agent).toContain("Role is fully decoupled from model and provider");
    const squad = renderToStaticMarkup(createElement(SquadCard, { detail: squadDetail, row: squadRows[0] as never, agents: agentRows as never, busy: false, onSave: noop, onLaunch: noop, onSelectAgent: noop }));
    for (const text of ["fable » luna, sol, terra", "Core Squad", "Commander", "Worker #1", "4 members"]) expect(squad).toContain(text);
  });
  it("round-trips skill paths and exposes searchable Skill and Preset selectors", () => {
    const withSkills = renderToStaticMarkup(createElement(AgentCard, { detail: agentDetail, row: agentRows[0] as never, squads: squadRows as never, instances: [], availableSkills, presets, busy: false, onSave: noop, onDispatch: noop, onSelectSquad: noop, onSelectRuntime: noop }));
    expect(agentDeclarationFrom(agentDetail.id, agentDraftFrom(agentDetail))).toMatchObject({ skills: agentDetail.skills });
    expect(withSkills).toContain('data-testid="agent-skill-search"'); expect(withSkills).toContain('data-testid="agent-preset"'); expect(withSkills).not.toContain("saving here would drop the mounts");
  });
  it("keeps the Agent/Squad payload path open at the preload boundary", () => {
    expect(assertPreloadPayload("showAgent", { repoId: "repo-a", agentId: "fable" })).toBe(true);
    expect(assertPreloadPayload("showSquad", { repoId: "repo-a", squadId: "core-squad" })).toBe(true);
    expect(assertPreloadPayload("listAgents", { repoId: "repo-a" })).toBe(true);
    expect(assertPreloadPayload("listAgentSkills", { repoId: "repo-a" })).toBe(true);
    expect(assertPreloadPayload("listSquads", { repoId: "repo-a" })).toBe(true);
    expect(() => assertPreloadPayload("listAgents", { repoId: "repo-a", agentId: "fable" })).toThrow(/not allowed/u);
  });
  it("takes the API key only as a masked one-shot input, and only where the plane has an API mode", () => {
    const field = renderToStaticMarkup(createElement(TextInput, { label: "API key", type: "password", value: "", onChange: noop }));
    expect(field).toMatch(/type="password"/u); expect(field).toContain('autoComplete="off"'); expect(field).toContain('value=""'); expect(field).not.toMatch(/name="/u);
    const dialog = (initialKind: "claude" | "codex" | "agy") => renderToStaticMarkup(createElement(NewRuntimeDialog, { installations: [installation], busy: false, initialKind, onCancel: noop, onCreate: noop }));
    for (const kind of ["claude", "codex", "agy"] as const) expect(dialog(kind)).not.toMatch(/type="password"/u);
    expect(dialog("claude")).toContain("API override");
    expect(dialog("codex")).toContain("Codex-family models only.");
    expect(dialog("agy")).toContain("AGY supports only its own login flow");
    expect(dialog("agy")).not.toContain("API override");
  });
  it("renders detected models as a defaulted selector and keeps custom text behind an override", () => {
    const markup = renderToStaticMarkup(createElement(NewRuntimeDialog, { installations: [installation], busy: false, initialKind: "codex", onCancel: noop, onCreate: noop }));
    expect(markup).toContain('data-testid="new-runtime-model"'); expect(markup).toContain("Auto (default gpt-5.6-sol)"); expect(markup).toContain("gpt-5.6-terra"); expect(markup).not.toContain('data-testid="new-runtime-model-custom"');
  });
  it("offers bottom and right terminal dock positions", async () => { const { readFile } = await import("node:fs/promises"), source = await readFile(new URL("../src/renderer/components/TerminalDock.tsx", import.meta.url), "utf8"); expect(source).toContain('data-testid="terminal-dock-bottom"'); expect(source).toContain('data-testid="terminal-dock-right"'); expect(source).toContain('data-dock-position={dockPosition}'); });
  it("hides disabled instances by default while retaining them in all mode", () => {
    const enabled = { ...instance, instanceId: "enabled-instance", enabled: true } as const;
    const disabled = { ...instance, instanceId: "disabled-instance", enabled: false } as const;
    expect(visibleRuntimeInstances([enabled, disabled], false).map((row) => row.instanceId)).toEqual(["enabled-instance"]);
    expect(visibleRuntimeInstances([enabled, disabled], true).map((row) => row.instanceId)).toEqual(["enabled-instance", "disabled-instance"]);
  });
  it("edits only the permission and isolation fields supported by each runtime kind", () => {
    const codex = runtimeCard(instance), claude = runtimeCard(claudeInstance);
    const agy = renderToStaticMarkup(createElement(RuntimeCard, { instance: agyInstance, agents: [], liveSessions: 0, busy: false, onSelectAgent: noop, onAuth: noop, onValidate: noop, onSetEnabled: noop, onUpdate: noop, onDelete: noop }));
    expect(codex).toContain('data-testid="runtime-instance-permission-mode"'); expect(codex).not.toContain('data-testid="runtime-instance-isolation"');
    expect(claude).toContain('data-testid="runtime-instance-permission-mode"'); expect(claude).toContain('data-testid="runtime-instance-isolation"');
    expect(agy).not.toContain('data-testid="runtime-instance-permissions"');
  });
  it("joins task titles and squad delegation into the sessions rail segment", async () => {
    const { joinRuntimePanorama, runtimeDockRows, runtimePanoramaDelegation } = await import("../src/renderer/runtime-panorama.ts");
    const row = { dispatchId: "dispatch-1", taskId: "task-runtime", executionId: "execution-1", runtimeSessionId: "runtime-1", instanceId: "codex-review", agentId: "luna", agentName: "Luna", delegatedByAgentId: "fable", delegatedByAgentName: "Fable", squadId: "core-squad", providerSessionId: null, eventStreamRef: null, startedAt: "2026-08-20T00:00:00.000Z", endedAt: null, outcome: null, status: "running" } as const;
    const panorama = joinRuntimePanorama([{ taskId: "task-runtime", title: "Review the runtime" }], [row, { ...row, dispatchId: "dispatch-2", runtimeSessionId: "runtime-2", startedAt: "2026-08-19T00:00:00.000Z", endedAt: "2026-08-19T01:00:00.000Z", outcome: "succeeded", status: "succeeded" }], new Map([["core-squad", squadDetail]]));
    expect(panorama[0]).toMatchObject({ taskTitle: "Review the runtime", instanceId: "codex-review", startedAt: row.startedAt, status: "running" });
    expect(runtimePanoramaDelegation(panorama[0]!)).toBe("Fable → Luna");
    const rows = runtimeDockRows(panorama, []);
    const rail = renderToStaticMarkup(createElement(RuntimeRail, { instances: [], agents: [], squads: [], orchestration: [], sessions: rows, selection: null, open: { runtimes: true, agents: true, squads: true, orchestration: true, sessions: true }, liveByInstance: new Map(), onToggle: noop, onSelect: noop, onNew: noop }));
    for (const text of ["Sessions", "Review the runtime", "Core Squad", ">running<", ">succeeded<"]) expect(rail).toContain(text);
    expect(rail).toContain('data-testid="rail-session-runtime-1"');
    expect(renderToStaticMarkup(createElement(SessionDetailView, { session, row: rows[0]!, result: null, frames: [], attach: "attached", busy: false, onCancel: noop, onOpenTask: noop }))).toContain("Fable → Luna");
  });
  it("reads a 402-task panorama through one batch request and keeps dispatch rows when the squad catalog fails", async () => {
    const tasks = Array.from({ length: 402 }, (_, index) => ({ taskId: `task-${String(index).padStart(3, "0")}`, title: `Task ${index}` })), dispatch = { dispatchId: "dispatch-batch", taskId: tasks[0]!.taskId, executionId: "execution-batch", runtimeSessionId: "runtime-batch", instanceId: "codex-review", squadId: "missing-squad", providerSessionId: null, eventStreamRef: null, startedAt: "2026-08-21T00:00:00.000Z", endedAt: null, outcome: null, status: "running" } as const, getTaskDispatches = vi.fn(async (taskIds: readonly string[]) => ({ ok: true, status: "ready", taskIds, unavailableTaskIds: [], dispatches: [dispatch], page: { limit: 500, cursor: null, nextCursor: null }, watermark: 1, sourceRevision: 1 } as const)), listSquads = vi.fn(async (): Promise<readonly (typeof squadRows)[number][]> => { throw new Error("one catalog row is unavailable"); });
    const panorama = await readPanorama("repo-a", tasks, { getTaskDispatches, listSquads });
    expect(getTaskDispatches).toHaveBeenCalledOnce(); expect(getTaskDispatches).toHaveBeenCalledWith(tasks.map(({ taskId }) => taskId)); expect(listSquads).toHaveBeenCalledOnce(); expect(panorama).toHaveLength(1); expect(panorama[0]).toMatchObject({ taskTitle: "Task 0", squad: null });
  });
});
