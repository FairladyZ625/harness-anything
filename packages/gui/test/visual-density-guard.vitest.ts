// harness-test-tier: fast
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * 视觉基线 v2 守护(gui-visual-language-standard §1.7/§1.8/§3,业主 2026-10-01):
 * 让「可读性优先」以后自动成立,而不是靠人记。规则是少量明确的正则与清单;
 * 排除项逐条带原因。条目高度与正文字号本来就该由 DenseRow 等原语一处定
 * (标准 §4),页面里再出现写死的矮行高/小字号即违规。
 */

// 目录 URL 一律带尾斜杠:不带尾斜杠的 base 在 new URL 相对解析时会丢掉最后一段。
const RENDERER_ROOT = new URL("../src/renderer/", import.meta.url);
const LOCALES_ROOT = new URL("../src/renderer/i18n/locales/", import.meta.url);

/** 目录级排除(路径相对 src/renderer),每条注明保留原因。 */
const EXCLUDED_DIRS = [
  // 原语本体:高度、字号、间距只在原语内定(标准 §4「一处实现」)。
  "components/primitives",
  // 终端 chrome 的小字号是任务边界外的既有形态(终端页任务约定)。
  "components/terminal",
  // 侧栏常驻系统状态条是 chrome 状态行,不是列表条目(与终端状态行同类)。
  "components/sidebar",
  // 底层控件几何(开关轨道、旋钮直径),不是条目高度。
  "components/ui",
  // 图谱节点/徽标是画布元素(§2.6 工具型页面),不是列表条目。
  "graph",
] as const;

/** 固定高度 10–39px 的 Tailwind 任意值类:列表条目/控件低于 40px 底线(§3)。 */
const SHORT_HEIGHT_RE = /\bh-\[(?:1[0-9]|2[0-9]|3[0-9])px\]/u;
/** 原始字号 7–12px:正文 14 / 辅助 ≥12.5(§3),页面不得写死更小的字号。 */
const SMALL_FONT_RE = /text-\[(?:[7-9]|1[012])(?:\.[0-9])?px\]/u;

/**
 * 悬停才出现的元素(§1.9③:关键操作不依赖悬停,触屏没有悬停):隐藏类与它的
 * group-hover 恢复类同一行出现即违规——收藏星 B4 即此形态。信息性内容(非操作)
 * 的悬停显示走文件级豁免并注明原因。
 */
const HOVER_ONLY_PAIRS = [
  ["opacity-0", "group-hover:opacity-100"],
  ["invisible", "group-hover:visible"],
  ["hidden", "group-hover:inline"],
] as const;
/** 豁免(逐条带原因):终端任务树行的 taskId 是悬停显示的辅助信息(选卡/聚焦
 * 按钮常显,操作不依赖悬停);终端 chrome 紧凑形态见 EXCLUDED_DIRS 注释。 */
const HOVER_ONLY_FILE_EXEMPT = ["components/terminal/TerminalTaskTreePicker.tsx"] as const;

/**
 * 已删除的截断类文案键(标准 §1.8:有空间就铺开,放不下就在区块内滚动;
 * 终态沉底用「已完成 N」分隔线,不藏进「展开」)。重新出现即失败。
 * 保留的「展开」只剩结构导航:components.primitives.expand/collapse
 * (DayDigest §4 原生点开)、terminal.view.taskTreeToggle(树)、
 * 邻域/图谱键(views.entityDetail.neighborhoodHint 等)、
 * components.graphFilterPanel.expandFilterPanel(筛选面板)、
 * agentRuntime.expand(AgentCard 配置面)、artifacts.drawer.expandTitle(抽屉)。
 */
const BANNED_TRUNCATION_KEYS = [
  "components.primitives.moreEntries",
  "views.freshnessView.moreGroups",
  "views.listView.terminalExpandAction",
  "views.listView.terminalCollapseAction",
  "views.workspace.tasks.doneCollapsed",
  "views.workspace.decisionsRetiredCollapsed",
  "views.workspace.factsOlder",
  "schedules.list.foldPaused",
  "schedules.runs.foldDone",
  "schedules.runs.foldHide",
  "components.taskFilterBar.expandColdTerminalCount",
  "components.taskFilterBar.collapseColdTerminalCount",
] as const;

async function collectSourceFiles(dir: URL, extension: string, acc: URL[] = []): Promise<URL[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await collectSourceFiles(new URL(`${entry.name}/`, dir), extension, acc);
    else if (entry.name.endsWith(extension)) acc.push(new URL(entry.name, dir));
  }
  return acc;
}

async function scanRenderer(): Promise<{ file: string; line: number; text: string }[]> {
  const excludedPrefixes = EXCLUDED_DIRS.map((dir) => `${RENDERER_ROOT.href}${dir}/`);
  const files = [
    ...(await collectSourceFiles(RENDERER_ROOT, ".tsx")),
    ...(await collectSourceFiles(RENDERER_ROOT, ".ts")),
  ];
  const violations: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    if (excludedPrefixes.some((prefix) => file.href.startsWith(prefix))) continue;
    const source = await readFile(file, "utf8");
    source.split("\n").forEach((text, index) => {
      for (const [pattern, label] of [
        [SHORT_HEIGHT_RE, "fixed height < 40px"],
        [SMALL_FONT_RE, "raw font <= 12px"],
      ] as const) {
        if (pattern.test(text)) violations.push({ file: file.href, line: index + 1, text: `${label}: ${text.trim()}` });
      }
    });
  }
  return violations;
}

async function scanLocales(): Promise<{ file: string; key: string }[]> {
  const locales = await readdir(LOCALES_ROOT, { withFileTypes: true });
  const hits: { file: string; key: string }[] = [];
  for (const locale of locales) {
    if (!locale.isDirectory()) continue;
    for (const namespace of await readdir(new URL(`${locale.name}/`, LOCALES_ROOT), { withFileTypes: true })) {
      if (!namespace.name.endsWith(".json")) continue;
      const file = new URL(`${locale.name}/${namespace.name}`, LOCALES_ROOT);
      const body = await readFile(file, "utf8");
      for (const key of BANNED_TRUNCATION_KEYS) {
        if (body.includes(`"${key}"`)) hits.push({ file: file.href, key });
      }
    }
  }
  return hits;
}

async function scanHoverOnly(): Promise<{ file: string; line: number; text: string }[]> {
  const exempt = HOVER_ONLY_FILE_EXEMPT.map((rel) => `${RENDERER_ROOT.href}${rel}`);
  const files = [
    ...(await collectSourceFiles(RENDERER_ROOT, ".tsx")),
    ...(await collectSourceFiles(RENDERER_ROOT, ".ts")),
  ].filter((file) => !exempt.includes(file.href));
  const violations: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    source.split("\n").forEach((text, index) => {
      for (const [hidden, revealed] of HOVER_ONLY_PAIRS) {
        if (text.includes(hidden) && text.includes(revealed)) {
          violations.push({ file: file.href, line: index + 1, text: `hover-only: ${text.trim()}` });
        }
      }
    });
  }
  return violations;
}

describe("visual density guard (gui-visual-language-standard v2)", () => {
  it("renderer pages declare no fixed row heights below 40px and no raw fonts at or below 12px", async () => {
    const violations = await scanRenderer();
    expect(violations).toEqual([]);
  });

  it("no element hides until group hover (actions must be reachable without hover, §1.9)", async () => {
    const violations = await scanHoverOnly();
    expect(violations).toEqual([]);
  });

  it("truncation-style expand copy keys stay deleted (terminal states sink behind a divider, §1.4/§1.8)", async () => {
    const excludedPrefixes = EXCLUDED_DIRS.map((dir) => `${RENDERER_ROOT.href}${dir}/`);
    const files = [
      ...(await collectSourceFiles(RENDERER_ROOT, ".tsx")),
      ...(await collectSourceFiles(RENDERER_ROOT, ".ts")),
    ];
    const bannedInSource: string[] = [];
    for (const file of files) {
      if (excludedPrefixes.some((prefix) => file.href.startsWith(prefix))) continue;
      const body = await readFile(file, "utf8");
      for (const key of BANNED_TRUNCATION_KEYS) {
        if (body.includes(key)) bannedInSource.push(`${key} @ ${file.href}`);
      }
    }
    expect(bannedInSource).toEqual([]);
    expect(await scanLocales()).toEqual([]);
  });
});
