// harness-test-tier: fast
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * S2 视觉基础(dec_B3D40712A6B050D83F1C2EF78D CH3):锐利圆角(2-4px)、玻璃层级
 * (backdrop-filter 模糊与饱和度、描边、内高光)、状态色竖线、环境光层与
 * prefers-reduced-motion 全局关闭。权威样张是业主认可的 overview-prototype.html v4
 * (`:root` 变量、`.tile`、`.focus`、`.scrim`、`#liquid` 滤镜)。
 */
const styles = readFileSync("src/renderer/styles.css", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
};

/** 从 opener(如 /@theme \{/ 或 /.glass\s*\{/)起做括号配平,返回块体。 */
function blockBody(opener: RegExp): string {
  const match = styles.match(opener);
  if (!match || match.index === undefined) return "";
  const open = styles.indexOf("{", match.index);
  let depth = 1;
  let i = open + 1;
  for (; i < styles.length && depth > 0; i += 1) {
    if (styles[i] === "{") depth += 1;
    else if (styles[i] === "}") depth -= 1;
  }
  return styles.slice(open + 1, i - 1);
}

function radiusTokens(): Record<string, number> {
  const theme = blockBody(/@theme\s*\{/u);
  const tokens: Record<string, number> = {};
  for (const match of theme.matchAll(/--radius-([a-z0-9]+):\s*([\d.]+)px/gu)) {
    tokens[match[1] ?? ""] = Number(match[2]);
  }
  return tokens;
}

describe("visual foundation: sharp radius tokens (2-4px)", () => {
  it("defines the full radius scale inside the token range", () => {
    const tokens = radiusTokens();
    for (const name of ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]) {
      expect(tokens[name], `--radius-${name}`).toBeDefined();
    }
    for (const [name, px] of Object.entries(tokens)) {
      expect(px, `--radius-${name}=${px}px`).toBeGreaterThanOrEqual(2);
      expect(px, `--radius-${name}=${px}px`).toBeLessThanOrEqual(4);
    }
  });

  it("leaves no oversized border-radius literal in styles.css", () => {
    const oversized: string[] = [];
    for (const match of styles.matchAll(/border-radius:\s*([^;]+);/gu)) {
      const value = (match[1] ?? "").trim();
      const px = /^([\d.]+)px$/u.exec(value)?.[1];
      if (px && Number(px) > 4) oversized.push(value);
    }
    expect(oversized).toEqual([]);
  });
});

describe("visual foundation: glass layer tokens", () => {
  it("composes .glass from blur/saturate/stroke/inner-highlight tokens", () => {
    const glass = blockBody(/\.glass\s*\{/u);
    expect(glass).toMatch(/backdrop-filter:\s*blur\(var\(--glass-blur\)\)\s*saturate\(var\(--glass-saturate\)\)/u);
    // A2 细边:玻璃描边宽走发丝线 token(Retina 上 0.5px),颜色仍是独立描边色。
    expect(glass).toMatch(/border:\s*var\(--hairline-width\) solid var\(--color-glass-border\)/u);
    expect(glass).toMatch(/inset 0 1px 0 var\(--color-glass-highlight\)/u);
  });

  it("keeps the modal scrim on its own blur/saturate level", () => {
    const scrim = blockBody(/\.glass-scrim\s*\{/u);
    expect(scrim).toMatch(/backdrop-filter:\s*blur\(var\(--scrim-blur\)\)\s*saturate\(var\(--scrim-saturate\)\)/u);
    expect(scrim).toMatch(/background:\s*var\(--color-scrim\)/u);
  });

  it("routes the magnify-layer refraction through the #liquid SVG filter", () => {
    expect(blockBody(/\.glass-liquid\s*\{/u)).toMatch(/backdrop-filter:\s*url\(#liquid\)/u);
  });

  it("overrides glass surface colors for the light theme", () => {
    const light = blockBody(/html\[data-theme="light"\]\s*\{/u);
    expect(light).toMatch(/--color-glass:/u);
    expect(light).toMatch(/--color-glass-border:/u);
  });
});

describe("visual foundation: A2 hairline borders", () => {
  it("scales the hairline width down on high-density screens", () => {
    expect(styles).toMatch(/--hairline-width:\s*1px/u);
    const double = blockBody(/@media \(min-resolution:\s*2dppx\)\s*\{/u);
    expect(double).toMatch(/--hairline-width:\s*0\.5px/u);
    const triple = blockBody(/@media \(min-resolution:\s*3dppx\)\s*\{/u);
    expect(triple).toMatch(/--hairline-width:\s*calc\(1px \/ 3\)/u);
  });

  it("keeps border tokens alpha-based so lines blend with their substrate", () => {
    const theme = blockBody(/@theme\s*\{/u);
    expect(theme).toMatch(/--color-border:\s*oklch\(1 0 0 \/ 0\.09\)/u);
    expect(theme).toMatch(/--color-border-strong:\s*oklch\(1 0 0 \/ 0\.18\)/u);
    const light = blockBody(/html\[data-theme="light"\]\s*\{/u);
    expect(light).toMatch(/--color-border:\s*oklch\(0\.25 0\.006 285 \/ 0\.1\)/u);
    expect(light).toMatch(/--color-border-strong:\s*oklch\(0\.25 0\.006 285 \/ 0\.2\)/u);
  });
});

describe("visual foundation: status edge and ambient backdrop", () => {
  it("paints the status vertical line from --status-edge", () => {
    const edge = blockBody(/\.status-edge::after\s*\{/u);
    expect(edge).toMatch(/width:\s*2px/u);
    expect(edge).toMatch(/background:\s*var\(--status-edge/u);
    expect(edge).toMatch(/pointer-events:\s*none/u);
  });

  it("keeps the aurora backdrop behind content and non-interactive", () => {
    const aurora = blockBody(/\.aurora\s*\{/u);
    expect(aurora).toMatch(/position:\s*fixed/u);
    // z-index: 0 浮在 html/body 不透明画布底色之上、AppShell(relative z-1)之下,对齐权威样张 overview-prototype.html v4。
    expect(aurora).toMatch(/z-index:\s*0/u);
    expect(aurora).toMatch(/pointer-events:\s*none/u);
    // 玻璃可见性前提:环境光在暗/亮两套主题都有,只是强度不同。
    expect(blockBody(/html\[data-theme="light"\]\s*\{/u)).toMatch(/--aurora-/u);
  });
});

describe("visual foundation: reduced motion", () => {
  it("disables every animation and transition under prefers-reduced-motion", () => {
    const reduced = blockBody(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/u);
    expect(reduced).toMatch(/animation:\s*none\s*!important/u);
    expect(reduced).toMatch(/transition:\s*none\s*!important/u);
  });

  it("preserves heartbeat telemetry animations without leaving frozen artifacts", () => {
    const reduced = blockBody(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/u);
    expect(reduced).toMatch(/\.live-row::after\s*\{[^}]*animation:[^}]*live-wave-sweep[^}]*!important/u);
    expect(reduced).toMatch(/\.seg-active-shimmer::after\s*\{[^}]*animation:[^}]*live-wave-sweep[^}]*!important/u);
  });

  it("disables micro-heartbeat animations under prefers-reduced-motion", () => {
    const reduced = blockBody(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/u);
    expect(reduced).not.toMatch(/\.status-tag-active\s*\{[^}]*animation:/u);
    expect(reduced).not.toMatch(/\.live-dot-pulse\s*\{[^}]*animation:/u);
  });
});

describe("visual foundation: motion as the sole animation library", () => {
  it("depends on motion and no competing animation library", () => {
    expect(pkg.dependencies.motion).toBeDefined();
    const rivals = Object.keys(pkg.dependencies).filter((name) =>
      /^(framer-motion|react-spring|@react-spring\/|gsap|@formkit\/auto-animate|react-transition-group|auto-animate)/u.test(
        name,
      ),
    );
    expect(rivals).toEqual([]);
  });
});
