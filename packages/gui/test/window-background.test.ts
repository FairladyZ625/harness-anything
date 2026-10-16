// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { windowBackgroundColor, windowBackgroundHex } from "../src/index.ts";

// 外部锚:styles.css 与 electron-main.ts 由测试文件的已知位置算出,不经被测实现。
const testDir = path.dirname(fileURLToPath(import.meta.url));
const stylesCss = readFileSync(path.join(testDir, "../src/renderer/styles.css"), "utf8");
const electronMainSource = readFileSync(path.join(testDir, "../src/main/electron-main.ts"), "utf8");

/**
 * `oklch(L C H)` → `#rrggbb`,CSS Color 4 / Ottosson OKLab 同源公式。生产侧只持
 * 预换算 hex 常量(Electron 的 backgroundColor 不解析 oklch),换算只活在本测试:
 * 用来证明常量确实是 styles.css oklch token 的换算结果。只收无 alpha 的窄格式,
 * 其余输入抛错——CSS token 漂移出该格式时测试以明确报错变红,而不是静默错配。
 */
function oklchToHex(color: string): string {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/u.exec(color);
  if (!match) throw new Error(`Not an opaque oklch(L C H) color: ${color}`);
  const [lightness, chroma, hueDegree] = match.slice(1).map(Number) as [number, number, number];
  const hue = (hueDegree * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channel = (linear: number): string => {
    const clamped = Math.min(1, Math.max(0, linear));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${[
    channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ].join("")}`;
}

// 换算向量:端点精确、色相 360° 取模等价、窄格式 fail-closed。钉死的是公式本身,
// 不依赖生产常量——常量守卫另有专测。
test("the in-test oklch conversion hits the exact endpoints, hue equivalence and fail-closed parse", () => {
  assert.equal(oklchToHex("oklch(1 0 0)"), "#ffffff");
  assert.equal(oklchToHex("oklch(0 0 0)"), "#000000");
  // 色相按 360° 取模等价:-75° ≡ 285°,负角度必须落在同一换算结果上。
  assert.equal(oklchToHex("oklch(0.205 0.006 -75)"), oklchToHex("oklch(0.205 0.006 285)"));
  assert.throws(() => oklchToHex("oklch(0.205 0.006 285 / 0.5)"), /opaque oklch/);
  assert.throws(() => oklchToHex("#17171a"), /opaque oklch/);
});

// 从 styles.css 取指定作用域的 --color-bg oklch 值。
function colorBgToken(scope: "dark" | "light"): string {
  const scopeSelector = scope === "dark" ? "@theme" : 'html[data-theme="light"]';
  const block =
    scope === "dark"
      ? stylesCss.match(/@theme\s*\{([^{}]*)\}/u)?.[1]
      : stylesCss.match(/html\[data-theme="light"\]\s*\{([^{}]*)\}/u)?.[1];
  const token = block?.match(/--color-bg:\s*([^;]+);/u)?.[1]?.trim();
  assert.ok(token, `styles.css ${scopeSelector} block no longer defines --color-bg`);
  return token;
}

// task_2c407ef2100f59900ba20869c8:窗口底色常量必须等于 renderer styles.css 的
// --color-bg token 的换算结果。测试读 CSS 的 oklch 值、在测试内换算、断言等于生产
// hex 常量——改 CSS 值或改常量任一侧,这里都直接红。
test("the window background hex constants are the converted --color-bg tokens of both themes", () => {
  assert.equal(
    oklchToHex(colorBgToken("dark")),
    windowBackgroundHex.dark,
    "dark window background hex drifted from the converted styles.css @theme --color-bg",
  );
  assert.equal(
    oklchToHex(colorBgToken("light")),
    windowBackgroundHex.light,
    "light window background hex drifted from the converted styles.css --color-bg",
  );
});

test("the window background is the app background token for both themes", () => {
  assert.equal(windowBackgroundColor(true), "#17171a");
  assert.equal(windowBackgroundColor(false), "#f3f3f5");
});

// 接线守卫:窗口构造点(electron-main.ts,全仓唯一 BrowserWindow)必须把原生主题解析
// 进 backgroundColor,并在主题翻转时同步;安全 flag 字面内联是既有静态门的要求,
// 这里只钉底色接线的两行。
test("the main window construction wires the theme-derived background color", () => {
  assert.match(electronMainSource, /backgroundColor:\s*windowBackgroundColor\(nativeTheme\.shouldUseDarkColors\)/u);
  assert.match(electronMainSource, /nativeTheme\.on\("updated",\s*\w+\)/u);
  assert.match(electronMainSource, /mainWindow\.once\("closed",\s*\(\)\s*=>\s*nativeTheme\.off\("updated"/u);
});
