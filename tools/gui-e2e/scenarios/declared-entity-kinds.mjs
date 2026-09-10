import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import {
  ADR_KIND,
  ISSUE_KIND,
  LIBRARY_DIRECTORY,
  PDF_SOURCE,
  PROBE_DIRECTORY,
  RESEARCH_KIND,
  RETIRED_SOURCE,
  SHARED_SOURCE,
  SHARED_SOURCE_DIRECTORY,
  V2_ATTRIBUTES,
  centerRow,
  openedEntityContentPath,
  reopenedAttributeValue,
  settledOwnedContent,
  writeProbeMaterial,
} from "./declared-entity-kinds.support.mjs";

/**
 * 声明出来的实体种类在 GUI 上可见、可建、可填属性、可读正文——而且**不靠 GUI 里的任何
 * 清单或按 kind 写死的分支**。
 *
 * 主线是一个任意新 Kind 的完整生命周期:GUI 创建 → v1 期建实例 → 删掉它的来源 → 改显示名
 * → 发布 v2 属性(必填项与 v1 不同)→ v1 期实例仍按 v1 读写 → v2 期用通用属性表单建实例
 * → 另一条 ingress 抢先写一次:中心答冲突,界面照原话说出来、把中心现在的值摆在草稿旁边、
 * 等人自己按下重填 → 回头再读 v1 期
 * 实例:来源那一屏说不存在,内容那一屏照常给出被接受时收下的字节 → 停用。
 *
 * 种子 kind 补三种形态:ADR 与 Research **导同一份物理来源**(证明 import 意图按 Kind 作用域,
 * 不再互撞);Research 另导一份真 PDF(证明二进制如实呈现,不摆假预览);external-issue 的
 * locator 是 url——daemon 会真的 HTTP GET,所以场景在本机起一个一次性服务当「外部系统」。
 */
export default {
  id: "declared-entity-kinds",
  feature: "entities",
  lane: "isolated",
  description:
    "An arbitrary GUI-declared kind completes create, a v1 instance, a v2 attribute publication, a schema-driven attribute form, reading its own content after the source is deleted, and retirement; seed kinds cover one physical source imported into two kinds, a real PDF, a multi-file directory and a url locator.",
  async run({ page, fixture, shot }) {
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
      const v1InstanceId = firstContentPath.split("/").at(-1);
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
      // 编辑面按**这一条钉住的那一版**长出来。它钉在 v1 上,那一版一个属性也没声明,
      // 所以这里不该出现 v2 的必填项——表单认的是实例的版本,不是 kind 的最新版本。
      assert.equal(
        await page.getByTestId("entity-detail-attributes").count(),
        0,
        "a v1-pinned instance must not be asked for the attributes v2 introduced",
      );
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
      const v2ContentPath = await openedEntityContentPath(page);
      const v2InstanceId = v2ContentPath.split("/").at(-1);

      // 8.5 **改一条已存在实例的属性**:读面给出它钉的那一版与它现在的值 → 表单按那一版预填
      //     → 写走同一条 fence → 再读回来的是账本里的值,不是留在组件里的草稿。
      await page.getByTestId("entity-detail-edit").click();
      await page.getByTestId("entity-detail-edit-form").waitFor();
      const detailAttributes = page.getByTestId("entity-detail-attributes");
      await detailAttributes.waitFor();
      assert.match(await detailAttributes.innerText(), /v2/u, "the edit form states which pinned version it fills");
      assert.equal(
        await detailAttributes.getByLabel("fiscalYear", { exact: true }).inputValue(),
        "2026",
        "the form starts from the values this instance already holds, not from an empty table",
      );
      assert.equal(await detailAttributes.getByLabel("region", { exact: true }).inputValue(), "north");
      await detailAttributes.getByLabel("fiscalYear", { exact: true }).fill("2027");
      await page.getByTestId("entity-detail-edit-save").click();
      // 回执落定之前不动这张表。等的是界面把回执的状态说出来那一刻,不是一个固定的睡眠——
      // 「已被中心接受」与「canonical 已经读得到」是两件事,这一句说的是后者。
      await page.getByTestId("entity-detail-action-applied").waitFor();
      await page.getByTestId("entity-detail-edit-form").waitFor({ state: "detached" });
      assert.equal(
        await reopenedAttributeValue(page, "fiscalYear", "2027"),
        "2027",
        "an accepted attribute edit must come back from the ledger read, not from the form's own state",
      );

      // 8.6 **fence 不成立**:表单开着、草稿还没提交的时候,另一条 ingress 对同一条实体写了
      //     一次并被中心接受。GUI 这一次保存因此拿着一个过期的 fence——界面不能把它说成
      //     「已生效」,也不能把人没提交的输入悄悄丢掉。
      await page.getByTestId("entity-detail-edit").click();
      await detailAttributes.waitFor();
      await detailAttributes.getByLabel("fiscalYear", { exact: true }).fill("2099");
      const staleRow = await centerRow(fixture, v2InstanceId);
      const independentIntent = {
        repo: { repoId: fixture.repoId },
        payload: {
          entityKind: staleRow.kind,
          entityId: staleRow.entityId,
          expectedVersion: staleRow.revision,
          title: staleRow.title,
          locator: staleRow.locator.value,
          attributes: { ...staleRow.descriptor.attributes, region: "south" },
        },
      };
      const independent = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.entity.update",
        independentIntent,
        2_000,
        20_000,
      );
      assert.equal(
        independent.outcome,
        "applied",
        `the independent ingress must really be accepted; center answered ${JSON.stringify(independent)}`,
      );
      // 同一次意图原样重发一次:中心交回同一次操作的回执,连接照常留着。这一条守的是回执
      // 信封本身——回执少一个字段,调用方的结果校验就会抛,流的错误路会把这条连接关掉,
      // 下面那次冲突也就再读不到中心的原话了。
      const replayed = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.entity.update",
        independentIntent,
        2_000,
        20_000,
      );
      assert.equal(
        replayed.outcome,
        "no_changes",
        `an identical intent must replay its own outcome; center answered ${JSON.stringify(replayed)}`,
      );
      assert.equal(replayed.opId, independent.opId, "a replay is the same operation, not a second one");
      assert.equal(replayed.code, "no_changes", "the replay receipt must carry the code its envelope requires");
      assert.equal(replayed.origin, "daemon", "the replay receipt must say who answered");
      // 中心还在,而且已经拿着别人写的那个值——冲突是「有人先写成功了」,不是「服务坏了」。
      const afterIndependent = await centerRow(fixture, v2InstanceId);
      assert.equal(afterIndependent.descriptor.attributes.region, "south");
      assert.ok(afterIndependent.revision > staleRow.revision, "the accepted write must move the revision");

      await page.getByTestId("entity-detail-edit-save").click();
      // 中心对这条过期 fence 的回答是 `revision_conflict`,界面因此落在**冲突**这一态:
      // 不是「已生效」,也不是「没拿到回答」——后者是连接被掐断时才该说的话。
      const conflictNote = page.getByTestId("entity-detail-action-conflict");
      await conflictNote.waitFor();
      assert.match(
        await conflictNote.innerText(),
        /已经被改过,请重新读取后再改/u,
        "the drawer must tell the person this row moved under them",
      );
      for (const absent of ["applied", "pending", "rejected"])
        assert.equal(
          await page.getByTestId(`entity-detail-action-${absent}`).count(),
          0,
          `an answered conflict must not also be reported as ${absent}`,
        );
      // 别人刚写进去的那个值就摆在草稿旁边:这一屏说得出「中心现在是什么」,
      // 而不是只给一句笼统的失败。
      await page.locator('[data-testid="entity-detail-conflict-field-region"]', { hasText: "south" }).waitFor();
      assert.match(
        await page.getByTestId("entity-detail-conflict-field-region").innerText(),
        /中心「south」.*你的「north」/su,
        "the conflict pane must name the value the center now holds beside the draft",
      );
      // 人没提交的那一格还在:别人的一次写不该顺手清掉这张表。
      assert.equal(
        await detailAttributes.getByLabel("fiscalYear", { exact: true }).inputValue(),
        "2099",
        "an unsubmitted draft must survive instead of being silently discarded",
      );
      assert.equal(
        await page.getByTestId("entity-detail-edit-form").count(),
        1,
        "the edit form stays open so the unsubmitted work is still reachable",
      );

      // 这一屏就是人看到的那一屏:中心的原话、中心现在的值、没丢的草稿、还开着的表单。
      await shot("declared-entity-kinds-write-conflict");

      // 中心自己对一个过期 fence 的回答:`revision_conflict`,连同它自己的那句解释。
      // 这一条走的是同一个 method、同一条 fence 语义,只是调用方不是渲染进程——它证明
      // 界面上那个 fence 是真的、而且中心确实会拒,不是场景自己编出来的一次失败。
      const centerOnStaleFence = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.entity.update",
        {
          repo: { repoId: fixture.repoId },
          payload: {
            entityKind: staleRow.kind,
            entityId: staleRow.entityId,
            // 0 是一个同样过期、但从没有哪次操作用过的 fence:用 staleRow.revision 会命中
            // 上面那次独立写的 opId,被中心当成同一次意图的重放而不是冲突。
            expectedVersion: 0,
            title: staleRow.title,
            locator: staleRow.locator.value,
            attributes: { ...staleRow.descriptor.attributes },
          },
        },
        2_000,
        20_000,
      );
      assert.equal(centerOnStaleFence.outcome, "op_rejected");
      assert.equal(
        centerOnStaleFence.code,
        "revision_conflict",
        `the center rejects a stale fence in its own words; it answered ${JSON.stringify(centerOnStaleFence)}`,
      );

      // 两次被拒的 fence 之后,仓格照常答话:一次冲突是一个答案,不是一次故障,
      // 不该把这条仓格打翻、让后面的读去等自愈。
      const stillServing = await centerRow(fixture, v2InstanceId);
      assert.equal(
        stillServing.revision,
        afterIndependent.revision,
        "a rejected fence must leave the cell serving the row it already holds",
      );

      // 人自己按下「用中心现在的值重填」:覆盖草稿是他按的一个动作,不是界面替他做的。
      await page.getByTestId("entity-detail-conflict-adopt").click();
      assert.equal(await detailAttributes.getByLabel("region", { exact: true }).inputValue(), "south");
      assert.equal(
        await detailAttributes.getByLabel("fiscalYear", { exact: true }).inputValue(),
        "2027",
        "adopting takes every one of the center's values, not only the field that clashed",
      );
      assert.equal(
        await page.getByTestId("entity-detail-conflict-incoming").count(),
        0,
        "once the draft is the center's own row there is nothing left to compare",
      );
      // 再改成他本来要的那个值:fence 现在是中心那一条,这一次落定。
      await detailAttributes.getByLabel("fiscalYear", { exact: true }).fill("2099");
      await page.getByTestId("entity-detail-edit-save").click();
      await page.getByTestId("entity-detail-action-applied").waitFor();
      await page.getByTestId("entity-detail-edit-form").waitFor({ state: "detached" });
      assert.equal(
        await reopenedAttributeValue(page, "fiscalYear", "2099"),
        "2099",
        "after the person adopts the center's row the same value applies and comes back from the ledger",
      );
      assert.equal(
        await reopenedAttributeValue(page, "region", "south"),
        "south",
        "the independent write's value must survive the person's retry",
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

      // 9.5 删除:描述符与这个实体收管的那一份内容一起退役——归档两者都留下,删除不留。
      //      被删的只有它自己那一份:来源不归它所有,同 kind 的另一条也不受影响。
      await page.getByRole("button", { name: /Runbook · v2 probe/u }).click();
      await page.getByTestId("entity-detail-delete").click();
      await page.getByTestId("entity-detail-delete-form").waitFor();
      await page.getByLabel("删除原因").fill("E2E delete probe");
      await page.getByTestId("entity-detail-delete-confirm").click();
      await page.getByRole("button", { name: /Runbook · v2 probe/u }).waitFor({ state: "detached" });
      assert.equal(
        await page.getByTestId("governed-entity-list").getByRole("button").count(),
        1,
        "delete takes the row with it; the other instance of the same kind stays",
      );
      const afterDelete = await settledOwnedContent(
        fixture.rootDir,
        "runbooks",
        (listed) => !listed.some((entry) => entry.startsWith(`entities/runbooks/${v2InstanceId}`)),
      );
      assert.equal(
        afterDelete.some((entry) => entry.startsWith(`entities/runbooks/${v2InstanceId}`)),
        false,
        `the deleted entity's own files must be retired; ledger still holds ${afterDelete.join(", ")}`,
      );
      assert.ok(
        afterDelete.some((entry) => entry.startsWith(`entities/runbooks/${v1InstanceId}`)),
        `deleting one entity must not touch another's files; ledger holds ${afterDelete.join(", ")}`,
      );
      // 来源不归它所有,所以来源目录仍在工作副本里,一个文件也没少。
      for (const held of ["README.md", "chapters/one.md", "chapters/two.md"])
        assert.ok(
          existsSync(path.join(fixture.rootDir, LIBRARY_DIRECTORY, held)),
          `deleting an entity must not delete the source it was imported from: ${held} is gone`,
        );
      // 幸存的那一条照常读得出自己的正文(两屏的选择跨实体保留,所以先切回内容屏)。
      await page.getByRole("button", { name: /Runbook · v1 pinned/u }).click();
      await page.getByTestId("entity-body-tab-content").click();
      await page.getByTestId("entity-managed-content-text").waitFor();
      assert.match(await page.getByTestId("entity-managed-content-text").innerText(), /实体照样读得到它/u);

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
