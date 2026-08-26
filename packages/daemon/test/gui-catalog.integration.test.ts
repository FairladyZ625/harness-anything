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
  assert.equal(
    snapshot.presets.every((row) => !("source" in row)),
    true,
  );
  assert.deepEqual(
    snapshot.adapters.map((row) => row.adapterId),
    ["local", "multica"],
  );
  const detail = await catalog.preset({ presetId: snapshot.presets[0]!.id });
  assert.deepEqual(validateCatalogPreset(detail), []);
  assert.doesNotMatch(JSON.stringify(detail), /packageSource/u);
  assert.deepEqual(validateCatalogRereadReceipt(await catalog.reread({ expectedDigest: snapshot.catalogDigest })), []);
});

test("GUI catalog preset read carries resolver document bodies (route A: single read surface)", async () => {
  const catalog = openGuiCatalog({ repoId: "catalog-test", rootDir: process.cwd() });
  const snapshot = await catalog.snapshot();
  const detail = (await catalog.preset({ presetId: snapshot.presets[0]!.id })) as {
    readonly resolved: {
      readonly documents: ReadonlyArray<{
        readonly slot: string;
        readonly path: string;
        readonly body: string;
        readonly mediaType: string;
      }>;
    };
  };
  // 包内文档正文是详情页的唯一内容来源:每行都有非空 body 与合法 mediaType。
  assert.ok(detail.resolved.documents.length > 0);
  for (const document of detail.resolved.documents) {
    assert.equal(typeof document.slot, "string");
    assert.equal(typeof document.path, "string");
    assert.ok(document.body.length > 0);
    assert.ok(["text/markdown", "text/plain"].includes(document.mediaType));
  }
  // 闭形状 fail-closed:缺 documents 字段或 body 不是字符串都拒收。
  const withoutDocuments = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>,
    resolved = withoutDocuments.resolved as Record<string, unknown>;
  delete resolved.documents;
  assert.ok(validateCatalogPreset(withoutDocuments).some((error) => error.includes("documents")));
  const withBadBody = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>,
    badResolved = withBadBody.resolved as { documents: ReadonlyArray<Record<string, unknown>> };
  badResolved.documents[0]!.body = 42;
  assert.ok(validateCatalogPreset(withBadBody).some((error) => error.includes("catalog preset document")));
});
