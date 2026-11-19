// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentRuntimeSessionDto, AgentRuntimeSessionGroupsResult } from "@harness-anything/daemon/protocol";
import { SessionsView } from "../src/renderer/views/SessionsView.tsx";
import { agentEntityClient } from "../src/renderer/agent-entity-client.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { runtimeInstanceCatalogQuery } from "../src/renderer/runtime-instance-data.ts";
import { squadRunsClient } from "../src/renderer/squad-run-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { WorkIndex } from "../src/renderer/model/work-collections.ts";
import { lifecycleFixture } from "./lifecycle.fixtures.ts";
import { emptySquadRuns } from "./squad-run-fixtures.ts";

const definition = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "instance-unbound-1",
  installationId: "codex-install",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-terra",
  reasoningEffort: null,
  baseUrl: null,
  authMode: "subscription",
} as const;

const makeSession = (
  runtimeSessionId: string,
  instanceId: string,
  status: "running" | "succeeded",
): AgentRuntimeSessionDto => ({
  runtimeSessionId,
  providerSessionId: `provider-${runtimeSessionId}`,
  instanceId,
  installationId: "codex-install",
  kindId: "codex",
  definitionSnapshotRef: "artifact:runtime-definition/test",
  definitionSnapshot: { ...definition, instanceId },
  definitionSnapshotPersisted: true,
  liveness: status === "running" ? "live" : "exited",
  lifecycle: lifecycleFixture(status),
  attachCapability: "supported",
  streamCursor: "stream:4",
  associations: [],
  activity: {
    lastObservedAt: "2026-08-23T03:00:00.000Z",
    outcome: status === "running" ? null : "succeeded",
    exitCode: status === "running" ? null : 0,
    resultRef: null,
    missingEvidence: null,
  },
});

const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

beforeEach(() => vi.stubGlobal("harness", {}));

afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flushEffects();
  }
  if (!predicate()) throw new Error("waitFor: condition did not hold within the bounded attempts");
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

describe("SessionsView unattributed group expansion", () => {
  it("expands unattributed:no-task in Work (散件) and Task views, renders rounds and orphans, and opens detail without empty task links", async () => {
    const unboundLiveSession = makeSession("runtime-unbound-live", "instance-unbound-1", "running"),
      unboundDoneSession = makeSession("runtime-unbound-done", "instance-unbound-2", "succeeded"),
      orphanSession = makeSession("runtime-orphan-free", "instance-orphan-direct", "running"),
      unboundDispatches = [
        {
          dispatchId: "dispatch_unbound_1",
          taskId: "",
          executionId: "",
          runtimeSessionId: "runtime-unbound-live",
          instanceId: "instance-unbound-1",
          attemptGroupId: "dispatch_unbound_1",
          attemptIndex: 0,
          provider: { instance: "instance-unbound-1", model: "gpt-5.6-terra" },
          classification: null,
          reason: null,
          fallbackState: null,
          nextDispatchId: null,
          agentId: "hydrogen",
          agentName: "Hydrogen",
          providerSessionId: null,
          eventStreamRef: null,
          startedAt: "2026-08-23T03:00:00.000Z",
          endedAt: null,
          outcome: null,
          status: "running" as const,
        },
        {
          dispatchId: "dispatch_unbound_2",
          taskId: "",
          executionId: "",
          runtimeSessionId: "runtime-unbound-done",
          instanceId: "instance-unbound-2",
          attemptGroupId: "dispatch_unbound_2",
          attemptIndex: 0,
          provider: { instance: "instance-unbound-2", model: "gpt-5.6-terra" },
          classification: null,
          reason: null,
          fallbackState: null,
          nextDispatchId: null,
          agentId: "sol",
          agentName: "Sol",
          providerSessionId: null,
          eventStreamRef: null,
          startedAt: "2026-08-23T02:00:00.000Z",
          endedAt: "2026-08-23T02:10:00.000Z",
          outcome: "succeeded" as const,
          status: "succeeded" as const,
        },
      ],
      groupsResult: AgentRuntimeSessionGroupsResult = {
        ok: true,
        status: "ready",
        groups: [
          {
            key: "unattributed:no-task",
            kind: "unattributed",
            label: "No task binding",
            latestStatus: "running",
            latestActivityAt: "2026-08-23T03:00:00.000Z",
            runningCount: 1,
            sessionCount: 2,
            roundCount: 2,
            latestRound: {
              runtimeSessionId: "runtime-unbound-live",
              dispatchId: "dispatch_unbound_1",
              agentName: "Hydrogen",
              instanceId: "instance-unbound-1",
              status: "running",
              classification: null,
              reason: null,
              startedAt: "2026-08-23T03:00:00.000Z",
            },
          },
          {
            key: "unattributed:no-dispatch",
            kind: "unattributed",
            label: "No dispatch record",
            latestStatus: "running",
            latestActivityAt: "2026-08-23T01:00:00.000Z",
            runningCount: 1,
            sessionCount: 1,
            roundCount: 0,
            latestRound: null,
          },
        ],
        sessionAgents: [],
        totals: { groups: 2, sessions: 3 },
        truncated: false,
        watermark: 1,
        sourceRevision: 1,
      },
      works: WorkIndex = {
        ready: true,
        hasWorks: true,
        isWorkRoot: (taskId) => taskId === "work-root-1",
        workOf: () => null,
      };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(runtimeInstanceCatalogQuery("repo-a").queryKey, { installations: [], instances: [] });
    client.setQueryData(["agents", "repo-a"], []);
    client.setQueryData(["squads", "repo-a"], []);
    vi.spyOn(agentEntityClient, "listSquads").mockResolvedValue([]);
    vi.spyOn(squadRunsClient, "list").mockResolvedValue(emptySquadRuns);
    vi.spyOn(agentRuntimeClient, "sessionGroups").mockResolvedValue(groupsResult);
    vi.spyOn(agentRuntimeClient, "events").mockResolvedValue({
      ok: true,
      runtimeSessionId: "runtime-unbound-live",
      events: [],
      cursor: "lifecycle:0",
      sourceCursor: "lifecycle:0",
      done: true,
    });
    vi.spyOn(harnessClient, "tailObservability").mockResolvedValue({
      schema: "daemon.observe-tail/v3",
      ok: true,
      repoId: "repo-a",
      mode: "local",
      kind: "dispatch",
      direction: "backward",
      status: "ready",
      items: [],
      historyCursor: null,
      liveCursor: null,
      sourceCursor: null,
      done: true,
    });
    vi.spyOn(harnessClient, "getTasks").mockResolvedValue({
      ok: true,
      status: "ready",
      rows: [],
      invalidRows: [],
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    } as never);
    vi.spyOn(harnessClient, "getAgenda").mockResolvedValue({
      ok: true,
      status: "ready",
      awaitingYou: [],
      awaitingDecision: [],
      awaitingDecisionReview: [],
      watermark: 1,
      sourceRevision: 1,
    } as never);
    const membersSpy = vi
      .spyOn(agentRuntimeClient, "sessionGroupMembers")
      .mockImplementation(async (_repoId, query) => ({
        ok: true,
        status: "ready",
        groupKey: query.groupKey,
        groupBy: query.groupBy ?? "task",
        dispatches: query.groupKey === "unattributed:no-task" ? unboundDispatches : [],
        sessions:
          query.groupKey === "unattributed:no-task" ? [unboundLiveSession, unboundDoneSession] : [orphanSession],
        watermark: 1,
        sourceRevision: 1,
      }));
    vi.spyOn(agentRuntimeClient, "session").mockImplementation(async (_repoId, runtimeSessionId) => ({
      ok: true,
      status: "ready",
      session:
        runtimeSessionId === "runtime-unbound-done"
          ? unboundDoneSession
          : runtimeSessionId === "runtime-orphan-free"
            ? orphanSession
            : unboundLiveSession,
      result: null,
      settlement: null,
      watermark: 1,
      sourceRevision: 1,
    }));

    let focusedEntityRef: string | null = null;
    const onSelectEntity = vi.fn((ref: string) => {
      focusedEntityRef = ref;
      renderApp();
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, client });
    const renderApp = () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(SessionsView, {
            repoId: "repo-a",
            relations: [],
            focusedEntityRef,
            onSelectEntity,
            onOpenTask: () => undefined,
            onBack: () => undefined,
            works,
          }),
        ),
      );
    };
    await act(async () => {
      renderApp();
    });
    await flushEffects();

    // 1. Work 视图:展开「散件 (loose)」→ 看到「No task binding · 2 rounds」→ 点击展开看到 2 个会话行。
    await click("session-work-toggle-loose");
    const noTaskToggle = byTestId("session-group-toggle-unattributed:no-task");
    expect(noTaskToggle.textContent).toContain("2 rounds");
    await click("session-group-toggle-unattributed:no-task");
    expect(membersSpy).toHaveBeenCalledWith(
      "repo-a",
      expect.objectContaining({ groupKey: "unattributed:no-task", groupBy: "task" }),
    );
    await waitFor(() => document.querySelector('[data-testid="rail-session-runtime-unbound-live"]') !== null);
    expect(byTestId("rail-session-runtime-unbound-done")).toBeTruthy();

    // 2. 点击组内轮次行 → 选中右侧详情,且不得渲染空的任务跳链按钮。
    await click("rail-session-runtime-unbound-done");
    expect(onSelectEntity).toHaveBeenCalledWith("session/runtime-unbound-done");
    await waitFor(() => byTestId("session-detail").textContent?.includes("instance-unbound-2") === true);
    expect(document.querySelector('[data-testid="session-open-task"]')).toBeNull();
    expect(document.querySelector('[data-testid="inspector-open-task"]')).toBeNull();

    // 3. 切到 Task 视图:「No task binding」仍可展开,且「No dispatch record」可展开并渲染孤立会话行。
    await click("sessions-group-task");
    await waitFor(() => document.querySelector('[data-testid="rail-session-runtime-unbound-live"]') !== null);
    await click("session-group-toggle-unattributed:no-dispatch");
    await waitFor(() => document.querySelector('[data-testid="rail-session-runtime-orphan-free"]') !== null);
    await click("rail-session-runtime-orphan-free");
    expect(onSelectEntity).toHaveBeenCalledWith("session/runtime-orphan-free");
    await waitFor(() => byTestId("session-detail").textContent?.includes("instance-orphan-direct") === true);
  });
});
