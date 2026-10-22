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
  // 先把注释整段剔除再解析:注释里出现的 `{`/`}` 与说明文字会粘到紧随其后的选择器上,
  // 让那条规则看起来「不是一条规则」而被静默跳过(实测:`.rt-pre-wrap` 前有注释时,
  // 给它加 font-family 却测不出缺开关)。
  const source = styles.replace(/\/\*[\s\S]*?\*\//gu, "");
  // 不要用 `(^|\})` 做前导:那个分组会把上一个块的收尾 `}` 一起吃掉,而它也属于「本块
  // 结束」的判定,于是每两条规则只解析出后面那条(本文件 164 条只解析出 89 条)。判断
  // 「某条规则是否缺开关」时这是抽样的错位——新增一条规则就能改变被看到的那一半(本任务
  // 实测:加 .rt-pre-wrap 后 direct 从 1 变 0,测试报红而生产 0 处违规)。
  for (const match of source.matchAll(/([^{}]*)\{([^{}]*)\}/gu)) {
    const selector = (match[1] ?? "").trim();
    if (selector === "" || selector.startsWith("@")) continue;
    blocks.push({ selector, body: match[2] ?? "" });
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
