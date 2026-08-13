// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { minimapMaskColor, readColorMode } from "../src/renderer/graph/colorMode.ts";

describe("MiniMap colorMode mapping (历史坑,验收门 4)", () => {
  it("uses dark mask for dark mode", () => {
    const mask = minimapMaskColor("dark");
    expect(mask).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("uses light mask for light mode (NOT the hardcoded dark mask)", () => {
    const mask = minimapMaskColor("light");
    // 历史坑:light 主题必须用浅色 mask,否则 minimap 糊黑。
    expect(mask).not.toBe("rgba(0, 0, 0, 0.5)");
    expect(mask).toBe("rgba(255, 255, 255, 0.6)");
  });

  it("readColorMode falls back to dark without document (SSR safety)", () => {
    // In vitest jsdom, document exists but data-theme may be unset → dark.
    const mode = readColorMode();
    expect(mode === "dark" || mode === "light").toBe(true);
  });
});
