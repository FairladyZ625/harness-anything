import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

/**
 * 取代链组件内横滚(ChainStrip 链接链契约):supersede 关系数无界增长时,链接链
 * 单行、在链内部横向滚动,链接仍可点(点击导航),滚动手势与键盘平移不触发导航;
 * 溢出时出右缘提示并进入 tab 序。
 * 数据面:lanes.mjs 的 seedSupersedeChain(dec_gui_smoke → 12 个真实 proposed 决策,
 * 走 decisionService 同一写路)。覆盖两个真实消费面:决策池行抽屉(ChainView)与
 * 专注裁决模式的 VerdictCard relation 卡。
 */
export default {
  id: "decision-supersede-chain",
  feature: "decisions",
  lane: "isolated",
  description:
    "Supersede link chains stay single-line and scroll inside the chain; links still navigate; scroll and keyboard panning do not.",
  async run({ page, shot }) {
    await nav(page, /^(?:待办签发|Approvals|Sign-offs)/u, "attestation-pool-total");
    await page.getByRole("tab", { name: /^(?:决策待裁|Decisions to judge)/u }).click();
    await page.getByText("Expose the triadic projection to the GUI", { exact: false }).first().waitFor();

    // ——— 消费面 1:决策池行 → 抽屉里的取代/修订链(ChainView) ———
    await page.getByText("Expose the triadic projection to the GUI", { exact: false }).first().click();
    const chain = page.getByTestId("supersede-chain").first();
    await chain.waitFor();
    // 等抽屉实际到达终点再量坐标，避免动画中的滚轮命中位置漂移。
    await page.waitForFunction(() => {
      const drawer = document.querySelector('[role="dialog"]');
      if (!drawer) return false;
      const transform = getComputedStyle(drawer).transform;
      return transform === "none" || Math.abs(new DOMMatrixReadOnly(transform).m41) < 0.01;
    });
    const geometry = await chain.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      singleLine: node.scrollHeight <= node.clientHeight + 1,
      links: node.querySelectorAll("button").length,
      hint: node.parentElement.querySelectorAll(":scope > [data-chain-hint]").length,
      drawerOpen: node.closest("[role='dialog'], aside, [data-drawer]") !== null,
    }));
    assert.ok(geometry.scrollWidth > geometry.clientWidth, `chain must overflow: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.singleLine, `chain must stay single-line: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.links, 13, `self link + 12 superseded decisions: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.hint, 1, `overflowing chain must show the hint: ${JSON.stringify(geometry)}`);

    // 横向滚轮只滚链,不导航(抽屉仍在、URL 不动)。
    const beforeWheelUrl = page.url();
    const box = await chain.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(600, 0);
    const afterWheel = await chain.evaluate((node) => ({
      scrollLeft: node.scrollLeft,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      stillInDrawer: node.closest("[role='dialog'], aside, [data-drawer]") !== null,
    }));
    assert.ok(afterWheel.scrollLeft > 0, "horizontal wheel must scroll the link chain");
    assert.equal(afterWheel.stillInDrawer, geometry.drawerOpen, "wheel scrolling must not navigate away");
    assert.equal(page.url(), beforeWheelUrl, "wheel scrolling must not change the route");

    // 键盘:链在抽屉正文里,Tab 可达,方向键平移不导航。锚在抽屉头部的实体链接
    // (链外、链前的最后一个可焦点面),真实 Tab 步进到滚动区。
    await chain.evaluate((node) => {
      node.scrollLeft = 0;
    });
    const headerLink = page
      .getByRole("dialog")
      .getByRole("button", { name: /dec_gui_smoke/u })
      .first();
    await headerLink.focus();
    let stripFocused = false;
    for (let step = 0; step < 15 && !stripFocused; step += 1) {
      await page.keyboard.press("Tab");
      stripFocused = await chain.evaluate((node) => globalThis.document.activeElement === node);
    }
    assert.ok(stripFocused, "Tab must reach the supersede chain scroll region");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const afterArrows = await chain.evaluate((node) => ({
      scrollLeft: node.scrollLeft,
      stillInDrawer: node.closest("[role='dialog'], aside, [data-drawer]") !== null,
    }));
    assert.ok(afterArrows.scrollLeft > 0, "ArrowRight on the focused chain must pan it");
    assert.equal(afterArrows.stillInDrawer, geometry.drawerOpen, "keyboard panning must not navigate away");
    await shot("decision-supersede-chain-drawer");

    // 链接仍可点:滚到末位点最后一个被取代决策,导航到它的决策面。
    await chain.evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
    });
    await chain.getByRole("button", { name: /dec_sup_12/u }).click();
    await page
      .getByText(/dec_sup_12|取代链样本决策 12/u)
      .first()
      .waitFor();
    await shot("decision-supersede-chain-navigated");

    // ——— 消费面 2:专注裁决模式的 VerdictCard relation 卡(同一 ChainStrip) ———
    await nav(page, /^(?:待办签发|Approvals|Sign-offs)/u, "attestation-pool-total");
    await page.getByRole("tab", { name: /^(?:决策待裁|Decisions to judge)/u }).click();
    await page.getByTestId("attestation-pool-focus-entry").click();
    const verdictChain = page.getByTestId("supersede-chain").first();
    await verdictChain.waitFor();
    await verdictChain.evaluate((node) => node.scrollIntoView({ block: "center" }));
    const verdictGeometry = await verdictChain.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      singleLine: node.scrollHeight <= node.clientHeight + 1,
      hint: node.parentElement.querySelectorAll(":scope > [data-chain-hint]").length,
    }));
    assert.ok(
      verdictGeometry.scrollWidth > verdictGeometry.clientWidth,
      `verdict chain must overflow: ${JSON.stringify(verdictGeometry)}`,
    );
    assert.ok(verdictGeometry.singleLine, `verdict chain must stay single-line: ${JSON.stringify(verdictGeometry)}`);
    assert.equal(verdictGeometry.hint, 1, `verdict chain must show the hint: ${JSON.stringify(verdictGeometry)}`);
    const verdictBox = await verdictChain.boundingBox();
    await page.mouse.move(verdictBox.x + verdictBox.width / 2, verdictBox.y + verdictBox.height / 2);
    await page.mouse.wheel(600, 0);
    const verdictAfterWheel = await verdictChain.evaluate((node) => node.scrollLeft);
    assert.ok(verdictAfterWheel > 0, "horizontal wheel must scroll the verdict chain");
    await shot("decision-supersede-chain-verdict");
  },
};
