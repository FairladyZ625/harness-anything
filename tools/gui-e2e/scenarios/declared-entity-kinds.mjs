import assert from "node:assert/strict";

const ADR_KIND = "software/coding/architecture-decision-record@1";
const LOCATOR = "docs/adr/ADR-0001-declared-entity-probe.md";

/**
 * 声明出来的实体种类在 GUI 上可见、可建、可打开、可筛选——而且**不靠 GUI 里的任何清单**。
 *
 * 本仓 vertical 声明了 architecture-decision-record。这条用例走完整一圈:说明面自己长出
 * 「声明实体」一组 → 在 GUI 上按 import 动作合同派生的表单新建一个(与 CLI 同一条写路)
 * → 新实体出现在列表 → 点开落到既有 Markdown 渲染器 → 领地筛选面板出现同一个 kind 的
 * 类型 chip,标签是声明里的显示名。
 */
export default {
  id: "declared-entity-kinds",
  feature: "entities",
  lane: "isolated",
  description: "A vertical-declared kind reaches the docs page, is creatable via entity import, renders, and filters.",
  async run({ page }) {
    await page.getByRole("button", { name: /实体说明|Entities/u }).click();
    await page.getByTestId("entities-content").waitFor();

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

    // 6. 领地筛选按 kind 生效:类型 chip 由读面派生,标签取声明里的显示名。
    await page
      .getByRole("button", { name: /关系图|Relation Graph/u })
      .first()
      .click();
    await page
      .getByRole("button", { name: /筛选|Filters/u })
      .first()
      .click();
    const typeChip = page.getByTestId(`graph-filter-entity-type-${ADR_KIND}`);
    await typeChip.waitFor();
    assert.equal(await typeChip.innerText(), "Architecture Decision Record");
  },
};
