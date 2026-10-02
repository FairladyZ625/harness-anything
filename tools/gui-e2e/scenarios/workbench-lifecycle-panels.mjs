import assert from "node:assert/strict";
import { createServer } from "node:http";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady } from "./helpers.mjs";

/**
 * 生命周期面板(终端/浏览器,task_d87e6982658ceccc5f26c80f30)的资源语义验收:
 *
 * 终端面板 = 终端页同一接线面:面板内真实 spawn 一个隔离会话、敲入命令并读到输出;
 * 关闭面板 = 离开终端页(停流 + detach),daemon 侧会话存活;重开面板经存档布局
 * 自动重附**同一个**会话(attach from seq 0 重放出历史输出),全程不产生第二个
 * 会话资源。会话身份直接读 attach 列表的 data-session-id,不以「有终端在跑」顶替。
 *
 * 浏览器面板 = 应用内浏览器页同一功能体:地址栏输入本地测试页地址真实导航,内容
 * 在 guest WebContents 里核对(getTitle);关闭面板销毁该 webview(guest 清零),
 * 重开是全新实例,再导航到第二页成功——不残留、不重复。
 */
const BODY = "[data-testid='floating-panel-body']";
const CATALOG_ENTRY = (id) => `[data-testid='panel-catalog-entry-${id}']`;

async function ensureCatalogOpen(page) {
  const open = await page.getByTestId("panel-catalog-list").isVisible();
  if (!open) await page.getByTestId("panel-catalog-button").click();
  await page.getByTestId("panel-catalog-list").waitFor();
}

async function addPanel(page, id) {
  await ensureCatalogOpen(page);
  await page.locator(CATALOG_ENTRY(id)).click();
}

async function waitForPanelBody(page, panelId, bodySelector) {
  await page.locator(`${BODY}[data-panel-id='${panelId}'] ${bodySelector}`).first().waitFor();
}

function panelWindow(page, panelId) {
  return page.locator(".dv-resize-container").filter({ has: page.locator(`${BODY}[data-panel-id='${panelId}']`) });
}

async function closePanel(page, panelId) {
  await panelWindow(page, panelId).locator(".dv-floating-titlebar").click();
  await panelWindow(page, panelId).locator("[data-testid='floating-panel-close']").first().click();
  await page.locator(`${BODY}[data-panel-id='${panelId}']`).waitFor({ state: "detached" });
}

/** 会话表里等一行「输出行 = marker」:比 getByText 更稳(xterm 可能把一行拆成
 * 多个 span),也比 textContent.includes 更严——回显行带引号,整行相等只认输出。 */
async function waitForTerminalRow(page, needle) {
  await page.waitForFunction((marker) => {
    const region = globalThis.document.querySelector("[data-testid='terminal-pane-region']");
    if (region === null) return false;
    return [...region.querySelectorAll(".xterm-rows > div")].some((row) => (row.textContent ?? "").trim() === marker);
  }, needle);
}

/** daemon 侧会话表(repo.terminal.sessions.list,只带 repo 作用域):面板外的资源事实。 */
async function terminalSessions(fixture) {
  const read = await requestDaemonJsonRpcAt(
    fixture.endpoint,
    "repo.terminal.sessions.list",
    { repo: { repoId: fixture.repoId } },
    1_000,
    5_000,
  );
  assert.equal(read.ok, true, `terminal session list failed: ${JSON.stringify(read)}`);
  return read.sessions;
}

/** 面板里当前活动 tab 的 pane 区(切 tab 即换 dockview 实例,pane 区只有活动组)。 */
const activePaneRegion = (page) =>
  page.locator(`${BODY}[data-panel-id='terminal'] [data-testid='terminal-pane-region']`);

/** 等待会话表出现新会话并返回它:quick-start 的 spawn 往返完成前的离散条件。 */
async function waitForNewSession(fixture, before) {
  const known = new Set(before.map((row) => row.sessionId));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await terminalSessions(fixture);
    const fresh = rows.filter((row) => !known.has(row.sessionId));
    if (fresh.length > 0) return { session: fresh[0], rows };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("quick-start did not spawn a new terminal session");
}

/** guest WebContents 里按 URL 前缀找浏览器面板的页面;找不到返回 null。 */
async function findBrowserGuest(app, urlPrefix) {
  return app.evaluate(({ webContents }, prefix) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(prefix));
    return guest ? guest.getTitle() : null;
  }, urlPrefix);
}

async function waitForBrowserGuest(app, urlPrefix, expectedTitle) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const title = await findBrowserGuest(app, urlPrefix);
    if (title === expectedTitle) return title;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`browser guest did not load ${urlPrefix} (title ${expectedTitle})`);
}

/** 本地测试页:两页不同标题,导航成功与否以 guest 内容为准,不依赖外网。 */
function startProbeServer() {
  const pages = new Map([
    ["/alpha", "WB Browser Probe Alpha"],
    ["/beta", "WB Browser Probe Beta"],
  ]);
  const server = createServer((request, response) => {
    const title = pages.get(request.url ?? "");
    if (title === undefined) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body><h1>${title}</h1><p id="marker">${title} content</p></body></html>`,
    );
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })),
  );
}

export default {
  id: "workbench-lifecycle-panels",
  feature: "panel-workspace",
  lane: "isolated",
  description:
    "The workbench terminal panel spawns, accepts input, and survives its own close/reopen as the same daemon session (no duplicate resources); the browser panel navigates a local test page through the address bar and destroys its webview on close.",
  async run({ page, app, fixture, shot }) {
    await bridgeReady(page);
    await page.getByRole("button", { name: /^(?:面板工作台|Panel Workbench)$/u }).click();
    await page.locator("[data-testid='floating-panel-grid']").waitFor();
    await page.getByTestId("panel-workbench-reset").click();
    await page.waitForFunction(() => {
      const ids = [...globalThis.document.querySelectorAll("[data-testid='floating-panel-body']")].map(
        (node) => node.dataset.panelId,
      );
      return ids.length === 3 && ["documents", "graph", "timeline"].every((id) => ids.includes(id));
    });

    // —— 终端面板:真实 spawn → 输入 → 关闭(detach)→ 重开(重附同会话)——
    await addPanel(page, "terminal");
    await waitForPanelBody(page, "terminal", "[data-testid='terminal-view']");
    const before = await terminalSessions(fixture);
    // quick-start「新建终端」:面板内 spawn 一个新会话,新 tab 成为活动组。
    await page
      .locator(`${BODY}[data-panel-id='terminal']`)
      .getByLabel(/新建终端|New terminal/u)
      .click();
    const { session } = await waitForNewSession(fixture, before);
    const marker = `WB_TERM_REUSE_${session.sessionId.slice(-6)}`;
    // 新会话的 pane 落在活动组;点中 pane 宿主后敲入命令。echo 自带换行,
    // 输出行整行就是 marker(printf 不带 \n 会把下一个提示符混进同一行);
    // Enter 作为独立按键发出——spawn 刚落定时面板仍在接流重排,混在 type()
    // 串里的换行可能落在焦点切换的瞬间。
    await activePaneRegion(page).locator("[data-pane-id]").first().click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await waitForTerminalRow(page, marker);
    // 会话身份:attach 列表按 data-session-id 列出;已开在 pane 里的禁选但仍带身份。
    await page.getByTestId("terminal-attach").click();
    await page.getByTestId("terminal-attach-list").waitFor();
    const ownRow = page.locator(`[data-testid='terminal-attach-list'] [data-session-id='${session.sessionId}']`);
    await ownRow.waitFor();
    assert.equal(await ownRow.isDisabled(), true, "the open session must be the attached one");
    await page.keyboard.press("Escape");
    await shot("workbench-terminal-panel-live");

    // 关闭面板 = 离开终端页:停流 + detach。daemon 侧会话必须存活。
    await closePanel(page, "terminal");
    const afterClose = await terminalSessions(fixture);
    assert.ok(
      afterClose.some((row) => row.sessionId === session.sessionId),
      "closing the panel must detach, not terminate, the session",
    );

    // 重开面板:存档布局恢复并重附同一会话;attach from seq 0 重放历史输出,
    // 且不产生第二个会话资源(会话表总数不变)。
    await addPanel(page, "terminal");
    await waitForPanelBody(page, "terminal", "[data-testid='terminal-view']");
    await activePaneRegion(page).locator("[data-pane-id]").first().waitFor();
    await waitForTerminalRow(page, marker);
    const afterReopen = await terminalSessions(fixture);
    assert.equal(afterReopen.length, afterClose.length, "reopening the panel must not spawn another session");
    await shot("workbench-terminal-panel-reopened");

    // —— 浏览器面板:地址栏导航本地测试页 → 关闭销毁 webview → 重开新实例 ——
    const { server, port } = await startProbeServer();
    try {
      const base = `http://127.0.0.1:${port}`;
      await addPanel(page, "browser");
      await waitForPanelBody(page, "browser", "[data-testid='browser-view']");
      const address = page.locator(`${BODY}[data-panel-id='browser']`).getByLabel("Address");
      await address.fill(`${base}/alpha`);
      await address.press("Enter");
      await waitForBrowserGuest(app, `${base}/alpha`, "WB Browser Probe Alpha");
      await shot("workbench-browser-panel-navigated");

      // 关闭面板销毁该 webview:guest WebContents 清零,不残留后台页面。
      await closePanel(page, "browser");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const title = await findBrowserGuest(app, base);
        if (title === null) break;
        if (attempt === 19) throw new Error("closing the browser panel must destroy its webview guest");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      // 重开是全新实例:再导航到第二页成功,且同源 guest 只有一个(旧实例未复活)。
      await addPanel(page, "browser");
      await waitForPanelBody(page, "browser", "[data-testid='browser-view']");
      await page.locator(`${BODY}[data-panel-id='browser']`).getByLabel("Address").fill(`${base}/beta`);
      await page.locator(`${BODY}[data-panel-id='browser']`).getByLabel("Address").press("Enter");
      await waitForBrowserGuest(app, `${base}/beta`, "WB Browser Probe Beta");
      const guests = await app.evaluate(({ webContents }, prefix) => {
        return webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(prefix)).length;
      }, base);
      assert.equal(guests, 1, "exactly one browser guest after reopen, the destroyed instance stays dead");
      await shot("workbench-browser-panel-reopened");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // 收尾:重置回默认三块。详情面板的面包屑里有「面板工作台」同名按钮,
    // 不收尾会让后续场景的导航定位违反 strict mode(panel-workbench-catalog 同一收尾)。
    await page.getByTestId("panel-workbench-reset").click();
    await page.waitForFunction(() => {
      const ids = [...globalThis.document.querySelectorAll("[data-testid='floating-panel-body']")].map(
        (node) => node.dataset.panelId,
      );
      return ids.length === 3 && ["documents", "graph", "timeline"].every((id) => ids.includes(id));
    });
  },
};
