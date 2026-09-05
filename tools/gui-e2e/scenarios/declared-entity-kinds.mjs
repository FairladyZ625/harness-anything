import assert from "node:assert/strict";
import { createServer } from "node:http";

const ADR_KIND = "software/coding/architecture-decision-record@1";
const LOCATOR = "docs/adr/ADR-0001-declared-entity-probe.md";
/** W2-C(#2217)声明的第二种 kind:locatorKinds 是 url/external-key,正文不在仓里。 */
const ISSUE_KIND = "software/coding/external-issue@1";
const RUNBOOK_KIND = "software/coding/runbook@1";

/**
 * 声明出来的实体种类在 GUI 上可见、可建、可打开、可筛选——而且**不靠 GUI 里的任何清单**。
 *
 * 本仓 vertical 声明了 architecture-decision-record 与 external-issue 两种。这条用例对
 * 两种各走完整一圈:说明面自己长出「声明实体」一组 → 在 GUI 上按 import 动作合同派生的
 * 表单新建一个(与 CLI 同一条写路)→ 新实体出现在列表 → 点开落到既有渲染器 → 领地
 * 筛选面板出现同一个 kind 的类型 chip,标签是声明里的显示名。
 *
 * 两种 locator 形状都覆盖:ADR 走 repository-path(仓内 Markdown,既有断言);external-issue
 * 的 locator 是 url——daemon 的 url 解析器会真的 HTTP GET,所以场景在本机起一个一次性
 * HTTP 服务来当「外部系统」,拿到的是真实响应正文,不是 mock 页面。全程不改 GUI 源码
 * (W2-0 #2215 的自适应能力);若哪个面必须改代码才出现,那是 W2-0 的缺口,不是本场景的事。
 */
export default {
  id: "declared-entity-kinds",
  feature: "entities",
  lane: "isolated",
  description:
    "Vertical-declared kinds (repository-path ADR and url external-issue) reach the docs page, are creatable via entity import, render, and reach the graph filter and territory nodes.",
  async run({ page }) {
    // 外部系统替身:external-issue 的 url locator 由 daemon 真实 GET。
    const served = await new Promise((resolve) => {
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          `${JSON.stringify(
            {
              schema: "external-issue-probe/v1",
              number: 2224,
              title: "Resident daemon log panel on the System tab",
              state: "closed",
            },
            null,
            2,
          )}\n`,
        );
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    try {
      const issueUrl = `http://127.0.0.1:${served.address().port}/issues/2224`;

      await page.getByRole("button", { name: /^实体$|Entities/u }).click();
      await page.getByTestId("entities-content").waitFor();

      // 配置面闭环:新建 kind → 用新 kind 建实例 → 停用 kind → 卡片灰显且不再允许新建实例。
      await page.getByTestId("new-vertical-kind").click();
      const kindForm = page.getByTestId("vertical-kind-form");
      await kindForm.waitFor();
      await kindForm.getByLabel("id").fill("runbook");
      await kindForm.getByLabel("idPrefix").fill("RUN");
      await kindForm.getByLabel("display.singular").fill("Runbook");
      await kindForm.getByLabel("display.plural").fill("Runbooks");
      await kindForm.getByLabel("store.pathTemplate").fill("entities/runbooks/{id}.json");
      await kindForm.getByRole("button", { name: "保存" }).click();
      const runbookCard = page.getByTestId(`entity-doc-card-${RUNBOOK_KIND}`);
      await runbookCard.waitFor();
      await runbookCard.click();
      await page.getByTestId("governed-entity-new").click();
      await page.getByTestId("new-governed-entity-locator").fill(LOCATOR);
      await page.getByTestId("new-governed-entity-title").fill("Runbook · GUI CRUD probe");
      await page.getByTestId("new-governed-entity-submit").click();
      await page.getByText("Runbook · GUI CRUD probe").waitFor();
      await page.getByRole("button", { name: "停用种类" }).click();
      await page.getByLabel("停用原因").fill("E2E lifecycle complete");
      await page.getByRole("button", { name: "确认停用" }).click();
      await page
        .getByRole("button", { name: /返回上一级|Back to previous/u })
        .first()
        .click();
      await page.getByTestId("entities-content").waitFor();
      await runbookCard.waitFor();
      assert.match(await runbookCard.innerText(), /已停用/u);
      assert.ok((await runbookCard.getAttribute("class")).includes("grayscale"), "retired kind card must be gray");

      // 1. 说明面按声明长出「声明实体」一组——GUI 没有这份清单,它来自读面。
      await page.getByTestId("entity-doc-group-declared").waitFor();
      const adrCard = page.getByTestId(`entity-doc-card-${ADR_KIND}`);
      await adrCard.waitFor();
      await adrCard.click();

      // 2. 声明的可配置项只读呈现;实体列表初始是真实空态,不预填示例。
      await page.getByTestId("entity-declaration-facets").waitFor();
      await page.getByTestId("governed-entity-empty").waitFor();

      // 3. 新建走 entity import:表单字段由 import 动作合同派生,只有 locator 与 title。
      await page.getByTestId("governed-entity-new").click();
      await page.getByTestId("new-governed-entity-form").waitFor();
      await page.getByTestId("new-governed-entity-locator").fill(LOCATOR);
      await page.getByTestId("new-governed-entity-title").fill("ADR-0001 · 声明实体探针");
      await page.getByTestId("new-governed-entity-submit").click();

      // 4. 建立之后可见:实体行来自账本投影,不是表单的本地回声。
      const list = page.getByTestId("governed-entity-list");
      await list.waitFor();
      const rows = list.getByRole("button");
      assert.ok((await rows.count()) > 0, "the imported entity must appear in the ledger-backed list");

      // 5. 点击即渲染:locator 指向 Markdown → 既有 Markdown 渲染器。
      await rows.first().click();
      const markdown = page.getByTestId("entity-locator-markdown");
      await markdown.waitFor();
      assert.match(await markdown.innerText(), /声明实体探针/u);

      // 6. 同一行完成 descriptor update → archive。写后列表由失效查询重新读取;
      //    archive 默认隐藏,打开「显示已归档」后以灰显行保留审计可见性。
      await list.getByRole("button", { name: "编辑" }).click();
      await list.getByLabel("title").fill("ADR-0001 · 已更新");
      await list.getByLabel("repository-path locator").fill(LOCATOR);
      await list.getByLabel("content version").fill("revision:gui-e2e-2");
      await list.getByRole("button", { name: "保存" }).click();
      await list.getByText("ADR-0001 · 已更新").waitFor();
      await list.getByRole("button", { name: "归档" }).click();
      await list.getByLabel("archive reason").fill("E2E lifecycle complete");
      await list.getByRole("button", { name: "确认归档" }).click();
      await page.getByLabel("显示已归档").check();
      await list.getByText("ADR-0001 · 已更新").waitFor();

      // 7. 第二种声明 kind:external-issue(url locator)不改 GUI 就出现在同一目录里。
      await page
        .getByRole("button", { name: /返回上一级|Back to previous/u })
        .first()
        .click();
      await page.getByTestId("entities-content").waitFor();
      const issueCard = page.getByTestId(`entity-doc-card-${ISSUE_KIND}`);
      await issueCard.waitFor();
      await issueCard.click();
      await page.getByTestId(`entity-doc-detail-${ISSUE_KIND}`).waitFor();
      await page.getByTestId("entity-declaration-facets").waitFor();
      await page.getByTestId("governed-entity-empty").waitFor();

      // 8. url locator 的新建:表单出现 locator 类型选择(声明给了 url/external-key),
      //    locator 字符串按 http(s) 前缀推断为 url kind,daemon 真实 GET 一次性 HTTP 服务。
      await page.getByTestId("governed-entity-new").click();
      await page.getByTestId("new-governed-entity-form").waitFor();
      await page.getByTestId("new-governed-entity-locator-kind").waitFor();
      await page.getByTestId("new-governed-entity-locator").fill(issueUrl);
      await page.getByTestId("new-governed-entity-title").fill("Issue 2224 · external probe");
      await page.getByTestId("new-governed-entity-submit").click();
      const issueRows = list.getByRole("button");
      await issueRows.first().waitFor();
      const issueRowText = await issueRows.first().innerText();
      assert.match(issueRowText, /issues\/2224/u, "the external-issue row must show its url locator");

      // 9. 领地筛选按 kind 生效:两个声明 kind 的类型 chip 都由读面派生,标签取声明显示名;
      //    图节点层:每种声明 kind 一块领地,chip 的 navRef 是 <kind>/<entityId>。
      await page
        .getByRole("button", { name: /关系图|Relation Graph/u })
        .first()
        .click();
      await page
        .getByRole("button", { name: /筛选|Filters/u })
        .first()
        .click();
      const adrChip = page.getByTestId(`graph-filter-entity-type-${ADR_KIND}`);
      await adrChip.waitFor();
      assert.equal(await adrChip.innerText(), "Architecture Decision Record");
      const issueChip = page.getByTestId(`graph-filter-entity-type-${ISSUE_KIND}`);
      await issueChip.waitFor();
      assert.equal(await issueChip.innerText(), "External Issue");
      // 重点模式(默认)会把焦点邻域外的 chip 折进「重点外 N 项」;切「全部」后领地才平铺。
      await page.getByTestId("graph-density-all").click();
      const issueNode = page.locator(`[data-testid="territory-chip"][data-nav-ref^="${ISSUE_KIND}/"]`);
      await issueNode.waitFor();
    } finally {
      await new Promise((resolve) => served.close(resolve));
    }
  },
};
