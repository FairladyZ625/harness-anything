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
import { harnessClient } from "../src/renderer/api-client.ts";
import { runtimeInstanceClient } from "../src/renderer/runtime-instance-client.ts";
import {
  prewarmRuntimeInstanceCatalog,
  runtimeInstanceCatalogQueryKey,
} from "../src/renderer/runtime-instance-data.ts";
import { squadRunsClient } from "../src/renderer/squad-run-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const definition = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "w4c-verify-codex",
  installationId: "codex-install",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-terra",
  reasoningEffort: null,
  baseUrl: null,
  authMode: "subscription",
} as const;
const session = (runtimeSessionId: string, taskId: string) =>
  ({
    runtimeSessionId,
    providerSessionId: `provider-${runtimeSessionId}`,
    instanceId: "w4c-verify-codex",
    installationId: "codex-install",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/test",
    definitionSnapshot: definition,
    liveness: "live",
    attachCapability: "supported",
    streamCursor: "stream:4",
    associations: [
      {
        taskId,
        executionId: "execution-1",
        holder: { personId: "person-owner", executorId: null },
        lease: { phase: "held", expiresAt: "2026-08-23T01:00:00.000Z" },
      },
    ],
    activity: { lastObservedAt: "2026-08-23T00:00:00.000Z", outcome: null, exitCode: null, resultRef: null },
  }) as const;
const boundSession = session("runtime-bound", "task-bound"),
  siblingSession = session("runtime-sibling", "task-bound");
const boundDispatch = {
  dispatchId: "dispatch_bbb",
  taskId: "task-bound",
  executionId: "execution-1",
  runtimeSessionId: "runtime-bound",
  instanceId: "w4c-verify-codex",
  agentId: "terra",
  agentName: "terra",
  providerSessionId: null,
  eventStreamRef: null,
  startedAt: "2026-08-23T02:00:00.000Z",
  endedAt: null,
  outcome: null,
  status: "running",
} as const;
const siblingDispatch = {
  ...boundDispatch,
  dispatchId: "dispatch_sibling",
  executionId: "execution-2",
  runtimeSessionId: "runtime-sibling",
  agentName: "terra sibling",
  status: "succeeded" as const,
  startedAt: "2026-08-23T01:00:00.000Z",
} as const;
// 同任务里别人的轮次:证明 Agent inspector 的相关会话按 agentId 精确过滤(§4b)。
const foreignDispatch = {
  ...boundDispatch,
  dispatchId: "dispatch_foreign",
  executionId: "execution-3",
  runtimeSessionId: "runtime-foreign",
  agentId: "luna",
  agentName: "luna",
  status: "succeeded" as const,
  startedAt: "2026-08-23T01:30:00.000Z",
} as const;
const sessionGroups = {
  ok: true,
  status: "ready",
  totals: { groups: 1, sessions: 2 },
  truncated: false,
  watermark: 1,
  sourceRevision: 1,
  groups: [
    {
      key: "task-bound",
      kind: "task" as const,
      label: "Bound task title",
      taskId: "task-bound",
      latestStatus: "running" as const,
      latestActivityAt: "2026-08-23T02:00:00.000Z",
      runningCount: 1,
      sessionCount: 2,
      roundCount: 2,
      latestRound: {
        runtimeSessionId: "runtime-bound",
        dispatchId: "dispatch_bbb",
        agentName: "terra",
        instanceId: "w4c-verify-codex",
        status: "running" as const,
        startedAt: "2026-08-23T02:00:00.000Z",
      },
    },
  ],
};
const emptySquadRuns = {
  ok: true as const,
  status: "ready" as const,
  runs: [],
  totals: { runs: 0 },
  truncated: false,
  watermark: 1,
  sourceRevision: 1,
};
const squadRunSummaryRow = {
  squadRunId: "squad_" + "c".repeat(18),
  squadId: "core-squad",
  taskId: "task-bound",
  mission: "Probe the orchestration flow",
  phase: "converged" as const,
  leaderTurnCount: 2,
  workerAttemptCount: 1,
  runningCount: 0,
  latestActivityAt: "2026-08-23T02:00:00.000Z",
};
const squadRunsListFixture = {
  ok: true as const,
  status: "ready" as const,
  runs: [squadRunSummaryRow],
  totals: { runs: 1 },
  truncated: false,
  watermark: 1,
  sourceRevision: 1,
};
const squadRunDetailFixture = {
  ok: true as const,
  status: "ready" as const,
  run: {
    squadRunId: squadRunSummaryRow.squadRunId,
    squadId: "core-squad",
    taskId: "task-bound",
    mission: "Probe the orchestration flow",
    phase: "converged" as const,
    error: null,
    currentLeaderRuntimeSessionId: null,
    leaderTurns: [
      {
        turnId: "leader-1",
        trigger: { kind: "worker_outcome", runtimeSessionId: "runtime-worker" },
        dispatchId: "dispatch_000000000000000000000002",
        runtimeSessionId: "runtime-sibling",
        decision: { kind: "converged" },
        status: "succeeded" as const,
        startedAt: "2026-08-23T01:30:00.000Z",
        endedAt: "2026-08-23T01:40:00.000Z",
      },
    ],
    workerAttempts: [
      {
        attemptId: "worker-1",
        workerId: "terra",
        dispatchId: "dispatch_bbb",
        runtimeSessionId: "runtime-bound",
        rejection: null,
        status: "running" as const,
        startedAt: "2026-08-23T02:00:00.000Z",
        endedAt: null,
      },
    ],
  },
  watermark: 1,
  sourceRevision: 1,
};
const tasks = [{ taskId: "task-bound", title: "Bound task title" }] as const;
const agents = [
  { id: "terra", name: "terra", runtimeType: "codex", role: "worker", layer: "user", validity: "valid", issues: [] },
] as const;
const squads = [
  {
    id: "core-squad",
    name: "Core Squad",
    leader: "terra",
    workers: ["terra"],
    layer: "user",
    validity: "valid",
    issues: [],
  },
] as const;
const providerInstallations = [
  {
    installationId: "codex-install-a",
    kindId: "codex",
    version: "1.0.0",
    observedAt: "2026-08-23T00:00:00.000Z",
    models: ["model-a", "model-b"],
    defaultModel: "model-a",
  },
  {
    installationId: "codex-install-b",
    kindId: "codex",
    version: "1.1.0",
    observedAt: "2026-08-23T00:00:00.000Z",
    models: ["model-a", "model-b", "model-c"],
    defaultModel: "model-b",
  },
] as const;
const providerInstance = {
  schemaVersion: 2,
  instanceId: "provider-edit",
  name: "Provider Edit",
  kindId: "codex",
  installationId: "codex-install-a",
  providerId: "openai",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  enabled: true,
  permissionMode: "bypass",
  isolationState: "enforced",
  codex: {
    reasoningEffort: null,
    baseUrl: null,
    baseUrlConfigured: false,
    wire_api: null,
    requires_openai_auth: null,
    http_headers: null,
  },
  authMode: "subscription",
  authState: "authenticated",
  authReadiness: { status: "ready", code: null, hint: null },
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

describe("runtime entry split (W6 IA)", () => {
  it("exposes the runtime nav entries with Schedules and no aggregate agents entry", () => {
    const runtime = NAV_GROUPS.find((group) => group.id === "runtime");
    expect(runtime?.items.map((item) => item.id)).toEqual(["sessions", "schedules", "agentSquad", "providers"]);
  });

  it("expands a task group and selects its round row into the sessions workspace main area", async () => {
    await mountSessions("session/runtime-bound");

    expect(byTestId("session-group-toggle-task-bound").getAttribute("aria-expanded")).toBe("true");
    expect(byTestId("rail-session-runtime-bound").getAttribute("aria-current")).toBe("true");
    expect(byTestId("rail-session-runtime-sibling")).toBeTruthy();
    expect(byTestId("session-detail").textContent).toContain("runtime-bound");
  });

  it("resolves a session deep link before the target task group is expanded", async () => {
    const firstGroup = {
      ...sessionGroups.groups[0]!,
      key: "task-first",
      label: "First task",
      taskId: "task-first",
      latestRound: {
        ...sessionGroups.groups[0]!.latestRound!,
        runtimeSessionId: "runtime-first",
        dispatchId: "dispatch_first",
      },
    };
    await mountSessions("session/runtime-sibling", {}, undefined, {
      ...sessionGroups,
      totals: { groups: 2, sessions: 3 },
      groups: [firstGroup, sessionGroups.groups[0]!],
    });

    expect(byTestId("session-group-toggle-task-bound").getAttribute("aria-expanded")).toBe("true");
    expect(byTestId("rail-session-runtime-sibling").getAttribute("aria-current")).toBe("true");
    expect(byTestId("session-detail").textContent).toContain("runtime-sibling");
    expect(agentRuntimeClient.session).toHaveBeenCalledWith("repo-a", "runtime-sibling");
  });

  it("narrows a task-sessions deep link to that task across the full range", async () => {
    await mountSessions("tasksessions/task-bound");

    expect(agentRuntimeClient.sessionGroups).toHaveBeenCalledWith(
      "repo-a",
      expect.objectContaining({
        groupBy: "task",
        since: "1970-01-01T00:00:00.000Z",
        query: "task-bound",
      }),
    );
    expect(byTestId("session-group-toggle-task-bound").getAttribute("aria-expanded")).toBe("true");
  });

  it("shows squad list read failures when the squad segment is active", async () => {
    await mountSessions("session/runtime-bound", {}, undefined, sessionGroups, async () => {
      throw new Error("squad read failed");
    });
    const squadSegment = [...byTestId("sessions-view").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Squad orchestration"),
    );
    expect(squadSegment).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      squadSegment!.click();
    });
    await flushEffects();

    expect(byTestId("runtime-read-error").textContent).toContain("squad read failed");
  });

  it("reuses a range cache when returning to it instead of keying reads by mount time", async () => {
    await mountSessions("session/runtime-bound");
    expect(agentRuntimeClient.sessionGroups).toHaveBeenCalledTimes(1);

    await clickButtonWithText("7d");
    expect(agentRuntimeClient.sessionGroups).toHaveBeenCalledTimes(2);
    await clickButtonWithText("24h");

    expect(agentRuntimeClient.sessionGroups).toHaveBeenCalledTimes(2);
  });

  it("keeps a dimension switch sticky while a session focus exists (G12 §1a)", async () => {
    await mountSessions("session/runtime-bound");
    const agentDimension = [...byTestId("sessions-view").querySelectorAll("button")].find(
      (button) => button.textContent === "Agent",
    );
    expect(agentDimension).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      agentDimension!.click();
    });
    await flushEffects();
    await flushEffects();

    const calls = vi.mocked(agentRuntimeClient.sessionGroups).mock.calls;
    expect(calls.at(-1)?.[1]).toMatchObject({ groupBy: "agent" });
    expect(calls.filter(([, query]) => query?.groupBy === "task").length).toBeGreaterThan(0);
  });

  it("defaults the squad segment to 30d and opens the flow detail from a run row (G12 §2a/§2b/§2c)", async () => {
    await mountSessions(null, {}, undefined, sessionGroups, async () => squadRunsListFixture);
    const squadSegment = [...byTestId("sessions-view").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Squad orchestration"),
    );
    await act(async () => {
      squadSegment!.click();
    });
    await flushEffects();

    const listCalls = vi.mocked(squadRunsClient.list).mock.calls;
    const squadWindow = listCalls.at(-1)?.[1]?.since;
    expect(squadWindow).toBeDefined();
    // 默认 30d:窗口起点在 25~31 天前,不再是把 terminal run 滤空的 24h。
    const daysAgo = (Date.now() - Date.parse(squadWindow!)) / 86_400_000;
    expect(daysAgo).toBeGreaterThan(25);
    expect(daysAgo).toBeLessThan(31);

    expect(squadRunsClient.read).not.toHaveBeenCalled();
    await click(`squad-run-toggle-${squadRunSummaryRow.squadRunId}`);
    expect(squadRunsClient.read).toHaveBeenCalledWith("repo-a", squadRunSummaryRow.squadRunId);
    expect(byTestId("squad-run-detail")).toBeTruthy();
    expect(byTestId("squad-run-turn-leader-1")).toBeTruthy();
    expect(byTestId("squad-run-attempt-worker-1")).toBeTruthy();
    expect(byTestId("squad-run-detail").textContent).toContain("after worker session");
    expect(byTestId("squad-run-detail").textContent).toContain("declared converged");
  });

  it("opens the bound task detail from the selected session (W5:派工链归 Task 详情)", async () => {
    const onOpenTask = vi.fn(),
      onSelectEntity = vi.fn();
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
    const sibling = [...inspector.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("terra sibling"),
    );
    expect(sibling).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      sibling!.click();
    });
    await flushEffects();

    expect(onSelectEntity).toHaveBeenCalledWith("session/runtime-sibling");
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

  it("lists every round of the selected agent in the inspector, not only the latest (G12 §4a)", async () => {
    await mountAgentSquad("agent/terra");
    const inspector = byTestId("runtime-inspector");
    const rows = [...inspector.querySelectorAll("button")].map((button) => button.textContent ?? "");
    // task-bound 的历史轮(terra sibling)与最新轮都在;相关会话按 agentId 精确读。
    expect(rows.some((text) => text.includes("terra sibling"))).toBe(true);
    expect(rows.filter((text) => text.includes("Bound task title")).length).toBe(2);
    expect(agentRuntimeClient.sessionGroups).toHaveBeenCalledWith(
      "repo-a",
      expect.objectContaining({ groupBy: "task", agentId: "terra" }),
    );
    expect(harnessClient.getTaskDispatches).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "repo-a", taskIds: ["task-bound"], limit: 500 }),
    );
  });

  it("keeps other agents' rounds and unattributed sessions out of the agent inspector (G12 §4b/§4c)", async () => {
    await mountAgentSquad("agent/terra");
    const inspector = byTestId("runtime-inspector");
    const rows = [...inspector.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(rows.some((text) => text.includes("luna"))).toBe(false);
    expect(rows.some((text) => text.includes("runtime-foreign"))).toBe(false);
  });

  it("routes the provider card's compatible-agent chips to the agent entry", async () => {
    const onSelectEntity = vi.fn();
    await mountProviders("provider/provider-edit", { onSelectEntity });

    expect(byTestId("rail-runtime-provider-edit").getAttribute("aria-current")).toBe("true");
    // 兼容 Agent chips 在实例卡的「兼容 Agents」区(跨入口出口):Provider → Agent。
    const compatible = [...byTestId("providers-view").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("terra"),
    );
    expect(compatible).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      compatible!.click();
    });
    await flushEffects();

    expect(onSelectEntity).toHaveBeenCalledWith("agent/terra");
  });

  it("reflects provider enablement only after the daemon receipt, through one catalog reread", async () => {
    let settleUpdate: (value: Record<string, unknown>) => void = () => undefined;
    const update = vi.spyOn(runtimeInstanceClient, "setEnabled").mockImplementation(
        () =>
          new Promise((resolve) => {
            settleUpdate = resolve;
          }),
      ),
      list = vi.spyOn(runtimeInstanceClient, "list").mockResolvedValue({
        instances: [providerInstance],
        installations: providerInstallations,
      });
    await mountProviders("provider/provider-edit");
    const toggle = byTestId("runtime-card-provider").querySelector('[role="switch"]');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });
    await flushEffects();

    // 回执未到:开关保持原值——不再有乐观翻转(评审 #5 第 8 条删除)。
    expect(update).toHaveBeenCalledWith("provider-edit", false);
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(list).not.toHaveBeenCalled();

    list.mockResolvedValue({
      instances: [{ ...providerInstance, enabled: false }],
      installations: providerInstallations,
    });
    settleUpdate({ ok: true });
    await flushEffects();
    await flushEffects();

    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps the enablement switch unchanged and surfaces the failure when the daemon rejects it", async () => {
    vi.spyOn(runtimeInstanceClient, "setEnabled").mockRejectedValue(new Error("daemon refused"));
    const list = vi.spyOn(runtimeInstanceClient, "list").mockResolvedValue({
      instances: [providerInstance],
      installations: providerInstallations,
    });
    await mountProviders("provider/provider-edit");
    const toggle = byTestId("runtime-card-provider").querySelector('[role="switch"]');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });
    await flushEffects();

    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(list).not.toHaveBeenCalled();
    const status = [...byTestId("providers-view").querySelectorAll('[role="status"]')].map((node) => node.textContent);
    expect(status.some((text) => text?.includes("daemon refused"))).toBe(true);
  });

  it("prewarms and retains one shared machine catalog read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      list = vi.spyOn(runtimeInstanceClient, "list").mockResolvedValue({
        instances: [providerInstance],
        installations: providerInstallations,
      });

    await Promise.all([prewarmRuntimeInstanceCatalog(client), prewarmRuntimeInstanceCatalog(client)]);

    expect(list).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(runtimeInstanceCatalogQueryKey)).toEqual({
      instances: [providerInstance],
      installations: providerInstallations,
    });
    client.clear();
  });

  it("auto-probes only the selected provider on cold entry", async () => {
    const unchecked = [
      {
        ...providerInstance,
        instanceId: "provider-first",
        name: "Provider First",
        authState: "unknown" as const,
        authReadiness: { status: "not-ready" as const, code: "runtime_auth_not_checked", hint: "not checked" },
      },
      {
        ...providerInstance,
        instanceId: "provider-selected",
        name: "Provider Selected",
        authState: "unknown" as const,
        authReadiness: { status: "not-ready" as const, code: "runtime_auth_not_checked", hint: "not checked" },
      },
    ];
    const probe = vi.spyOn(runtimeInstanceClient, "probe").mockImplementation(async (instanceId) => ({
      ...unchecked.find((instance) => instance.instanceId === instanceId)!,
      authState: "authenticated",
      authReadiness: { status: "ready", code: null, hint: null },
    }));
    await mountProviders("provider/provider-selected");
    const client = mounted.at(-1)!.client;
    await act(async () => {
      client.setQueryData(runtimeInstanceCatalogQueryKey, {
        instances: unchecked,
        installations: providerInstallations,
      });
    });
    await flushEffects();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("provider-selected");
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
    const remaining = [...byTestId("runtime-provider-models").querySelectorAll("input[type=checkbox]")].find(
      (input) =>
        (input as HTMLInputElement).value === "on" && (input.parentElement?.textContent ?? "").includes("model-b"),
    ) as HTMLInputElement;
    expect(remaining.disabled).toBe(true);
    await click("runtime-provider-save");

    expect(onUpdate).toHaveBeenCalledWith({
      instanceId: "provider-edit",
      name: "Provider Renamed",
      installationId: "codex-install-b",
      models: ["model-b"],
      defaultModel: "model-b",
    });
  });
});

function seedQueries(client: QueryClient) {
  client.setQueryData(["runtime-instances", "machine"], {
    installations: providerInstallations,
    instances: [providerInstance],
  });
  // 会话页读面(sessionGroups / task.dispatches / overview { taskId } / squad runs)由
  // mountView 的 client spy 提供;这里只播 Provider/Agent 页仍用的 overview 单键。
  const overview = {
    ok: true,
    status: "ready",
    installations: [],
    instances: [],
    sessions: [boundSession, siblingSession],
    watermark: 1,
    sourceRevision: 1,
  };
  client.setQueryData(["runtime-control", "repo-a", "overview"], overview);
  client.setQueryData(["agents", "repo-a"], agents);
  client.setQueryData(["squads", "repo-a"], squads);
  client.setQueryData(["catalog", "repo-a", "snapshot"], { presets: [] });
  client.setQueryData(["agent-skills", "repo-a"], []);
  client.setQueryData(["agent-detail", "repo-a", "terra"], {
    id: "terra",
    name: "terra",
    runtimeType: "codex",
    role: "worker",
    instructions: "Do the work.",
    model: null,
    skills: [],
    prompts: [],
    preset: null,
  });
  client.setQueryData(["squad-detail", "repo-a", "core-squad"], {
    id: "core-squad",
    name: "Core Squad",
    leader: "terra",
    workers: ["terra"],
    roster: "terra » terra",
  });
}

async function mountView(
  element: React.ReactElement,
  tailImpl: (
    payload: Parameters<typeof harnessClient.tailObservability>[0],
  ) => Promise<Awaited<ReturnType<typeof harnessClient.tailObservability>>> = async (payload) => ({
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: payload.repoId,
    mode: "local",
    kind: "dispatch",
    direction: payload.direction,
    status: "ready",
    items: [],
    historyCursor: null,
    liveCursor: null,
    sourceCursor: null,
    done: true,
  }),
  sessionGroupsResult = sessionGroups,
  listSquadRuns: () => Promise<Awaited<ReturnType<typeof squadRunsClient.list>>> = async () => emptySquadRuns,
  readSquadRun: (
    _repoId: string,
    _squadRunId: string,
  ) => Promise<Awaited<ReturnType<typeof squadRunsClient.read>>> = async () => squadRunDetailFixture,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedQueries(client);
  vi.spyOn(agentRuntimeClient, "session").mockImplementation(async (_repoId, runtimeSessionId) => ({
    ok: true,
    status: "ready",
    session: runtimeSessionId === "runtime-sibling" ? siblingSession : boundSession,
    result: null,
    watermark: 1,
    sourceRevision: 1,
  }));
  vi.spyOn(harnessClient, "tailObservability").mockImplementation(tailImpl);
  vi.spyOn(agentRuntimeClient, "sessionGroups").mockImplementation(async (_repoId, query = {}) =>
    query.query === "terra" || query.groupBy === "task" ? sessionGroupsResult : { ...sessionGroupsResult, groups: [] },
  );
  vi.spyOn(agentRuntimeClient, "overview").mockImplementation(async (_repoId, taskId?: string) =>
    taskId === "task-bound"
      ? { ...sessionGroups, sessions: [boundSession, siblingSession] }
      : { ...sessionGroups, sessions: [] },
  );
  vi.spyOn(harnessClient, "getTaskDispatches").mockImplementation(async (payload) => {
    const requested =
        "taskId" in payload ? [payload.taskId as string] : [...(payload as { readonly taskIds: string[] }).taskIds],
      dispatches = requested.includes("task-bound") ? [boundDispatch, siblingDispatch, foreignDispatch] : [];
    return "taskId" in payload
      ? ({
          ok: true,
          status: "ready",
          taskId: (payload as { readonly taskId: string }).taskId,
          dispatches,
          watermark: 1,
          sourceRevision: 1,
        } as never)
      : ({
          ok: true,
          status: "ready",
          taskIds: requested,
          unavailableTaskIds: [],
          dispatches,
          page: { limit: 500, cursor: null, nextCursor: null, remainingCount: 0 },
          watermark: 1,
          sourceRevision: 1,
        } as never);
  });
  vi.spyOn(squadRunsClient, "list").mockImplementation(listSquadRuns);
  vi.spyOn(squadRunsClient, "read").mockImplementation(readSquadRun);
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  // 会话页数据面是 daemon 读(spy 提供的异步 promise):补两个微任务轮 + 一个宏任务轮,
  // 让 sessionGroups/squad runs 查询落定后再交给断言。
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flushEffects();
  return container;
}

async function mountSessions(
  focusedEntityRef: string,
  handlers: { readonly onOpenTask?: (taskId: string) => void; readonly onSelectEntity?: (ref: string) => void } = {},
  tailImpl?: (
    payload: Parameters<typeof harnessClient.tailObservability>[0],
  ) => Promise<Awaited<ReturnType<typeof harnessClient.tailObservability>>>,
  sessionGroupsResult = sessionGroups,
  listSquadRuns?: () => Promise<Awaited<ReturnType<typeof squadRunsClient.list>>>,
) {
  const element = createElement(SessionsView, {
    repoId: "repo-a",
    relations: [
      {
        from: "decision/dec_decisions0000000000000000",
        to: `task/${boundDispatch.taskId}`,
        kind: "derives",
        provenance: "local-document",
      },
    ],
    focusedEntityRef,
    onSelectEntity: handlers.onSelectEntity ?? (() => undefined),
    onOpenTask: handlers.onOpenTask ?? (() => undefined),
  });
  return mountView(element, tailImpl, sessionGroupsResult, listSquadRuns);
}
async function mountAgentSquad(
  focusedEntityRef: string,
  handlers: { readonly onSelectEntity?: (ref: string) => void } = {},
) {
  const element = createElement(AgentSquadView, {
    repoId: "repo-a",
    tasks: tasks.map(({ taskId, title }) => ({ taskId, title, heldLease: false })),
    focusedEntityRef,
    onSelectEntity: handlers.onSelectEntity ?? (() => undefined),
  });
  return mountView(element);
}
async function mountProviders(
  focusedEntityRef: string,
  handlers: { readonly onSelectEntity?: (ref: string) => void } = {},
) {
  const element = createElement(ProvidersView, {
    repoId: "repo-a",
    focusedEntityRef,
    onSelectEntity: handlers.onSelectEntity ?? (() => undefined),
  });
  return mountView(element);
}

async function mountProviderCard(onUpdate: ReturnType<typeof vi.fn>) {
  const client = new QueryClient(),
    container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(
      createElement(RuntimeCard, {
        instance: providerInstance,
        installations: providerInstallations,
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
}

async function click(testId: string) {
  await act(async () => {
    byTestId(testId).click();
  });
  await flushEffects();
}

async function clickButtonWithText(text: string) {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
  expect(button).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    (button as HTMLButtonElement).click();
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
async function clickCheckbox(model: string) {
  const checkbox = [...byTestId("runtime-provider-models").querySelectorAll("input[type=checkbox]")].find((input) =>
    input.parentElement?.textContent?.includes(model),
  );
  expect(checkbox).toBeInstanceOf(HTMLInputElement);
  await act(async () => {
    (checkbox as HTMLInputElement).click();
  });
  await flushEffects();
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
