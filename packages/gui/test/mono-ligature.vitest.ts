// harness-test-tier: fast
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Geist Mono 的 liga 把「--」压成一格宽的长划连字(hyphen_hyphen.liga advance 600 /
// lsb -476,墨迹回卷吃掉前导空格的可见间隙),命令行 `create --title` 在屏幕上读成
// `create--title`(task_585c73ff,开/关对照探针实测 -- 簇 6.61px → 13.21px)。
// 等宽面显示的是命令与 id,不是散文:连字在 --font-mono 的定义处全局关闭,
// font-mono utility 与 var(--font-mono) 使用点共用同一个开关。
const styles = readFileSync("src/renderer/styles.css", "utf8");

function declarationBlocks(): { selector: string; body: string }[] {
  const blocks: { selector: string; body: string }[] = [];
  for (const match of styles.matchAll(/(^|\})([^{}]*)\{([^{}]*)\}/gu)) {
    blocks.push({ selector: (match[2] ?? "").trim(), body: match[3] ?? "" });
  }
  return blocks;
}

describe("mono font ligature switch (task_585c73ff)", () => {
  it("defines the switch on the mono font's global definition", () => {
    expect(styles).toMatch(/--font-mono--font-feature-settings:\s*"liga" 0;?/u);
  });

  it("every rule applying var(--font-mono) directly carries the same switch", () => {
    const direct = declarationBlocks().filter((block) => /font-family:\s*var\(--font-mono\);?/u.test(block.body));
    expect(direct.length).toBeGreaterThan(0);
    const missing = direct.filter(
      (block) => !/font-feature-settings:\s*var\(--font-mono--font-feature-settings\);?/u.test(block.body),
    );
    expect(missing.map((block) => block.selector)).toEqual([]);
  });
});
