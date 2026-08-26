// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_SETTINGS_V1 } from "../../kernel/src/index.ts";
import { openGuiCatalog } from "../src/gui-catalog.ts";
import { validateCatalogPreset, validateCatalogRereadReceipt, validateCatalogSnapshot } from "../src/gui-s3-control.ts";

const openCatalog = () =>
  openGuiCatalog({ repoId: "catalog-test", rootDir: process.cwd(), readSettings: () => INITIAL_SETTINGS_V1 });

test("GUI catalog projection uses canonical inventory without source paths or placeholders", async () => {
  const catalog = openCatalog();
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
  const catalog = openCatalog();
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

test("GUI catalog preset read carries only detail-page consumed fields (review#4 §10.1 narrowing)", async () => {
  const catalog = openCatalog();
  const snapshot = await catalog.snapshot();
  const detail = (await catalog.preset({ presetId: snapshot.presets[0]!.id })) as {
    readonly preset: Record<string, unknown>;
    readonly resolved: {
      readonly documents: ReadonlyArray<Record<string, unknown>>;
    } & Record<string, unknown>;
  };
  // 读面收窄:详情页无消费者的字段不出现在 daemon response(GUI 消费者集合见
  // PresetDetailView.tsx / components/presetDetail/)。
  assert.equal("title" in detail.preset, false);
  assert.equal("profiles" in detail.preset, false);
  assert.equal("identity" in detail.resolved, false);
  for (const document of detail.resolved.documents) assert.equal("requiredAnchors" in document, false);
  // 闭形状 fail-closed:把删掉的字段塞回去必须被拒(每个字段一行否定对照)。
  const readded = JSON.parse(JSON.stringify(detail)) as {
    preset: Record<string, unknown>;
    resolved: { documents: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>;
  };
  readded.preset.title = "narrowed";
  readded.preset.profiles = [];
  readded.resolved.identity = {};
  readded.resolved.documents[0]!.requiredAnchors = [];
  const errors = validateCatalogPreset(readded);
  for (const field of ["manifest.title", "manifest.profiles", "resolved.identity", "document.requiredAnchors"])
    assert.ok(
      errors.some((error) => error.includes(field)),
      `${field} must be rejected by the closed shape: ${JSON.stringify(errors)}`,
    );
});
