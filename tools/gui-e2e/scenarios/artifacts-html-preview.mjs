import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

// The guest WebContents attaches asynchronously after the embedder element mounts, and it
// is the surface the reader actually sees — the element alone can be full height while the
// guest stays at Chromium's 150px default (display:block on the element does exactly that).
async function guestViewportHeight(app, scale) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const size = await app.evaluate(({ webContents }) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith("data:text/html;charset=utf-8,"));
      if (!guest) return { width: -1, height: -1 };
      return guest.capturePage().then((image) => image.getSize());
    });
    if (size.height > 0) return Math.round(size.height / scale);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return -1;
}

export default {
  id: "artifacts-html-preview",
  feature: "sessions-artifacts",
  lane: "isolated",
  description: "An HTML artifact preview fills its host box so long reports scroll inside the webview.",
  async run({ app, page }) {
    await nav(page, /^(?:产物|Artifacts)$/u, "artifacts-view");
    await page.getByTestId("artifact-focus-task-gui-smoke-artifacts/preview-height.html").click();
    await page.getByTestId("html-artifact-webview").waitFor();
    const measured = await page.evaluate(() => {
      const host = globalThis.document.querySelector('[data-testid="html-artifact-host"]');
      const webview = globalThis.document.querySelector('[data-testid="html-artifact-webview"]');
      const scale = globalThis.devicePixelRatio || 1;
      if (host === null || webview === null) return { host: -1, element: -1, scale };
      return {
        host: Math.round(host.getBoundingClientRect().height),
        element: Math.round(webview.getBoundingClientRect().height),
        scale,
      };
    });
    const guest = await guestViewportHeight(app, measured.scale);
    assert.ok(
      measured.element >= measured.host * 0.9,
      `webview element ${measured.element}px is under 90% of host ${measured.host}px`,
    );
    assert.ok(
      guest >= measured.host * 0.9,
      `webview guest viewport ${guest}px is under 90% of host ${measured.host}px` +
        ` (element ${measured.element}px) — the guest stopped tracking the element height`,
    );
  },
};
