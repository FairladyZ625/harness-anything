// harness-test-tier: integration
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskRelationsTab } from "../src/renderer/components/taskDetail/TaskRelationsTab.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
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

  it("renders the relations Section title and note from en-US i18n", async () => {
    vi.stubGlobal("window", {
      harness: {
        getRelationGraph: vi.fn(async () => ({
          ok: true,
          page: { limit: 500, cursor: null, nextCursor: null },
          edges: [],
          coverageRows: [],
          factAnchors: [],
          facts: [],
          cursor: null,
          sourceCursor: null,
          done: true,
        })),
        getAgentRuntimeOverview: vi.fn(async () => ({ ok: true, sessions: [] })),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setActiveLocale("en-US");
    try {
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(TaskRelationsTab, { task, onOpenSession: () => undefined }),
          ),
        );
      });
      // B1: 外层 Section 的 title/note 不再内嵌自然语言——en-US 下整个 Section 头行
      // 只有英文文案，标题与 note 都来自 views.taskDetailView.relationsTitle/relationsNote。
      const sectionHeader = container.querySelector("h2")?.parentElement;
      expect(sectionHeader?.textContent).toContain("Task relations");
      expect(sectionHeader?.textContent).toContain("Jumpable index of the lineage and cost tree");
      expect(sectionHeader?.textContent ?? "").not.toMatch(/[\u4e00-\u9fff]/u);
    } finally {
      setActiveLocale("zh-CN");
      await act(async () => root.unmount());
    }
  });
});
