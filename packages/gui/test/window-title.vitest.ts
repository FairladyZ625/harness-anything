// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import { APP_WINDOW_TITLE, projectWindowTitle } from "../src/renderer/window-title.ts";

// 窗口标题(task_ca1ee6b9e8f83c89cb376e5f07):停在项目上的窗口显示「项目名 —
// Harness Anything」,Dock/任务栏/⌘` 可辨认;未选项目保持应用名(index.html 初值)。
describe("projectWindowTitle", () => {
  it("停在项目上时是「项目名 — Harness Anything」", () => {
    expect(projectWindowTitle("harness-anything")).toBe("harness-anything — Harness Anything");
    expect(projectWindowTitle("第二个项目")).toBe(`第二个项目 — ${APP_WINDOW_TITLE}`);
  });

  it("未选项目(null)回落应用名,与 index.html 初值一致", () => {
    expect(projectWindowTitle(null)).toBe(APP_WINDOW_TITLE);
  });
});
