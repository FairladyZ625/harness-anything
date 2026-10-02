import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

// A raw Task output — PDF, PNG, log — used to be invisible: the timeline walked for
// html/md only, and selecting such a file anywhere in the GUI rendered its empty body
// through the Markdown reader, i.e. a blank page indistinguishable from an empty file.
// This scenario is the visual claim behind the unit tests: in a real Electron window the
// binary row exists, and opening it paints actual PDF page pixels, not a blank rectangle.
export default {
  id: "artifacts-raw-preview",
  feature: "sessions-artifacts",
  lane: "isolated",
  description:
    "A binary artifact is listed under the raw facet and renders a real PDF page through the document read path.",
  async run({ page, shot }) {
    await nav(page, /^(?:产物|Artifacts)$/u, "artifacts-view");
    // FilterChips 原语不逐钮发 testid:按文案选中 raw facet(标准 §2.4 筛选按钮)。
    await page
      .getByTestId("artifacts-filters")
      .getByRole("button", { name: /^(?:Binary|二进制)/u })
      .click();
    // 行是 DenseRow:testid 在行壳上,点其内按钮打开预览。
    await page.getByTestId("artifact-row-task-gui-smoke-artifacts/reports/dossier.pdf").getByRole("button").click();
    const panel = page.getByTestId("task-document-binary");
    await panel.waitFor();
    const preview = page.getByTestId("artifact-preview-content");
    // The defect itself: DocReader emits `.prose-harness`, and with an empty body that is the blank page.
    assert.equal(await preview.locator(".prose-harness").count(), 0, "a raw artifact must not render as prose");
    assert.equal(await preview.locator('[data-testid="html-artifact-webview"]').count(), 0);
    await panel.locator("summary").click();
    const text = await panel.innerText();
    assert.match(text, /application\/pdf/u, `binary panel did not state its media type: ${text}`);
    assert.match(text, /dossier\.pdf/u, `binary panel did not state where the bytes are: ${text}`);
    await page.waitForFunction(() => {
      const canvas = globalThis.document.querySelector("[data-pdf-pages] canvas");
      if (!canvas) return false;
      const pixel = canvas.getContext("2d").getImageData(100, 100, 1, 1).data;
      return pixel[0] < 20 && pixel[1] > 100 && pixel[2] > 100 && pixel[3] === 255;
    });
    assert.equal(await panel.getByRole("alert").count(), 0);
    await shot("pdf-rendered");
    assert.equal(await page.getByTestId("task-document-binary-open").count(), 1);
  },
};
