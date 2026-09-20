// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { daemonGuiActionMethods } from "@harness-anything/daemon/protocol";
import { presetCommands } from "../../preset/src/preset-command-contract.ts";
import { OverviewNextView } from "../src/renderer/views/OverviewNextView.tsx";
import { harnessClient } from "../src/renderer/api-client.ts";
import type { CatalogPresetSuccess, CatalogSnapshotSuccess } from "../src/renderer/api-client-catalog.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  searchCurrentRepo,
  START_WORK_TASK_CLASSES,
  START_WORK_WORK_KINDS,
  startWorkCommand,
  startWorkIdempotencyKey,
  type StartWorkDraft,
} from "../src/renderer/start-work-flow.ts";

/**
 * G1「工作范围与入口」(S5,task_654349ce)的判据:
 *  - 三个入口都接着真东西:切仓走壳层那一份切换器;搜索走统一实体索引且每行带类型与
 *    所属任务组;「开始一项工作」走到真实 `ha task create` 命令。
 *  - 「不画没有接线的按钮」有对照:命令里出现的每个 flag 都在 task-create 契约里声明过,
 *    两个取值面与 kernel 的真实词表逐词相等;GUI 写面里确实没有 task 创建 ingress
 *    (所以这一步只能是 CLI 指引,这是事实不是偷懒)。
 *  - 重复执行不重复创建:命令自带由表单内容派生的幂等键,同一份表单键不变、字段一改键就变。
 *  - 创建后核对按真实任务投影判定:没找到就说没找到,不假成功。
 */

const REPO_ID = "work-entry-probe",
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
    module: "gui",
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
  taskRow({ taskId: "task_root", title: "统一工作体验", rootTaskId: "task_root" }),
  taskRow({
    taskId: "task_child",
    title: "首次工作与入口",
    parentTaskId: "task_root",
    rootTaskId: "task_root",
    rootTitle: "统一工作体验",
  }),
];

const SEARCH_ROWS = [
  { ref: "task/task_root", label: "统一工作体验", sub: "active", entity: "task" },
  { ref: "task/task_child", label: "首次工作与入口", sub: "active", entity: "task" },
  { ref: "decision/dec_probe", label: "并列新增总览(新)", sub: "in_effect", entity: "decision" },
];

const CATALOG: CatalogSnapshotSuccess = {
  schema: "gui-catalog-snapshot/v1",
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
  ciWorkflows: [],
  bundledAgents: ["codex-worker", "claude-reviewer"],
  settingsFields: [],
  gateMappings: {
    adapters: [],
    appliesTo: [],
    adapterFields: {},
    governanceFields: [],
    governableAdapters: [],
    internalGateId: "code-doc-reconciliation",
  },
  adapters: [],
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
    profile: { completionGateIds: ["ci", "code-doc-reconciliation"] },
    templates: [],
    documents: [],
    entrypoints: [],
    provenance: {},
    digest: "sha256:probe",
  },
};

const PROJECT = {
  id: REPO_ID,
  name: "harness-anything",
  path: "/tmp/work-entry-probe",
  preset: "standard-task",
  engines: ["kernel"],
  watermarkAt: NOW,
};

const HEALTH = {
  daemon: { state: "responsive", observedAgeSec: 1, uptimeMs: 60_000 },
  cell: { state: "ok", queueDepth: 0, problem: null },
  projection: { status: "ready", lag: 0 },
  ledgerChange: { at: NOW, ageSec: 1 },
} as Parameters<typeof OverviewNextView>[0]["health"];

const DRAFT: StartWorkDraft = {
  title: "接上总览(新)的开始一项工作",
  intent: "目标:冷用户能从总览(新)建出第一项工作。交付:入口三件套 + 定向测试。",
  presetId: "standard-task",
  profileId: "baseline",
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
  readonly switchRepo: ReturnType<typeof vi.fn>;
  readonly searchActive: ReturnType<typeof vi.fn>;
  readonly navigateEntity: ReturnType<typeof vi.fn>;
  readonly refreshLedger: ReturnType<typeof vi.fn>;
  readonly openTask: ReturnType<typeof vi.fn>;
  readonly presetReads: ReturnType<typeof vi.fn>;
  rerender: (tasks: readonly TaskRow[]) => Promise<void>;
}

async function mountOverviewNext(
  options: { readonly tasks?: readonly TaskRow[]; readonly catalog?: CatalogSnapshotSuccess | null } = {},
): Promise<Mounted> {
  const switchRepo = vi.fn(),
    searchActive = vi.fn(),
    navigateEntity = vi.fn(),
    refreshLedger = vi.fn(),
    openTask = vi.fn(),
    presetReads = vi.fn(async () => PRESET_DETAIL);
  // observe.tail 永不结算:G5 停在读取中,本套用例只判 G1。
  vi.spyOn(harnessClient, "tailObservability").mockImplementation(() => new Promise<ObserveTailRead>(() => undefined));
  vi.spyOn(harnessClient, "getCatalogPreset").mockImplementation(presetReads);
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
          createElement(OverviewNextView, {
            repoId: REPO_ID,
            project: PROJECT,
            tasks,
            agenda: undefined,
            agendaError: null,
            activeSessions: [],
            runtimeError: null,
            health: HEALTH,
            daemonReadFailed: false,
            ledgerRevision: { watermark: 12, sourceRevision: 3 },
            searchRows: SEARCH_ROWS,
            catalog: options.catalog === undefined ? CATALOG : (options.catalog ?? undefined),
            catalogError: null,
            onNavigateEntity: navigateEntity,
            onOpenGroup: () => undefined,
            onSelectRuntimeEntity: () => undefined,
            onOpenPool: () => undefined,
            onOpenSessions: () => undefined,
            onSwitchRepo: switchRepo,
            onSearchActiveChange: searchActive,
            onRefreshLedger: refreshLedger,
            onOpenTask: openTask,
          }),
        ),
      );
    });
  };
  await render(options.tasks ?? TASKS);
  return {
    container,
    switchRepo,
    searchActive,
    navigateEntity,
    refreshLedger,
    openTask,
    presetReads,
    rerender: render,
  };
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

describe("G1 开始一项工作:命令面与真实契约对齐", () => {
  const declared = presetCommands.find((command) => command.id === "task-create");

  it("task-create 命令在契约里存在,且走中心单写路", () => {
    expect(declared, "task-create command declaration").toBeTruthy();
    expect([...declared!.path]).toEqual(["task", "create"]);
    expect(declared!.method).toBe("repo.task.create");
  });

  it("生成的命令只用契约声明过的 flag", () => {
    const declaredFlags = new Set(declared!.inputs.map((input) => input.name));
    const emitted = startWorkCommand(DRAFT).argv.filter((token) => token.startsWith("--"));
    expect(emitted.length).toBeGreaterThan(0);
    for (const flag of emitted) expect(declaredFlags, `${flag} not declared by task-create`).toContain(flag);
    expect(emitted).toEqual([
      "--title",
      "--preset",
      "--profile",
      "--task-class",
      "--kind",
      "--parent",
      "--idempotency-key",
    ]);
  });

  // 契约的 enum 就是 kernel 词表的投影(生成器从 kernel 声明产出 task-create 投影,
  // `preset-system.ts` 也是拿 `taskCreateEnum` 当取值面),所以这里对着契约核对即可 ——
  // 渲染层的字面镜像与 `ha task create` 真正接受的取值一字不差,顺序也一样。
  it("两个取值面与 task-create 契约声明的 enum 逐词相等(含顺序)", () => {
    const enumOf = (name: string) => [...(declared!.inputs.find((input) => input.name === name)?.enum ?? [])];
    expect(enumOf("--task-class")).toEqual([...START_WORK_TASK_CLASSES]);
    expect(enumOf("--kind")).toEqual([...START_WORK_WORK_KINDS]);
  });

  it("GUI 写面里确实没有任务创建 ingress —— 这一步只能给 CLI 指引", () => {
    const guiWriteMethods = daemonGuiActionMethods.map((action) => action.method);
    expect(guiWriteMethods).not.toContain("repo.task.create");
    expect(guiWriteMethods).toContain("repo.task.start");
  });

  it("标题里的空格与引号不会把命令拆开", () => {
    const text = startWorkCommand({ ...DRAFT, title: `把 "开始" 接上` }).text;
    expect(text).toContain(`--title '把 "开始" 接上'`);
    expect(text.startsWith("ha task create ")).toBe(true);
  });
});

describe("G1 开始一项工作:幂等键", () => {
  it("同一份表单重复生成命令完全一致,不会建出第二条", () => {
    const first = startWorkCommand(DRAFT),
      second = startWorkCommand({ ...DRAFT });
    expect(second.text).toBe(first.text);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.text).toContain(`--idempotency-key ${first.idempotencyKey}`);
  });

  it("表单任一字段改动,幂等键随之改变", () => {
    const base = startWorkIdempotencyKey(DRAFT);
    const variants: StartWorkDraft[] = [
      { ...DRAFT, title: `${DRAFT.title} 二` },
      { ...DRAFT, intent: `${DRAFT.intent} 追加` },
      { ...DRAFT, presetId: "docs-task" },
      { ...DRAFT, profileId: null },
      { ...DRAFT, taskClass: "milestone" },
      { ...DRAFT, workKind: "fix" },
      { ...DRAFT, parentTaskId: null },
    ];
    for (const variant of variants) expect(startWorkIdempotencyKey(variant)).not.toBe(base);
  });
});

describe("G1 搜索:类型与所属任务组", () => {
  it("命中带实体类型;子任务带所属组,根任务与非任务行没有组", () => {
    const hits = searchCurrentRepo(SEARCH_ROWS, TASKS, "统一", 12);
    expect(hits.map((hit) => hit.ref)).toEqual(["task/task_root"]);
    expect(hits[0].entity).toBe("task");
    expect(hits[0].group).toBeNull();
    const child = searchCurrentRepo(SEARCH_ROWS, TASKS, "首次", 12)[0];
    expect(child.group).toEqual({ taskId: "task_root", title: "统一工作体验" });
    const decision = searchCurrentRepo(SEARCH_ROWS, TASKS, "并列", 12)[0];
    expect(decision.entity).toBe("decision");
    expect(decision.group).toBeNull();
  });

  it("空查询不出结果;上限生效", () => {
    expect(searchCurrentRepo(SEARCH_ROWS, TASKS, "   ", 12)).toEqual([]);
    expect(searchCurrentRepo(SEARCH_ROWS, TASKS, "a", 1).length).toBeLessThanOrEqual(1);
  });
});

describe("G1 区域:三个入口", () => {
  it("渲染切仓、当前仓搜索与开始一项工作三个入口", async () => {
    const view = await mountOverviewNext();
    const bar = byTestId(view.container, "overview-next-work-entry");
    expect(bar.textContent).toContain("切换仓库");
    expect(bar.textContent).toContain("开始一项工作");
    expect(byTestId(view.container, "overview-next-search-input")).toBeTruthy();
    expect(bar.textContent).toContain(PROJECT.name);
  });

  it("切仓按钮走壳层那一份切换器", async () => {
    const view = await mountOverviewNext();
    await click(byTestId(view.container, "overview-next-switch-repo"));
    expect(view.switchRepo).toHaveBeenCalledTimes(1);
  });

  it("有输入才启用事实索引读面,结果显式标类型与所属组,点击走实体导航", async () => {
    const view = await mountOverviewNext();
    expect(view.searchActive.mock.calls.at(-1)?.[0]).toBe(false);
    expect(queryTestId(view.container, "overview-next-search-results")).toBeNull();
    await type(byTestId(view.container, "overview-next-search-input"), "首次");
    expect(view.searchActive.mock.calls.at(-1)?.[0]).toBe(true);
    const results = byTestId(view.container, "overview-next-search-results");
    expect(results.textContent).toContain("task");
    expect(results.textContent).toContain("所属组:统一工作体验");
    await click(results.querySelector("button")!);
    expect(view.navigateEntity).toHaveBeenCalledWith("task/task_child");
  });

  it("查无此项时给诚实空态,不冒充有结果", async () => {
    const view = await mountOverviewNext();
    await type(byTestId(view.container, "overview-next-search-input"), "不存在的东西");
    expect(byTestId(view.container, "overview-next-search-results").textContent).toContain("没有匹配");
  });
});

describe("G1 开始一项工作:向导走到真实创建命令", () => {
  async function openWizard(tasks?: readonly TaskRow[]) {
    const view = await mountOverviewNext(tasks ? { tasks } : {});
    await click(byTestId(view.container, "overview-next-start-work"));
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

  it("填完三步后给出真实 ha task create 命令与必要条件", async () => {
    const view = await openWizard();
    await choose(dialogTestId("start-work-task-class"), "standard");
    await choose(dialogTestId("start-work-parent"), "task_root");
    await click(dialogTestId("start-work-next"));
    await type(dialogTestId("start-work-title"), DRAFT.title);
    await type(dialogTestId("start-work-intent"), DRAFT.intent);
    await click(dialogTestId("start-work-next"));
    // 已解析 profile 只在第 3 步读:前两步一条请求都不发。
    expect(view.presetReads).toHaveBeenCalledTimes(1);
    const command = dialogTestId("start-work-command").textContent ?? "";
    expect(command).toContain("ha task create");
    expect(command).toContain(`--title '${DRAFT.title}'`);
    expect(command).toContain("--preset standard-task");
    expect(command).toContain("--parent task_root");
    expect(dialogTestId("start-work-idempotency").textContent).toContain("gui-start-work-");
    await until(
      () => (dialogTestId("start-work-preconditions").textContent ?? "").includes("code-doc-reconciliation"),
      "resolved profile gates never arrived",
    );
    const preconditions = dialogTestId("start-work-preconditions").textContent ?? "";
    expect(preconditions).toContain("responsive");
    expect(preconditions).toContain("valid");
    expect(dialogTestId("start-work-executors").textContent).toContain("codex-worker");
    expect(dialogTestId("start-work-plan-body").textContent).toBe(DRAFT.intent);
  });

  it("缺标题或缺目标时不画命令,只说还差什么", async () => {
    await openWizard();
    await click(dialogTestId("start-work-next"));
    await click(dialogTestId("start-work-next"));
    expect(queryTestId(document.body, "start-work-command")).toBeNull();
    expect(dialogTestId("start-work-dialog").textContent).toContain("还差:");
  });

  it("创建后核对:刷新台账并按标题找到真任务才算数,找不到就说找不到", async () => {
    const view = await openWizard();
    await click(dialogTestId("start-work-next"));
    await type(dialogTestId("start-work-title"), "新建的工作");
    await type(dialogTestId("start-work-intent"), DRAFT.intent);
    await click(dialogTestId("start-work-next"));
    await click(dialogTestId("start-work-verify"));
    expect(view.refreshLedger).toHaveBeenCalledTimes(1);
    expect(dialogTestId("start-work-dialog").textContent).toContain("还没有「新建的工作」");
    expect(queryTestId(document.body, "start-work-open")).toBeNull();
    // 台账下一切面带回这条任务:核对转为找到,并能直达任务。
    await view.rerender([...TASKS, taskRow({ taskId: "task_new", title: "新建的工作", rootTaskId: "task_new" })]);
    expect(dialogTestId("start-work-dialog").textContent).toContain("task_new");
    await click(dialogTestId("start-work-open"));
    expect(view.openTask).toHaveBeenCalledWith("task_new");
  });

  it("目录快照还没到时不画选型面,如实说在读", async () => {
    const view = await mountOverviewNext({ catalog: null });
    await click(byTestId(view.container, "overview-next-start-work"));
    expect(dialogTestId("start-work-dialog").textContent).toContain("正在读取目录快照");
    expect(queryTestId(document.body, "start-work-preset")).toBeNull();
  });
});
