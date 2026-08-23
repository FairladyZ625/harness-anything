// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeWorkspace } from "../src/renderer/views/RuntimeWorkspace.tsx";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const definition = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "w4c-verify-codex", installationId: "codex-install", kindId: "codex", providerId: "openai", model: "gpt-5.6-terra", reasoningEffort: null, baseUrl: null, authMode: "subscription" } as const;
const session = (runtimeSessionId: string, taskId: string) => ({ runtimeSessionId, providerSessionId: `provider-${runtimeSessionId}`, instanceId: "w4c-verify-codex", installationId: "codex-install", kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/test", definitionSnapshot: definition, liveness: "live", attachCapability: "supported", streamCursor: "stream:4", associations: [{ taskId, executionId: "execution-1", holder: { personId: "person-owner", executorId: null }, lease: { phase: "held", expiresAt: "2026-08-23T01:00:00.000Z" } }], activity: { lastObservedAt: "2026-08-23T00:00:00.000Z", outcome: null, exitCode: null, resultRef: null } } as const);
const boundSession = session("runtime-bound", "task-bound"), siblingSession = session("runtime-sibling", "task-sibling");
const boundDispatch = { dispatchId: "dispatch_bbb", taskId: "task-bound", executionId: "execution-1", runtimeSessionId: "runtime-bound", instanceId: "w4c-verify-codex", agentId: "terra", agentName: "terra", providerSessionId: null, eventStreamRef: null, startedAt: "2026-08-23T02:00:00.000Z", endedAt: null, outcome: null, status: "running" } as const;
const siblingDispatch = { ...boundDispatch, dispatchId: "dispatch_sibling", taskId: "task-sibling", executionId: "execution-2", runtimeSessionId: "runtime-sibling", agentName: "terra sibling", startedAt: "2026-08-23T01:00:00.000Z" } as const;
const tasks = [{ taskId: "task-bound", title: "Bound task title" }, { taskId: "task-sibling", title: "Sibling task title" }] as const;
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

describe("runtime workspace interaction wiring", () => {
  it("selects a rail session into the main workspace", async () => {
    await mountWorkspace();

    await click("rail-session-runtime-bound");

    expect(byTestId("rail-session-runtime-bound").getAttribute("aria-current")).toBe("true");
    expect(byTestId("session-detail").textContent).toContain("runtime-bound");
  });

  it("focuses a dispatch's live session from the task composition", async () => {
    await mountWorkspace();
    await click("rail-orchestration-task-bound");

    await click("orchestration-session-dispatch_bbb");

    expect(byTestId("rail-session-runtime-bound").getAttribute("aria-current")).toBe("true");
    expect(byTestId("session-detail").textContent).toContain("runtime-bound");
  });

  it("opens the bound task from the selected session", async () => {
    await mountWorkspace();
    await click("rail-session-runtime-bound");

    await click("session-open-task");

    expect(byTestId("rail-orchestration-task-bound").getAttribute("aria-current")).toBe("true");
    expect(byTestId("orchestration-panel").getAttribute("data-task")).toBe("task-bound");
  });

  it("focuses a related session from the workspace inspector", async () => {
    await mountWorkspace();
    await click("rail-session-runtime-bound");
    const inspector = byTestId("runtime-inspector");
    const sibling = [...inspector.querySelectorAll("button")].find((button) => button.textContent?.includes("Sibling task title"));
    expect(sibling).toBeInstanceOf(HTMLButtonElement);

    await act(async () => { sibling!.click(); });
    await flushEffects();

    expect(byTestId("rail-session-runtime-sibling").getAttribute("aria-current")).toBe("true");
    expect(byTestId("session-detail").textContent).toContain("runtime-sibling");
  });
});

async function mountWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["runtime-instances", "machine"], { installations: [], instances: [] });
  client.setQueryData(["runtime-control", "repo-a", "overview"], { ok: true, status: "ready", installations: [], instances: [], sessions: [boundSession, siblingSession], watermark: 1, sourceRevision: 1 });
  client.setQueryData(["agents", "repo-a"], []);
  client.setQueryData(["squads", "repo-a"], []);
  client.setQueryData(["runtime-panorama", "repo-a", "task-bound,task-sibling"], [
    { ...boundDispatch, taskTitle: "Bound task title", squad: null },
    { ...siblingDispatch, taskTitle: "Sibling task title", squad: null }
  ]);
  client.setQueryData(["catalog", "repo-a", "snapshot"], { presets: [] });
  client.setQueryData(["agent-skills", "repo-a"], []);
  client.setQueryData(["orchestration", "repo-a", "task-bound", "documents", 0], { documents: [
    { path: "tasks/task-bound-verify/artifacts/missions/dispatch_bbb.md", blobSha256: "a".repeat(64), size: 10, mediaType: "text/markdown" },
    { path: "tasks/task-bound-verify/artifacts/dispatches/dispatch_bbb.json", blobSha256: "b".repeat(64), size: 10, mediaType: "text/plain" }
  ] });
  client.setQueryData(["orchestration", "repo-a", "task-bound", "dispatches", 0], { dispatches: [boundDispatch] });
  vi.spyOn(agentRuntimeClient, "session").mockImplementation(async (_repoId, runtimeSessionId) => ({ ok: true, status: "ready", session: runtimeSessionId === "runtime-sibling" ? siblingSession : boundSession, result: null, watermark: 1, sourceRevision: 1 }));
  vi.spyOn(agentRuntimeClient, "attach").mockReturnValue(() => undefined);
  const container = document.createElement("div"), root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(RuntimeWorkspace, { repoId: "repo-a", tasks })));
  });
  return container;
}

async function click(testId: string) {
  await act(async () => { byTestId(testId).click(); });
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
