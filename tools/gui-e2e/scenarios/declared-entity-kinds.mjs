import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

// 声明 kind 在读面上的名字是稳定身份 entity-kind/KND-…,不再带任何版本段。安装种子里的
// 三个 kind 的 kindId 是提交过的常量(packages/preset/assets/software-coding/vertical.json)。
const ADR_KIND = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94";
const ISSUE_KIND = "entity-kind/KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05";
const RESEARCH_KIND = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16";
// 同一份物理来源,后面会被导进**两个**不同的种类:import 的意图身份含 Kind,所以第二次
// 不再撞上第一次的 operation。
const SHARED_SOURCE = "docs/adr/ADR-0001-declared-entity-probe.md";
const SHARED_SOURCE_DIRECTORY = "docs/adr";

// 本场景自己写进工作副本的素材(不碰 lane 的 fixture 文件):一份会被删掉的来源、一个
// 多文件目录、一份真 PDF。
const PROBE_DIRECTORY = "probe";
const RETIRED_SOURCE = "probe/retired-source.md";
const LIBRARY_DIRECTORY = "probe/library";
// 浏览器的起点由既有实体推出来,而读面列举不了仓根,所以素材都放在能从起点走到的位置。
const PDF_SOURCE = "docs/adr/paper.pdf";

/**
 * v2 属性声明:必填项与 v1 完全不同(v1 一个属性也没有)。v1 期建的实例钉在 v1 上,
 * 发布 v2 之后照常读、照常改;v2 期新建的实例必须把这两个必填项填出来。
 */
const V2_ATTRIBUTES = JSON.stringify({
  region: { type: "string", enum: ["north", "south"], required: true },
  fiscalYear: { type: "integer", required: true },
  reviewed: { type: "boolean" },
});

/**
 * 声明出来的实体种类在 GUI 上可见、可建、可填属性、可读正文——而且**不靠 GUI 里的任何
 * 清单或按 kind 写死的分支**。
 *
 * 主线是一个任意新 Kind 的完整生命周期:GUI 创建 → v1 期建实例 → 删掉它的来源 → 改显示名
 * → 发布 v2 属性(必填项与 v1 不同)→ v1 期实例仍按 v1 读写 → v2 期用通用属性表单建实例
 * → 回头再读 v1 期实例:来源那一屏说不存在,内容那一屏照常给出被接受时收下的字节 → 停用。
 *
 * 种子 kind 补三种形态:ADR 与 Research **导同一份物理来源**(证明 import 意图按 Kind 作用域,
 * 不再互撞);Research 另导一份真 PDF(证明二进制如实呈现,不摆假预览);external-issue 的
 * locator 是 url——daemon 会真的 HTTP GET,所以场景在本机起一个一次性服务当「外部系统」。
 */

/** 一份结构真实的最小 PDF:头部的二进制注释让它不是 UTF-8,读面因此如实判成 binary。 */
function minimalPdfBytes() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R" +
      " /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Length 62 >>\nstream\nBT /F1 12 Tf 20 50 Td (Declared entity probe) Tj ET\nendstream\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const header = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1");
  const offsets = [];
  let body = header;
  for (const object of objects) {
    offsets.push(body.length);
    body = Buffer.concat([body, Buffer.from(object, "latin1")]);
  }
  const startxref = body.length;
  const table =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.concat([body, Buffer.from(table, "latin1")]);
}

/** 本场景自己的素材。写在工作副本里,和用户手放进去的文件没有区别。 */
function writeProbeMaterial(rootDir) {
  mkdirSync(path.join(rootDir, PROBE_DIRECTORY), { recursive: true });
  writeFileSync(
    path.join(rootDir, RETIRED_SOURCE),
    "# 值班手册 · 一号\n\n这份来源在导入之后会被删掉,实体照样读得到它。\n",
  );
  mkdirSync(path.join(rootDir, LIBRARY_DIRECTORY, "chapters"), { recursive: true });
  writeFileSync(path.join(rootDir, LIBRARY_DIRECTORY, "README.md"), "# 手册合集\n\n目录来源的说明页。\n");
  writeFileSync(path.join(rootDir, LIBRARY_DIRECTORY, "chapters", "one.md"), "# 第一章\n\n子目录里的第一篇。\n");
  writeFileSync(path.join(rootDir, LIBRARY_DIRECTORY, "chapters", "two.md"), "# 第二章\n\n子目录里的第二篇。\n");
  writeFileSync(path.join(rootDir, PDF_SOURCE), minimalPdfBytes());
}

/**
 * 一个 kind 目录下,authored ledger 已经收管并结算到工作副本的路径。
 *
 * 发布是异步的:回执 applied 之后,SQLite 的那一刀才被结算成 authored Git 的一个提交与
 * 一份工作副本。这里按秒轮询到出现为止,而不是一读就断言——否则测的是时序不是归属。
 */
async function settledOwnedContent(rootDir, kindDirectory, timeoutMs = 15_000) {
  const authoredRoot = path.join(rootDir, "harness"),
    prefix = `entities/${kindDirectory}`,
    deadline = Date.now() + timeoutMs;
  for (;;) {
    const listed = execFileSync("git", ["-C", authoredRoot, "ls-tree", "-r", "--name-only", "HEAD", prefix], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    if (listed.length > 0 || Date.now() > deadline) return listed;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** 从当前打开的实体那一屏读出它的实例身份:身份由中心铸,界面上唯一稳定的出处是内容位置。 */
async function openedEntityContentPath(page) {
  await page.getByTestId("entity-managed-content-path").waitFor();
  return page.getByTestId("entity-managed-content-path").innerText();
}

export default {
  id: "declared-entity-kinds",
  feature: "entities",
  lane: "isolated",
  description:
    "An arbitrary GUI-declared kind completes create, a v1 instance, a v2 attribute publication, a schema-driven attribute form, reading its own content after the source is deleted, and retirement; seed kinds cover one physical source imported into two kinds, a real PDF, a multi-file directory and a url locator.",
  async run({ page, fixture }) {
    writeProbeMaterial(fixture.rootDir);
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

      const entitiesTab = page.getByTestId("app-sidebar-scroll").getByRole("button", { name: /^实体$|Entities/u });
      await entitiesTab.click();
      await page.getByTestId("entities-content").waitFor();

      // ── 主线:任意新 kind 的完整生命周期。身份由中心铸造,所以卡片按显示文本定位。──
      await page.getByTestId("new-vertical-kind").click();
      const kindForm = page.getByTestId("vertical-kind-form");
      await kindForm.waitFor();
      // id 必须精确匹配:idPrefix 的标签也含 "id"。
      await kindForm.getByLabel("id", { exact: true }).fill("runbook");
      await kindForm.getByLabel("idPrefix").fill("RUN");
      await kindForm.getByLabel("display.singular").fill("Runbook");
      await kindForm.getByLabel("display.plural").fill("Runbooks");
      await kindForm.getByLabel("store.pathTemplate").fill("entities/runbooks/{id}.json");
      // 两种 locator 都声明:向导因此长出来源切换器,url 与仓内路径同页可选。
      await kindForm.getByRole("checkbox").nth(1).check();
      await kindForm.getByRole("button", { name: "保存" }).click();

      const runbookCard = page.locator('[data-testid^="entity-doc-card-entity-kind/"]', { hasText: "Runbook:" });
      await runbookCard.waitFor();
      await runbookCard.click();
      const facets = page.getByTestId("entity-declaration-facets");
      await facets.waitFor();
      const mintedKindId = await facets.locator("dd").nth(1).innerText();
      assert.match(mintedKindId, /^KND-[0-9a-f]{32}$/u, "the center mints the stable kind identity");

      // 1. v1 期建一个实例。这一版声明没有属性,页面因此**不摆**属性表单。
      await page.getByTestId("governed-entity-new").click();
      const wizard = page.getByTestId("new-entity-wizard");
      await wizard.waitFor();
      await wizard.getByTestId("new-entity-wizard-source-repository-path").click();
      // 还没有同 kind 实体可推起点:给一个仓内目录再浏览。整串输完输入框才让位给浏览器。
      await wizard.getByLabel("浏览起点目录").fill(PROBE_DIRECTORY);
      await wizard.getByTestId("new-entity-wizard-seed-browse").click();
      await wizard.getByTestId(`repo-path-entry-${RETIRED_SOURCE}`).click();
      await wizard.getByTestId("new-entity-wizard-title-override").waitFor();
      assert.equal(
        await wizard.getByTestId("new-entity-wizard-attributes").count(),
        0,
        "a version that declares no attribute must not put an empty attribute form on screen",
      );
      assert.match(
        await wizard.getByTestId("new-entity-wizard-preview-area").innerText(),
        /值班手册 · 一号/u,
        "the derived title comes from the source's first heading",
      );
      assert.doesNotMatch(
        await wizard.getByTestId("new-entity-wizard-preview-area").innerText(),
        /RUN-[0-9a-f]{8}/u,
        "the wizard must not predict the instance id the center mints",
      );
      await wizard.getByTestId("new-entity-wizard-title-override").fill("Runbook · v1 probe");
      await wizard.getByTestId("new-entity-wizard-submit").click();

      // 2. 正文默认开在**这个实体自己收管的内容**上,位置由读面给出,不由界面拼。
      const firstContentPath = await openedEntityContentPath(page);
      assert.match(
        firstContentPath,
        /^harness\/entities\/runbooks\/RUN-[0-9a-f]{32}$/u,
        `the content read states where the entity's own bytes live; got ${firstContentPath}`,
      );
      await page.getByTestId("entity-managed-content-text").waitFor();
      assert.match(await page.getByTestId("entity-managed-content-text").innerText(), /实体照样读得到它/u);

      // 3. 台账收管了来源字节:一次被接受的导入把来源收进实体自己的内容根,连同描述符一起
      //    落进 authored ledger 的 Git 与工作副本。
      const ownedContent = await settledOwnedContent(fixture.rootDir, "runbooks");
      assert.ok(
        ownedContent.some((entry) => /^entities\/runbooks\/RUN-[0-9a-f]{32}\.json$/u.test(entry)),
        `the accepted import must publish the descriptor; ledger holds ${ownedContent.join(", ")}`,
      );
      assert.ok(
        ownedContent.some((entry) => /^entities\/runbooks\/RUN-[0-9a-f]{32}\/retired-source\.md$/u.test(entry)),
        `the accepted import must take the source bytes into the entity's own content root; ledger holds ${ownedContent.join(", ")}`,
      );

      // 4. 只改显示名:kindId 与已有实例不动,保存后 facets 呈新名。
      await page.getByRole("button", { name: "编辑种类" }).click();
      await page.getByLabel("display.singular").fill("Operations Runbook");
      await page.getByRole("button", { name: "保存" }).click();
      await facets.getByText("Operations Runbook").waitFor();
      assert.equal(
        await facets.locator("dd").nth(1).innerText(),
        mintedKindId,
        "a rename must not move the stable kind identity",
      );

      // 5. 发布属性版本 v2:必填项与 v1 不同;已发布正文只读在场,v1 不被重写。
      await page.getByRole("button", { name: "发布属性版本" }).click();
      const schemaForm = page.getByTestId("vertical-kind-schema-form");
      await schemaForm.waitFor();
      assert.match(await schemaForm.innerText(), /已发布版本/u, "published v1 bodies must stay visible read-only");
      await page.getByLabel("attributes JSON").fill(V2_ATTRIBUTES);
      await schemaForm.getByRole("button", { name: "发布 v2" }).click();
      await facets.getByText("v1, v2").waitFor();

      // 6. v1 期实例仍按它钉的那一版走:发布 v2 之后照常改标题,中心不向它索要 v2 的必填项。
      await page.getByRole("button", { name: /Runbook · v1 probe/u }).click();
      await page.getByTestId("entity-detail-edit").click();
      const runbookEdit = page.getByTestId("entity-detail-edit-form");
      await runbookEdit.waitFor();
      await runbookEdit.getByLabel("title").fill("Runbook · v1 pinned");
      await page.getByTestId("entity-detail-edit-save").click();
      await page.getByTestId("governed-entity-list").getByText("Runbook · v1 pinned").waitFor();

      // 7. 来源被删掉。实体被接受时收下的那一份不受影响——第 9 步冷缓存回头验。
      rmSync(path.join(fixture.rootDir, RETIRED_SOURCE));

      // 8. v2 期新建实例:属性表单按**这一版声明**长出来,必填项没填就交不出去。
      await page.getByTestId("governed-entity-new").click();
      await wizard.waitFor();
      await wizard.getByTestId("new-entity-wizard-source-repository-path").click();
      // 这个 kind 现在有既有实体了,浏览器直接落在它们的公共父目录上,不再问起点。
      assert.equal(
        await wizard.getByTestId("repo-path-browser-location").innerText(),
        PROBE_DIRECTORY,
        "an existing entity's locator supplies the browse root",
      );
      await wizard.getByTestId(`repo-path-entry-${LIBRARY_DIRECTORY}`).click();
      await wizard.getByTestId("repo-path-browser-pick-directory").click();
      await wizard.getByTestId("new-entity-wizard-title-override").waitFor();
      const attributes = wizard.getByTestId("new-entity-wizard-attributes");
      await attributes.waitFor();
      assert.match(await attributes.innerText(), /v2/u, "the form states which published version it fills");
      assert.equal(
        await wizard.getByTestId("new-entity-wizard-submit").isDisabled(),
        true,
        "a declared required attribute that is empty must block the import",
      );
      await wizard.getByTestId("new-entity-wizard-attributes-incomplete").waitFor();
      await attributes.getByLabel("region", { exact: true }).selectOption("north");
      await attributes.getByLabel("fiscalYear", { exact: true }).fill("2026");
      await attributes.getByLabel("reviewed", { exact: true }).check();
      assert.equal(
        await wizard.getByTestId("new-entity-wizard-attributes-incomplete").count(),
        0,
        "filling the declared attributes clears the block",
      );
      await wizard.getByTestId("new-entity-wizard-title-override").fill("Runbook · v2 probe");
      await wizard.getByTestId("new-entity-wizard-submit").click();

      // 目录来源的实体:内容是一棵树,子目录点开才读那一层。
      const contentTree = page.getByTestId("entity-managed-content");
      await contentTree.waitFor();
      await page.getByTestId("entity-content-node-README.md").waitFor();
      await page.getByTestId("entity-content-node-chapters").click();
      await page.getByTestId("entity-content-node-chapters/one.md").click();
      await page.getByTestId("entity-managed-content-text").waitFor();
      assert.match(await page.getByTestId("entity-managed-content-text").innerText(), /子目录里的第一篇/u);
      assert.equal(
        await page.getByTestId("governed-entity-list").getByRole("button").count(),
        2,
        "the v2 import created a second instance",
      );

      // 9. 冷缓存回读:重载渲染进程,把 GUI 的全部查询缓存丢掉,再回到那个实例。来源已经
      //     不在工作副本里(第 7 步删的),实体自己的那一份照常读得到。
      await page.reload();
      await page.getByTestId("app-sidebar-scroll").waitFor();
      await page
        .getByTestId("app-sidebar-scroll")
        .getByRole("button", { name: /^实体$|Entities/u })
        .click();
      await page.getByTestId("entities-content").waitFor();
      const reopened = page.locator('[data-testid^="entity-doc-card-entity-kind/"]', {
        hasText: "Operations Runbook:",
      });
      await reopened.waitFor();
      await reopened.click();
      await page.getByRole("button", { name: /Runbook · v1 pinned/u }).click();
      await page.getByTestId("entity-managed-content-text").waitFor();
      assert.match(
        await page.getByTestId("entity-managed-content-text").innerText(),
        /实体照样读得到它/u,
        "an accepted import keeps its bytes after the source is deleted",
      );
      await page.getByTestId("entity-body-tab-source").click();
      await page.getByTestId("entity-locator-opaque").waitFor();
      assert.match(
        await page.getByTestId("entity-locator-opaque").innerText(),
        /不存在/u,
        "the source pane must say the path is gone rather than borrow the entity's own bytes",
      );

      // 10. 停用:已有材料仍可读,但不再允许新建;目录卡片灰显。
      await page.getByRole("button", { name: "停用种类" }).click();
      await page.getByLabel("停用原因").fill("E2E lifecycle complete");
      await page.getByRole("button", { name: "确认停用" }).click();
      await page.getByTestId("governed-entity-new").waitFor({ state: "detached" });
      await page.getByRole("button", { name: /Runbook · v1 pinned/u }).click();
      await page.getByTestId("entity-body-tab-content").click();
      await page.getByTestId("entity-managed-content-text").waitFor();
      assert.match(
        await page.getByTestId("entity-managed-content-text").innerText(),
        /实体照样读得到它/u,
        "retiring a kind stops new instances; it does not stop reading the old ones",
      );
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

      // ── 种子 kind:同一份来源进两个种类、真 PDF、url 三种形态。──
      // 1. 说明面按声明长出「声明实体」一组——GUI 没有这份清单,它来自读面。
      await page.getByTestId("entity-doc-group-declared").waitFor();
      const adrCard = page.getByTestId(`entity-doc-card-${ADR_KIND}`);
      await adrCard.waitFor();
      await adrCard.click();

      // 2. 声明的可配置项只读呈现;实体列表初始是真实空态,不预填示例。
      await page.getByTestId("entity-declaration-facets").waitFor();
      await page.getByTestId("governed-entity-empty").waitFor();

      // 3. 新建走 entity import:这个 kind 只声明 repository-path,向导直接给仓内浏览器。
      await page.getByTestId("governed-entity-new").click();
      await wizard.waitFor();
      await wizard.getByLabel("浏览起点目录").fill(SHARED_SOURCE_DIRECTORY);
      await wizard.getByTestId("new-entity-wizard-seed-browse").click();
      await wizard.getByTestId(`repo-path-entry-${SHARED_SOURCE}`).click();
      await wizard.getByTestId("new-entity-wizard-title-override").waitFor();
      await wizard.getByTestId("new-entity-wizard-title-override").fill("ADR-0001 · 声明实体探针");
      await wizard.getByTestId("new-entity-wizard-submit").click();
      const adrContentPath = await openedEntityContentPath(page);
      assert.match(adrContentPath, /^harness\/entities\/architecture-decision-records\/ADR-[0-9a-f]{32}$/u);

      // 4. 建立之后可见:实体行来自账本投影,不是表单的本地回声。
      const list = page.getByTestId("governed-entity-list");
      await list.waitFor();
      assert.ok(
        (await list.getByRole("button").count()) > 0,
        "the imported entity must appear in the ledger-backed list",
      );
      await page.getByTestId("entity-body-tab-source").click();
      await page.getByTestId("entity-locator-markdown").waitFor();
      assert.match(
        await list.innerText(),
        /ADR-0001-declared-entity-probe\.md/u,
        "the row's locator is the source the wizard actually submitted",
      );

      // 5. 详情操作区完成 descriptor update → archive。写后列表由失效查询重新读取;
      //    contentVersion 不在这一页——它是中心按接受的字节导出的摘要,不接受手填。
      await page.getByTestId("entity-detail-edit").click();
      const editForm = page.getByTestId("entity-detail-edit-form");
      await editForm.waitFor();
      assert.equal(
        await editForm.getByLabel("content version").count(),
        0,
        "the descriptor digest is derived from accepted bytes, never typed by hand",
      );
      await editForm.getByLabel("title").fill("ADR-0001 · 已更新");
      await page.getByTestId("entity-detail-edit-save").click();
      await list.getByText("ADR-0001 · 已更新").waitFor();
      await page.getByTestId("entity-detail-archive").click();
      await page.getByLabel("归档原因").fill("E2E lifecycle complete");
      await page.getByTestId("entity-detail-archive-confirm").click();
      await page.getByLabel("显示已归档").check();
      await list.getByText("ADR-0001 · 已更新").waitFor();

      // 6. **同一份物理来源导进第二个种类**:import 的意图身份含 Kind,所以这一次不再撞上
      //    ADR 那一次的 operation,而是铸出一个属于 Research 的新实例。
      await page
        .getByRole("button", { name: /返回上一级|Back to previous/u })
        .first()
        .click();
      await page.getByTestId("entities-content").waitFor();
      const researchCard = page.getByTestId(`entity-doc-card-${RESEARCH_KIND}`);
      await researchCard.waitFor();
      await researchCard.click();
      await page.getByTestId("governed-entity-new").click();
      await wizard.waitFor();
      await wizard.getByLabel("浏览起点目录").fill(SHARED_SOURCE_DIRECTORY);
      await wizard.getByTestId("new-entity-wizard-seed-browse").click();
      await wizard.getByTestId(`repo-path-entry-${SHARED_SOURCE}`).click();
      await wizard.getByTestId("new-entity-wizard-title-override").waitFor();
      await wizard.getByTestId("new-entity-wizard-title-override").fill("Research · 同一份来源");
      await wizard.getByTestId("new-entity-wizard-submit").click();
      const researchContentPath = await openedEntityContentPath(page);
      assert.match(
        researchContentPath,
        /^harness\/entities\/research\/RES-[0-9a-f]{32}$/u,
        `the same source imported into a second kind gets that kind's own instance; got ${researchContentPath}`,
      );
      await page.getByTestId("entity-managed-content-text").waitFor();
      assert.match(await page.getByTestId("entity-managed-content-text").innerText(), /声明实体探针/u);

      // 7. 真 PDF:读面对二进制不载字节,所以这里给事实卡而不是一个空的「预览」。
      await page.getByTestId("governed-entity-new").click();
      await wizard.waitFor();
      await wizard.getByTestId(`repo-path-entry-${PDF_SOURCE}`).click();
      await wizard.getByTestId("new-entity-wizard-title-override").waitFor();
      await wizard.getByTestId("new-entity-wizard-title-override").fill("Research · PDF 探针");
      await wizard.getByTestId("new-entity-wizard-submit").click();
      await page.getByTestId("entity-locator-pdf").waitFor();
      assert.match(
        await page.getByTestId("entity-locator-pdf").innerText(),
        /harness\/entities\/research\/RES-[0-9a-f]{32}\/paper\.pdf/u,
        "the pdf card names the entity's own copy, not the source path",
      );
      assert.equal(
        await page.getByTestId("entity-managed-content-text").count(),
        0,
        "binary content must not be rendered as if it were text",
      );

      // 8. 第三种声明 kind:external-issue(url locator)不改 GUI 就出现在同一目录里。
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

      // 9. url locator 的新建:声明不含 repository-path,向导因此只给 URL 输入;
      //    daemon 真实 GET 那个一次性 HTTP 服务,title 按 url 末段推导。
      await page.getByTestId("governed-entity-new").click();
      await wizard.waitFor();
      await wizard.getByLabel("外部 URL").fill(issueUrl);
      await wizard.getByTestId("new-entity-wizard-title-override").waitFor();
      assert.match(
        await wizard.getByTestId("new-entity-wizard-preview-area").innerText(),
        /2224/u,
        "the url title rule is the daemon's: the last path segment",
      );
      await wizard.getByTestId("new-entity-wizard-submit").click();
      const issueRows = list.getByRole("button");
      await issueRows.first().waitFor();
      assert.match(
        await issueRows.first().innerText(),
        /issues\/2224/u,
        "the external-issue row must show its url locator",
      );
      // 取回来的正文同样归实体所有:一条 url 指针照样有可读的内容。
      await page.getByTestId("entity-managed-content-text").waitFor();
      assert.match(await page.getByTestId("entity-managed-content-text").innerText(), /2224/u);
      // url 指针本身没有仓内字节可读:来源那一屏如实呈现元数据卡,不假装渲染。
      await page.getByTestId("entity-body-tab-source").click();
      await page.getByTestId("entity-locator-opaque").waitFor();

      // 10. 领地筛选按 kind 生效:种子 kind 的类型 chip 都由读面派生,标签取声明显示名;
      //     图节点层:每种声明 kind 一块领地,chip 的 navRef 是 <kind>/<entityId>。
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
