// harness-test-tier: integration
// @vitest-environment happy-dom
// 设置修订令牌的 mutation 层契约(task_abfd845f39b26fc9da3d8ca9e9):GUI 用 settings read
// 的 singleton 行修订作 expectedVersion;mutation 成功后立刻把回执里的新修订顶进缓存,
// 使 invalidate 后的重读完成前的第二次提交带新令牌——重读窗口(harness 桥挂起模拟)
// 内连续两次提交都不带旧值。令牌与 lastChanged 归因修订刻意不同值,证明两者不再互冒。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { settingsQueryKeys, useSettingsMutation, useSettingsQuery } from "../src/renderer/settings-data.ts";

const REPO_ID = "settings-token-probe";

/** 令牌(11)与归因修订(9)不同值:提交带 11 而不是 9,才是「读行修订不读归因」。 */
const SEEDED_READ = {
  schema: "daemon.settings-read/v1",
  decisionPoints: [],
  ok: true,
  settings: {
    schema: "settings/v1",
    settingsId: "repository",
    defaultVertical: "software/coding",
    defaultPreset: "standard-task",
    defaultProfile: "baseline",
    closeout: { profile: "standard" },
    locale: "zh-CN",
    scaffolds: { task: "governance/task-scaffold.json", repository: "governance/repository-scaffold.json" },
  },
  values: { defaultPreset: "standard-task" },
  revision: 11,
  lastChanged: { occurredAt: "2026-10-01T00:00:00.000Z", actor: "person:probe", revision: 9 },
} as const;

/** 与 ProvidersView 同型的提交探针:令牌取 settings read 的 revision。 */
function TokenProbe() {
  const settings = useSettingsQuery(REPO_ID),
    settingsMutation = useSettingsMutation(REPO_ID);
  return createElement(
    "button",
    {
      "data-testid": "token-submit",
      onClick: () => settingsMutation.mutate({ reviewReturnBudget: 5, expectedVersion: settings.data?.revision ?? 0 }),
    },
    settings.data?.revision ?? "pending",
  );
}

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = [];

/** 渲染探针并缓存种子;harness 桥的读面挂起(重读窗口不关闭),写面记录载荷。 */
async function mountProbe(): Promise<{ readonly container: HTMLElement; readonly submitted: () => unknown[] }> {
  const submitted: unknown[] = [];
  const nextReceiptRevision = 12;
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: {
      updateSettings: vi.fn(async (payload: Record<string, unknown>) => {
        submitted.push(payload);
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "settings-update",
          outcome: "applied",
          opId: String(payload.idempotencyKey),
          revision: nextReceiptRevision,
        };
      }),
      // 重读窗口保持打开:invalidate 触发的 refetch 永不落地,令牌只能来自回执顶新。
      getSettings: () => new Promise(() => undefined),
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsQueryKeys.read(REPO_ID), SEEDED_READ);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(TokenProbe)));
  });
  mounted.push({ root, container });
  return { container, submitted: () => submitted };
}

afterEach(() => {
  const entry = mounted.pop();
  if (entry) {
    act(() => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
  Reflect.deleteProperty(window, "harness");
});

describe("settings mutation revision token", () => {
  it("提交带 singleton 行修订,回执修订在重读落地前顶进缓存", async () => {
    const { container, submitted } = await mountProbe();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="token-submit"]')!;
    expect(button.textContent).toBe("11");
    await act(async () => {
      button.click();
    });
    expect(submitted()[0]).toMatchObject({ expectedVersion: 11 });
    // 第一次成功后、refetch 仍挂起:缓存令牌已经是回执的 12,不是种子读的 11。
    expect(button.textContent).toBe("12");
    await act(async () => {
      button.click();
    });
    expect(submitted()[1]).toMatchObject({ expectedVersion: 12 });
  });
});
