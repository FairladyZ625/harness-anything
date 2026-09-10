import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

// A raw Task output — PDF, PNG, log — used to be invisible: the timeline walked for
// html/md only, and selecting such a file anywhere in the GUI rendered its empty body
// through the Markdown reader, i.e. a blank page indistinguishable from an empty file.
// This scenario is the visual claim behind the unit tests: in a real Electron window the
// binary row exists, and what it opens is metadata plus a byte route, not a white rectangle.
export default {
  id: "artifacts-raw-preview",
  feature: "sessions-artifacts",
  lane: "isolated",
  description: "A binary artifact is listed under the raw facet and previews as metadata, never a blank page.",
  async run({ page }) {
    await nav(page, /^(?:产物|Artifacts)$/u, "artifacts-view");
    await page.getByTestId("artifacts-filter-raw").click();
    await page.getByTestId("artifact-focus-task-gui-smoke-artifacts/reports/dossier.pdf").click();
    const panel = page.getByTestId("task-document-binary");
    await panel.waitFor();
    const preview = page.getByTestId("artifact-preview-content");
    // The defect itself: DocReader emits `.prose-harness`, and with an empty body that is the blank page.
    assert.equal(await preview.locator(".prose-harness").count(), 0, "a raw artifact must not render as prose");
    assert.equal(await preview.locator('[data-testid="html-artifact-webview"]').count(), 0);
    const text = await panel.innerText();
    assert.match(text, /application\/octet-stream/u, `binary panel did not state its media type: ${text}`);
    assert.match(text, /dossier\.pdf/u, `binary panel did not state where the bytes are: ${text}`);
    assert.match(text, /\b76\b/u, `binary panel did not state the real byte count: ${text}`);
    assert.equal(await page.getByTestId("task-document-binary-open").count(), 1);
  },
};
