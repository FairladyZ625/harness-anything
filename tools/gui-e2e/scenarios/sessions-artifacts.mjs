import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nav } from "./helpers.mjs";

export default {
  id: "sessions-artifacts",
  feature: "sessions-artifacts",
  lane: "isolated",
  description: "Session and artifact workspaces render the complete paginated artifact timeline.",
  async run({ page, fixture }) {
    const artifactsRoot = path.join(fixture.rootDir, "harness", fixture.packagePath, "artifacts"),
      older = new Date("2020-01-01T00:00:00.000Z");
    mkdirSync(artifactsRoot, { recursive: true });
    // Put an artifact beyond the first 100-row RPC page. The page must still load and
    // preview it through the ordinary daemon bridge, without a second query path.
    for (let index = 0; index < 101; index += 1) {
      const target = path.join(artifactsRoot, `pagination-${String(index).padStart(3, "0")}.html`);
      writeFileSync(target, `<h1>Pagination artifact ${index}</h1>`);
      utimesSync(target, older, older);
    }
    await nav(page, /^(?:会话|Sessions)$/u, "sessions-view");
    await nav(page, /^(?:产物|Artifacts)$/u, "artifacts-view");
    const final = page.getByTestId("artifact-row-task-gui-smoke-artifacts/pagination-100.html");
    await final.waitFor();
    assert.equal(await final.count(), 1);
    await final.getByRole("button").click();
    await page.getByTestId("html-artifact-webview").waitFor();
  },
};
