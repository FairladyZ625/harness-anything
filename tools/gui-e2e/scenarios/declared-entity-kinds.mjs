import assert from "node:assert/strict";
import { createServer } from "node:http";

// 声明 kind 在读面上的名字是稳定身份 entity-kind/KND-…,不再带任何版本段。安装种子里的
// 两个 kind 的 kindId 是提交过的常量(packages/preset/assets/software-coding/vertical.json)。
const ADR_KIND = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94";
const ISSUE_KIND = "entity-kind/KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05";
const LOCATOR = "docs/adr/ADR-0001-declared-entity-probe.md";

/**
 * 声明出来的实体种类在 GUI 上可见、可建、可打开、可筛选——而且**不靠 GUI 里的任何清单**。
 *
 * 主线是一个**任意新 kind 的完整生命周期**(不是翻动安装种子里的 Research/ADR 开关):
 * GUI 创建(身份与 v1 属性版本由中心铸造,fence 0)→ 建实例 → 只改显示名(ref 不变)→
 * 发布属性版本 v2(v1 只读保留)→ v1 期建的实例照常打开(pinned-existing read)→ v2 下再建
 * 实例 → 停用(灰显、不可再建)。种子里的 ADR/external-issue 两种 kind 补充两种 locator
 * 形态的实建与图筛选覆盖:ADR 走 repository-path(仓内 Markdown);external-issue 的
 * locator 是 url——daemon 的 url 解析器会真的 HTTP GET,所以场景在本机起一个一次性
 * HTTP 服务来当「外部系统」。全程不改 GUI 源码;若哪个面必须改代码才出现,那是缺口。
 */
export default {
  id: "declared-entity-kinds",
  feature: "entities",
  lane: "isolated",
  description:
    "A GUI-declared arbitrary kind completes create, instance, rename, schema v2 publish, pinned-existing read and archive; seed kinds (repository-path ADR and url external-issue) cover both locator shapes end to end.",
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

      // ── 主线:任意新 kind 的完整生命周期。身份由中心铸造,所以卡片按显示文本定位。──
      await page.getByTestId("new-vertical-kind").click();
      const kindForm = page.getByTestId("vertical-kind-form");
      await kindForm.waitFor();
      await kindForm.getByLabel("id").fill("runbook");
      await kindForm.getByLabel("idPrefix").fill("RUN");
      await kindForm.getByLabel("display.singular").fill("Runbook");
      await kindForm.getByLabel("display.plural").fill("Runbooks");
      await kindForm.getByLabel("store.pathTemplate").fill("entities/runbooks/{id}.json");
      await kindForm.getByRole("button", { name: "保存" }).click();

      const runbookCard = page.locator('[data-testid^="entity-doc-card-entity-kind/"]', { hasText: "Runbook:" });
      await runbookCard.waitFor();
      await runbookCard.click();
      await page.getByTestId("entity-declaration-facets").waitFor();

      // 1. v1 期建一个实例:发布 v2 之前的存量,之后必须照常可读(pinned-existing)。
      await page.getByTestId("governed-entity-new").click();
      await page.getByTestId("new-governed-entity-locator").fill(LOCATOR);
      await page.getByTestId("new-governed-entity-title").fill("Runbook · GUI CRUD probe");
      await page.getByTestId("new-governed-entity-submit").click();
      await page.getByText("Runbook · GUI CRUD probe").waitFor();

      // 2. 只改显示名:ref/身份不动,保存后 facets 呈新名。
      await page.getByRole("button", { name: "编辑种类" }).click();
      await page.getByLabel("display.singular").fill("Operations Runbook");
      await page.getByRole("button", { name: "保存" }).click();
      const facets = page.getByTestId("entity-declaration-facets");
      await facets.getByText("Operations Runbook").waitFor();

      // 3. 发布属性版本 v2:已发布正文只读在场,新版本不重写 v1;facets 的版本清单变 v1, v2。
      await page.getByRole("button", { name: "发布属性版本" }).click();
      const schemaForm = page.getByTestId("vertical-kind-schema-form");
      await schemaForm.waitFor();
      assert.match(await schemaForm.innerText(), /已发布版本/u, "published v1 bodies must stay visible read-only");
      await page.getByLabel("attributes JSON").fill('{"owner":{"type":"string"},"reviewed":{"type":"boolean"}}');
      await schemaForm.getByRole("button", { name: "发布 v2" }).click();
      await facets.getByText("v1, v2").waitFor();

      // 4. pinned-existing read:v1 期建的实例在 v2 发布后照常打开并渲染正文。
      await page.getByRole("button", { name: "Runbook · GUI CRUD probe" }).click();
      const markdown = page.getByTestId("entity-locator-markdown");
      await markdown.waitFor();
      assert.match(await markdown.innerText(), /声明实体探针/u);

      // 5. v2 下再建一个实例(新实例默认用最新版本;属性全部可选,无属性也可建)。
      await page.getByTestId("governed-entity-new").click();
      await page.getByTestId("new-governed-entity-locator").fill("docs/adr/ADR-0001-declared-entity-probe.md");
      await page.getByTestId("new-governed-entity-title").fill("Runbook · v2 probe");
      await page.getByTestId("new-governed-entity-submit").click();
      await page.getByText("Runbook · v2 probe").waitFor();

      // 6. 停用:已有材料仍可管理,但不再允许新建;目录卡片灰显。
      await page.getByRole("button", { name: "停用种类" }).click();
      await page.getByLabel("停用原因").fill("E2E lifecycle complete");
      await page.getByRole("button", { name: "确认停用" }).click();
      await page.getByTestId("governed-entity-new").waitFor({ state: "detached" });
      await page
        .getByRole("button", { name: /返回上一级|Back to previous/u })
        .first()
        .click();
      await page.getByTestId("entities-content").waitFor();
      const retiredCard = page.locator('[data-testid^="entity-doc-card-entity-kind/"]', {
        hasText: "Operations Runbook:",
      });
      await retiredCard.waitFor();
      assert.match(await retiredCard.innerText(), /已停用/u);
      assert.ok((await retiredCard.getAttribute("class")).includes("grayscale"), "retired kind card must be gray");

      // ── 种子 kind 的补充覆盖:两种 locator 形态的实建、渲染与图筛选。──
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
      const adrMarkdown = page.getByTestId("entity-locator-markdown");
      await adrMarkdown.waitFor();
      assert.match(await adrMarkdown.innerText(), /声明实体探针/u);

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

      // 9. 领地筛选按 kind 生效:种子 kind 的类型 chip 都由读面派生,标签取声明显示名;
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
