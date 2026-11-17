// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { connectionQueryKeys } from "../src/renderer/connection-data.ts";
import { settingsQueryKeys } from "../src/renderer/settings-data.ts";
import { AppMotionConfig } from "../src/renderer/motion-config.tsx";
import { ThemeProvider } from "../src/renderer/theme.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";
import type { SystemRepoRow } from "../src/renderer/api-client.ts";
import { settingsFieldsFace, settingsGroupsFace } from "./settings-catalog-snapshot.ts";

const REPO_ID = "settings-machine-preference-probe";
const mounted: Array<{ readonly root: Root; readonly container: HTMLElement }> = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();
  }
  resetGuiTransportForTest();
  Reflect.deleteProperty(window, "harness");
  localStorage.clear();
});

function repo(mode: SystemRepoRow["mode"]): SystemRepoRow {
  return {
    repoId: REPO_ID,
    displayName: "Settings preference probe",
    canonicalRoot: "/tmp/settings-preference-probe",
    authoredBranch: "main",
    registrationState: "enabled",
    mode,
    connectionId: mode === "local" ? "local" : "center",
    cellState: "attached",
    generation: 1,
    queueDepth: 0,
    lockState: mode === "local" ? "held" : "not_applicable",
    recoveryMs: null,
    lastError: null,
    unavailableReason: null,
  };
}

async function mountSettings(mode: SystemRepoRow["mode"]) {
  localStorage.setItem("harness-locale", "zh-CN");
  setActiveLocale("zh-CN");
  resetGuiTransportForTest();
  const [{ SettingsView }, { I18nProvider }] = await Promise.all([
    import("../src/renderer/views/SettingsView.tsx"),
    import("../src/renderer/i18n/index.tsx"),
  ]);
  const updateCalls: unknown[] = [];
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: {
      firstRun: {
        chooseRepository: vi.fn(async () => null),
        bootstrap: vi.fn(async () => ({ ok: true })),
      },
      request: vi.fn(async (method: string, payload: unknown): Promise<unknown> => {
        if (method === "updateSettings") {
          updateCalls.push(payload);
          throw new Error("fetch failed");
        }
        throw new Error(`Unexpected settings probe request: ${method}`);
      }),
    },
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  client.setQueryData(settingsQueryKeys.read(REPO_ID), {
    schema: "daemon.settings-read/v1",
    ok: true,
    settings: {
      schema: "settings/v1",
      settingsId: "repository",
      defaultVertical: "software/coding",
      defaultPreset: "standard-task",
      defaultProfile: "baseline",
      locale: "en-US",
      gates: [],
      scaffolds: { task: "governance/task-scaffold.json", repository: "governance/repository-scaffold.json" },
    },
    values: {
      defaultVertical: "software/coding",
      defaultPreset: "standard-task",
      defaultProfile: "baseline",
      reviewReturnBudget: 2,
      closeoutReview: false,
      locale: "en-US",
      taskMaterializationPolicy: "include_done",
      guiConnectTimeoutMs: 2_000,
      guiRequestTimeoutMs: 30_000,
      guiTerminalBrowser: "embedded",
    },
    revision: 1,
    lastChanged: "initial",
    decisionPoints: [],
  });
  client.setQueryData(catalogQueryKeys.snapshot(REPO_ID), {
    schema: "daemon.gui-catalog/v1",
    ok: true,
    settingsFields: settingsFieldsFace(),
    settingsGroups: settingsGroupsFace(),
    settingsScaffolds: { task: [], repository: [] },
    verticals: [],
    presets: [],
    profiles: [],
    scaffolds: { task: [], repository: [] },
    reviewers: [],
    completionSources: [],
    agents: [],
  });
  client.setQueryData(["agents", REPO_ID], []);
  client.setQueryData(connectionQueryKeys.status(), []);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        null,
        createElement(
          ThemeProvider,
          null,
          createElement(
            AppMotionConfig,
            null,
            createElement(
              QueryClientProvider,
              { client },
              createElement(SettingsView, {
                repoId: REPO_ID,
                repos: [repo(mode)],
                onOpenProject: () => undefined,
                onJoinCenter: () => undefined,
              }),
            ),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(container.textContent).toContain("仓库设置"));
  });
  return { container, updateCalls, client };
}

describe("settings distinguish machine preferences from repository governance", () => {
  it("shows governance settings as read-only for a remote-edge repository", async () => {
    const { container } = await mountSettings("remote-edge");

    expect(container.textContent).toContain("只读");
    const advancedToggle = container.querySelector<HTMLButtonElement>('[data-testid="settings-advanced-toggle"]');
    if (advancedToggle) await act(async () => advancedToggle.click());
    expect(container.querySelector('[data-testid="settings-reviewReturnBudget-input"]')).toHaveProperty(
      "disabled",
      true,
    );
    expect(container.querySelector('[role="switch"][aria-label="closeoutReview"]')).toHaveProperty("disabled", true);
    expect(container.querySelector('[data-testid="settings-repository-save"]')).toHaveProperty("disabled", true);
    const editControls = Array.from(
      container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
        "input, select, textarea, button",
      ),
    ).filter((control) => {
      const testId = control.dataset.testid;
      return (
        ![
          "settings-taskMaterializationPolicy-select",
          "settings-guiConnectTimeoutMs-input",
          "settings-guiRequestTimeoutMs-input",
          "settings-guiTerminalBrowser-select",
        ].includes(testId ?? "") &&
        testId !== "settings-search" &&
        testId !== "settings-advanced-toggle" &&
        !testId?.startsWith("settings-tab-")
      );
    });
    expect(editControls.length).toBeGreaterThan(3);
    expect(editControls.every((control) => control.disabled)).toBe(true);
  });

  it.each(["local", "remote-edge"] as const)(
    "changes every machine preference and visits settings groups without a repository write (%s)",
    async (mode) => {
      const { container, updateCalls } = await mountSettings(mode);
      const click = async (testId: string) => {
        const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
        expect(button, testId).not.toBeNull();
        await act(async () => button!.click());
      };
      const select = async (testId: string, value: string) => {
        const control = container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
        expect(control, testId).not.toBeNull();
        await act(async () => {
          control!.value = value;
          control!.dispatchEvent(new Event("change", { bubbles: true }));
        });
      };

      await click("settings-tab-appearance");
      await click("settings-theme-light");
      await click("settings-motion-off");
      await click("settings-ui-scale-comfortable");
      await click("settings-tab-timeDisplay");
      await select("settings-time-zone", "UTC");
      await click("settings-date-format-long");
      await click("settings-hour-cycle-h12");
      await click("settings-list-style-absolute");
      await click("settings-tab-language");
      await select("settings-language", "en-US");
      expect(localStorage.getItem("harness-locale")).toBe("en-US");
      await select("settings-language", "zh-CN");

      for (const tab of [
        "repositories",
        "repository",
        "appearance",
        "timeDisplay",
        "language",
        "shortcuts",
        "notifications",
        "data",
        "privacy",
        "updates",
      ])
        await click(`settings-tab-${tab}`);

      expect(localStorage.getItem("harness-theme")).toBe("light");
      expect(localStorage.getItem("harness-motion")).toBe("off");
      expect(localStorage.getItem("harness-ui-scale")).toBe("comfortable");
      expect(JSON.parse(localStorage.getItem("harness:gui:time-display") ?? "null")).toEqual({
        timeZone: "UTC",
        dateFormat: "long",
        hour12: true,
        listStyle: "absolute",
      });
      expect(localStorage.getItem("harness-locale")).toBe("zh-CN");
      expect(updateCalls).toEqual([]);
      expect(container.textContent).not.toContain("fetch failed");
    },
  );

  it.each(["local", "remote-edge"] as const)("submits terminal browser as a machine preference (%s)", async (mode) => {
    const { container, updateCalls } = await mountSettings(mode);
    const control = container.querySelector<HTMLSelectElement>('[data-testid="settings-guiTerminalBrowser-select"]')!;
    expect(control.disabled).toBe(false);
    await act(async () => {
      control.value = "system";
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="settings-repository-save"]')!.click(),
    );
    await vi.waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toMatchObject({ repoId: REPO_ID, guiTerminalBrowser: "system" });
    expect(Object.keys(updateCalls[0] as object).sort()).toEqual([
      "expectedVersion",
      "guiTerminalBrowser",
      "idempotencyKey",
      "repoId",
    ]);
  });

  it.each(["local", "remote-edge"] as const)(
    "derives the local materialization selector and submits only its change (%s)",
    async (mode) => {
      const { container, updateCalls } = await mountSettings(mode);
      const control = container.querySelector<HTMLSelectElement>(
        '[data-testid="settings-taskMaterializationPolicy-select"]',
      )!;
      expect(control.disabled).toBe(false);
      expect(Array.from(control.options).map((option) => option.value)).toEqual(["none", "in_flight", "include_done"]);
      await act(async () => {
        control.value = "in_flight";
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const save = container.querySelector<HTMLButtonElement>('[data-testid="settings-repository-save"]')!;
      expect(save.disabled).toBe(false);
      await act(async () => save.click());
      expect(updateCalls).toEqual([
        {
          repoId: REPO_ID,
          expectedVersion: 1,
          taskMaterializationPolicy: "in_flight",
          idempotencyKey: expect.any(String),
        },
      ]);
    },
  );

  it.each(["remote-edge", "local"] as const)(
    "shows pending files and retries only the saved local policy (%s)",
    async (mode) => {
      const { container, client } = await mountSettings(mode),
        request = vi.mocked(window.harness.request),
        updates: Record<string, unknown>[] = [];
      let saved = client.getQueryData<Record<string, unknown>>(settingsQueryKeys.read(REPO_ID))!;
      request.mockImplementation(async (method, payload) => {
        if (method === "getSettings") return saved;
        if (method !== "updateSettings") throw new Error(`Unexpected request: ${method}`);
        updates.push(payload as Record<string, unknown>);
        saved = {
          ...saved,
          revision: mode === "local" ? 2 : 1,
          values: { ...(saved.values as object), taskMaterializationPolicy: "in_flight", reviewReturnBudget: 9 },
        };
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "settings-update",
          opId: "local-policy",
          revision: mode === "local" ? 2 : 1,
          outcome: updates.length === 1 ? "pending" : "applied",
          warnings: updates.length === 1 ? ["Local materialization conflicts: tasks/task_done/task_plan.md"] : [],
          guidance:
            updates.length === 1
              ? [
                  {
                    kind: "run-command",
                    args: { command: "ha settings update --task-materialization-policy in_flight" },
                  },
                ]
              : [],
        };
      });
      const control = container.querySelector<HTMLSelectElement>(
        '[data-testid="settings-taskMaterializationPolicy-select"]',
      )!;
      await act(async () => {
        control.value = "in_flight";
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
      if (mode === "local") {
        const budget = container.querySelector<HTMLInputElement>('[data-testid="settings-reviewReturnBudget-input"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(budget, "3");
          budget.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[data-testid="settings-repository-save"]')!.click(),
      );
      await act(async () => {
        await vi.waitFor(() =>
          expect(
            container.querySelector('[data-testid="settings-materialization-pending"]'),
            JSON.stringify({ updates, text: container.textContent?.slice(-2600) }),
          ).not.toBeNull(),
        );
      });
      expect(control.value).toBe("in_flight");
      expect(container.textContent).toContain("tasks/task_done/task_plan.md");
      expect(container.textContent).toContain("ha settings update --task-materialization-policy in_flight");
      const retry = container.querySelector<HTMLButtonElement>('[data-testid="settings-materialization-retry"]')!;
      expect(retry.disabled).toBe(false);
      await act(async () => retry.click());
      await act(async () => {
        await vi.waitFor(() =>
          expect(container.querySelector('[data-testid="settings-materialization-pending"]')).toBeNull(),
        );
      });
      expect(updates).toHaveLength(2);
      if (mode === "local") expect(updates[0]).toMatchObject({ reviewReturnBudget: 3 });
      expect(updates[1]).toEqual({
        repoId: REPO_ID,
        taskMaterializationPolicy: "in_flight",
        expectedVersion: mode === "local" ? 2 : 1,
        idempotencyKey: expect.any(String),
      });
    },
  );

  it("keeps repository governance editable for a pure local repository", async () => {
    const { container } = await mountSettings("local");

    expect(container.querySelector("[data-testid='settings-read-only']")).toBeNull();
    expect(container.querySelector('[data-testid="settings-reviewReturnBudget-input"]')).toHaveProperty(
      "disabled",
      false,
    );
    expect(container.querySelector('[data-testid="settings-repository-save"]')).toHaveProperty("disabled", false);
  });
});
