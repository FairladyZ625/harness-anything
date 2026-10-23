#!/usr/bin/env node

// GUI 验收截图的固定入口:真实 Electron 窗口 + Vite dev renderer + canonical daemon 数据,只读。
// worker 只需要说「哪个项目、哪些页面、拍之前点什么」,不再各写一份临时抓屏脚本
// (2026-10-01 三件任务的截图拍在快速切换排第一的项目上,worker 看不了 PNG 发现不了)。
// 用法:
//   node tools/gui-e2e/capture.mjs --project harness-anything --out artifacts/screenshots \
//     --page 总览 --page 会话 --click "已成功" --scroll-to "会话事实"
// --click / --scroll-to 归属于它前面最近的一个 --page:先按出现顺序点击,再按出现顺序滚动,
// 然后等读面就绪再截图。找不到项目(精确匹配,不退回第一个)或导航文字即失败退出。
// --scroll-to 按「标题优先」梯度解析:标题精确 → 文字精确 → 标题包含 → 文字包含,命中后把目标
// 对齐到滚动口顶部。只按包含匹配取第一个可见节点会把页头说明里的同一个词当成节标题
// (2026-10-23 CEO 验收 #3924 时「在干活」命中页头副标题「显示此刻正在干活的会话」,三张分节
// 截图全是页顶)。
// 需要点「第几个/哪一个」的确定性入口用 --testid-click <testid>[::<内部 CSS>]:验收证据要
// 重复复现同一条会话,按可见文字点会被截断文案或同名行带偏(2026-10-22 两次点到别行)。
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startGuiDriver } from "./driver.mjs";
import { openProject, navLocator } from "./capture-nav.mjs";
import { resolveScrollTarget, scrollTargetToTop } from "./capture-scroll.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..", "..");
// 单页 6s 与项目切换等待同源;可用 --settle-ms 覆盖单页等待。
const DEFAULT_PAGE_SETTLE_MS = 6_000;

function usage(error) {
  console.error(
    `${error ? `error: ${error}\n` : ""}usage: node tools/gui-e2e/capture.mjs --project <name> [--out <dir>]
  --page <侧栏导航文字> [--click <文字>]... [--scroll-to <文字>]...   (可重复多页)
options:
  --project <name>    快速切换面板里的项目显示名,精确匹配;必须是 canonical 项目
  --show             显式展示窗口(仅用户要求现场演示时使用)
  --out <dir>         截图输出目录(默认 artifacts/screenshots)
  --page <nav>        侧栏导航按钮文字;--click/--scroll-to 作用于它前面最近的 --page
  --click <text>      截图前点击页面内该文字(第一个可见匹配)
  --testid-click <t>  截图前点击 data-testid=<t> 的元素;<t>::<css> 点它内部的选择器
  --scroll-to <text>  截图前把该文字滚到视口顶部:标题精确 → 文字精确 → 标题包含 → 文字包含,
                      取第一个有可见匹配的层级(节标题优先于页头说明里的同词)
  --settle-ms <n>     每页截图前的等待毫秒数(默认 6000)
  --window-size WxH   窗口尺寸(默认 1440x900);改前改后对比须同尺寸`,
  );
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    project: null,
    out: "artifacts/screenshots",
    pages: [],
    show: false,
    settleMs: DEFAULT_PAGE_SETTLE_MS,
    windowSize: { width: 1440, height: 900 },
    theme: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === "--project") options.project = value();
    else if (arg === "--show") options.show = true;
    else if (arg === "--out") options.out = value();
    else if (arg === "--settle-ms") options.settleMs = Number(value());
    else if (arg === "--theme") {
      // 亮/暗成对截图(验收协议):写进本次运行自有的临时 profile,不动任何台账。
      const theme = value();
      if (theme !== "dark" && theme !== "light") throw new Error("--theme 只接受 dark|light");
      options.theme = theme;
    } else if (arg === "--window-size") {
      const match = /^(\d+)x(\d+)$/u.exec(value() ?? "");
      if (!match) throw new Error("--window-size 需要 WxH 形式,如 2000x1200");
      options.windowSize = { width: Number(match[1]), height: Number(match[2]) };
    } else if (arg === "--page")
      options.pages.push({ nav: value(), clicks: [], scrolls: [], testids: [], matches: [] });
    else if (arg === "--testid-click") {
      const page = options.pages.at(-1);
      if (!page) throw new Error(`${arg} 必须跟在某个 --page 之后`);
      page.testids.push(value());
    } else if (arg === "--click") {
      const page = options.pages.at(-1);
      if (!page) throw new Error(`${arg} 必须跟在某个 --page 之后`);
      page.clicks.push(value());
    } else if (arg === "--scroll-to") {
      const page = options.pages.at(-1);
      if (!page) throw new Error(`${arg} 必须跟在某个 --page 之后`);
      page.scrolls.push(value());
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!options.project) throw new Error("缺少 --project");
  if (options.pages.length === 0) throw new Error("至少需要一个 --page");
  if (!Number.isInteger(options.settleMs) || options.settleMs < 0) throw new Error("--settle-ms 需要非负整数");
  for (const page of options.pages) if (!page.nav) throw new Error("--page 需要导航文字");
  return options;
}

function fileNameFor(nav, used) {
  const base = nav.replace(/[/\\?%*:|"<>\u0000-\u001f]/gu, "_") || "page";
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}-${suffix}`;
  used.add(name);
  return `${name}.png`;
}

async function startViteRenderer(port) {
  // 主进程从 packages/gui/dist-electron/ 加载 preload;worktree 里没有这份产物时 renderer 无桥,
  // 窗口停在「Daemon 尚未就绪」。renderer 走 dev server,所以只补 preload 这一份构建
  // (调用方式与 tools/e2e-probe.mjs 的 prepareE2EProbeGui 相同,~0.3s)。
  execFileSync(
    process.execPath,
    [path.join(workspaceRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.preload.config.ts"],
    { cwd: path.join(workspaceRoot, "packages", "gui"), stdio: "pipe" },
  );
  const vite = spawn(
    process.execPath,
    [
      path.join(workspaceRoot, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: path.join(workspaceRoot, "packages", "gui"), stdio: "ignore" },
  );
  // 就绪轮询有界(200 × 100ms),连接被拒只表示还在启动;预算耗尽即失败,不静默继续。
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${port}`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return vite;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  vite.kill();
  throw new Error(`Vite dev renderer 在 127.0.0.1:${port} 上 20 秒内未就绪`);
}

async function capturePage(driver, entry, filePath, settleMs) {
  const { page } = driver;
  await (await navLocator(page, entry.nav)).click();
  for (const click of entry.clicks) {
    const target = page.getByText(click).filter({ visible: true }).first();
    await target.click({ timeout: 10_000 });
  }
  for (const spec of entry.testids) {
    // `testid::selector` = 先定位 data-testid,再点它内部的选择器(如 details 的 summary)。
    const [testId, inner] = spec.split("::");
    const root = page.getByTestId(testId);
    const target = inner === undefined ? root : root.locator(inner).first();
    await target.click({ timeout: 10_000 });
  }
  for (const scroll of entry.scrolls) {
    // 滚不到 = 截图里不会有要验收的区域,按失败处理而不是静默跳过。
    const resolved = await resolveScrollTarget(page, scroll);
    const alignment = await scrollTargetToTop(resolved.locator);
    // 到不了口顶 = 这一节上方已滚到底(文档剩余高度不够),画面顶部仍是本节内容,不是工具没滚;
    // 记进 matches 让日志与验收一眼能分辨。
    entry.matches.push({ text: scroll, tier: resolved.tier, matches: resolved.matches, ...alignment });
  }
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: filePath });
  const heading = page.locator("h1").filter({ visible: true }).first();
  const title = (await heading.count()) > 0 ? ((await heading.textContent()) ?? "").trim() : null;
  return title || `(页面无 h1,按侧栏导航「${entry.nav}」核对)`;
}

async function main(argv) {
  const options = parseArgs(argv);
  const outDir = path.resolve(options.out);
  mkdirSync(outDir, { recursive: true });
  const port = 5300 + (process.pid % 200);
  const vite = await startViteRenderer(port);
  // 窗口状态证据与 profile 一样是本次运行自有的临时物,收尾时一并移除,不在产物目录留垃圾。
  const runRoot = mkdtempSync(path.join(tmpdir(), "gui-capture-"));
  let driver;
  try {
    driver = await startGuiDriver({
      workspaceRoot,
      rootDir: workspaceRoot,
      env: { ...process.env, ELECTRON_RENDERER_URL: `http://127.0.0.1:${port}` },
      runRoot,
      headless: !options.show,
    });
  } catch (error) {
    rmSync(runRoot, { recursive: true, force: true });
    vite.kill();
    throw error;
  }
  const { page, app } = driver;
  const usedNames = new Set();
  try {
    // setSize 的回调在 Electron 主进程里求值,取不到 Node 侧闭包,尺寸经第二参传入。
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(size.width, size.height);
    }, options.windowSize);
    await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
    if (options.theme !== null) {
      // 渲染层在装载时读 localStorage 的 harness-theme;写入后重载一次让它生效。
      await page.evaluate((mode) => globalThis.localStorage.setItem("harness-theme", mode), options.theme);
      await page.reload();
      await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
    }
    const project = await openProject(driver, options.project);
    if (project !== options.project) {
      throw new Error(`切换后侧栏显示的项目是「${project}」,不是「${options.project}」`);
    }
    for (const entry of options.pages) {
      const filePath = path.join(outDir, fileNameFor(entry.nav, usedNames));
      const title = await capturePage(driver, entry, filePath, options.settleMs);
      // 滚动命中层级与对齐结果写进日志:验收时「这一张是从哪个标题开始的、为什么没到口顶」
      // 不该靠猜。
      const scrolled =
        entry.matches.length === 0
          ? ""
          : ` | scroll=${entry.matches
              .map(
                ({ text, tier, matches, gapPx, atMaxScroll }) =>
                  `${text}@${tier}(${matches})${gapPx === 0 ? "" : ` gap=${gapPx}px${atMaxScroll ? " at-max-scroll" : ""}`}`,
              )
              .join(",")}`;
      console.log(`[capture] ${entry.nav} -> ${filePath} | project=${project} | title=${title}${scrolled}`);
    }
    console.log(`[capture] done: ${options.pages.length} 页,输出目录 ${outDir},project=${project}`);
    if (driver.consoleFailures.length > 0) {
      console.error(
        `[capture] renderer console errors(不阻断截图,验收时人工判断):\n${driver.consoleFailures.join("\n")}`,
      );
    }
  } catch (error) {
    if (driver.consoleFailures.length > 0) {
      console.error(`[capture] renderer console errors(失败现场):\n${driver.consoleFailures.join("\n")}`);
    }
    throw error;
  } finally {
    await driver.close?.().catch(() => {});
    await app.close().catch(() => {});
    rmSync(runRoot, { recursive: true, force: true });
    vite.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    usage(error instanceof Error ? error.message : String(error));
  });
}
