// harness-test-tier: fast
import { describe, expect, it } from "vitest";

describe("tool page visual language", () => {
  it("keeps tool canvases full-width and puts surrounding controls in compact glass panels", async () => {
    const { readFile } = await import("node:fs/promises");
    const [sessions, terminal, browser] = await Promise.all([
      readFile(new URL("../src/renderer/views/SessionsView.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/renderer/views/TerminalView.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/renderer/views/BrowserView.tsx", import.meta.url), "utf8"),
    ]);

    // 标准 §2.5 v2:会话页是左列表、右常驻详情,不再用抽屉。
    // §2.3 统一页头:页头用共享 PageHeader 原语(裸行,活会话数并入页头结论句)。
    expect(sessions).not.toContain("<Drawer");
    expect(sessions).toContain('data-testid="sessions-detail"');
    expect(sessions).toContain("<PageHeader");
    expect(terminal).toContain('className="flex min-h-0 flex-1 flex-row overflow-hidden bg-bg p-2"');
    expect(terminal).toContain("glass ml-2 flex min-h-0 min-w-0 flex-1");
    expect(browser).toContain('className="glass flex shrink-0 items-center gap-1 rounded-sm');
    expect(browser).toContain("in-app-browser-host");
  });
});
