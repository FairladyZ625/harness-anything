// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { QuickSwitcher } from "../src/renderer/components/sidebar/QuickSwitcher.tsx";
import type { SystemRepoRow } from "../src/renderer/api-client.ts";

/**
 * 快速切换面板精简(业主 2026-10-11 截图追加):已停用项目默认收进底部折叠区
 * 不与常用项目混排;每张卡片只留项目名与一行状态,queue/lock 等诊断字段进悬停
 * title;置顶行按置顶顺序排前。行保持 button > span.font-semibold 结构(gui-e2e
 * capture.mjs 的 openProject 按显示名匹配点击)。
 */

const repo = (patch: Partial<SystemRepoRow>): SystemRepoRow => ({
  repoId: "r",
  displayName: "R",
  canonicalRoot: "/tmp/r",
  authoredBranch: null,
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
  ...patch,
});

const anchored = { current: document.createElement("button") };

function panelRows() {
  return [...document.querySelectorAll('[data-testid="quick-switcher-panel"] button')];
}

function rowTitles() {
  return [...document.querySelectorAll('[data-testid="quick-switcher-panel"] button span.font-semibold')].map(
    (span) => span.textContent,
  );
}

async function renderSwitcher(props: Partial<Parameters<typeof QuickSwitcher>[0]> = {}) {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  roots.push(root);
  await act(async () =>
    root.render(
      createElement(QuickSwitcher, {
        open: true,
        anchorRef: anchored,
        repos: [],
        activeRepoId: null,
        pinnedRepoIds: [],
        onToggleProjectPin: () => undefined,
        onOpenProject: () => undefined,
        onOpenProjectManager: () => undefined,
        ...props,
      }),
    ),
  );
}

const roots: Root[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe("快速切换面板精简(业主 2026-10-11)", () => {
  it("已停用项目默认收进底部折叠区,展开才可见;启用项目不与之混排", async () => {
    await renderSwitcher({
      repos: [
        repo({ repoId: "main", displayName: "主项目" }),
        repo({ repoId: "test-accept", displayName: "验收仓", registrationState: "disabled" }),
      ],
    });
    expect(rowTitles()).toEqual(["主项目"]);
    const section = document.querySelector('[data-testid="quick-switcher-disabled"]');
    expect(section).not.toBeNull();
    expect(
      section?.querySelector('[data-testid="quick-switcher-disabled-toggle"]')?.getAttribute("aria-expanded"),
    ).toBe("false");
    await act(async () =>
      section
        ?.querySelector('[data-testid="quick-switcher-disabled-toggle"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(rowTitles()).toEqual(["主项目", "验收仓"]);
  });

  it("卡片只留一行状态:queue/lock 诊断不进版面,收进悬停 title", async () => {
    await renderSwitcher({
      repos: [
        repo({
          repoId: "main",
          displayName: "主项目",
          queueDepth: 3,
          lockState: "held",
          unavailableReason: "cell down",
        }),
      ],
    });
    const main = panelRows().find((button) => button.textContent?.includes("主项目"));
    expect(main).toBeDefined();
    // 版面一行:repoId,不带诊断字样;诊断与失败原因在 title。
    expect(main?.textContent).toContain("main");
    expect(main?.textContent).not.toMatch(/queue|lock/u);
    expect(main?.getAttribute("title")).toContain("queue 3");
    expect(main?.getAttribute("title")).toContain("lock held");
    expect(main?.getAttribute("title")).toContain("cell down");
  });

  it("置顶行按置顶顺序排前,其余保持传入顺序;置顶按钮回调带 repoId", async () => {
    const pinned: string[] = [];
    await renderSwitcher({
      repos: [
        repo({ repoId: "a", displayName: "A" }),
        repo({ repoId: "b", displayName: "B" }),
        repo({ repoId: "c", displayName: "C" }),
      ],
      pinnedRepoIds: ["c", "b"],
      onToggleProjectPin: (repoId) => pinned.push(repoId),
    });
    expect(rowTitles()).toEqual(["C", "B", "A"]);
    await act(async () =>
      document
        .querySelector('[data-testid="quick-switcher-pin-a"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(pinned).toEqual(["a"]);
  });

  it("未挂载的启用仓在一行状态里说明(不与已附着行重复同一状态词)", async () => {
    await renderSwitcher({
      repos: [
        repo({ repoId: "warming", displayName: "挂载中仓", cellState: "warming" }),
        repo({ repoId: "ok", displayName: "正常仓" }),
      ],
    });
    const rows = panelRows().filter((button) => button.querySelector("span.font-semibold"));
    const okRow = rows.find((button) => button.textContent?.includes("正常仓"));
    const warmingRow = rows.find((button) => button.textContent?.includes("挂载中仓"));
    expect(okRow?.textContent).not.toMatch(/attached|已附着/u);
    expect(warmingRow?.textContent).toMatch(/挂载中/u);
  });
});
