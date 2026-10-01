// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HomeView } from "../src/renderer/views/HomeView.tsx";
import { harnessClient, type SystemRepoRow } from "../src/renderer/api-client.ts";
import { agentRuntimeClient, runtimeQueryKeys } from "../src/renderer/agent-runtime-client.ts";
import { workspaceSummaryQueryKeys } from "../src/renderer/workspace-summary-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import {
  groupProjects,
  projectActivityRead,
  projectStatusMeta,
  type ProjectActivityRead,
} from "../src/renderer/model/repo-state.ts";

/**
 * 项目管理页(gui-visual-language-standard §2.5):分组与排序、每个项目第二行的真实数字、
 * 读不到时的原因、管理动作只在宿主 bridge 有能力时出现,停用与移除确认后才调用 bridge。
 */

const mounted: Root[] = [];
const host = window as unknown as { harness?: unknown };

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});
afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
  delete host.harness;
});

const repo = (overrides: Partial<SystemRepoRow>): SystemRepoRow => ({
  repoId: "canonical",
  displayName: "Harness Anything",
  canonicalRoot: "/tmp/canonical",
  authoredBranch: "main",
  registrationState: "enabled",
  mode: "local",
  connectionId: "local",
  cellState: "attached",
  generation: 1,
  queueDepth: 0,
  lockState: "not_applicable",
  recoveryMs: null,
  lastError: null,
  unavailableReason: null,
  ...overrides,
});

const summary = (counts: Partial<Record<"active" | "submitted" | "in_review" | "blocked", number>>, inbox = 0) => ({
  tasks: { lastChangedAt: null, byStatus: { active: 0, submitted: 0, in_review: 0, blocked: 0, ...counts } },
  decisions: { inboxCount: inbox },
});
const sessions = (...liveness: string[]) => ({ sessions: liveness.map((value) => ({ liveness: value })) });
const ready = (overrides: Partial<Extract<ProjectActivityRead, { state: "ready" }>>): ProjectActivityRead => ({
  state: "ready",
  lastChangedAt: null,
  active: 0,
  awaitingYou: 0,
  inReview: 0,
  blocked: 0,
  liveAgents: 0,
  ...overrides,
});

async function mountHome(
  repos: readonly SystemRepoRow[],
  currentRepoId: string | null,
  seed: Readonly<Record<string, { readonly summary: unknown; readonly runtime: unknown }>> = {},
): Promise<{
  readonly container: HTMLElement;
  readonly opened: readonly string[];
  readonly targets: readonly (string | undefined)[];
}> {
  const opened: string[] = [];
  const targets: (string | undefined)[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [repoId, data] of Object.entries(seed)) {
    client.setQueryData(workspaceSummaryQueryKeys.read(repoId), data.summary);
    client.setQueryData(runtimeQueryKeys.overviewAll(repoId), data.runtime);
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(HomeView, {
          repos,
          currentRepoId,
          onOpenProject: (repoId: string, target?: "agenda" | "work") => {
            opened.push(repoId);
            targets.push(target);
          },
        }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, opened, targets };
}

/** 点击后等 mutation 的结果落到状态里(react-query 在后续 tick 通知)。 */
async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 条目上的「⋯」与它打开的气泡(气泡 portal 到 body,同一时刻只有一个)。 */
const more = (entry: HTMLElement): HTMLElement => entry.querySelector<HTMLElement>('[data-testid="home-entry-more"]')!;
const panel = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="home-entry-more-panel"]')!;

const entryIds = (scope: ParentNode): string[] =>
  [...scope.querySelectorAll("[data-testid^='home-repo-']")].map((entry) =>
    entry.getAttribute("data-testid")!.replace("home-repo-", ""),
  );

describe("项目分组与状态(model/repo-state)", () => {
  it("坏的与等人处理的进「需要处理」,坏的在前、其次按等人处理数量;当前项目在「项目」组置首;停用沉底", () => {
    const repos = [
      repo({ repoId: "b-idle" }),
      repo({ repoId: "z-current" }),
      repo({ repoId: "m-awaits-2" }),
      repo({ repoId: "a-awaits-5" }),
      repo({ repoId: "y-broken", cellState: "unavailable", unavailableReason: "ledger unreadable" }),
      repo({ repoId: "c-read-failed" }),
      repo({ repoId: "d-disabled", registrationState: "disabled", cellState: "not_loaded", lastError: "root gone" }),
      repo({ repoId: "e-not-loaded", cellState: "not_loaded" }),
    ];
    const reads: Record<string, ProjectActivityRead> = {
      "m-awaits-2": ready({ awaitingYou: 2 }),
      "a-awaits-5": ready({ awaitingYou: 5 }),
      "c-read-failed": { state: "failed", reason: "projection_pending" },
      "b-idle": ready({}),
      "z-current": ready({ active: 3 }),
    };
    const groups = groupProjects(repos, "z-current", (row) => reads[row.repoId] ?? { state: "unread" });
    expect(groups.attention.map((row) => row.repoId)).toEqual([
      "c-read-failed",
      "y-broken",
      "a-awaits-5",
      "m-awaits-2",
    ]);
    expect(groups.open.map((row) => row.repoId)).toEqual(["z-current", "b-idle", "e-not-loaded"]);
    expect(groups.disabled.map((row) => row.repoId)).toEqual(["d-disabled"]);
  });

  it("读面结果折成数字:等你处理 = 待派审 + 待裁决定;runtime 没读到时任务数字照常、agent 记为未知", () => {
    expect(projectActivityRead({ error: null }, { error: null })).toEqual({ state: "loading" });
    expect(projectActivityRead({ error: new Error("repo_unavailable") }, { error: null })).toEqual({
      state: "failed",
      reason: "repo_unavailable",
    });
    const data = summary({ active: 9, submitted: 2, in_review: 3, blocked: 4 }, 1);
    // 摘要到了、runtime 还在路上:仍是 loading,不先闪一个「agent 没读到」。
    expect(projectActivityRead({ data, error: null }, { error: null })).toEqual({ state: "loading" });
    expect(
      projectActivityRead({ data, error: null }, { data: sessions("live", "stale", "live"), error: null }),
    ).toEqual({
      state: "ready",
      lastChangedAt: null,
      active: 9,
      awaitingYou: 3,
      inReview: 3,
      blocked: 4,
      liveAgents: 2,
    });
    expect(projectActivityRead({ data, error: null }, { error: new Error("boom") })).toMatchObject({
      state: "ready",
      lastChangedAt: null,
      liveAgents: null,
    });
  });

  it("状态标签说项目现在的情况,不是每行都一样的「已附着」", () => {
    const attached = repo({});
    expect(projectStatusMeta(attached, ready({ awaitingYou: 1, active: 5 })).tone).toBe("wait");
    expect(projectStatusMeta(attached, ready({ active: 5 }))).toEqual({
      tone: "active",
      labelKey: "views.homeView.statusActive",
    });
    expect(projectStatusMeta(attached, ready({ liveAgents: 1 })).tone).toBe("active");
    expect(projectStatusMeta(attached, ready({})).labelKey).toBe("views.homeView.statusIdle");
    expect(projectStatusMeta(attached, { state: "failed", reason: "x" }).tone).toBe("bad");
    expect(projectStatusMeta(repo({ registrationState: "disabled" }), { state: "unread" }).tone).toBe("cancel");
    expect(
      projectStatusMeta(repo({ mode: "remote-proxy", cellState: "not_loaded", canonicalRoot: null }), {
        state: "unread",
      }).labelKey,
    ).toBe("views.homeView.statusRemote");
    expect(projectStatusMeta(repo({ cellState: "warming" }), { state: "unread" }).tone).toBe("wait");
  });
});

describe("HomeView 项目管理页", () => {
  it("已挂载项目第二行是真实数字;等人处理的排最前并带数量;当前项目有标记;点行进入", async () => {
    const { container, opened } = await mountHome(
      [repo({ repoId: "aa-current", displayName: "Current" }), repo({ repoId: "zz-awaits", displayName: "Awaits" })],
      "aa-current",
      {
        "aa-current": { summary: summary({ active: 9, in_review: 3, blocked: 4 }), runtime: sessions("live", "live") },
        "zz-awaits": { summary: summary({ active: 1, submitted: 2 }, 1), runtime: sessions() },
      },
    );
    expect(entryIds(container)).toEqual(["zz-awaits", "aa-current"]);
    expect(entryIds(container.querySelector('[data-testid="home-group-attention"]')!)).toEqual(["zz-awaits"]);
    expect(entryIds(container.querySelector('[data-testid="home-group-open"]')!)).toEqual(["aa-current"]);
    expect(container.querySelector('[data-testid="home-group-disabled"]')).toBeNull();

    const awaits = container.querySelector<HTMLElement>('[data-testid="home-repo-zz-awaits"]')!;
    expect(awaits.querySelector("[data-status-tone]")?.getAttribute("data-status-tone")).toBe("wait");
    expect(awaits.textContent).toContain("等你处理 3");
    // 没有 agent 在跑时不写这句(重复值不逐行重复),第二行只剩真实计数。
    expect(awaits.textContent).toContain("进行中 1");
    expect(awaits.textContent).not.toContain("agent");
    expect(awaits.querySelector('[data-testid="home-entry-agents"]')).toBeNull();
    expect(awaits.style.getPropertyValue("--status-edge")).toContain("var(--color-status-submitted)");

    const current = container.querySelector<HTMLElement>('[data-testid="home-repo-aa-current"]')!;
    expect(current.dataset.current).toBe("true");
    expect(current.textContent).toContain("当前");
    // 有 agent 在跑才写,排最前并单独着色。
    expect(current.textContent).toContain("2 个 agent 在跑 · 进行中 9 · 评审中 3 · 阻塞 4");
    expect(current.querySelector('[data-testid="home-entry-agents"]')?.textContent).toBe("2 个 agent 在跑");
    expect(current.textContent).toContain("/tmp/canonical");
    expect(current.style.getPropertyValue("--status-edge")).toBe("");
    // 当前项目不再给「进入」按钮;其他可进入的项目给,且与点第一行同一个动作。
    expect(current.querySelector('[data-testid="home-entry-open"]')).toBeNull();
    await act(async () => {
      awaits.querySelector<HTMLElement>('[data-testid="home-entry-open"]')!.click();
      awaits.querySelector("button")!.click();
    });
    expect(opened).toEqual(["zz-awaits", "zz-awaits"]);
    expect(container.querySelector('[data-testid="home-counts"]')?.textContent).toBe("1 个可进入 · 1 个需要处理");
  });

  it("只读已挂载的项目;没读的说清原因:未挂载、远端代理、预热、已停用、挂不上", async () => {
    const readSummary = vi.spyOn(harnessClient, "getWorkspaceSummary");
    const readRuntime = vi.spyOn(agentRuntimeClient, "overview");
    const { container } = await mountHome(
      [
        repo({ repoId: "a-not-loaded", cellState: "not_loaded" }),
        repo({
          repoId: "b-proxy",
          mode: "remote-proxy",
          cellState: "not_loaded",
          canonicalRoot: null,
          connectionId: "srv",
        }),
        repo({ repoId: "c-warming", cellState: "warming" }),
        repo({ repoId: "d-disabled", registrationState: "disabled", cellState: "not_loaded" }),
        repo({ repoId: "e-broken", cellState: "unavailable", unavailableReason: "ledger unreadable" }),
      ],
      null,
    );
    expect(readSummary).not.toHaveBeenCalled();
    expect(readRuntime).not.toHaveBeenCalled();
    expect(entryIds(container)).toEqual(["e-broken", "c-warming", "a-not-loaded", "b-proxy", "d-disabled"]);
    const text = (id: string) => container.querySelector(`[data-testid="home-repo-${id}"]`)!.textContent;
    expect(text("a-not-loaded")).toContain("还没有挂载");
    expect(text("b-proxy")).toContain("远端代理:数据在服务器上");
    expect(text("b-proxy")).toContain("连接 srv · 本机没有工作区");
    expect(text("c-warming")).toContain("正在挂载");
    expect(text("d-disabled")).toContain("已停用:不挂载");
    expect(text("e-broken")).toContain("ledger unreadable");
    const broken = container.querySelector<HTMLElement>('[data-testid="home-repo-e-broken"]')!;
    expect(broken.querySelector("[data-status-tone]")?.getAttribute("data-status-tone")).toBe("bad");
    expect(broken.style.getPropertyValue("--status-edge")).toContain("var(--color-status-blocked)");
    // 停用的项目不可进入:第一行不是按钮,也没有「进入」。
    const disabled = container.querySelector('[data-testid="home-repo-d-disabled"]')!;
    expect(disabled.querySelector("button")).toBeNull();
    expect(disabled.querySelector('[data-testid="home-entry-open"]')).toBeNull();
  });

  it("某个项目读取失败只影响它自己:那一行显示原因并进「需要处理」,其他项目照常", async () => {
    vi.spyOn(harnessClient, "getWorkspaceSummary").mockImplementation(async ({ repoId }) => {
      if (repoId === "bad") throw new Error("projection_pending");
      return summary({ active: 2 }) as never;
    });
    vi.spyOn(agentRuntimeClient, "overview").mockResolvedValue(sessions() as never);
    const { container } = await mountHome([repo({ repoId: "bad" }), repo({ repoId: "good" })], "good");
    expect(entryIds(container.querySelector('[data-testid="home-group-attention"]')!)).toEqual(["bad"]);
    expect(container.querySelector('[data-testid="home-repo-bad"]')!.textContent).toContain(
      "任务情况读取失败:projection_pending",
    );
    expect(container.querySelector('[data-testid="home-repo-good"]')!.textContent).toContain("进行中 2");
  });

  it("「没有进行中的任务」只在整行没别的可说时出现;零 agent 任何时候都不写", async () => {
    const { container } = await mountHome([repo({ repoId: "idle" }), repo({ repoId: "agents-only" })], null, {
      idle: { summary: summary({}), runtime: sessions("stale") },
      "agents-only": { summary: summary({}), runtime: sessions("live") },
    });
    const text = (id: string) => container.querySelector(`[data-testid="home-repo-${id}"]`)!.textContent;
    expect(text("idle")).toContain("没有进行中的任务");
    expect(text("idle")).not.toContain("agent");
    expect(text("agents-only")).toContain("1 个 agent 在跑");
    expect(text("agents-only")).not.toContain("没有进行中的任务");
  });

  it("管理动作只在宿主 bridge 有能力时出现,收在「⋯」里;停用与移除确认后才调用 repoAdmin,启用直接执行", async () => {
    const repos = [
      repo({ repoId: "on", displayName: "On" }),
      repo({ repoId: "off", displayName: "Off", registrationState: "disabled", cellState: "not_loaded" }),
    ];
    const seed = { on: { summary: summary({}), runtime: sessions() } };
    const bare = await mountHome(repos, null, seed);
    expect(bare.container.querySelector('[data-testid="home-entry-more"]')).toBeNull();
    expect(bare.container.querySelector('[data-testid="home-add-project"]')).toBeNull();

    const receipt = { schema: "command-receipt/v2", ok: true };
    const update = vi.fn(async () => receipt),
      unregister = vi.fn(async () => receipt);
    host.harness = {
      repoAdmin: { update, unregister, register: vi.fn(), inspectWorkspace: vi.fn() },
      firstRun: { chooseRepository: vi.fn(async () => null), bootstrap: vi.fn() },
    };
    const { container } = await mountHome(repos, null, seed);
    expect(container.querySelector('[data-testid="home-add-project"]')?.textContent).toBe("添加项目");
    const on = container.querySelector<HTMLElement>('[data-testid="home-repo-on"]')!,
      off = container.querySelector<HTMLElement>('[data-testid="home-repo-off"]')!;
    // 条目上只有一个主按钮「进入」;停用/启用/移除不直接摆在条目上。
    expect([...on.querySelectorAll("button")].map((button) => button.textContent)).toContain("进入");
    expect(on.textContent).not.toContain("停用");
    expect(off.textContent).not.toContain("移除");

    // 停用:打开「⋯」→ 选停用 → 出现确认;取消不调用 bridge。
    await click(more(on));
    expect(panel().querySelector('[data-testid="home-entry-remove"]')).toBeNull();
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-disable"]')!);
    expect(update).not.toHaveBeenCalled();
    expect(panel().textContent).toContain("停用「On」?");
    expect(panel().textContent).toContain("不再挂载");
    expect(panel().textContent).toContain("不再读取它的任务情况");
    expect(panel().textContent).toContain("可以再启用");
    // 没有 agent 在跑时确认里不出现这句。
    expect(panel().querySelector('[data-testid="home-entry-confirm-agents"]')).toBeNull();
    expect(panel().textContent).not.toContain("agent 在跑");
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-confirm-cancel"]')!);
    expect(document.querySelector('[data-testid="home-entry-more-panel"]')).toBeNull();
    expect(update).not.toHaveBeenCalled();
    await click(more(on));
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-disable"]')!);
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-confirm-ok"]')!);
    expect(update.mock.calls).toEqual([[{ repoId: "on", state: "disabled" }]]);
    expect(document.querySelector('[data-testid="home-entry-more-panel"]')).toBeNull();

    // 移除只对已停用的项目出现,同样先确认;启用可逆,不需要确认。
    await click(more(off));
    expect(panel().querySelector('[data-testid="home-entry-disable"]')).toBeNull();
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-remove"]')!);
    expect(unregister).not.toHaveBeenCalled();
    expect(panel().textContent).toContain("移除「Off」?");
    expect(panel().textContent).toContain("只从这台 daemon 注销注册,不删除磁盘上的任何文件");
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-confirm-ok"]')!);
    expect(unregister.mock.calls).toEqual([[{ repoId: "off" }]]);
    await click(more(off));
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-enable"]')!);
    expect(update.mock.calls).toEqual([[{ repoId: "on", state: "disabled" }], [{ repoId: "off", state: "enabled" }]]);
  });

  it("项目有 agent 在跑时,停用的确认里明说数量", async () => {
    const update = vi.fn(async () => ({ schema: "command-receipt/v2", ok: true }));
    host.harness = { repoAdmin: { update, unregister: vi.fn(), register: vi.fn(), inspectWorkspace: vi.fn() } };
    const { container } = await mountHome([repo({ repoId: "busy", displayName: "Busy" })], null, {
      busy: { summary: summary({ active: 2 }), runtime: sessions("live", "live", "stale", "live") },
    });
    await click(more(container.querySelector<HTMLElement>('[data-testid="home-repo-busy"]')!));
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-disable"]')!);
    expect(panel().querySelector('[data-testid="home-entry-confirm-agents"]')?.textContent).toBe(
      "这个项目现在有 3 个 agent 在跑。",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("动作被拒绝时原因就地显示在那一行", async () => {
    host.harness = {
      repoAdmin: {
        update: vi.fn(async () => ({ ok: false, error: { code: "repo_busy", hint: "仓库有在飞写入" } })),
        unregister: vi.fn(),
        register: vi.fn(),
        inspectWorkspace: vi.fn(),
      },
    };
    const { container } = await mountHome([repo({ repoId: "on" })], null, {
      on: { summary: summary({}), runtime: sessions() },
    });
    await click(more(container.querySelector<HTMLElement>('[data-testid="home-repo-on"]')!));
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-disable"]')!);
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-confirm-ok"]')!);
    expect(container.querySelector('[data-testid="home-entry-feedback"]')?.textContent).toBe("仓库有在飞写入");
    // 只有 repoAdmin、没有选目录的 bridge:不给「添加项目」入口。
    expect(container.querySelector('[data-testid="home-add-project"]')).toBeNull();
  });

  it("添加项目:有台账的目录直接注册;没有台账的目录说明去哪里新建,不注册", async () => {
    const register = vi.fn(async () => ({ schema: "command-receipt/v2", ok: true }));
    const chooseRepository = vi.fn(async () => "/work/with-ledger");
    const inspectWorkspace = vi.fn(async ({ rootDir }: { rootDir: string }) => ({
      ok: true,
      hasWorkspace: rootDir === "/work/with-ledger",
      suggestedRepoId: "with-ledger",
    }));
    host.harness = {
      repoAdmin: { register, inspectWorkspace, update: vi.fn(), unregister: vi.fn() },
      firstRun: { chooseRepository, bootstrap: vi.fn() },
    };
    const { container } = await mountHome([], null);
    expect(container.querySelector('[data-testid="home-empty"]')?.textContent).toContain("还没有项目");
    expect(container.querySelector('[data-testid="home-content"]')).toBeNull();
    const add = container.querySelector<HTMLElement>('[data-testid="home-add-project"]')!;
    await click(add);
    expect(register.mock.calls).toEqual([[{ rootDir: "/work/with-ledger", repoId: "with-ledger", mode: "local" }]]);
    expect(container.querySelector('[data-testid="home-add-notice"]')?.textContent).toBe("已添加项目 with-ledger。");

    chooseRepository.mockResolvedValueOnce("/work/plain");
    await click(add);
    expect(register).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="home-add-notice"]')?.textContent).toContain(
      "「/work/plain」里还没有 Harness 台账",
    );
  });
});

describe("项目页补齐答复与数字跳转", () => {
  it("仅取已接入仓的议程第一页，显示 N+，数字进入正确视图", async () => {
    const getAgenda = vi.spyOn(harnessClient, "getAgenda").mockResolvedValue({
      awaitingYou: [{ relationId: "one" }, { relationId: "two" }],
      page: { nextCursor: "more" },
    } as never);
    const { container, targets } = await mountHome(
      [repo({ repoId: "one" }), repo({ repoId: "off", cellState: "not_loaded" })],
      null,
      { one: { summary: summary({ active: 3 }), runtime: sessions() } },
    );
    expect(getAgenda).toHaveBeenCalledExactlyOnceWith({ repoId: "one", limit: 100 });
    const entry = container.querySelector<HTMLElement>('[data-testid="home-repo-one"]')!;
    expect(entry.textContent).toContain("等你答复 2+");
    await click(entry.querySelector<HTMLElement>('[data-testid="home-entry-awaiting"]')!);
    await click(entry.querySelector<HTMLElement>('[data-testid="home-entry-active"]')!);
    expect(targets).toEqual(["agenda", "work"]);
  });
  it("第一页无下一页时显示准确条数，不带加号", async () => {
    vi.spyOn(harnessClient, "getAgenda").mockResolvedValue({
      awaitingYou: [{ relationId: "one" }],
      page: { nextCursor: null },
    } as never);
    const { container } = await mountHome([repo({ repoId: "complete" })], null, {
      complete: { summary: summary({}, 2), runtime: sessions() },
    });
    const reply = container.querySelector<HTMLElement>('[data-testid="home-entry-reply"]')!;
    expect(reply.textContent).toBe("等你答复 1");
    expect(container.querySelector('[data-testid="home-entry-awaiting"]')?.getAttribute("title")).toBe(
      "待评审/待裁决 2；等你答复 1",
    );
  });
  it("零条与读取失败都隐藏答复数字，其余数字仍显示", async () => {
    const getAgenda = vi
      .spyOn(harnessClient, "getAgenda")
      .mockResolvedValueOnce({
        awaitingYou: [],
        page: { nextCursor: null },
      } as never)
      .mockRejectedValueOnce(new Error("read denied"));
    const { container } = await mountHome([repo({ repoId: "zero" }), repo({ repoId: "failed" })], null, {
      zero: { summary: summary({ active: 1 }), runtime: sessions() },
      failed: { summary: summary({ active: 2 }), runtime: sessions() },
    });
    expect(getAgenda).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("等你答复");
    expect(container.textContent).toContain("进行中 2");
  });
  it("本机目录动作传 repoId，远端项目没有动作", async () => {
    const openDirectory = vi.fn().mockResolvedValue(undefined);
    host.harness = { projects: { openDirectory } };
    const { container } = await mountHome([
      repo({ repoId: "local", canonicalRoot: "/registered/local", cellState: "not_loaded" }),
      repo({ repoId: "remote", mode: "remote-proxy", canonicalRoot: null, cellState: "not_loaded" }),
    ]);
    await click(more(container.querySelector<HTMLElement>('[data-testid="home-repo-local"]')!));
    await click(panel().querySelector<HTMLElement>('[data-testid="home-entry-directory"]')!);
    expect(openDirectory).toHaveBeenCalledExactlyOnceWith({ repoId: "local" });
    expect(more(container.querySelector<HTMLElement>('[data-testid="home-repo-remote"]')!)).toBeNull();
  });
});

it("renders the summary timestamp as relative activity with the full time on hover, and omits null", async () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const data = summary({ active: 1 });
  const { container } = await mountHome([repo({})], "canonical", {
    canonical: { summary: { ...data, tasks: { ...data.tasks, lastChangedAt: at } }, runtime: sessions() },
  });
  const time = container.querySelector<HTMLTimeElement>('[data-testid="home-entry-last-activity"]')!;
  expect(time.dateTime).toBe(at);
  expect(time.textContent).toBe("5 分钟前");
  expect(time.title).toMatch(/^最近活动 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const empty = await mountHome([repo({ repoId: "empty" })], null, {
    empty: { summary: summary({}), runtime: sessions() },
  });
  expect(empty.container.querySelector('[data-testid="home-entry-last-activity"]')).toBeNull();
});
