// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { openGuiCatalog } from "../src/gui-catalog.ts";
import { validateCatalogPreset, validateCatalogRereadReceipt, validateCatalogSnapshot } from "../src/gui-s3-control.ts";

test("GUI catalog projection uses canonical inventory without source paths or placeholders", async () => {
    const catalog = openGuiCatalog({ repoId: "catalog-test", rootDir: process.cwd() });
    const snapshot = await catalog.snapshot();
    assert.deepEqual(validateCatalogSnapshot(snapshot), []);
    assert.equal(snapshot.presets.length, 12);
    assert.equal(snapshot.presets.every((row) => !("source" in row)), true);
    assert.deepEqual(snapshot.adapters.map((row) => row.adapterId), ["local", "multica"]);
    const detail = await catalog.preset({ presetId: snapshot.presets[0]!.id });
    assert.deepEqual(validateCatalogPreset(detail), []);
    assert.doesNotMatch(JSON.stringify(detail), /packageSource/u);
    assert.deepEqual(validateCatalogRereadReceipt(await catalog.reread({ expectedDigest: snapshot.catalogDigest })), []);
});
