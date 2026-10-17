// harness-test-tier: fast
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * GUI 渲染与动效卫生门禁 (GUI Rendering Hygiene Gate)
 *
 * 背景与教训:
 * 在高保真玻璃拟态 (Glassmorphism) 与环境光 (Aurora) 界面中，Chromium 的合成器 (Compositor)
 * 与滤镜缓存机制对重绘极度敏感。若在无限循环动画中操作 `box-shadow`、`filter` 或布局属性，
 * 浏览器每帧都会强制重绘图层，并连带导致重叠的全部 `backdrop-filter` 毛玻璃缓存全量失效，
 * 引发 GPU 100% 满载与整机发热卡顿。
 *
 * 本门禁在 CI 与本地测试阶段静态扫描 CSS，对有害渲染模式进行 fail-closed 拦截，
 * 并向 Agent 输出详尽的「保证高美观度且零性能惩罚」的优化方案与代码范式。
 */

const stylesPath = "src/renderer/styles.css";
const styles = readFileSync(stylesPath, "utf8");

export function stripComments(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, "");
}

export interface KeyframeDefinition {
  name: string;
  body: string;
}

export interface KeyframePropertyViolation {
  property: string;
  value: string;
}

/** 提取 CSS 中全部 @keyframes 块 */
export function extractKeyframes(cleanCss: string): KeyframeDefinition[] {
  const keyframes: KeyframeDefinition[] = [];
  const regex = /@keyframes\s+([a-zA-Z0-9_-]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleanCss)) !== null) {
    const name = match[1] ?? "";
    const startIndex = match.index + match[0].length;
    let depth = 1;
    let i = startIndex;
    while (i < cleanCss.length && depth > 0) {
      if (cleanCss[i] === "{") depth += 1;
      else if (cleanCss[i] === "}") depth -= 1;
      i += 1;
    }
    const body = cleanCss.slice(startIndex, i - 1);
    keyframes.push({ name, body });
  }
  return keyframes;
}

/** 查找在动画中被无限循环 (infinite) 使用的 @keyframes 名字集合 */
export function findInfiniteKeyframeNames(cleanCss: string, keyframes: KeyframeDefinition[]): Set<string> {
  const infiniteSet = new Set<string>();
  const animRegex = /animation(?:-iteration-count)?\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = animRegex.exec(cleanCss)) !== null) {
    const val = match[1] ?? "";
    if (/\binfinite\b/.test(val)) {
      for (const kf of keyframes) {
        if (new RegExp(`\\b${kf.name}\\b`).test(val)) {
          infiniteSet.add(kf.name);
        }
      }
    }
  }
  return infiniteSet;
}

/** 提取 keyframe 内部声明的所有属性及取值 */
export function parseDeclarationsInKeyframe(body: string): { property: string; value: string }[] {
  const decls: { property: string; value: string }[] = [];
  const blockRegex = /\{([^}]+)\}/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(body)) !== null) {
    const blockContent = blockMatch[1] ?? "";
    const lines = blockContent.split(";");
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const prop = line.slice(0, colonIdx).trim().toLowerCase();
        const val = line.slice(colonIdx + 1).trim();
        if (prop) decls.push({ property: prop, value: val });
      }
    }
  }
  return decls;
}

/**
 * 被禁止在无限循环动画中出现的重绘/回流属性:
 * 1. box-shadow: 重度光栅化绘制，导致 backdrop-filter 缓存每帧失效
 * 2. filter / backdrop-filter: 高开销卷积着色器计算
 * 3. 布局属性 (width, height, top, bottom, left, right, margin*, padding*): 触发布局回流
 * 4. stroke-dashoffset (2026-10-18 二轮, task_5c651ff17b698ff2bce7e6affa): SVG 描边
 *    每帧重绘,非合成器属性。业主口径②:保留下来的循环动效只能动 transform/opacity。
 */
export const PROHIBITED_ANIMATED_PROPERTIES = new Set([
  "box-shadow",
  "filter",
  "-webkit-filter",
  "backdrop-filter",
  "-webkit-backdrop-filter",
  "stroke-dashoffset",
  "-webkit-stroke-dashoffset",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "top",
  "bottom",
  "left",
  "right",
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "padding",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "border-width",
]);

/** 构造给 Agent 的高可读性、富有指导意义的报错报告 */
export function formatKeyframeGuidanceReport(keyframeName: string, violations: KeyframePropertyViolation[]): string {
  const violationsList = violations.map((v) => `  - 属性: "${v.property}" (当前值: ${v.value})`).join("\n");

  return `
================================================================================
🚨 [GUI RENDER HYGIENE GATE FAILURE]
检测到无限循环动画使用了禁止的重绘/回流属性！
Keyframe 动画名: "${keyframeName}"
违规属性列表:
${violationsList}

--------------------------------------------------------------------------------
💡 为什么这会造成严重的性能灾难 (Chromium 渲染原理):
1. 在 Chromium / Electron 渲染管线中，"box-shadow"、"filter" 以及尺寸布局属性无法由 GPU
   合成线程 (Compositor Thread) 独立处理，必须走主线程的光栅化与 Paint 重绘。
2. 当无限循环动画 (如心跳、呼吸脉冲) 持续修改这类属性时，浏览器每秒强制重绘 60~120 次。
3. 尤为致命的是：当这些元素处于毛玻璃 (.glass 的 backdrop-filter) 之下或内部时，
   Chromium 每帧都会丢弃已缓存的背景模糊纹理并全屏重新计算高斯模糊，直接导致 GPU 100% 满载！

--------------------------------------------------------------------------------
✨ 解决方案：如何【保持顶级视觉美观】同时【享受 0ms 纯 GPU 合成性能】？

方案 1 (推荐)：静态光晕 + 合成器 transform / opacity 放缩呼吸
保留组件高颜值的柔和外发光，将 box-shadow 静态赋予元素，只在 @keyframes 中操作 transform 和 opacity：

  ❌ 错误做法 (每帧重绘导致显卡风扇狂转):
  @keyframes my-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5); }
    100% { box-shadow: 0 0 0 8px transparent; }
  }

  ✅ 正确做法 (优雅呼吸、零光栅化开销，GPU 占用率 0%):
  .my-pulse-dot {
    /* 静态光晕一次性绘制，由合成器缓存 */
    box-shadow: 0 0 6px 1px color-mix(in oklab, var(--color-status-done) 60%, transparent);
    animation: my-dot-breathe 2.4s var(--ease) infinite;
  }
  @keyframes my-dot-breathe {
    0%, 100% { transform: scale(0.92); opacity: 0.75; }
    50%      { transform: scale(1.18); opacity: 1; }
  }

方案 2：外扩脉冲波纹 (如雷达波) 请用 ::after 伪元素 + transform: scale()
如果需要由内向外扩散的光环波纹，使用 ::after 带有描边或微光，并在 @keyframes 中仅 scale 与 fade-out：

  ✅ 扩展波纹范式:
  .my-radar::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid var(--color-status-active);
    animation: radar-wave 2s cubic-bezier(0, 0, 0.2, 1) infinite;
  }
  @keyframes radar-wave {
    0%   { transform: scale(1); opacity: 0.8; }
    100% { transform: scale(2.4); opacity: 0; }
  }
================================================================================
`;
}

export function formatAuroraGuidanceReport(detail: string): string {
  return `
================================================================================
🚨 [GUI RENDER HYGIENE GATE FAILURE]
检测到背景环境光 (.aurora) 存在危险渲染配置！
问题详情: ${detail}

--------------------------------------------------------------------------------
💡 为什么这会造成严重的性能灾难:
全屏或大尺寸的动态环境光层若使用实时 \`filter: blur(80px)\`，每次浮动微移都会迫使 GPU
对数百万像素执行超大半径的高斯卷积着色器计算。叠加窗口各处的 .glass (backdrop-filter) 后，
着色器开销成倍放大，导致 Electron 窗口静止时 GPU 持续 100%。

--------------------------------------------------------------------------------
✨ 解决方案：如何【保持极致柔和的环境光氛围】同时【避免高斯模糊滤镜开销】？

1. 使用多段分析性径向渐变 (Multi-Stop Analytical Radial-Gradient) 替代 live blur:
   径向渐变通过数学函数在光栅化时天然呈现平滑递减，视觉效果比 live blur 更通透，且着色器成本几乎为 0！

  ✅ 推荐极光多段径向渐变范式:
  background: radial-gradient(
    circle closest-side,
    color-mix(in oklab, var(--aurora-1) 85%, transparent) 0%,
    color-mix(in oklab, var(--aurora-1) 45%, transparent) 45%,
    color-mix(in oklab, var(--aurora-1) 12%, transparent) 75%,
    transparent 100%
  );

2. 开启严苛的硬件加速隔离 (Layer Containment):
  .aurora 必须拥有以下属性以防止重绘污染全局视口:
  - contain: strict;
  - transform: translate3d(0, 0, 0);
  - pointer-events: none;
================================================================================
`;
}

export function formatNestedGlassGuidanceReport(): string {
  return `
================================================================================
🚨 [GUI RENDER HYGIENE GATE FAILURE]
检测到 .glass 内部子组件未禁用嵌套 backdrop-filter！

--------------------------------------------------------------------------------
💡 为什么禁止在 .glass 容器内叠加 backdrop-filter:
父容器已对视口背后像素进行模糊采样。若子元素（如嵌套卡片、内部标签）再次声明 backdrop-filter，
Chromium 将执行递归多重 pass 离屏模糊，消耗大量显存带宽，但人眼肉眼几乎观察不到额外差异。

--------------------------------------------------------------------------------
✨ 解决方案:
子组件应依赖半透明纯色与轻量描边体现层级，显式禁用嵌套模糊：
  .glass .glass-sub {
    backdrop-filter: none;
    background: color-mix(in oklab, var(--color-glass) 80%, transparent);
    border: 1px solid var(--color-glass-border);
  }
================================================================================
`;
}

describe("GUI render hygiene: infinite animation keyframes safety", () => {
  const clean = stripComments(styles);
  const keyframes = extractKeyframes(clean);
  const infiniteKeyframes = findInfiniteKeyframeNames(clean, keyframes);

  it("ensures all infinite @keyframes use compositor-only properties (transform, opacity)", () => {
    const failures: { name: string; violations: KeyframePropertyViolation[] }[] = [];

    for (const kf of keyframes) {
      if (!infiniteKeyframes.has(kf.name)) continue;

      const decls = parseDeclarationsInKeyframe(kf.body);
      const violations: KeyframePropertyViolation[] = [];

      for (const decl of decls) {
        if (PROHIBITED_ANIMATED_PROPERTIES.has(decl.property)) {
          violations.push(decl);
        }
      }

      if (violations.length > 0) {
        failures.push({ name: kf.name, violations });
      }
    }

    if (failures.length > 0) {
      const reports = failures.map((f) => formatKeyframeGuidanceReport(f.name, f.violations)).join("\n");
      expect.unreachable(reports);
    }
  });
});

/**
 * 空闲在场门控覆盖检查(task_5c651ff17b698ff2bce7e6affa):
 * 合成器友好的 infinite 动画本身仍是「只要有任一动画在跑,合成器就持续产帧、
 * .glass backdrop-filter 每帧重模糊」——实测空闲 gpu-process 17% vs 全停 0.3%。
 * 因此类级约束是:styles.css 里每一个声明 infinite 动画的选择器,都必须出现在
 * html[data-motion="idle"] 的暂停规则里;新加的永续动画若逃出门控,这里红。
 */
export interface FlatRule {
  selectors: string[];
  declarations: string;
}

/** 平铺解析顶层规则块(@media 内层规则同样按平铺块捕获;@keyframes 体不含 infinite 声明)。 */
export function extractFlatRules(cleanCss: string): FlatRule[] {
  const rules: FlatRule[] = [];
  const regex = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleanCss)) !== null) {
    const selectorText = (match[1] ?? "").trim();
    // @media/@supports/@keyframes 头与关键帧内部选择器(0%/to)不参与「谁声明了动画」判定。
    if (
      selectorText.startsWith("@") ||
      /^[\d.]+%(?:\s*,\s*[\d.]+%)*$/.test(selectorText) ||
      selectorText === "to" ||
      selectorText === "from"
    ) {
      continue;
    }
    rules.push({
      selectors: selectorText
        .split(",")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean),
      declarations: match[2] ?? "",
    });
  }
  return rules;
}

export const IDLE_GATE_PREFIX = 'html[data-motion="idle"] ';

/** 门控规则覆盖的选择器集合(剥掉 html[data-motion="idle"] 前缀后的裸选择器)。 */
export function gatedSelectors(cleanCss: string): Set<string> {
  const gate = extractFlatRules(cleanCss).find((rule) =>
    /animation-play-state\s*:\s*paused\s*!important/.test(rule.declarations),
  );
  return new Set((gate?.selectors ?? []).map((s) => s.replace(IDLE_GATE_PREFIX, "")));
}

/** 声明了 infinite 动画的选择器集合(含 prefers-reduced-motion 块里的 re-enable 规则)。 */
export function infiniteAnimationSelectors(cleanCss: string): Set<string> {
  const selectors = new Set<string>();
  for (const rule of extractFlatRules(cleanCss)) {
    if (!/\binfinite\b/.test(rule.declarations)) continue;
    for (const selector of rule.selectors) selectors.add(selector);
  }
  return selectors;
}

describe("GUI render hygiene: idle presence gate coverage", () => {
  const clean = stripComments(styles);

  it("pauses every selector that declares an infinite animation while the user is idle", () => {
    const gated = gatedSelectors(clean);
    const infinite = infiniteAnimationSelectors(clean);
    if (infinite.size === 0)
      expect.unreachable("styles.css declares no infinite animation; the gate contract went stale");
    const escaped = [...infinite].filter((selector) => !gated.has(selector));
    if (escaped.length > 0) {
      expect.unreachable(
        `[GUI RENDER HYGIENE GATE FAILURE] 以下选择器声明了 infinite 动画但未被 html[data-motion="idle"] 暂停规则覆盖(空闲时 gpu-process 会被它持续拉高):\n${escaped
          .map((s) => `  - ${s}`)
          .join("\n")}\n把它们加进 styles.css 的 idle 暂停规则选择器列表(一次性入场动画不要加)。`,
      );
    }
  });

  it("detects an ungated infinite animation as a violation (negative control)", () => {
    const badCss = `
      .heartbeat-dot {
        animation: some-breathe 2s infinite;
      }
    `;
    const gated = gatedSelectors(badCss);
    const infinite = infiniteAnimationSelectors(badCss);
    expect(infinite.has(".heartbeat-dot")).toBe(true);
    expect(gated.has(".heartbeat-dot")).toBe(false);
  });
});

describe("GUI render hygiene: ambient backdrop (.aurora) zero-cost diffusion", () => {
  const clean = stripComments(styles);

  it("bans live filter: blur() on .aurora and its child elements", () => {
    // 匹配 .aurora 规则块
    const auroraBlockMatch = clean.match(/\.aurora\s*\{([^}]+)\}/);
    expect(auroraBlockMatch, ".aurora rule block must exist").toBeTruthy();
    const auroraBody = auroraBlockMatch ? auroraBlockMatch[1] : "";

    if (/filter\s*:\s*blur/i.test(auroraBody)) {
      expect.unreachable(formatAuroraGuidanceReport(".aurora declares live filter: blur()"));
    }

    // 匹配 .aurora 子元素
    const childMatches = [...clean.matchAll(/\.aurora\s+i[^{]*\{([^}]+)\}/g)];
    for (const m of childMatches) {
      const childBody = m[1] ?? "";
      if (/filter\s*:\s*blur/i.test(childBody)) {
        expect.unreachable(formatAuroraGuidanceReport(".aurora i declares live filter: blur()"));
      }
    }
  });

  it("enforces hardware layer isolation on .aurora", () => {
    const auroraBlockMatch = clean.match(/\.aurora\s*\{([^}]+)\}/);
    expect(auroraBlockMatch).toBeTruthy();
    const body = auroraBlockMatch ? auroraBlockMatch[1] : "";

    expect(body, ".aurora must have contain: strict").toMatch(/contain\s*:\s*strict/);
    expect(body, ".aurora must have pointer-events: none").toMatch(/pointer-events\s*:\s*none/);
    expect(body, ".aurora must have 3D hardware acceleration transform").toMatch(
      /transform\s*:\s*translate3d\(0,\s*0,\s*0\)/,
    );
  });

  it("uses multi-stop analytical radial gradients for smooth diffusion on .aurora i elements", () => {
    for (const idx of [1, 2, 3]) {
      const match = clean.match(new RegExp(`\\.aurora\\s+i:nth-child\\(${idx}\\)\\s*\\{([^}]+)\\}`));
      expect(match, `.aurora i:nth-child(${idx}) base rule must exist`).toBeTruthy();
      const body = match ? match[1] : "";
      expect(body, `.aurora i:nth-child(${idx}) must use radial-gradient`).toMatch(/background\s*:\s*radial-gradient/);
      expect(body, `.aurora i:nth-child(${idx}) radial-gradient must define multi-stop falloffs (color-mix)`).toMatch(
        /color-mix/,
      );
    }
  });
});

describe("GUI render hygiene: glass nesting hygiene", () => {
  const clean = stripComments(styles);

  it("disables nested backdrop-filter on .glass .glass-sub", () => {
    const subMatch = clean.match(/\.glass\s+\.glass-sub\s*\{([^}]+)\}/);
    if (!subMatch) {
      expect.unreachable(formatNestedGlassGuidanceReport());
    }
    const body = subMatch ? subMatch[1] : "";
    expect(body, ".glass .glass-sub must declare backdrop-filter: none").toMatch(/backdrop-filter\s*:\s*none/);
  });
});

describe("GUI render hygiene: diagnostic negative and positive controls", () => {
  it("detects animated box-shadow and generates detailed agent guidance report", () => {
    const badCss = `
      .pulsing-card {
        animation: dangerous-shadow 2s infinite;
      }
      @keyframes dangerous-shadow {
        0% { box-shadow: 0 0 0 0 red; }
        100% { box-shadow: 0 0 10px 4px transparent; }
      }
    `;
    const keyframes = extractKeyframes(badCss);
    const infinite = findInfiniteKeyframeNames(badCss, keyframes);
    expect(infinite.has("dangerous-shadow")).toBe(true);

    const decls = parseDeclarationsInKeyframe(keyframes[0]?.body ?? "");
    const violations = decls.filter((d) => PROHIBITED_ANIMATED_PROPERTIES.has(d.property));
    expect(violations.length).toBeGreaterThan(0);

    const report = formatKeyframeGuidanceReport("dangerous-shadow", violations);
    expect(report).toContain("🚨 [GUI RENDER HYGIENE GATE FAILURE]");
    expect(report).toContain("为什么这会造成严重的性能灾难");
    expect(report).toContain("静态光晕 + 合成器 transform / opacity");
  });

  it("detects animated stroke-dashoffset as a violation (2026-10-18 二轮:循环动效只动 transform/opacity)", () => {
    const badCss = `
      .flow-beam {
        animation: dash-march 3s linear infinite;
      }
      @keyframes dash-march {
        to { stroke-dashoffset: -96; }
      }
    `;
    const keyframes = extractKeyframes(badCss);
    const infinite = findInfiniteKeyframeNames(badCss, keyframes);
    expect(infinite.has("dash-march")).toBe(true);

    const decls = parseDeclarationsInKeyframe(keyframes[0]?.body ?? "");
    const violations = decls.filter((d) => PROHIBITED_ANIMATED_PROPERTIES.has(d.property));
    expect(violations.map((v) => v.property)).toEqual(["stroke-dashoffset"]);
  });

  it("passes compliant keyframe using only transform and opacity", () => {
    const goodCss = `
      .safe-breathe {
        animation: compositor-pulse 2s infinite;
      }
      @keyframes compositor-pulse {
        0%, 100% { transform: scale(0.95); opacity: 0.7; }
        50% { transform: scale(1.05); opacity: 1; }
      }
    `;
    const keyframes = extractKeyframes(goodCss);
    const infinite = findInfiniteKeyframeNames(goodCss, keyframes);
    expect(infinite.has("compositor-pulse")).toBe(true);

    const decls = parseDeclarationsInKeyframe(keyframes[0]?.body ?? "");
    const violations = decls.filter((d) => PROHIBITED_ANIMATED_PROPERTIES.has(d.property));
    expect(violations).toEqual([]);
  });
});
