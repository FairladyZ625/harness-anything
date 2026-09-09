import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";

// 声明 kind 在读面上的名字是稳定身份 entity-kind/KND-…,不再带任何版本段。安装种子里的
// 两个 kind 的 kindId 是提交过的常量(packages/preset/assets/software-coding/vertical.json)。
const ADR_KIND = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94";
const ISSUE_KIND = "entity-kind/KND-2a6d1b8f0c4e5d7b9f3a1c2e4d6b8f05";
const PROBE_FILE = "docs/adr/ADR-0001-declared-entity-probe.md";
const PROBE_DIRECTORY = "docs/adr";
/**
 * ADR 实体用**另一份**来源:import 的 operation id 由 sourceIdentity + locator + 内容摘要
 * 决定,**不含 kind**,所以同一份来源在第二个 kind 下再导一次会撞上第一次的 operation,
 * 被判成 "is not the requested observation"。那是 E3 的 operation 作用域缺口(已上报),
 * 这里绕开它,用一份没被别的 kind 占过的来源。
 */
const ADR_SEED = "harness/context";
const ADR_DIRECTORY_ENTRY = "harness/context/research";
const ADR_FILE = "harness/context/research/README.md";

/**
 * 声明出来的实体种类在 GUI 上可见、可建、可打开、可筛选——而且**不靠 GUI 里的任何清单**。
 *
 * 主线是一个**任意新 kind 的完整生命周期**(不是翻动安装种子里的 Research/ADR 开关):
 * GUI 创建(身份与 v1 属性版本由中心铸造,fence 0)→ 建 v1 实例 → 只改显示名(kindId 不变)
 * → 发布属性版本 v2(v1 只读保留)→ v1 期建的实例照常打开(pinned-existing read)→ v2 下
 * 用**另一个来源**再建实例 → 停用(灰显、不可再建、旧实例仍可读)。
 *
 * 两个实例必须用**两个不同的来源**:同来源同意图的 import 是幂等重放,会回到同一个实体,
 * 那样就证明不了「v2 之后新建的是新实例」。这里 v1 用一个文件、v2 用它所在的目录。
 *
 * 种子里的 ADR/external-issue 两种 kind 补充两种 locator 形态:ADR 走 repository-path
 * (仓内 Markdown);external-issue 的 locator 是 url——daemon 的 url 解析器会真的 HTTP GET,
 * 所以场景在本机起一个一次性 HTTP 服务来当「外部系统」。全程不改 GUI 源码;若哪个面必须改
 * 代码才出现,那是缺口。
 *
 * 走的是**当前生产向导**:选来源(仓内浏览器 / URL 输入)→ 预览推导 title → 导入,身份由
 * 中心回执给出。旧的 new-governed-entity-* 手填表单已经不存在,场景不按它写。
 */
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

export default {
  id: "declared-entity-kinds",
  feature: "entities",
  lane: "isolated",
  description:
    "A GUI-declared arbitrary kind completes create, instance, rename, schema v2 publish, pinned-existing read and archive through the production wizard; seed kinds (repository-path ADR and url external-issue) cover both locator shapes end to end.",
  async run({ page, fixture }) {
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

      // 1. v1 期建一个实例:来源是一个仓内文件。发布 v2 之前的存量,之后必须照常可读。
      await page.getByTestId("governed-entity-new").click();
      const wizard = page.getByTestId("new-entity-wizard");
      await wizard.waitFor();
      await wizard.getByTestId("new-entity-wizard-source-repository-path").click();
      // 还没有同 kind 实体可推起点:给一个仓内目录再浏览。整串输完输入框才让位给浏览器。
      await wizard.getByLabel("浏览起点目录").fill(PROBE_DIRECTORY);
      await wizard.getByTestId("new-entity-wizard-seed-browse").click();
      await wizard.getByTestId(`repo-path-entry-${PROBE_FILE}`).click();
      // 预览只给推导 title;实例 id 由中心铸,预览里不出现。
      await wizard.getByTestId("new-entity-wizard-title-override").waitFor();
      assert.match(
        await wizard.getByTestId("new-entity-wizard-preview-area").innerText(),
        /声明实体探针/u,
        "the derived title comes from the source's first heading",
      );
      assert.doesNotMatch(
        await wizard.getByTestId("new-entity-wizard-preview-area").innerText(),
        /RUN-[0-9a-f]{8}/u,
        "the wizard must not predict the instance id the center mints",
      );
      await wizard.getByTestId("new-entity-wizard-title-override").fill("Runbook · v1 probe");
      await wizard.getByTestId("new-entity-wizard-submit").click();

      // 导入被接受后,GUI 用**回执里的**实例身份导航到这一条,正文在右栏渲染。
      const markdown = page.getByTestId("entity-locator-markdown");
      await markdown.waitFor();
      assert.match(await markdown.innerText(), /声明实体探针/u);

      // 2. 台账收管了来源字节:一次被接受的导入把来源收进实体自己的内容根,连同描述符一起
      //    落进 authored ledger 的 Git 与工作副本。这是**内容归属**的实证:GUI 只发了一条
      //    import,字节从此归实体所有,来源路径改不改都不影响它。
      //
      //    这一段读的是 fixture 的文件系统,不是 GUI:实体内容落在 authored root 下,而
      //    `repo.entity.locator.read` 按仓根寻址且不公开 authored root 前缀,所以 GUI 目前
      //    没有能寻址到它的读面——这是记录在案的缺口,不在这一页伪造一个能读的界面。
      const ownedContent = await settledOwnedContent(fixture.rootDir, "runbooks");
      assert.ok(
        ownedContent.some((entry) => /^entities\/runbooks\/RUN-[0-9a-f]{32}\.json$/u.test(entry)),
        `the accepted import must publish the descriptor; ledger holds ${ownedContent.join(", ")}`,
      );
      assert.ok(
        ownedContent.some((entry) =>
          /^entities\/runbooks\/RUN-[0-9a-f]{32}\/ADR-0001-declared-entity-probe\.md$/u.test(entry),
        ),
        `the accepted import must take the source bytes into the entity's own content root; ledger holds ${ownedContent.join(", ")}`,
      );

      // 3. 只改显示名:kindId 与已有实例不动,保存后 facets 呈新名。
      await page.getByRole("button", { name: "编辑种类" }).click();
      await page.getByLabel("display.singular").fill("Operations Runbook");
      await page.getByRole("button", { name: "保存" }).click();
      await facets.getByText("Operations Runbook").waitFor();
      assert.equal(
        await facets.locator("dd").nth(1).innerText(),
        mintedKindId,
        "a rename must not move the stable kind identity",
      );

      // 4. 发布属性版本 v2:已发布正文只读在场,新版本不重写 v1;facets 的版本清单变 v1, v2。
      await page.getByRole("button", { name: "发布属性版本" }).click();
      const schemaForm = page.getByTestId("vertical-kind-schema-form");
      await schemaForm.waitFor();
      assert.match(await schemaForm.innerText(), /已发布版本/u, "published v1 bodies must stay visible read-only");
      await page.getByLabel("attributes JSON").fill('{"owner":{"type":"string"},"reviewed":{"type":"boolean"}}');
      await schemaForm.getByRole("button", { name: "发布 v2" }).click();
      await facets.getByText("v1, v2").waitFor();

      // 5. pinned-existing read:v1 期建的实例在 v2 发布后照常打开并渲染正文。
      await page.getByRole("button", { name: /Runbook · v1 probe/u }).click();
      await page.getByTestId("entity-locator-markdown").waitFor();
      assert.match(await page.getByTestId("entity-locator-markdown").innerText(), /声明实体探针/u);

      // 6. v2 下再建一个实例。来源换成**另一个**:同来源同意图会重放回上一个实体,
      //    换成它所在的目录才是一个新实例。已有实体让浏览器直接落在那个目录上。
      await page.getByTestId("governed-entity-new").click();
      await wizard.waitFor();
      await wizard.getByTestId("new-entity-wizard-source-repository-path").click();
      await wizard.getByTestId("repo-path-browser-pick-directory").click();
      await wizard.getByTestId("new-entity-wizard-title-override").waitFor();
      assert.equal(
        await wizard.getByTestId("new-entity-wizard-locator").innerText(),
        PROBE_DIRECTORY,
        "the second instance imports a different source than the first",
      );
      await wizard.getByTestId("new-entity-wizard-title-override").fill("Runbook · v2 probe");
      await wizard.getByTestId("new-entity-wizard-submit").click();
      await page.getByTestId("entity-locator-directory").waitFor();
      const runbookList = page.getByTestId("governed-entity-list");
      assert.equal(await runbookList.getByRole("button").count(), 2, "two distinct sources mean two instances");

      // 7. 停用:已有材料仍可读,但不再允许新建;目录卡片灰显。
      await page.getByRole("button", { name: "停用种类" }).click();
      await page.getByLabel("停用原因").fill("E2E lifecycle complete");
      await page.getByRole("button", { name: "确认停用" }).click();
      await page.getByTestId("governed-entity-new").waitFor({ state: "detached" });
      await page.getByRole("button", { name: /Runbook · v1 probe/u }).click();
      await page.getByTestId("entity-locator-markdown").waitFor();
      assert.match(
        await page.getByTestId("entity-locator-markdown").innerText(),
        /声明实体探针/u,
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

      // ── 种子 kind 的补充覆盖:两种 locator 形态的实建、渲染与图筛选。──
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
      await wizard.getByLabel("浏览起点目录").fill(ADR_SEED);
      await wizard.getByTestId("new-entity-wizard-seed-browse").click();
      await wizard.getByTestId(`repo-path-entry-${ADR_DIRECTORY_ENTRY}`).click();
      await wizard.getByTestId(`repo-path-entry-${ADR_FILE}`).click();
      await wizard.getByTestId("new-entity-wizard-title-override").waitFor();
      await wizard.getByTestId("new-entity-wizard-title-override").fill("ADR-0001 · 声明实体探针");
      await wizard.getByTestId("new-entity-wizard-submit").click();

      // 4. 建立之后可见:实体行来自账本投影,不是表单的本地回声。
      const list = page.getByTestId("governed-entity-list");
      await list.waitFor();
      assert.ok(
        (await list.getByRole("button").count()) > 0,
        "the imported entity must appear in the ledger-backed list",
      );

      // 5. 点击即渲染:locator 指向 Markdown → 既有 Markdown 渲染器。
      await page.getByTestId("entity-locator-markdown").waitFor();
      assert.match(
        await list.innerText(),
        /harness\/context\/research\/README\.md/u,
        "the row's locator is the source the wizard actually submitted",
      );

      // 6. 详情操作区完成 descriptor update → archive。写后列表由失效查询重新读取;
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
      await editForm.getByLabel("repository-path locator").fill(ADR_FILE);
      await page.getByTestId("entity-detail-edit-save").click();
      await list.getByText("ADR-0001 · 已更新").waitFor();
      await page.getByTestId("entity-detail-archive").click();
      await page.getByLabel("归档原因").fill("E2E lifecycle complete");
      await page.getByTestId("entity-detail-archive-confirm").click();
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

      // 8. url locator 的新建:声明不含 repository-path,向导因此只给 URL 输入;
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
      // url 指针没有仓内字节可读:如实呈现元数据卡,不假装渲染。
      await page.getByTestId("entity-locator-opaque").waitFor();

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
