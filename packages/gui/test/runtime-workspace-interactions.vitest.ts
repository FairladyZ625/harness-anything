// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeCard } from "../src/renderer/components/runtime/RuntimeCard.tsx";
import { SessionsView } from "../src/renderer/views/SessionsView.tsx";
import { AgentSquadView } from "../src/renderer/views/AgentSquadView.tsx";
import { ProvidersView } from "../src/renderer/views/ProvidersView.tsx";
import { NAV_GROUPS } from "../src/renderer/navigation/navConfig.tsx";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const definition = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "w4c-verify-codex", installationId: "codex-install", kindId: "codex", providerId: "openai", model: "gpt-5.6-terra", reasoningEffort: null, baseUrl: null, authMode: "subscription" } as const;
const session = (runtimeSessionId: string, taskId: string) => ({ runtimeSessionId, providerSessionId: `provider-${runtimeSessionId}`, instanceId: "w4c-verify-codex", installationId: "codex-install", kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/test", definitionSnapshot: definition, liveness: "live", attachCapability: "supported", streamCursor: "stream:4", associations: [{ taskId, executionId: "execution-1", holder: { personId: "person-owner", executorId: null }, lease: { phase: "held", expiresAt: "2026-08-23T01:00:00.000Z" } }], activity: { lastObservedAt: "2026-08-23T00:00:00.000Z", outcome: null, exitCode: null, resultRef: null } } as const);
const boundSession = session("runtime-bound", "task-bound"), siblingSession = session("runtime-sibling", "task-sibling");
const boundDispatch = { dispatchId: "dispatch_bbb", taskId: "task-bound", executionId: "execution-1", runtimeSessionId: "runtime-bound", instanceId: "w4c-verify-codex", agentId: "terra", agentName: "terra", providerSessionId: null, eventStreamRef: null, startedAt: "2026-08-23T02:00:00.000Z", endedAt: null, outcome: null, status: "running" } as const;
const siblingDispatch = { ...boundDispatch, dispatchId: "dispatch_sibling", taskId: "task-sibling", executionId: "execution-2", runtimeSessionId: "runtime-sibling", agentName: "terra sibling", startedAt: "2026-08-23T01:00:00.000Z" } as const;
const tasks = [{ taskId: "task-bound", title: "Bound task title" }, { taskId: "task-sibling", title: "Sibling task title" }] as const;
const agents = [{ id: "terra", name: "terra", runtimeType: "codex", role: "worker", layer: "user", validity: "valid", issues: [] }] as const;
const squads = [{ id: "core-squad", name: "Core Squad", leader: "terra", workers: ["terra"], layer: "user", validity: "valid", issues: [] }] as const;
const providerInstallations = [{ installationId: "codex-install-a", kindId: "codex", version: "1.0.0", observedAt: "2026-08-23T00:00:00.000Z", models: ["model-a", "model-b"], defaultModel: "model-a" }, { installationId: "codex-install-b", kindId: "codex", version: "1.1.0", observedAt: "2026-08-23T00:00:00.000Z", models: ["model-a", "model-b", "model-c"], defaultModel: "model-b" }] as const;
const providerInstance = { schemaVersion: 2, instanceId: "provider-edit", name: "Provider Edit", kindId: "codex", installationId: "codex-install-a", providerId: "openai", models: ["model-a", "model-b"], defaultModel: "model-a", enabled: true, permissionMode: "bypass", isolationState: "enforced", codex: { reasoningEffort: null, baseUrl: null, baseUrlConfigured: false, wire_api: null, requires_openai_auth: null, http_headers: null }, authMode: "subscription", authState: "authenticated", authReadiness: { status: "ready", code: null, hint: null } } as const;
const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) { root.unmount(); client.clear(); }
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("runtime entry split (W6 IA)", () => {
  it("exposes exactly three runtime nav entries and no aggregate agents entry", () => {
    const runtime = NAV_GROUPS.find((group) => group.id === "runtime");
    expect(runtime?.items.map((item) => item.id)).toEqual(["sessions", "agentSquad", "providers"]);
  });

  it("selects a rail session into the sessions workspace main area", async () => {
    await mountSessions("session/runtime-bound");

    expect(byTestId("rail-session-runtime-bound").getAttribute("aria-current")).toBe("true");
    expect(byTestId("session-detail").textContent).toContain("runtime-bound");
  });

  it("opens the bound task detail from the selected session (W5:派工链归 Task 详情)", async () => {
    const onOpenTask = vi.fn(), onSelectEntity = vi.fn();
    await mountSessions("session/runtime-bound", { onOpenTask, onSelectEntity });

    await click("session-open-task");

    expect(onOpenTask).toHaveBeenCalledWith("task-bound");
    // 编排 rail 段已撤销:任务组合不再出现在运行时工作区。
    expect(document.querySelector('[data-testid^="rail-orchestration-"]')).toBeNull();
  });

  it("routes a sibling session pick from the inspector through the addressable session ref", async () => {
    const onSelectEntity = vi.fn();
    await mountSessions("session/runtime-bound", { onSelectEntity });
    const inspector = byTestId("runtime-inspector");
    const sibling = [...inspector.querySelectorAll("button")].find((button) => button.textContent?.includes("Sibling task title"));
    expect(sibling).toBeInstanceOf(HTMLButtonElement);

    await act(async () => { sibling!.click(); });
    await flushEffects();

    expect(onSelectEntity).toHaveBeenCalledWith("session/runtime-sibling");
  });

  it("keeps more than 32 streamed frames in the inline session scroller (W6:不回截断)", async () => {
    await mountSessions("session/runtime-bound", {}, (onValue) => {
      for (let index = 0; index < 40; index += 1) onValue({ schema: "agent-runtime-attach-event/v1", runtimeSessionId: "runtime-bound", cursor: `stream:${index + 5}`, occurredAt: `2026-08-23T00:00:${String(index).padStart(2, "0")}.000Z`, type: "heartbeat" });
      return () => undefined;
    });

    expect(document.querySelectorAll('[data-testid="session-event-frame"]')).toHaveLength(40);
    expect(byTestId("session-event-stream").className).toContain("max-h-64");
    expect(byTestId("session-event-stream").className).toContain("overflow-y-auto");
  });

  it("selects agents and squads inside the identity workspace and routes cross-entry jumps", async () => {
    const onSelectEntity = vi.fn();
    await mountAgentSquad("agent/terra", { onSelectEntity });

    expect(byTestId("rail-agent-terra").getAttribute("aria-current")).toBe("true");
    expect(byTestId("agent-card-terra").textContent).toContain("terra");

    // Rail squad row → addressable squad ref (same entry: squads are a facet of this page).
    await click("rail-squad-core-squad");
    expect(onSelectEntity).toHaveBeenCalledWith("squad/core-squad");
  });

  it("routes the provider card's compatible-agent chips to the agent entry", async () => {
    const onSelectEntity = vi.fn();
    await mountProviders("provider/provider-edit", { onSelectEntity });

    expect(byTestId("rail-runtime-provider-edit").getAttribute("aria-current")).toBe("true");
    // 兼容 Agent chips 在实例卡的「兼容 Agents」区(跨入口出口):Provider → Agent。
    const compatible = [...byTestId("providers-view").querySelectorAll("button")].find((button) => button.textContent?.includes("terra"));
    expect(compatible).toBeInstanceOf(HTMLButtonElement);
    await act(async () => { compatible!.click(); });
    await flushEffects();

    expect(onSelectEntity).toHaveBeenCalledWith("agent/terra");
  });

  it("edits a provider with one cancelable draft and always keeps its default model selected", async () => {
    const onUpdate = vi.fn();
    await mountProviderCard(onUpdate);

    await click("runtime-provider-edit");
    await input("runtime-provider-name", "Cancelled rename");
    await click("runtime-provider-cancel");
    expect(onUpdate).not.toHaveBeenCalled();

    await click("runtime-provider-edit");
    expect((byTestId("runtime-provider-name") as HTMLInputElement).value).toBe("Provider Edit");
    await input("runtime-provider-name", "Provider Renamed");
    await select("runtime-provider-installation", "codex-install-b");
    await select("runtime-provider-default-model", "model-b");
    await select("runtime-provider-default-model", "model-a");
    await clickCheckbox("model-a");

    expect((byTestId("runtime-provider-default-model") as HTMLSelectElement).value).toBe("model-b");
    const remaining = [...byTestId("runtime-provider-models").querySelectorAll("input[type=checkbox]")].find((input) => (input as HTMLInputElement).value === "on" && (input.parentElement?.textContent ?? "").includes("model-b")) as HTMLInputElement;
    expect(remaining.disabled).toBe(true);
    await click("runtime-provider-save");

    expect(onUpdate).toHaveBeenCalledWith({ instanceId: "provider-edit", name: "Provider Renamed", installationId: "codex-install-b", models: ["model-b"], defaultModel: "model-b" });
  });
});

function seedQueries(client: QueryClient) {
  client.setQueryData(["runtime-instances", "machine"], { installations: providerInstallations, instances: [providerInstance] });
  client.setQueryData(["runtime-control", "repo-a", "overview"], { ok: true, status: "ready", installations: [], instances: [], sessions: [boundSession, siblingSession], watermark: 1, sourceRevision: 1 });
  client.setQueryData(["agents", "repo-a"], agents);
  client.setQueryData(["squads", "repo-a"], squads);
  client.setQueryData(["runtime-panorama", "repo-a", "task-bound,task-sibling"], [
    { ...boundDispatch, taskTitle: "Bound task title", squad: null },
    { ...siblingDispatch, taskTitle: "Sibling task title", squad: null }
  ]);
  client.setQueryData(["catalog", "repo-a", "snapshot"], { presets: [] });
  client.setQueryData(["agent-skills", "repo-a"], []);
  client.setQueryData(["agent-detail", "repo-a", "terra"], { id: "terra", name: "terra", runtimeType: "codex", role: "worker", instructions: "Do the work.", model: null, skills: [], prompts: [], preset: null });
  client.setQueryData(["squad-detail", "repo-a", "core-squad"], { id: "core-squad", name: "Core Squad", leader: "terra", workers: ["terra"], roster: "terra » terra" });
}

async function mountView(element: React.ReactElement, attachImpl: (onValue: (value: unknown) => void) => () => void = () => () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedQueries(client);
  vi.spyOn(agentRuntimeClient, "session").mockImplementation(async (_repoId, runtimeSessionId) => ({ ok: true, status: "ready", session: runtimeSessionId === "runtime-sibling" ? siblingSession : boundSession, result: null, watermark: 1, sourceRevision: 1 }));
  vi.spyOn(agentRuntimeClient, "attach").mockImplementation((_repoId, _runtimeSessionId, _cursor, onValue) => attachImpl(onValue as (value: unknown) => void));
  const container = document.createElement("div"), root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await act(async () => { await Promise.resolve(); });
  return container;
}

async function mountSessions(focusedEntityRef: string, handlers: { readonly onOpenTask?: (taskId: string) => void; readonly onSelectEntity?: (ref: string) => void } = {}, attachImpl?: (onValue: (value: unknown) => void) => () => void) {
  const element = createElement(SessionsView, { repoId: "repo-a", tasks, focusedEntityRef, onSelectEntity: handlers.onSelectEntity ?? (() => undefined), onOpenTask: handlers.onOpenTask ?? (() => undefined) });
  return mountView(element, attachImpl);
}
async function mountAgentSquad(focusedEntityRef: string, handlers: { readonly onSelectEntity?: (ref: string) => void } = {}) {
  const element = createElement(AgentSquadView, { repoId: "repo-a", tasks: tasks.map(({ taskId, title }) => ({ taskId, title, heldLease: false })), focusedEntityRef, onSelectEntity: handlers.onSelectEntity ?? (() => undefined) });
  return mountView(element);
}
async function mountProviders(focusedEntityRef: string, handlers: { readonly onSelectEntity?: (ref: string) => void } = {}) {
  const element = createElement(ProvidersView, { repoId: "repo-a", focusedEntityRef, onSelectEntity: handlers.onSelectEntity ?? (() => undefined) });
  return mountView(element);
}

async function mountProviderCard(onUpdate: ReturnType<typeof vi.fn>) {
  const client = new QueryClient(), container = document.createElement("div"), root = createRoot(container);
  document.body.append(container); mounted.push({ root, client });
  await act(async () => {
    root.render(createElement(RuntimeCard, { instance: providerInstance, installations: providerInstallations, agents: [], liveSessions: 0, busy: false, onSelectAgent: () => undefined, onAuth: () => undefined, onValidate: () => undefined, onSetEnabled: () => undefined, onUpdate, onDelete: () => undefined, onSelfTest: async () => null }));
  });
}

async function click(testId: string) {
  await act(async () => { byTestId(testId).click(); });
  await flushEffects();
}

async function input(testId: string, value: string) {
  await act(async () => { const field = byTestId(testId) as HTMLInputElement, setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; setValue?.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); field.dispatchEvent(new Event("change", { bubbles: true })); });
  await flushEffects();
}
async function select(testId: string, value: string) {
  await act(async () => { const field = byTestId(testId) as HTMLSelectElement; field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); });
  await flushEffects();
}
async function clickCheckbox(model: string) {
  const checkbox = [...byTestId("runtime-provider-models").querySelectorAll("input[type=checkbox]")].find((input) => input.parentElement?.textContent?.includes(model));
  expect(checkbox).toBeInstanceOf(HTMLInputElement);
  await act(async () => { (checkbox as HTMLInputElement).click(); });
  await flushEffects();
}

async function flushEffects() {
  await act(async () => { await Promise.resolve(); });
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  expect(element, `missing data-testid=${testId}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}
