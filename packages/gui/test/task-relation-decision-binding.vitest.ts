// harness-test-tier: integration
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskRelationsTab } from "../src/renderer/components/taskDetail/TaskRelationsTab.tsx";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

const task: TaskRow = {
  taskId: "task-bound",
  title: "Bound task",
  projectId: "repo-a",
  coordinationStatus: "active",
  rawStatus: "active",
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "not_required",
  engine: "local",
  source: "local-document",
  module: "gui",
  lastKnownAt: "2026-09-13T00:00:00.000Z",
  gates: [],
  docs: [],
  ...projectedTaskFields("active"),
};

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("task relation decision binding", () => {
  it("loads every relation page and folds a decision claim anchor into its decision", async () => {
    const getRelationGraph = vi.fn(async ({ cursor }: { cursor?: string }) => ({
      ok: true,
      page: { limit: 500, cursor: cursor ?? null, nextCursor: cursor ? null : "bindings" },
      edges: cursor
        ? [
            {
              relationId: "rel-binding",
              sourceRef: "decision/dec-bound/CH1",
              targetRef: "task/task-bound",
              relationType: "derives",
              direction: "directed",
              strength: "strong",
              origin: "declared",
              state: "active",
              current: true,
              rationale: "binding",
              ownerRef: "decision/dec-bound",
              sourcePath: "event:decision/dec-bound",
              recordIndex: 0,
            },
          ]
        : [],
      coverageRows: [],
      factAnchors: [],
      facts: [],
      cursor: "lifecycle:7",
      sourceCursor: "lifecycle:7",
      done: true,
    }));
    vi.stubGlobal("window", {
      harness: {
        getRelationGraph,
        getAgentRuntimeOverview: vi.fn(async () => ({ ok: true, sessions: [] })),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(TaskRelationsTab, {
            task,
            decisions: [{ decisionId: "dec-bound", title: "Bound decision", state: "in_effect" }],
            onOpenSession: () => undefined,
          }),
        ),
      );
    });
    for (let attempt = 0; attempt < 10 && !container.textContent?.includes("dec-bound"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const decisionGroup = [...container.querySelectorAll("section")].find(
      (section) => section.querySelector("h3")?.textContent === "Decision",
    );
    expect(getRelationGraph).toHaveBeenCalledTimes(2);
    expect(decisionGroup?.textContent).toContain("dec-bound");
    expect(decisionGroup?.textContent).toContain("in_effect");
    await act(async () => root.unmount());
  });
});
