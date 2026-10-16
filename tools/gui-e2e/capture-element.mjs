#!/usr/bin/env node

// GUI 任务截图证据的元素取景入口:给定代码树、路由、被测元素选择器、主题/宽度/减少动态
// 效果矩阵,自动 scrollIntoView、按元素包围盒 clip,落盘前断言元素真的在画面里且可见,
// 不过即非零退出、不留图(2026-10-16 两次同族失真:排版包 Region/chain 截图全是页面顶部、
// 动效包 Drawer 截图是空白页——两包运行时断言测的都是 DOM 计算值,不是画面上有没有被测
// 元素)。断言面沿用两包打回修复轮的取景协议:元素可见链 + 含祖先有效透明度 + 视口交集
// + clip 完整覆盖包围盒。与 capture.mjs 的分工:capture.mjs 拍项目数据的整页验收图;
// 本工具拍显式代码树的元素特写,before/after 对比各调一次、分别给 --out。
// 用法:
//   node tools/gui-e2e/capture-element.mjs --code-tree <path> --route /component-catalog.html \
//     --selector '[data-testid="catalog-supersede-chain"]' --name chain --scroll-x right \
//     --out artifacts/screenshots/after --matrix dark@1440,light@1440,dark@1440+reduced
// --selector 可重复;--name/--scroll/--scroll-x 作用于它前面最近的一个 --selector。
// 选择器写成逗号并列(如 "aside[role=dialog], [data-testid^=agenda-row-]")时按匹配并集
// 取景,复合构图用这个。代码树需要可解析的 node_modules(vite/electron 本体由本仓提供):
// 临时基线树用 `ln -s <任务worktree>/node_modules <树>/node_modules`。
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startGuiDriver } from "./driver.mjs";
import { openProject, navLocator } from "./capture-nav.mjs";

const DEFAULT_PAD = 24; // 包围盒外扩量:露边缘上下文,同时不把无关内容收进来
const OPACITY_FLOOR = 0.1; // 落盘硬门:含祖先的有效透明度低于此值按「画面上没有」处理
const SETTLE_TIMEOUT_MS = 10_000;
const WINDOW_HEIGHT = 900;
const DEFAULT_MATRIX = "dark@1440";

export function parseMatrix(spec) {
  return spec.split(",").map((raw) => {
    const token = raw.trim();
    const match = /^(dark|light)@(\d+)(\+reduced)?$/u.exec(token);
    if (!match) throw new Error(`矩阵项无法解析: ${token}(期望形如 dark@1440 或 dark@1440+reduced)`);
    const width = Number(match[2]);
    if (width < 320) throw new Error(`矩阵项宽度过窄: ${token}`);
    return { theme: match[1], width, reduced: Boolean(match[3]) };
  });
}

function slugFor(text) {
  const slug = text
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return slug || "target";
}

function assignTargetNames(targets) {
  const used = new Set();
  for (const target of targets) {
    const base = slugFor(target.name ?? target.selector);
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${base}-${suffix}`;
    used.add(name);
    target.name = name;
  }
}

export function parseCaptureArgs(argv) {
  const options = {
    codeTree: null,
    route: "/",
    out: null,
    nav: null,
    project: null,
    matrix: DEFAULT_MATRIX,
    pad: DEFAULT_PAD,
    height: WINDOW_HEIGHT,
    settleTimeoutMs: SETTLE_TIMEOUT_MS,
    settleMs: 0,
    targets: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === "--code-tree") options.codeTree = value();
    else if (arg === "--route") options.route = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--nav") options.nav = value();
    else if (arg === "--project") options.project = value();
    else if (arg === "--matrix") options.matrix = value();
    else if (arg === "--pad") options.pad = Number(value());
    else if (arg === "--height") options.height = Number(value());
    else if (arg === "--settle-timeout-ms") options.settleTimeoutMs = Number(value());
    else if (arg === "--settle-ms") options.settleMs = Number(value());
    else if (arg === "--selector") options.targets.push({ selector: value(), name: null, scroll: null, scrollX: null });
    else if (arg === "--name" || arg === "--scroll" || arg === "--scroll-x") {
      const target = options.targets.at(-1);
      if (!target) throw new Error(`${arg} 必须跟在某个 --selector 之后`);
      if (arg === "--name") target.name = value();
      else if (arg === "--scroll") target.scroll = value();
      else target.scrollX = value();
    } else throw new Error(`未知参数: ${arg}`);
  }
  for (const key of ["codeTree", "out"])
    if (!options[key]) throw new Error(`缺少 --${key === "codeTree" ? "code-tree" : key}`);
  if (options.targets.length === 0) throw new Error("至少需要一个 --selector");
  if (!options.route.startsWith("/")) throw new Error("--route 需要以 / 开头的路径,如 / 或 /component-catalog.html");
  for (const [flag, key, min] of [
    ["pad", "pad", 0],
    ["height", "height", 200],
    ["settle-timeout-ms", "settleTimeoutMs", 0],
    ["settle-ms", "settleMs", 0],
  ]) {
    if (!Number.isInteger(options[key]) || options[key] < min) throw new Error(`--${flag} 需要不小于 ${min} 的整数`);
  }
  for (const target of options.targets) {
    if (!target.selector) throw new Error("--selector 需要一个 CSS 选择器");
    if (target.scroll !== null && !["top", "middle", "bottom"].includes(target.scroll)) {
      throw new Error(`--scroll 只认 top/middle/bottom,收到 ${target.scroll}`);
    }
    if (target.scrollX !== null && !["left", "middle", "right"].includes(target.scrollX)) {
      throw new Error(`--scroll-x 只认 left/middle/right,收到 ${target.scrollX}`);
    }
  }
  const combos = parseMatrix(options.matrix);
  assignTargetNames(options.targets);
  return { ...options, combos };
}

// 落盘前守卫(纯函数,供单测):输入是页面实测,输出 clip;任一不过抛错,调用方不落图。
// 可见性按「实际绘制盒」口径:滚动/裁剪祖先只画滚动口内的内容,包围盒在 DOM 里不等于
// 画面上有;目标被裁出一部分时 clip 只框实际画得出的切片,证据记录裁剪比。
export function frameGuards(measure, { pad = DEFAULT_PAD, name = "target" } = {}) {
  if (!measure?.present) throw new Error(`${name}: 选择器未匹配任何元素,画面上没有可验收内容`);
  if (!measure.chainVisible) {
    throw new Error(`${name}: 元素被 display/visibility 隐藏链遮蔽: ${(measure.faintChain ?? []).join(" | ")}`);
  }
  if (measure.opacity <= OPACITY_FLOOR) {
    throw new Error(`${name}: 元素有效透明度 ${measure.opacity} ≤ ${OPACITY_FLOOR},画面上不可见(含祖先 opacity)`);
  }
  const { bbox, painted, doc } = measure;
  if (bbox.width <= 0 || bbox.height <= 0) {
    throw new Error(`${name}: 元素包围盒 ${bbox.width.toFixed(0)}×${bbox.height.toFixed(0)}px,没有可拍画面`);
  }
  if (painted.width <= 0 || painted.height <= 0) {
    throw new Error(
      `${name}: 元素画面上没有可拍内容(被滚动容器/裁剪祖先完全裁掉,或不在屏幕上;包围盒 ${bbox.width.toFixed(0)}×${bbox.height.toFixed(0)}px @doc(${bbox.x.toFixed(0)},${bbox.y.toFixed(0)}))`,
    );
  }
  // clip 用文档坐标 + fullPage 截图(走 captureBeyondViewport),与窗口滚动状态解耦,
  // 比视口宽的元素也能完整入画(实测 chain-strip 1676px > 视口 1440px)。
  const clip = {
    x: Math.max(0, painted.x - pad),
    y: Math.max(0, painted.y - pad),
    width: Math.min(painted.width + pad * 2, doc.width - Math.max(0, painted.x - pad)),
    height: Math.min(painted.height + pad * 2, doc.height - Math.max(0, painted.y - pad)),
  };
  const inter = (a, b) => ({
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  });
  const area = (rect) => Math.max(0, rect.width) * Math.max(0, rect.height);
  const paintedArea = area(painted);
  // 实际绘制盒必须完整落在 clip 里(渐隐缘、比视口宽的链都在画面内)。
  if (Math.abs(area(inter(painted, clip)) - paintedArea) > 0.5) {
    throw new Error(
      `${name}: 元素未完整入画(clip 覆盖 ${area(inter(painted, clip)).toFixed(0)}px² ≠ 绘制盒 ${paintedArea.toFixed(0)}px²)`,
    );
  }
  return { clip, paintedPx2: paintedArea };
}

// 页内实测(自包含,经 page.evaluate 序列化):所有匹配元素的并集包围盒、实际绘制盒 +
// 可见链 + 含祖先的有效透明度。断言只信画面上的事实——元素在 DOM、样式正确,但祖先
// opacity≈0 时画面上什么都没有(动效包空白抽屉图的根因);被滚动容器裁掉的部分同样
// 画不出来(重拍轮实证:966px 的 prose 在 230px 滚动口里,包围盒口径会把 3/4 空白当入画)。
const measureTargetInPage = (selector) => {
  const els = Array.from(globalThis.document.querySelectorAll(selector));
  if (els.length === 0) return { present: false, matches: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let paintedLeft = Infinity;
  let paintedTop = Infinity;
  let paintedRight = -Infinity;
  let paintedBottom = -Infinity;
  let chainVisible = true;
  let opacity = 1;
  const faintChain = [];
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
    // 实际绘制盒 = 包围盒 ∏ 祖先裁剪盒。overflow 裁剪祖先只画滚动口内的内容;
    // position:fixed 边界之上不再有裁剪盒,视口就是它的裁剪盒;html/body 正常滚动时
    // 不产生裁剪盒,fullPage 截图能拍到文档折叠线以下。
    const clips = [];
    for (let node = el; node instanceof globalThis.Element; node = node.parentElement) {
      const cs = globalThis.getComputedStyle(node);
      if (cs.position === "fixed") {
        clips.push({ left: 0, top: 0, right: globalThis.innerWidth, bottom: globalThis.innerHeight });
        break;
      }
      if (node !== el && (cs.overflowX !== "visible" || cs.overflowY !== "visible")) {
        const box = node.getBoundingClientRect();
        clips.push({ left: box.left, top: box.top, right: box.right, bottom: box.bottom });
      }
    }
    let sliceLeft = rect.left;
    let sliceTop = rect.top;
    let sliceRight = rect.right;
    let sliceBottom = rect.bottom;
    for (const clip of clips) {
      sliceLeft = Math.max(sliceLeft, clip.left);
      sliceTop = Math.max(sliceTop, clip.top);
      sliceRight = Math.min(sliceRight, clip.right);
      sliceBottom = Math.min(sliceBottom, clip.bottom);
    }
    if (sliceRight > sliceLeft && sliceBottom > sliceTop) {
      paintedLeft = Math.min(paintedLeft, sliceLeft);
      paintedTop = Math.min(paintedTop, sliceTop);
      paintedRight = Math.max(paintedRight, sliceRight);
      paintedBottom = Math.max(paintedBottom, sliceBottom);
    }
    let elChain = true;
    let elOpacity = 1;
    for (let node = el; node instanceof globalThis.Element; node = node.parentElement) {
      const cs = globalThis.getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") elChain = false;
      elOpacity *= Number(cs.opacity);
    }
    if (!elChain || elOpacity < 1) {
      for (let node = el; node instanceof globalThis.Element; node = node.parentElement) {
        const cs = globalThis.getComputedStyle(node);
        if (Number(cs.opacity) < 1 || cs.display === "none" || cs.visibility === "hidden") {
          faintChain.push(
            `${node.tagName.toLowerCase()}${node.getAttribute("class") ? `.${node.getAttribute("class").split(/\s+/).slice(0, 4).join(".")}` : ""} opacity=${cs.opacity} display=${cs.display} vis=${cs.visibility}`,
          );
        }
      }
    }
    chainVisible = chainVisible && elChain;
    opacity = Math.min(opacity, elOpacity);
  }
  const paintedExists = paintedRight > paintedLeft && paintedBottom > paintedTop;
  return {
    present: true,
    matches: els.length,
    chainVisible,
    opacity: Math.round(opacity * 1000) / 1000,
    faintChain,
    bbox: { x: left + globalThis.scrollX, y: top + globalThis.scrollY, width: right - left, height: bottom - top },
    painted: paintedExists
      ? {
          x: paintedLeft + globalThis.scrollX,
          y: paintedTop + globalThis.scrollY,
          width: paintedRight - paintedLeft,
          height: paintedBottom - paintedTop,
        }
      : { x: 0, y: 0, width: 0, height: 0 },
    view: {
      x: globalThis.scrollX,
      y: globalThis.scrollY,
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    },
    doc: {
      width: globalThis.document.documentElement.scrollWidth,
      height: globalThis.document.documentElement.scrollHeight,
    },
  };
};

// 沉降判定(自包含):等待元素真正完全可见再拍;与 measureTargetInPage 同一可见性口径,
// 只做门槛过滤不做证据。入场动画冻结在 opacity 0 的祖先下时这里永远不满足,超时后交回
// 落盘硬门拒绝(区别只是报错更早、更可读)。
const shootableInPage = (selector) => {
  const els = Array.from(globalThis.document.querySelectorAll(selector));
  if (els.length === 0) return false;
  for (const el of els) {
    let chain = true;
    let opacity = 1;
    for (let node = el; node instanceof globalThis.Element; node = node.parentElement) {
      const cs = globalThis.getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") chain = false;
      opacity *= Number(cs.opacity);
    }
    if (!chain || opacity < 0.9) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= globalThis.innerHeight || rect.left >= globalThis.innerWidth)
      return false;
  }
  return true;
};

const rafTwice = (page) =>
  page.evaluate(
    () => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))),
  );

/**
 * 元素取景截图会话:显式 --code-tree 的 Vite dev renderer + 隐藏 Electron + 独立临时
 * profile。run 回调拿到 session(page/applyCombo/navTo/openProject/framedShot)自行组织
 * 矩阵与目标;CLI 与测试共用这一层。
 */
export async function runElementCaptureSession(options, run) {
  const workspaceRoot = options.workspaceRoot ?? path.resolve(import.meta.dirname, "..", "..");
  const codeTree = realpathSync(options.codeTree);
  const temp = mkdtempSync(path.join(tmpdir(), "gui-element-capture-"));
  const gui = path.join(codeTree, "packages/gui");
  const viteBin = path.join(workspaceRoot, "node_modules/vite/bin/vite.js");
  // preload 构建在被拍代码树里(主进程从该树的 dist-electron 读 preload);vite/electron
  // 本体走本仓 node_modules,基线临时树符号链接同一套即可(先例:scroll-fade 包复拍轮)。
  execFileSync(process.execPath, [viteBin, "build", "--config", "vite.preload.config.ts"], {
    cwd: gui,
    stdio: "pipe",
  });
  const config = path.join(temp, "vite.config.mjs");
  writeFileSync(
    config,
    `import base from ${JSON.stringify(pathToFileURL(path.join(gui, "vite.config.ts")).href)};
export default {...base, root:${JSON.stringify(gui)}, cacheDir:${JSON.stringify(path.join(temp, "cache"))}};`,
  );
  const port = 10000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const vite = spawn(
    process.execPath,
    [
      viteBin,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--configLoader",
      "native",
      "--config",
      config,
    ],
    { cwd: gui, stdio: ["ignore", "pipe", "pipe"] },
  );
  let viteLog = "";
  vite.stdout.on("data", (chunk) => (viteLog += chunk));
  vite.stderr.on("data", (chunk) => (viteLog += chunk));
  let driver;
  try {
    for (let attempt = 0; ; attempt += 1) {
      if (vite.exitCode !== null || attempt > 300) throw new Error(`Vite failed: ${viteLog}`);
      if (
        await fetch(base).then(
          (response) => response.ok,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    driver = await startGuiDriver({
      workspaceRoot: codeTree,
      rootDir: codeTree,
      env: { ...(options.env ?? process.env), ELECTRON_RENDERER_URL: base },
      runRoot: temp,
      headless: true,
    });
    const { page, app } = driver;
    const session = {
      driver,
      page,
      app,
      base,
      temp,
      options,
      comboDir: (combo) => path.join(options.out, `${combo.theme}-${combo.width}${combo.reduced ? "-reduced" : ""}`),
      async applyCombo(combo, route = options.route) {
        await page.emulateMedia({ reducedMotion: combo.reduced ? "reduce" : "no-preference" });
        await page.evaluate(({ theme }) => {
          globalThis.localStorage.setItem("harness-theme", theme);
          globalThis.localStorage.setItem("harness-motion", "system");
        }, combo);
        await page.goto(base + route);
        await app.evaluate(
          ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
          { width: combo.width, height: options.height },
        );
        if (route === "/") await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
        // 应用与组件目录都经 ThemeProvider 落 data-theme,主题没落定前不取景。
        await page.waitForFunction((theme) => globalThis.document.documentElement.dataset.theme === theme, combo.theme);
      },
      navTo: (label) => navLocator(page, label).then((locator) => locator.click()),
      openProject: (project) => openProject(driver, project),
      /** 元素取景截图:scrollIntoView 居中 → 摆滚动位 → 沉降 → 实测 → 守卫 → 落图。 */
      async framedShot(target, dir) {
        const { scroll = null, scrollX = null } = target;
        await page.evaluate((selector) => {
          globalThis.document
            .querySelector(selector)
            ?.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        }, target.selector);
        if (scroll !== null || scrollX !== null) {
          // 滚动位在 scrollIntoView 之后摆:内容目标会被 scrollIntoView 重新居中,先摆
          // 会被覆盖成同一状态(实测三态同图)。作用于目标自身;目标是内容元素(自身不
          // 滚)时作用于最近的可滚祖先——那才是滚这段内容的滚动上下文(prose 的滚动口
          // 在 DocumentFrame 的 overflow-auto div 上,设在 prose 自身是 no-op)。
          await page.evaluate(
            ({ selector, scroll, scrollX }) => {
              const el = globalThis.document.querySelector(selector);
              if (el === null) throw new Error(`滚动目标不存在: ${selector}`);
              let scroller = null;
              for (let node = el; node instanceof globalThis.Element; node = node.parentElement) {
                if (node.scrollHeight - node.clientHeight > 2 || node.scrollWidth - node.clientWidth > 2) {
                  scroller = node;
                  break;
                }
              }
              if (scroller === null) return;
              if (scroll) {
                scroller.scrollTop =
                  scroll === "top"
                    ? 0
                    : scroll === "bottom"
                      ? scroller.scrollHeight
                      : Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
              }
              if (scrollX) {
                scroller.scrollLeft =
                  scrollX === "left"
                    ? 0
                    : scrollX === "right"
                      ? scroller.scrollWidth
                      : Math.round((scroller.scrollWidth - scroller.clientWidth) / 2);
              }
            },
            { selector: target.selector, scroll, scrollX },
          );
        }
        await rafTwice(page);
        await page
          .waitForFunction(shootableInPage, target.selector, {
            timeout: target.settleTimeoutMs ?? options.settleTimeoutMs,
          })
          .catch(() => undefined);
        const measure = await page.evaluate(measureTargetInPage, target.selector);
        const { clip } = frameGuards(measure, { pad: options.pad, name: target.name });
        await driver.assertBackground();
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${target.name}.png`);
        await page.screenshot({ path: file, clip, fullPage: true, animations: "allow" });
        const bboxArea = measure.bbox.width * measure.bbox.height || 1;
        const paintedArea = measure.painted.width * measure.painted.height;
        return {
          file,
          matches: measure.matches,
          opacity: measure.opacity,
          elementPx: [measure.bbox.width, measure.bbox.height].map((value) => +value.toFixed(0)),
          paintedPx: [measure.painted.width, measure.painted.height].map((value) => +value.toFixed(0)),
          paintedRatio: +(paintedArea / bboxArea).toFixed(3),
          clipPx: [clip.width, clip.height].map((value) => +value.toFixed(0)),
        };
      },
    };
    await run(session);
  } finally {
    if (driver) await driver.close();
    vite.kill();
    writeFileSync(path.join(temp, "vite.log"), viteLog);
  }
}

function usage(error) {
  console.error(
    `${error ? `error: ${error}\n` : ""}usage: node tools/gui-e2e/capture-element.mjs --code-tree <path> --out <dir> \
--selector <css> [--name <id>] [--scroll top|middle|bottom] [--scroll-x left|middle|right]...
options:
  --code-tree <path>          被拍摄的代码树(before/after 对比各调一次)
  --route <path>              dev server 路径:/ 主应用(可配 --nav),/component-catalog.html 组件目录
  --selector <css>            被测元素选择器;可重复,逗号并列按并集取景(复合构图)
  --name <id>                 该目标的落盘文件名(默认由选择器派生)
  --scroll <pos>              截图前把目标(或其最近可滚祖先)竖向滚动位摆到 top/middle/bottom
  --scroll-x <pos>            截图前把目标(或其最近可滚祖先)横向滚动位摆到 left/middle/right
  --nav <label>               截图前点击侧栏导航按钮(主应用路由)
  --project <name>            先在快速切换面板精确选中该项目(主应用路由,只读)
  --matrix <combos>           主题@宽度[+reduced] 逗号并列,如 dark@1440,light@1120+reduced(默认 dark@1440)
  --out <dir>                 输出目录;每组合落入 <out>/<theme>-<width>[-reduced]/,另有 capture-evidence.json
  --pad <px>                  包围盒外扩像素(默认 24)
  --height <px>               窗口高度(默认 900;宽度由矩阵给)
  --settle-timeout-ms <n>     等元素完全可见的沉降上限(默认 10000;0 跳过)
  --settle-ms <n>             导航后固定等待毫秒(数据沉降,默认 0)`,
  );
  process.exitCode = 1;
}

async function main(argv) {
  const options = parseCaptureArgs(argv);
  const evidence = {
    tool: "tools/gui-e2e/capture-element.mjs",
    codeTree: options.codeTree,
    route: options.route,
    nav: options.nav,
    project: options.project,
    matrix: options.matrix,
    pad: options.pad,
    height: options.height,
    targets: options.targets,
    runs: [],
  };
  let failure = null;
  try {
    await runElementCaptureSession(options, async (session) => {
      const { page } = session;
      if (options.project) {
        await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
        const switched = await session.openProject(options.project);
        if (switched !== options.project) {
          throw new Error(`切换后侧栏显示的项目是「${switched}」,不是「${options.project}」`);
        }
      }
      for (const combo of options.combos) {
        await session.applyCombo(combo);
        if (options.nav) await session.navTo(options.nav);
        if (options.settleMs > 0) await page.waitForTimeout(options.settleMs);
        const dir = session.comboDir(combo);
        for (const target of options.targets) {
          const shot = await session.framedShot(target, dir);
          evidence.runs.push({
            combo: `${combo.theme}@${combo.width}${combo.reduced ? "+reduced" : ""}`,
            target: target.name,
            selector: target.selector,
            scroll: target.scroll,
            scrollX: target.scrollX,
            ...shot,
          });
          console.log(
            `[capture-element] ${combo.theme}@${combo.width}${combo.reduced ? "+reduced" : ""} ${target.name} -> ${shot.file} (element ${shot.elementPx.join("x")}px, painted ${shot.paintedPx.join("x")}px/${shot.paintedRatio}, clip ${shot.clipPx.join("x")}px)`,
          );
        }
      }
      evidence.consoleFailures = [...session.driver.consoleFailures];
    });
  } catch (error) {
    failure = error;
  }
  // 失败也落证据 JSON(阳性轮的图保留;失败那张不落图)。
  mkdirSync(options.out, { recursive: true });
  const evidenceFile = path.join(options.out, "capture-evidence.json");
  writeFileSync(
    evidenceFile,
    JSON.stringify({ ...evidence, failure: failure === null ? null : String(failure.message ?? failure) }, null, 2),
  );
  if (failure !== null) throw failure;
  if (evidence.consoleFailures?.length > 0) {
    console.error(
      `[capture-element] renderer console errors(不阻断截图,验收时人工判断):\n${evidence.consoleFailures.join("\n")}`,
    );
  }
  console.log(
    `[capture-element] done: ${options.combos.length} 组矩阵 × ${options.targets.length} 个目标,证据 ${evidenceFile}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    usage(error instanceof Error ? error.message : String(error));
  });
}
