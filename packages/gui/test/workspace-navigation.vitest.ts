// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { createViewHistory, goBack, pushLocation } from "../src/renderer/navigation/viewHistory.ts";
import { initialLocation } from "../src/renderer/navigation/viewHistoryStorage.ts";

describe("workspace navigation", () => {
  it("restores the workspace scope after opening a task and going back", () => {
    const workspace = { ...initialLocation(), view: "workspace" as const, scopeRootTaskId: "task_root" };
    const history = pushLocation(createViewHistory(workspace), { ...workspace, selectedId: "task_child" });
    expect(goBack(history).entries[0]?.scopeRootTaskId).toBe("task_root");
    expect(goBack(history).entries[0]?.selectedId).toBeNull();
  });
});
