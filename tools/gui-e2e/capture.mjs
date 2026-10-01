#!/usr/bin/env node

// GUI 验收截图的固定入口:真实 Electron 窗口 + Vite dev renderer + canonical daemon 数据,只读。
// worker 只需要说「哪个项目、哪些页面、拍之前点什么」,不再各写一份临时抓屏脚本
// (2026-10-01 三件任务的截图拍在快速切换排第一的项目上,worker 看不了 PNG 发现不了)。
// 用法:
//   node tools/gui-e2e/capture.mjs --project harness-anything --out artifacts/screenshots \
//     --page 总览 --page 会话 --click "已成功" --scroll-to "会话事实"
// --click / --scroll-to 归属于它前面最近的一个 --page:先按出现顺序点击,再按出现顺序滚动,
// 然后等读面就绪再截图。找不到项目(精确匹配,不退回第一个)或导航文字即失败退出。
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startGuiDriver } from "./driver.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..", "..");
// 项目切换后的 canonical 读面没有跨页面统一的就绪信号,15s 是 CEO 手写脚本三次验证过的
// 等待量(task_1ef433fd / task_560ddd7e);单页 6s 同源。可用 --settle-ms 覆盖单页等待。
const PROJECT_SETTLE_MS = 15_000;
const DEFAULT_PAGE_SETTLE_MS = 6_000;
// 切换按钮的可访问名来自它的内容(项目名),title 属性才是稳定的定位点。
const SWITCHER_TITLE = /快速切换项目|Quickly switch projects/u;

function usage(error) {
  console.error(
    `${error ? `error: ${error}\n` : ""}usage: node tools/gui-e2e/capture.mjs --project <name> [--out <dir>]
  --page <侧栏导航文字> [--click <文字>]... [--scroll-to <文字>]...   (可重复多页)
options:
  --project <name>    快速切换面板里的项目显示名,精确匹配;必须是 canonical 项目
  --out <dir>         截图输出目录(默认 artifacts/screenshots)
  --page <nav>        侧栏导航按钮文字;--click/--scroll-to 作用于它前面最近的 --page
  --click <text>      截图前点击页面内该文字(第一个可见匹配)
  --scroll-to <text>  截图前把该文字滚入视口(第一个匹配)
  --settle-ms <n>     每页截图前的等待毫秒数(默认 6000)`,
  );
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { project: null, out: "artifacts/screenshots", pages: [], settleMs: DEFAULT_PAGE_SETTLE_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === "--project") options.project = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--settle-ms") options.settleMs = Number(value());
    else if (arg === "--page") options.pages.push({ nav: value(), clicks: [], scrolls: [] });
    else if (arg === "--click") {
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

async function openProject(driver, project) {
  const { page } = driver;
  const switcher = page.getByTitle(SWITCHER_TITLE);
  await switcher.click();
  const panel = page.getByTestId("quick-switcher-panel");
  await panel.waitFor({ timeout: 5_000 });
  // 项目条目的显示名在 span.font-semibold 里;对显示名做精确匹配,杜绝「退回第一个项目」。
  const entries = panel.locator("button span.font-semibold");
  const names = (await entries.evaluateAll((spans) => spans.map((span) => span.textContent.trim()))).filter(Boolean);
  const match = names.findIndex((name) => name === project);
  if (match === -1) {
    throw new Error(
      `快速切换面板里没有项目「${project}」。可用项目: ${names.length ? names.join("、") : "(面板为空)"}`,
    );
  }
  await entries.nth(match).click();
  await switcher.getByText(project, { exact: true }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(PROJECT_SETTLE_MS);
  return (await switcher.locator("span.truncate").first().textContent())?.trim() ?? "";
}

async function navLocator(page, nav) {
  const sidebar = page.getByTestId("app-sidebar-scroll");
  const exact = sidebar.getByRole("button", { name: nav, exact: true });
  if ((await exact.count()) > 0) return exact.first();
  const fuzzy = sidebar.getByRole("button", { name: new RegExp(escapeRegExp(nav), "u") });
  if ((await fuzzy.count()) > 0) return fuzzy.last();
  const available = (
    await sidebar.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.textContent.trim()))
  ).filter(Boolean);
  throw new Error(`侧栏导航里没有「${nav}」。可用导航: ${[...new Set(available)].join("、")}`);
}

async function capturePage(driver, entry, filePath, settleMs) {
  const { page } = driver;
  await (await navLocator(page, entry.nav)).click();
  for (const click of entry.clicks) {
    const target = page.getByText(click).filter({ visible: true }).first();
    await target.click({ timeout: 10_000 });
  }
  for (const scroll of entry.scrolls) {
    // 滚不到 = 截图里不会有要验收的区域,按失败处理而不是静默跳过。
    await page.getByText(scroll).filter({ visible: true }).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
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
  let driver;
  try {
    driver = await startGuiDriver({
      workspaceRoot,
      rootDir: workspaceRoot,
      env: { ...process.env, ELECTRON_RENDERER_URL: `http://127.0.0.1:${port}` },
      runRoot: mkdtempSync(path.join(tmpdir(), "gui-capture-")),
      headless: false,
    });
  } catch (error) {
    vite.kill();
    throw error;
  }
  const { page, app } = driver;
  const usedNames = new Set();
  try {
    // setSize 的回调在 Electron 主进程里求值,取不到模块常量,尺寸用字面量(与 CEO 脚本一致)。
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1440, 900);
    });
    await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
    const project = await openProject(driver, options.project);
    if (project !== options.project) {
      throw new Error(`切换后侧栏显示的项目是「${project}」,不是「${options.project}」`);
    }
    for (const entry of options.pages) {
      const filePath = path.join(outDir, fileNameFor(entry.nav, usedNames));
      const title = await capturePage(driver, entry, filePath, options.settleMs);
      console.log(`[capture] ${entry.nav} -> ${filePath} | project=${project} | title=${title}`);
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
    vite.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    usage(error instanceof Error ? error.message : String(error));
  });
}
