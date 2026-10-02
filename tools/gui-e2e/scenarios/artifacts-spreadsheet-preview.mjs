import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

// A spreadsheet artifact used to fall into the "read but not renderable" branch of
// BinaryDocumentPreview — real bytes arrived and nothing was readable. This scenario is
// the visual claim behind packages/gui/test/spreadsheet-preview.vitest.tsx: opening the
// artifact from the real artifacts entry parses the authorized bytes in the renderer,
// shows actual cell values, switches worksheets, and scrolls both axes inside the
// bounded frame instead of stretching the page.
export default {
  id: "artifacts-spreadsheet-preview",
  feature: "sessions-artifacts",
  lane: "isolated",
  description:
    "A multi-sheet XLSX artifact renders real cell values with sheet switching and two-axis internal scrolling.",
  async run({ page, shot }) {
    await nav(page, /^(?:产物|Artifacts)$/u, "artifacts-view");
    // FilterChips 原语不逐钮发 testid:按文案选中 raw facet(标准 §2.4 筛选按钮)。
    await page
      .getByTestId("artifacts-filters")
      .getByRole("button", { name: /^(?:Binary|二进制)/u })
      .click();
    await page.getByTestId("artifact-row-task-gui-smoke-artifacts/tables/inventory.xlsx").getByRole("button").click();
    const panel = page.getByTestId("document-spreadsheet-preview");
    await panel.waitFor();
    await page.getByTestId("spreadsheet-grid").waitFor();

    // 单元格内容是真的:中文表头、公式缓存值(1280 = 1000+280 的缓存结果)都在网格里。
    const firstCells = await panel.innerText();
    assert.match(firstCells, /表头1/u, `spreadsheet did not render header cells: ${firstCells.slice(0, 200)}`);
    assert.match(firstCells, /1280/u, "cached formula value is missing from the grid");
    assert.match(firstCells, /第510行45列/u, "the last row/column cell is missing — silent truncation");

    // 几何:宽表横滚、高表纵滚都发生在查看器自己的滚动容器里,页面不被撑长。
    const geometry = await page.evaluate(() => {
      const section = globalThis.document.querySelector('[data-testid="document-spreadsheet-preview"]');
      const scroller = section?.querySelector("[data-document-scroll]");
      if (section === null || scroller === null) return null;
      const box = section.getBoundingClientRect();
      const style = globalThis.getComputedStyle(section);
      return {
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        sectionHeight: Math.round(box.height),
        maxHeight: style.maxHeight,
      };
    });
    assert.notEqual(geometry, null, "spreadsheet frame or scroll container is missing");
    assert.ok(
      geometry.scrollWidth > geometry.clientWidth,
      `wide sheet must scroll horizontally inside the frame (scrollWidth ${geometry.scrollWidth} vs clientWidth ${geometry.clientWidth})`,
    );
    assert.ok(
      geometry.scrollHeight > geometry.clientHeight,
      `tall sheet must scroll vertically inside the frame (scrollHeight ${geometry.scrollHeight} vs clientHeight ${geometry.clientHeight})`,
    );
    // 边界:整框(工具栏+滚动区)被封在 --long-content-cap 里,内容高度不把页面撑长。
    const capPixels = Number.parseFloat(geometry.maxHeight);
    assert.ok(
      Number.isFinite(capPixels) && geometry.sectionHeight <= Math.ceil(capPixels) + 1,
      `frame height ${geometry.sectionHeight}px exceeds its --long-content-cap ${geometry.maxHeight}`,
    );
    await shot("spreadsheet-wide-tall");

    // 工作表切换:SegCtl 分段钮切到第二张表,明细值出现、汇总值让位。
    const sheetButtons = panel.locator('[role="group"][aria-label="工作表"] button');
    assert.deepEqual(await sheetButtons.allInnerTexts(), ["汇总", "明细"]);
    await sheetButtons.nth(1).click();
    await page.getByTestId("spreadsheet-grid").getByText("乙").waitFor();
    const detailText = await panel.innerText();
    assert.match(detailText, /明细/u);
    assert.doesNotMatch(detailText, /第510行45列/u, "summary sheet cells must leave when the detail sheet opens");
    assert.equal(await panel.getByRole("alert").count(), 0);
    await shot("spreadsheet-detail-sheet");
  },
};
