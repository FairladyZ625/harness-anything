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

    expect(sessions).toMatch(/<Drawer\s+open=\{inspector\}/u);
    expect(sessions).toContain("<StatusTag");
    expect(terminal).toContain('className="flex min-h-0 flex-1 flex-row overflow-hidden bg-bg p-2"');
    expect(terminal).toContain("glass ml-2 flex min-h-0 min-w-0 flex-1");
    expect(browser).toContain('className="glass flex shrink-0 items-center gap-1 rounded-sm');
    expect(browser).toContain("in-app-browser-host");
  });
});
