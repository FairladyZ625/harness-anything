// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationView } from "../src/renderer/views/CollaborationView.tsx";
import type { AccessAdminApi, AccessDevice } from "../src/api/access-admin-contract.ts";
import type { FleetOverviewRead } from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

// 2026-10-13 业主裁定:①节点卡上的落后/新鲜时长按「距最近一次确认」每秒重算,
// 拓扑数据到达时同步纠正;②点节点打开设备管理(改名/暂停/恢复/移除/退出全部会话,
// 走既有 access 命令面),自有已移除设备默认从图上隐藏。这里用假时钟与假 Electron
// 桥验证行为,不走真 daemon。

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

const mountedRoots: Root[] = [];
afterEach(() => {
  while (mountedRoots.length > 0) act(() => mountedRoots.pop()!.unmount());
  Reflect.deleteProperty(window, "harness");
  vi.useRealTimers();
});

/** 三边缘节点夹具:lag(31 分钟未确认)、fresh(30 秒前确认)、已移除节点 dogfood-ubuntu。 */
function overviewFixture(): FleetOverviewRead {
  const edge = (nodeId: string, replica: Record<string, unknown> | null) => ({
    nodeId,
    role: "edge" as const,
    owner: { kind: "value" as const, text: "person_zeyu" },
    build: { kind: "unavailable" as const, reason: "replica-status-has-no-build-field" },
    online: { kind: "unavailable" as const, reason: "tls-session-fact-not-exposed" },
    leases: [],
    replica,
    replicaNote: replica === null ? "center-replica-ledger-has-no-row-for-node" : null,
    watch: { kind: "unavailable" as const, reason: "edge-sync-internals-not-exposed" },
    lastFailure: { kind: "unavailable" as const, reason: "no-replica-sync-failure-record-in-lifecycle-read" },
  });
  return {
    schema: "daemon.fleet-overview/v1",
    ok: true,
    repoId: "repo-test",
    mode: "remote-center",
    generatedAt: "2026-10-06T01:00:00.000Z",
    center: {
      nodeId: "center",
      daemonId: "default",
      startedAt: "2026-10-01T00:00:00.000Z",
      version: "0.0.0",
      commitSha: "bd2251a",
    },
    centerRevision: 164,
    nodes: [
      {
        nodeId: "center",
        role: "center",
        owner: { kind: "value", text: "daemon" },
        build: { kind: "value", text: "0.0.0 @ bd2251a" },
        online: { kind: "value", text: "running" },
        leases: [],
        replica: null,
        replicaNote: null,
        watch: { kind: "value", text: "local canonical writer" },
        lastFailure: { kind: "unavailable", reason: "no-replica-sync-failure-record-in-lifecycle-read" },
      },
      edge("cc90-ubuntu", {
        repoId: "repo-test",
        viewId: "view-a",
        centerRevision: 164,
        centerEventAt: "2026-10-06T01:00:00.000Z",
        ackRevision: 163,
        ackedAt: "2026-10-06T00:29:00.000Z",
        lagRevisions: 1,
        lagMs: 61_000,
        delivery: "delta",
      }),
      edge("edge-fresh", {
        repoId: "repo-test",
        viewId: "view-b",
        centerRevision: 164,
        centerEventAt: "2026-10-06T00:59:00.000Z",
        ackRevision: 164,
        ackedAt: "2026-10-06T00:59:30.000Z",
        lagRevisions: 0,
        lagMs: 0,
        delivery: "current",
      }),
      edge("dogfood-ubuntu", {
        repoId: "repo-test",
        viewId: "view-c",
        centerRevision: 160,
        centerEventAt: "2026-10-05T00:00:00.000Z",
        ackRevision: 150,
        ackedAt: "2026-10-05T00:00:30.000Z",
        lagRevisions: 10,
        lagMs: 300_000,
        delivery: "degraded",
      }),
    ],
    links: [
      {
        nodeId: "cc90-ubuntu",
        state: "lag",
        delivery: "delta",
        lagRevisions: 1,
        lagMs: 61_000,
        ackedAt: "2026-10-06T00:29:00.000Z",
        centerRevision: 164,
      },
      {
        nodeId: "edge-fresh",
        state: "fresh",
        delivery: "current",
        lagRevisions: 0,
        lagMs: 0,
        ackedAt: "2026-10-06T00:59:30.000Z",
        centerRevision: 164,
      },
      {
        nodeId: "dogfood-ubuntu",
        state: "unsynced",
        delivery: "degraded",
        lagRevisions: 10,
        lagMs: 300_000,
        ackedAt: "2026-10-05T00:00:30.000Z",
        centerRevision: 160,
      },
    ],
    events: [],
    notes: ["events-attribution=current-lease", "edge-online=unavailable", "sync-internals=unavailable"],
    warnings: [],
  };
}

function deviceFixture(nodeId: string, state: AccessDevice["state"], version: string): AccessDevice {
  return {
    nodeId,
    personId: "person_zeyu",
    systemName: `${nodeId}-system`,
    displayName: `${nodeId}-display`,
    platform: "linux",
    registeredAt: "2026-10-01T00:00:00.000Z",
    state,
    revocation: "complete",
    version,
  };
}

/** 假 Electron access 面:devices 可变(remove 后真实反映新状态),写操作记录调用参数。 */
function fakeAccessApi(initialDevices: AccessDevice[]) {
  const state = { devices: initialDevices.map((device) => ({ ...device })) };
  const receipt = (operation: string) => ({
    ok: true,
    operationId: `op-${operation}`,
    operation,
    actor: "person_zeyu",
    phase: "settled",
    outcome: "applied",
  });
  const api = {
    forRepository: () => api,
    devices: vi.fn(async () => ({
      ok: true,
      nodes: state.devices.map((device) => ({ ...device })),
      version: "list-9",
    })),
    renameDevice: vi.fn(async (input: { readonly nodeId: string }) => {
      state.devices = state.devices.map((device) =>
        device.nodeId === input.nodeId ? { ...device, version: "next" } : device,
      );
      return receipt("device-rename");
    }),
    pauseDevice: vi.fn(async (input: { readonly nodeId: string }) => {
      state.devices = state.devices.map((device) =>
        device.nodeId === input.nodeId ? { ...device, state: "paused", version: "next" } : device,
      );
      return receipt("device-pause");
    }),
    resumeDevice: vi.fn(async (input: { readonly nodeId: string }) => {
      state.devices = state.devices.map((device) =>
        device.nodeId === input.nodeId ? { ...device, state: "active", version: "next" } : device,
      );
      return receipt("device-resume");
    }),
    removeDevice: vi.fn(async (input: { readonly nodeId: string }) => {
      state.devices = state.devices.map((device) =>
        device.nodeId === input.nodeId ? { ...device, state: "removed", version: "next" } : device,
      );
      return receipt("device-remove");
    }),
    logoutDevices: vi.fn(async () => receipt("device-logout-all")),
  };
  return { api: api as unknown as AccessAdminApi, state };
}

type RenderOptions = {
  readonly overview?: FleetOverviewRead;
  readonly access?: AccessAdminApi;
};

async function renderView(options: RenderOptions = {}) {
  if (options.access !== undefined)
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: { access: options.access },
    });
  const host = document.createElement("div"),
    root = createRoot(host),
    queryClient = new QueryClient();
  mountedRoots.push(root);
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CollaborationView
          repoId="repo-test"
          mode="remote-center"
          overview={options.overview ?? overviewFixture()}
          onOpenTask={() => {}}
          onNavigateEntity={() => {}}
          now="2026-10-06T01:00:00.000Z"
        />
      </QueryClientProvider>,
    );
  });
  return {
    host,
    root,
    invalidateSpy,
    text: () => host.textContent ?? "",
    card: (nodeId: string) => host.querySelector<HTMLElement>(`[data-testid="collaboration-node-${nodeId}"]`),
    sinceAck: (nodeId: string) =>
      host.querySelector(`[data-testid="collaboration-node-since-ack-${nodeId}"]`)?.textContent ?? null,
    click: (element: Element | null | undefined) => {
      expect(element, "click target must exist").not.toBeNull();
      act(() => element!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    },
    rerender: async (overview: FleetOverviewRead) => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <CollaborationView
              repoId="repo-test"
              mode="remote-center"
              overview={overview}
              onOpenTask={() => {}}
              onNavigateEntity={() => {}}
              now="2026-10-06T01:00:00.000Z"
            />
          </QueryClientProvider>,
        );
      });
    },
  };
}

describe("落后/新鲜时长按最近确认时间每秒重算(业主裁定①)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T01:00:00.000Z"));
  });

  it("lag 与 fresh 卡都显示距最近确认的走动时长,墙钟前进 1 分钟后数字跟着前进", async () => {
    const view = await renderView();
    // 假时钟 01:00:00:lag 节点 00:29 确认 → 31m;fresh 节点 00:59:30 确认 → 30s。
    expect(view.sinceAck("cc90-ubuntu")).toBe("31m");
    expect(view.sinceAck("edge-fresh")).toBe("30s");
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.sinceAck("cc90-ubuntu")).toBe("32m");
    expect(view.sinceAck("edge-fresh")).toBe("1m 30s");
    // unsynced(未同步)节点不给走动时长:没有可主张的确认锚点,如实缺席。
    expect(view.sinceAck("dogfood-ubuntu")).toBeNull();
  });

  it("拓扑数据到达(新的最近确认时间)时,秒数同步纠正而不是继续外推", async () => {
    const view = await renderView();
    expect(view.sinceAck("cc90-ubuntu")).toBe("31m");
    const refreshed = overviewFixture();
    const node = refreshed.nodes.find((row) => row.nodeId === "cc90-ubuntu")!;
    (node.replica as { ackedAt: string }).ackedAt = "2026-10-06T00:59:00.000Z";
    (refreshed.links[0] as { ackedAt: string }).ackedAt = "2026-10-06T00:59:00.000Z";
    await view.rerender(refreshed);
    expect(view.sinceAck("cc90-ubuntu")).toBe("1m");
  });
});

describe("已移除的自有设备默认不在图上(业主裁定②)", () => {
  it("设备登记为 removed 的节点默认隐藏;「显示已移除」开关恢复显示并更新摘要", async () => {
    const { api } = fakeAccessApi([
      deviceFixture("cc90-ubuntu", "active", "3"),
      deviceFixture("dogfood-ubuntu", "removed", "5"),
    ]);
    const view = await renderView({ access: api });
    expect(view.card("cc90-ubuntu")).not.toBeNull();
    expect(view.card("dogfood-ubuntu")).toBeNull();
    expect(view.text()).toContain("已隐藏 1 个已移除节点");
    // 中心节点与他人的节点不参与隐藏;摘要按可见节点计数。
    expect(view.card("center")).not.toBeNull();
    expect(view.text()).toContain("3 节点");
    const toggle = view.host.querySelector<HTMLInputElement>('[data-testid="collaboration-show-removed"] input')!;
    view.click(toggle);
    expect(view.card("dogfood-ubuntu")).not.toBeNull();
    expect(view.text()).toContain("4 节点");
  });
});

describe("节点详情抽屉里的设备管理面板(业主裁定②)", () => {
  it("owner 自己的设备展示状态与四类操作,危险操作红色", async () => {
    const { api } = fakeAccessApi([deviceFixture("cc90-ubuntu", "active", "3")]);
    const view = await renderView({ access: api });
    view.click(view.card("cc90-ubuntu"));
    const panel = view.host.querySelector('[data-testid="collaboration-node-management"]')!;
    expect(panel.textContent).toContain("设备管理");
    expect(panel.textContent).toContain("cc90-ubuntu-display");
    expect(panel.textContent).toContain("cc90-ubuntu-system · linux");
    expect(panel.querySelector('[data-testid="collaboration-device-rename-cc90-ubuntu"]')).not.toBeNull();
    expect(panel.querySelector('[data-testid="collaboration-device-toggle-cc90-ubuntu"]')!.textContent).toContain(
      "暂停并撤销访问",
    );
    const remove = panel.querySelector<HTMLButtonElement>('[data-testid="collaboration-device-remove-cc90-ubuntu"]')!;
    expect(remove.textContent).toContain("移除设备");
    expect(remove.className).toContain("text-danger");
    expect(panel.querySelector('[data-testid="collaboration-device-logout-all"]')).not.toBeNull();
  });

  it("移除设备先过确认框,按设备版本号提交;成功后设备重读、拓扑失效、节点从图上消失", async () => {
    const { api } = fakeAccessApi([deviceFixture("cc90-ubuntu", "active", "3")]);
    const view = await renderView({ access: api });
    view.click(view.card("cc90-ubuntu"));
    view.click(view.host.querySelector('[data-testid="collaboration-device-remove-cc90-ubuntu"]'));
    const confirmDialog = view.host.querySelector('[data-testid="collaboration-device-confirmation"]');
    expect(confirmDialog).not.toBeNull();
    expect(confirmDialog!.textContent).toContain("后续请求将按新设备状态处理");
    view.click(view.host.querySelector('[data-testid="collaboration-device-confirm"]'));
    await act(async () => undefined);
    expect(api.removeDevice).toHaveBeenCalledWith({ nodeId: "cc90-ubuntu", expectedVersion: "3" });
    expect(api.devices.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(view.invalidateSpy).toHaveBeenCalledWith({ queryKey: ["fleet-overview", "repo-test"] });
    // 设备登记已变 removed:节点从图上隐藏,隐藏计数出现。
    expect(view.card("cc90-ubuntu")).toBeNull();
    expect(view.text()).toContain("已隐藏 1 个已移除节点");
  });

  it("改名打开输入框,保存按新名称提交;退出全部会话按设备清单版本号提交", async () => {
    const { api } = fakeAccessApi([deviceFixture("cc90-ubuntu", "active", "3")]);
    const view = await renderView({ access: api });
    view.click(view.card("cc90-ubuntu"));
    view.click(view.host.querySelector('[data-testid="collaboration-device-rename-cc90-ubuntu"]'));
    const input = view.host.querySelector<HTMLInputElement>('[data-testid="collaboration-device-name"]')!;
    expect(input.value).toBe("cc90-ubuntu-display");
    await act(async () => {
      // React 受控输入要用原生 setter 赋值,直接改 .value 会被值追踪器当成未变化。
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "客厅小主机");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    view.click(view.host.querySelector('[data-testid="collaboration-device-save-name"]'));
    await act(async () => undefined);
    expect(api.renameDevice).toHaveBeenCalledWith({
      nodeId: "cc90-ubuntu",
      expectedVersion: "3",
      displayName: "客厅小主机",
    });
    view.click(view.host.querySelector('[data-testid="collaboration-device-logout-all"]'));
    view.click(view.host.querySelector('[data-testid="collaboration-device-confirm"]'));
    await act(async () => undefined);
    expect(api.logoutDevices).toHaveBeenCalledWith({ expectedVersion: "list-9" });
  });

  it("不属于自己设备的节点如实标注只有 owner 能管理,不渲染操作按钮", async () => {
    const { api } = fakeAccessApi([deviceFixture("cc90-ubuntu", "active", "3")]);
    const view = await renderView({ access: api });
    view.click(view.card("edge-fresh"));
    const panel = view.host.querySelector('[data-testid="collaboration-node-management"]')!;
    expect(panel.querySelector('[data-testid="collaboration-management-not-owned"]')!.textContent).toContain(
      "该节点不在你的设备清单里",
    );
    expect(panel.querySelector('[data-testid^="collaboration-device-"]')).toBeNull();
  });

  it("无 Electron 桥(浏览器预览)显示通道不可用,不假装可管理", async () => {
    const view = await renderView();
    view.click(view.card("cc90-ubuntu"));
    const panel = view.host.querySelector('[data-testid="collaboration-node-management"]')!;
    expect(panel.querySelector('[data-testid="collaboration-management-unavailable"]')!.textContent).toContain(
      "没有设备管理通道",
    );
  });

  it("写操作被拒(版本冲突)时显示拒绝原因,不静默吞掉", async () => {
    const { api } = fakeAccessApi([deviceFixture("cc90-ubuntu", "active", "3")]);
    (api.removeDevice as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      code: "version_conflict",
      expectedVersion: "3",
      currentVersion: "7",
    });
    const view = await renderView({ access: api });
    view.click(view.card("cc90-ubuntu"));
    view.click(view.host.querySelector('[data-testid="collaboration-device-remove-cc90-ubuntu"]'));
    view.click(view.host.querySelector('[data-testid="collaboration-device-confirm"]'));
    await act(async () => undefined);
    const refusal = view.host.querySelector<HTMLElement>('[data-testid="collaboration-management-refusal"]')!;
    expect(refusal.getAttribute("data-code")).toBe("version_conflict");
    expect(refusal.textContent).toContain("数据已被其他管理员改过");
    // 冲突后设备没有变成 removed:节点仍在图上,不因失败而消失。
    expect(view.card("cc90-ubuntu")).not.toBeNull();
  });
});
