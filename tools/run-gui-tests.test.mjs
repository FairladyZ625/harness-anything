import assert from "node:assert/strict";
import test from "node:test";
import { guiVitestManifest } from "./gui-test-manifest.mjs";
import { validateGuiVitestManifest } from "./gui-test-runner-lib.mjs";

test("GUI Vitest manifest accepts classified GUI tests", () => {
  assert.deepEqual(validateGuiVitestManifest([...guiVitestManifest], guiVitestManifest), { errors: [] });
});

test("GUI Vitest manifest fails closed on unclassified files", () => {
  assert.deepEqual(
    validateGuiVitestManifest(
      ["packages/gui/test/renderer-app-model.vitest.ts", "packages/gui/test/new-renderer.vitest.ts"],
      ["packages/gui/test/renderer-app-model.vitest.ts"]
    ),
    { errors: ["GUI Vitest file missing from manifest: packages/gui/test/new-renderer.vitest.ts"] }
  );
});

test("GUI Vitest manifest rejects missing and duplicate entries", () => {
  assert.deepEqual(
    validateGuiVitestManifest(["packages/gui/test/renderer-app-model.vitest.ts"], [
      "packages/gui/test/renderer-app-model.vitest.ts",
      "packages/gui/test/renderer-app-model.vitest.ts",
      "packages/gui/test/missing.vitest.ts"
    ]),
    {
      errors: [
        "GUI Vitest file appears more than once in manifest: packages/gui/test/renderer-app-model.vitest.ts",
        "GUI Vitest manifest references missing file: packages/gui/test/missing.vitest.ts"
      ]
    }
  );
});
