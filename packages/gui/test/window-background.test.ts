// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { oklchToHex, windowBackgroundColor, windowBackgroundOklch } from "../src/index.ts";

// 外部锚:styles.css 与 electron-main.ts 由测试文件的已知位置算出,不经被测实现。
const testDir = path.dirname(fileURLToPath(import.meta.url));
const stylesCss = readFileSync(path.join(testDir, "../src/renderer/styles.css"), "utf8");
const electronMainSource = readFileSync(path.join(testDir, "../src/main/electron-main.ts"), "utf8");

// task_2c407ef2100f59900ba20869c8:窗口底色必须等于 renderer styles.css 的 --color-bg
// token。Electron 的 backgroundColor 只解析 Hex/RGB/HSL/命名色,oklch token 经
// oklchToHex(CSS Color 4 / Ottosson OKLab 同源公式)确定性换算;向量钉死换算正确性,
// 字符串比对钉死 token 镜像与 CSS 不漂移。
test("oklchToHex hits the exact endpoints and both window background tokens", () => {
  assert.equal(oklchToHex("oklch(1 0 0)"), "#ffffff");
  assert.equal(oklchToHex("oklch(0 0 0)"), "#000000");
  assert.equal(oklchToHex(windowBackgroundOklch.dark), "#17171a");
  assert.equal(oklchToHex(windowBackgroundOklch.light), "#f3f3f5");
  // 色相按 360° 取模等价:-75° ≡ 285°,负角度必须落在同一换算结果上。
  assert.equal(oklchToHex("oklch(0.205 0.006 -75)"), oklchToHex(windowBackgroundOklch.dark));
});

test("oklchToHex rejects anything outside the opaque oklch(L C H) token format", () => {
  assert.throws(() => oklchToHex("oklch(0.205 0.006 285 / 0.5)"), /opaque oklch/);
  assert.throws(() => oklchToHex("#17171a"), /opaque oklch/);
  assert.throws(() => oklchToHex("not a color"), /opaque oklch/);
});

test("the window background is the app background token for both themes", () => {
  assert.equal(windowBackgroundColor(true), "#17171a");
  assert.equal(windowBackgroundColor(false), "#f3f3f5");
});

// 漂移守卫:常量是 styles.css --color-bg 的逐字镜像,字符串相等,不经换算通道——
// CSS token 改了而常量没跟上时,这里直接红并指出要改哪一行。
test("window background tokens mirror the renderer --color-bg tokens character for character", () => {
  const darkBlock = stylesCss.match(/@theme\s*\{([^{}]*)\}/u)?.[1];
  const lightBlock = stylesCss.match(/html\[data-theme="light"\]\s*\{([^{}]*)\}/u)?.[1];
  const tokenOf = (block: string | undefined, scope: string) => {
    const token = block?.match(/--color-bg:\s*([^;]+);/u)?.[1]?.trim();
    assert.ok(token, `styles.css ${scope} block no longer defines --color-bg`);
    return token;
  };
  assert.equal(
    tokenOf(darkBlock, "@theme"),
    windowBackgroundOklch.dark,
    "dark window background token drifted from styles.css @theme --color-bg",
  );
  assert.equal(
    tokenOf(lightBlock, 'html[data-theme="light"]'),
    windowBackgroundOklch.light,
    "light window background token drifted from styles.css --color-bg",
  );
});

// 接线守卫:窗口构造点(electron-main.ts,全仓唯一 BrowserWindow)必须把原生主题解析
// 进 backgroundColor,并在主题翻转时同步;安全 flag 字面内联是既有静态门的要求,
// 这里只钉底色接线的两行。
test("the main window construction wires the theme-derived background color", () => {
  assert.match(electronMainSource, /backgroundColor:\s*windowBackgroundColor\(nativeTheme\.shouldUseDarkColors\)/u);
  assert.match(electronMainSource, /nativeTheme\.on\("updated",\s*\w+\)/u);
  assert.match(electronMainSource, /mainWindow\.once\("closed",\s*\(\)\s*=>\s*nativeTheme\.off\("updated"/u);
});
