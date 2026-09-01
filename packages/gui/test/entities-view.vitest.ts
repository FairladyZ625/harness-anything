// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EntitiesView } from "../src/renderer/views/EntitiesView.tsx";
import { ENTITY_DOC_GROUPS, FACT_TYPE_VOCABULARY } from "../src/renderer/entity-docs.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { ViewId } from "../src/renderer/navigation/viewHistory.ts";

/**
 * 实体说明面行为判据:目录 → 详情、活行数来自既有读面、GUI 入口跳转、
 * Fact Type 受控词表区的诚实空态(阴性对照:登记面未合入时不得渲染任何
 * 示例 Type,同时事实切面照常显示真实统计——证明空的是登记面,不是读面)。
 */

const REPO_ID = "repo-entities";
const noop = () => undefined;
const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  setActiveLocale("zh-CN");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { root } of mounted.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubBridge(
  domainTypes: ReadonlyArray<{ readonly domainType: string; readonly registeredByFactId: string }> = [],
) {
  const calls = { relationGraph: 0 };
  vi.stubGlobal("window", {
    harness: {
      getWorkspaceSummary: vi.fn(async () => ({
        schema: "daemon.workspace-summary/v1",
        ok: true,
        status: "ready",
        tasks: { total: 12, byStatus: {} },
        decisions: { total: 7, inboxCount: 0, byState: {}, groups: [] },
        watermark: 40,
        sourceRevision: 40,
      })),
      getCatalogSnapshot: vi.fn(async () => ({
        schema: "gui-catalog-snapshot/v1",
        ok: true,
        status: "ready",
        repoId: REPO_ID,
        observedAt: "2026-08-30T00:00:00.000Z",
        catalogDigest: "digest000000000000",
        defaults: { verticalId: "software/coding", presetId: "preset-a", profileId: null, locale: "zh-CN" },
        presets: [
          {
            id: "preset-a",
            title: "A",
            description: "",
            verticalId: "software/coding",
            sourceKind: "bundled",
            validity: "valid",
            version: "1",
            kind: null,
            defaultProfile: null,
            profiles: [],
            entrypoints: [],
            issues: [],
            shadows: null,
          },
        ],
        verticals: [],
        templates: [],
        scaffolds: { task: [], repository: [] },
        adapters: [
          {
            adapterId: "claude",
            registered: true,
            capabilities: [],
            writability: "read-write",
            defaultProvider: false,
            unavailableReason: null,
          },
        ],
      })),
      listAgents: vi.fn(async () => ({
        schema: "agent-entity-catalog/v1",
        ok: true,
        agents: [{ id: "glm-5-3", name: "GLM" }],
      })),
      listSquads: vi.fn(async () => ({
        schema: "squad-entity-catalog/v1",
        ok: true,
        squads: [],
      })),
      listSchedules: vi.fn(async () => ({
        ok: true,
        status: "ready",
        schedules: [
          {
            scheduleId: "schedule_alpha",
            name: "alpha",
            state: "armed",
            mode: "detect",
            availability: "available",
          },
        ],
        watermark: 3,
        sourceRevision: 3,
      })),
      getRelationGraph: vi.fn(async () => {
        calls.relationGraph += 1;
        return {
          ok: true,
          facet: "facts",
          edges: [],
          coverageRows: [],
          factAnchors: [],
          facts: [
            { anchor: "fact/F-AAAAAAAA", text: "观察一", category: "lesson" },
            { anchor: "fact/F-BBBBBBBB", text: "观察二", category: "lesson" },
            { anchor: "fact/F-CCCCCCCC", text: "观察三", category: "finding" },
          ],
          domainTypes: domainTypes.map((entry, index) => ({ ...entry, workspaceRevision: index + 1 })),
          warnings: [],
        };
      }),
    },
  });
  return calls;
}

async function renderSurface(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  mounted.push({ root, container });
  return container;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function view(focusedEntityDocKind: string | null, onOpenView: (view: ViewId) => void = noop) {
  return createElement(EntitiesView, {
    repoId: REPO_ID,
    focusedEntityDocKind,
    onOpenEntityDoc: noop,
    onExitDetail: noop,
    onOpenView,
    projectName: "Probe",
  });
}

describe("entities catalog", () => {
  it("renders every documented entity as a card grouped by plane", async () => {
    stubBridge();
    const container = await renderSurface(view(null));
    for (const group of ENTITY_DOC_GROUPS)
      expect(container.querySelector(`[data-testid="entity-doc-group-${group.id}"]`)).not.toBeNull();
    for (const doc of ENTITY_DOC_GROUPS.flatMap((group) => group.docs))
      expect(container.querySelector(`[data-testid="entity-doc-card-${doc.kind}"]`), doc.kind).not.toBeNull();
  });

  it("shows live counts from the existing read surfaces", async () => {
    stubBridge();
    const container = await renderSurface(view(null));
    await settle();
    const taskCard = container.querySelector<HTMLElement>('[data-testid="entity-doc-card-task"]');
    expect(taskCard?.textContent).toContain("12");
    const agentCard = container.querySelector<HTMLElement>('[data-testid="entity-doc-card-agent"]');
    expect(agentCard?.textContent).toContain("1");
  });
});

describe("entity doc detail", () => {
  it("renders definition, fields, statuses, relations, and actions for a triad entity", async () => {
    stubBridge();
    const container = await renderSurface(view("decision"));
    await settle();
    const text = container.textContent ?? "";
    expect(container.querySelector('[data-testid="entity-doc-detail-decision"]')).not.toBeNull();
    expect(text).toContain("承重选择");
    expect(text).toContain("decisionId");
    expect(text).toContain("in_effect");
    expect(text).toContain("supersedes");
    expect(text).toContain("declare-claim");
    // 嵌套载荷分组与 GUI 入口说明都在详情里。
    expect(text).toContain("payload(proposal)");
    expect(text).toContain("决策批准 / 决策池");
  });

  it("navigates to the entity's live view from the detail header", async () => {
    stubBridge();
    const opened: ViewId[] = [];
    const container = await renderSurface(view("schedule", (next) => opened.push(next)));
    await settle();
    const button = container.querySelector<HTMLButtonElement>('button[title*="定时计划"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    expect(opened).toEqual(["schedules"]);
  });

  it("renders an honest unknown-kind state instead of guessing", async () => {
    stubBridge();
    const container = await renderSurface(view("unicorn"));
    expect(container.querySelector('[data-testid="entity-doc-detail-unknown"]')).not.toBeNull();
    expect(container.textContent).toContain("未知实体 kind:unicorn");
  });
});

describe("fact type vocabulary area (negative control)", () => {
  it("shows a real empty state with no fabricated types while the fact facet still renders live stats", async () => {
    const calls = stubBridge();
    const container = await renderSurface(view("fact"));
    await settle();
    const area = container.querySelector('[data-testid="fact-type-vocabulary"]');
    expect(area).not.toBeNull();
    // 裁决引用与真实投影标注都在场。
    expect(area?.textContent).toContain("投影实况");
    expect(area?.textContent).toContain(FACT_TYPE_VOCABULARY.decisionId);
    // 阴性对照:空投影不得出现任何示例 Type。
    const registered = container.querySelector('[data-testid="fact-type-registered-list"]');
    expect(registered?.textContent).toContain("空——");
    // 同一详情里,事实切面是真实数据:既有读面工作正常,空的是登记面本身。
    expect(calls.relationGraph).toBeGreaterThan(0);
    const live = container.querySelector('[data-testid="fact-facet-live"]');
    expect(live?.textContent).toContain("3 条 fact");
    expect(live?.textContent).toContain("lesson · 2");
    expect(live?.textContent).toContain("finding · 1");
  });

  it("renders registered types and their exact registration fact ids", async () => {
    stubBridge([
      { domainType: "architecture", registeredByFactId: "F-AAAABBBB" },
      { domainType: "bug", registeredByFactId: "F-CCCCDDDD" },
    ]);
    const container = await renderSurface(view("fact"));
    await settle();
    const registered = container.querySelector('[data-testid="fact-type-registered-list"]');
    expect(registered?.textContent).toContain("architecture");
    expect(registered?.textContent).toContain("fact/F-AAAABBBB");
    expect(registered?.textContent).toContain("bug");
    expect(registered?.textContent).toContain("fact/F-CCCCDDDD");
    expect(registered?.textContent).not.toContain("空——");
  });

  it("does not read the fact facet for other entities", async () => {
    const calls = stubBridge();
    await renderSurface(view("task"));
    await settle();
    expect(calls.relationGraph).toBe(0);
  });
});
