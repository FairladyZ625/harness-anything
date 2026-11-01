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
      request: vi.fn(async (method: string, payload: unknown) => {
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
    settings: { locale: "en-US", gates: [] },
    values: {
      defaultVertical: "software/coding",
      defaultPreset: "standard-task",
      defaultProfile: "baseline",
      reviewReturnBudget: 2,
      closeoutReview: false,
      locale: "en-US",
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
  return { container, updateCalls };
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
        testId !== "settings-search" && testId !== "settings-advanced-toggle" && !testId?.startsWith("settings-tab-")
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
