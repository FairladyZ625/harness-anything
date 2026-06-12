import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rendererCapabilityModel, rendererNavigation } from "../src/index.ts";

test("renderer model has no Node or Electron privileged surface", () => {
  assert.equal(rendererCapabilityModel.nodeGlobalsAvailable, false);
  assert.equal(rendererCapabilityModel.privilegedModulesAvailable, false);
  assert.equal(rendererCapabilityModel.receivesOnlyPreloadData, true);
  assert.deepEqual(rendererNavigation.map((item) => item.id), [
    "board",
    "list",
    "detail",
    "doc-viewer",
    "review-queue",
    "graph"
  ]);
});

test("renderer source does not import privileged modules", () => {
  const source = readFileSync("packages/gui/src/renderer/app-model.ts", "utf8");

  assert.equal(/\bfrom\s+["'](?:node:)?(?:fs|child_process|process|path|os|electron)["']/.test(source), false);
});
