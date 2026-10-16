// capture.mjs 与 capture-element.mjs 共用的取景前置:快速切换面板选项目、侧栏导航定位。
// 只做只读导航;项目切换后的读面没有跨页统一就绪信号,15s 是 CEO 手写脚本三次验证过的
// 等待量(task_1ef433fd / task_560ddd7e)。
const PROJECT_SETTLE_MS = 15_000;
// 切换按钮的可访问名来自它的内容(项目名),title 属性才是稳定的定位点。
export const SWITCHER_TITLE = /快速切换项目|Quickly switch projects/u;

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function openProject(driver, project) {
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

export async function navLocator(page, nav) {
  const sidebar = page.getByTestId("app-sidebar-scroll");
  const exact = sidebar.getByRole("button", { name: nav, exact: true });
  if ((await exact.count()) > 0) return exact.first();
  // 正则直接用(双语 locale 的稳定定位,如 /^(?:总览|Overview)$/u);字符串退化为包含匹配。
  const fuzzy = sidebar.getByRole("button", {
    name: typeof nav === "string" ? new RegExp(escapeRegExp(nav), "u") : nav,
  });
  if ((await fuzzy.count()) > 0) return fuzzy.last();
  const available = (
    await sidebar.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.textContent.trim()))
  ).filter(Boolean);
  throw new Error(`侧栏导航里没有「${nav}」。可用导航: ${[...new Set(available)].join("、")}`);
}
