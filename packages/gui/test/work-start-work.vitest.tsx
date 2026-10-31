// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { daemonGuiActionMethods } from "@harness-anything/daemon/protocol";
import { presetCommands, presetMethods } from "../../preset/src/preset-command-contract.ts";
import { WorkView } from "../src/renderer/views/WorkView.tsx";
import { harnessClient } from "../src/renderer/api-client.ts";
import type { CatalogPresetSuccess, CatalogSnapshotSuccess } from "../src/renderer/api-client-catalog.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  START_WORK_TASK_CLASSES,
  START_WORK_WORK_KINDS,
  startWorkIdempotencyKey,
  startWorkPlan,
  type StartWorkDraft,
} from "../src/renderer/start-work-flow.ts";

/**
 * 「开始一项工作」(S5,task_654349ce;dec_DC3A1BB9 CH3 迁到工作页顶部)经 GUI action
 * 直接提交 canonical `repo.task.create`,用真实 receipt 展示 taskId/packagePath/opId。
 */

const REPO_ID = "work-start-probe",
  NOW = "2026-09-21T02:00:00.000Z";

function taskRow(patch: Partial<TaskRow> & { readonly taskId: string }): TaskRow {
  return {
    title: patch.taskId,
    projectId: REPO_ID,
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "kernel/task-lifecycle/v1",
    origin: "native",
    source: "local-document",
    lastKnownAt: NOW,
    gates: [],
    board: projectedTaskFields("active").board,
    visibility: projectedTaskFields("active").visibility,
    capabilities: projectedTaskFields("active").capabilities,
    risk: projectedTaskFields("active").risk,
    phase: projectedTaskFields("active").phase,
    docs: [],
    ...patch,
  } as TaskRow;
}

const TASKS = [
  taskRow({ taskId: "task_root", title: "统一工作体验", workId: "task_root" }),
  taskRow({
    taskId: "task_child",
    title: "首次工作与入口",
    parentTaskId: "task_root",
    workId: "task_root",
    workTitle: "统一工作体验",
  }),
];

const CATALOG: CatalogSnapshotSuccess = {
  schema: "gui-catalog-snapshot/v2",
  ok: true,
  status: "ready",
  repoId: REPO_ID,
  observedAt: NOW,
  defaults: { verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", locale: "zh-CN" },
  presets: [
    {
      id: "standard-task",
      title: "标准任务",
      description: "默认软件编码任务包",
      verticalId: "software/coding",
      sourceKind: "bundled",
      validity: "valid",
      version: "1.0.0",
      kind: "task",
      defaultProfile: "baseline",
      profiles: [{ id: "baseline", title: "baseline" }],
      entrypoints: [],
      issues: [],
      shadows: null,
    },
    {
      id: "broken-preset",
      title: "坏掉的 preset",
      description: "目录里标为不可用",
      verticalId: "software/coding",
      sourceKind: "user",
      validity: "blocked",
      version: null,
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
  bundledAgents: ["codex-worker", "claude-reviewer"],
  settingsFields: [],
  settingsGroups: [],
  gateMappings: {
    appliesTo: [],
    adapterFields: {},
    governanceFields: [],
    governableAdapters: [],
  },
};

const PRESET_DETAIL: CatalogPresetSuccess = {
  schema: "gui-catalog-preset/v1",
  ok: true,
  repoId: REPO_ID,
  preset: {
    id: "standard-task",
    verticalId: "software/coding",
    version: "1.0.0",
    extends: null,
    capabilityImports: [],
  },
  resolved: {
    profile: { completionGateIds: ["ci", "manual-attest"] },
    templates: [],
    documents: [
      {
        slot: "task.plan",
        path: "task_plan.md",
        body: [
          "# {{title}}",
          "",
          "Task Contract: harness-task v1",
          "",
          "## Brief",
          "",
          "One-line statement of the task objective and scope.",
          "",
          "## Context",
          "",
          "Record the input context and established facts.",
          "",
          "## Verification",
          "",
          "Write every acceptance item as command plus expected result.",
        ].join("\n"),
        mediaType: "text/markdown",
        owner: "machine",
        templateRef: "template://task.plan@1.0.0",
      },
    ],
    entrypoints: [],
    provenance: {},
    digest: "sha256:probe",
  },
};

const DRAFT: StartWorkDraft = {
  title: "接上工作页的开始一项工作",
  intent: "目标:冷用户能从工作页建出第一项工作。交付:入口 + 定向测试。",
  presetId: "standard-task",
  riskTier: "medium",
  taskClass: "standard",
  workKind: "feat",
  parentTaskId: "task_root",
};

setActiveLocale("zh-CN");

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

interface Mounted {
  readonly container: HTMLElement;
  readonly refreshLedger: ReturnType<typeof vi.fn>;
  readonly openTask: ReturnType<typeof vi.fn>;
  readonly presetReads: ReturnType<typeof vi.fn>;
  readonly createTask: ReturnType<typeof vi.fn>;
  rerender: (tasks: readonly TaskRow[]) => Promise<void>;
}

async function mountWorkView(
  options: { readonly tasks?: readonly TaskRow[]; readonly catalog?: CatalogSnapshotSuccess | null } = {},
): Promise<Mounted> {
  const refreshLedger = vi.fn(),
    openTask = vi.fn(),
    presetReads = vi.fn(async () => PRESET_DETAIL),
    createTask = vi.fn(async () => ({
      schema: "command-receipt/v2" as const,
      ok: true,
      command: "task-create",
      outcome: "applied" as const,
      opId: "op-start-work",
      taskId: "task_new",
      packagePath: "tasks/task_new-start-work",
    }));
  vi.spyOn(harnessClient, "getCatalogPreset").mockImplementation(presetReads);
  vi.spyOn(harnessClient, "createTask").mockImplementation(createTask as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const render = async (tasks: readonly TaskRow[]) => {
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(WorkView, {
            tasks,
            repoId: REPO_ID,
            projectName: "harness-anything",
            ready: true,
            onOpenTask: openTask,
            catalog: options.catalog === undefined ? CATALOG : (options.catalog ?? undefined),
            catalogError: null,
            daemonState: "responsive",
            onRefreshLedger: refreshLedger,
          }),
        ),
      );
    });
  };
  await render(options.tasks ?? TASKS);
  return { container, refreshLedger, openTask, presetReads, createTask, rerender: render };
}

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(element, `missing [data-testid="${testId}"]`).toBeTruthy();
  return element!;
}

function queryTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return (
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ??
    document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  );
}

/** 对话框走 Modal,渲染在同一棵树上但可能不在 container 内;统一从 body 找。 */
function dialogTestId(testId: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(element, `missing dialog [data-testid="${testId}"]`).toBeTruthy();
  return element!;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(element: HTMLElement, value: string): Promise<void> {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(element: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** 有界地让出事件循环,等一条已发出的读结算;不是墙钟等待。 */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let spins = 0; !predicate(); spins += 1) {
    expect(spins, label).toBeLessThan(200);
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

describe("G1 开始一项工作:GUI Action 与真实契约对齐", () => {
  const declared = presetCommands.find((command) => command.id === "task-create");
  const guiCreate = daemonGuiActionMethods.find(({ method }) => method === "repo.task.create");

  it("task-create GUI Action 复用 CLI 方法的中心单写 payload 与 Action kind", () => {
    expect(declared, "task-create command declaration").toBeTruthy();
    expect([...declared!.path]).toEqual(["task", "create"]);
    expect(declared!.method).toBe("repo.task.create");
    expect(guiCreate?.actionKind).toBe("task-create");
    const presetMethod = presetMethods.find((candidate) => candidate.method === declared!.method);
    expect(guiCreate?.params.fields.payload).toEqual(presetMethod?.params.fields.payload);
  });

  // 契约的 enum 是 kernel 词表的投影,渲染层镜像必须逐词相等。
  it("两个取值面与 task-create 契约声明的 enum 逐词相等(含顺序)", () => {
    const enumOf = (name: string) => [...(declared!.inputs.find((input) => input.name === name)?.enum ?? [])];
    expect(enumOf("--task-class")).toEqual([...START_WORK_TASK_CLASSES]);
    expect(enumOf("--kind")).toEqual([...START_WORK_WORK_KINDS]);
  });

  it("把 brief 放进预置 task.plan scaffold 并保留每个 section", () => {
    const scaffold = PRESET_DETAIL.resolved.documents[0]!.body,
      plan = startWorkPlan(scaffold, DRAFT.title, DRAFT.intent, "See the Brief before work begins.");
    expect(plan).not.toBeNull();
    if (plan === null) throw new Error("the valid fixture scaffold should produce a task plan");
    expect(plan).toContain(`# ${DRAFT.title}`);
    expect(plan).toContain(`> ${DRAFT.intent}`);
    expect(plan).toContain("## Brief");
    expect(plan).toContain("## Context");
    expect(plan).toContain("## Verification");
    expect(plan).toContain("See the Brief before work begins.");
    expect(plan).not.toContain("One-line statement of the task objective and scope.");
  });

  it("does not submit an unusable scaffold without a section heading", () => {
    expect(startWorkPlan("A template without task.plan sections.", DRAFT.title, DRAFT.intent, "Review.")).toBeNull();
  });
});

describe("G1 开始一项工作:幂等键", () => {
  it("同一份表单重复提交使用相同键,不会建出第二条", () => {
    expect(startWorkIdempotencyKey({ ...DRAFT })).toBe(startWorkIdempotencyKey(DRAFT));
  });

  it("表单任一字段改动,幂等键随之改变", () => {
    const base = startWorkIdempotencyKey(DRAFT);
    const variants: StartWorkDraft[] = [
      { ...DRAFT, title: `${DRAFT.title} 二` },
      { ...DRAFT, intent: `${DRAFT.intent} 追加` },
      { ...DRAFT, presetId: "docs-task" },
      { ...DRAFT, riskTier: "low" },
      { ...DRAFT, taskClass: "work" },
      { ...DRAFT, workKind: "fix" },
      { ...DRAFT, parentTaskId: null },
    ];
    for (const variant of variants) expect(startWorkIdempotencyKey(variant)).not.toBe(base);
  });
});

describe("工作页顶部:开始一项工作(dec_DC3A1BB9 CH3)", () => {
  it("入口在工作页页头,点开是创建向导", async () => {
    const view = await mountWorkView();
    const header = view.container.querySelector("header")!;
    const entry = byTestId(view.container, "work-start-work");
    expect(header.contains(entry)).toBe(true);
    expect(entry.textContent).toContain("开始一项工作");
    expect(queryTestId(document.body, "start-work-dialog")).toBeNull();
    await click(entry);
    expect(dialogTestId("start-work-dialog").textContent).toContain("开始一项工作");
  });
});

describe("G1 开始一项工作:向导经真实 GUI Action 创建", () => {
  async function openWizard(tasks?: readonly TaskRow[]) {
    const view = await mountWorkView(tasks ? { tasks } : {});
    await click(byTestId(view.container, "work-start-work"));
    return view;
  }

  it("第一步的取值面来自真实目录快照,不可用的 preset 不给选", async () => {
    const view = await openWizard();
    const preset = dialogTestId("start-work-preset") as HTMLSelectElement;
    expect([...preset.options].map((option) => option.value)).toEqual(["standard-task", "broken-preset"]);
    expect([...preset.options].find((option) => option.value === "broken-preset")?.disabled).toBe(true);
    expect(preset.value).toBe("standard-task");
    expect(dialogTestId("start-work-preset-detail").textContent).toContain("默认软件编码任务包");
    expect(view.presetReads).not.toHaveBeenCalled();
  });

  it("填完三步后直接提交 scaffold plan 并展示 daemon 回执", async () => {
    const view = await openWizard();
    await choose(dialogTestId("start-work-task-class"), "standard");
    await choose(dialogTestId("start-work-parent"), "task_root");
    await click(dialogTestId("start-work-next"));
    await type(dialogTestId("start-work-title"), DRAFT.title);
    await type(dialogTestId("start-work-intent"), DRAFT.intent);
    await click(dialogTestId("start-work-next"));
    // 已解析 profile 只在第 3 步读:前两步一条请求都不发。
    expect(view.presetReads).toHaveBeenCalledTimes(1);
    expect(queryTestId(document.body, "start-work-command")).toBeNull();
    expect(queryTestId(document.body, "start-work-publish-command")).toBeNull();
    await until(
      () => queryTestId(document.body, "start-work-idempotency") !== null,
      "resolved preset plan never produced an idempotency note",
    );
    expect(dialogTestId("start-work-idempotency").textContent).toContain("gui-start-work-");
    await until(
      () => (dialogTestId("start-work-preconditions").textContent ?? "").includes("manual-attest"),
      "resolved profile gates never arrived",
    );
    const preconditions = dialogTestId("start-work-preconditions").textContent ?? "";
    expect(preconditions).toContain("responsive");
    expect(preconditions).toContain("valid");
    expect(dialogTestId("start-work-executors").textContent).toContain("codex-worker");
    const plan = dialogTestId("start-work-plan-body").textContent ?? "";
    expect(plan).toContain(DRAFT.intent);
    expect(plan).toContain("## Verification");
    await until(() => queryTestId(document.body, "start-work-create") !== null, "create action never became ready");
    await click(dialogTestId("start-work-create"));
    expect(view.createTask).toHaveBeenCalledTimes(1);
    expect(view.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: REPO_ID,
        title: DRAFT.title,
        presetId: DRAFT.presetId,
        riskTier: DRAFT.riskTier,
        taskClass: DRAFT.taskClass,
        workKind: DRAFT.workKind,
        parentTaskId: DRAFT.parentTaskId,
        idempotencyKey: startWorkIdempotencyKey(DRAFT),
        plan,
      }),
    );
    expect(view.refreshLedger).toHaveBeenCalledTimes(1);
    expect(dialogTestId("start-work-receipt").textContent).toContain("task_new");
    expect(dialogTestId("start-work-receipt").textContent).toContain("tasks/task_new-start-work");
    await click(dialogTestId("start-work-open"));
    expect(view.openTask).toHaveBeenCalledWith("task_new");
  });

  it("缺标题或缺目标时不显示创建动作,只说还差什么", async () => {
    await openWizard();
    await click(dialogTestId("start-work-next"));
    await click(dialogTestId("start-work-next"));
    expect(queryTestId(document.body, "start-work-create")).toBeNull();
    expect(dialogTestId("start-work-dialog").textContent).toContain("还差:");
  });

  it("创建拒绝时透传 daemon 的错误,不伪造成功", async () => {
    const view = await openWizard();
    await click(dialogTestId("start-work-next"));
    await type(dialogTestId("start-work-title"), "新建的工作");
    await type(dialogTestId("start-work-intent"), DRAFT.intent);
    await click(dialogTestId("start-work-next"));
    view.createTask.mockResolvedValueOnce({
      schema: "command-receipt/v2",
      ok: false,
      command: "task-create",
      outcome: "op_rejected",
      opId: "N/A",
      code: "task_create_denied",
      rejectionExplanation: "task-create is not authorized",
    });
    await until(() => queryTestId(document.body, "start-work-create") !== null, "create action never became ready");
    await click(dialogTestId("start-work-create"));
    expect(dialogTestId("start-work-dialog").textContent).toContain("task-create is not authorized");
    expect(queryTestId(document.body, "start-work-receipt")).toBeNull();
    expect(view.refreshLedger).not.toHaveBeenCalled();
  });

  it("目录快照还没到时不画选型面,如实说在读", async () => {
    const view = await mountWorkView({ catalog: null });
    await click(byTestId(view.container, "work-start-work"));
    expect(dialogTestId("start-work-dialog").textContent).toContain("正在读取目录快照");
    expect(queryTestId(document.body, "start-work-preset")).toBeNull();
  });
});
