import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Schema } from "effect";
import {
  PresetManifestSchema,
  TemplateCatalogSchema,
  VerticalDefinitionSchema,
  type PresetManifest,
  type TemplateCatalog,
  type VerticalDefinition
} from "../../src/schemas/registry.ts";
import {
  planTemplateMaterialization,
  validatePresetManifests,
  validateTemplateCatalog,
  validateVerticalDefinition
} from "../../src/domain/extension-model.ts";

const templateCatalogUrl = new URL("../../fixtures/schemas/template-catalog/valid.json", import.meta.url);
const presetManifestUrl = new URL("../../fixtures/schemas/preset-manifest/valid.json", import.meta.url);
const verticalDefinitionUrl = new URL("../../fixtures/schemas/vertical-definition/valid.json", import.meta.url);

test("vertical, preset, and template schemas decode clean-room extension fixtures", async () => {
  const catalog = Schema.decodeUnknownSync(TemplateCatalogSchema)(await readFixture(templateCatalogUrl));
  const preset = Schema.decodeUnknownSync(PresetManifestSchema)(await readFixture(presetManifestUrl));
  const vertical = Schema.decodeUnknownSync(VerticalDefinitionSchema)(await readFixture(verticalDefinitionUrl));

  assert.equal(validateTemplateCatalog(catalog).ok, true);
  assert.equal(validatePresetManifests([preset], { kernelVersion: "1.0.0" }).ok, true);
  assert.equal(validateVerticalDefinition(vertical).ok, true);
});

test("template catalog validation fails closed on locale structure drift", async () => {
  const catalog = Schema.decodeUnknownSync(TemplateCatalogSchema)(await readFixture(templateCatalogUrl));
  const drifted: TemplateCatalog = {
    ...catalog,
    documents: [{
      ...catalog.documents[0],
      locales: catalog.documents[0].locales.map((variant) => variant.locale === "zh-CN"
        ? { ...variant, anchors: ["## Goal", "## Steps"], body: "## Goal\n\n## Steps\n" }
        : variant)
    }]
  };

  const result = validateTemplateCatalog(drifted);

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "template_locale_structure_mismatch"), true);
  assert.equal(result.issues.some((issue) => issue.code === "missing_required_anchor"), true);
});

test("template materialization plans locale fallback without writing documents", async () => {
  const catalog = Schema.decodeUnknownSync(TemplateCatalogSchema)(await readFixture(templateCatalogUrl));
  const enOnlyCatalog: TemplateCatalog = {
    ...catalog,
    documents: [{
      ...catalog.documents[0],
      locales: catalog.documents[0].locales.filter((variant) => variant.locale === "en-US")
    }]
  };
  const result = planTemplateMaterialization({
    catalog: enOnlyCatalog,
    locale: "zh-CN",
    selections: [{
      slot: "task.flow",
      templateRef: "template://planning/task-flow@1",
      materializeAs: "task_flow.md",
      localePolicy: {
        prefer: "project",
        fallback: "en-US"
      }
    }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.documents[0].fallbackUsed, true);
  assert.equal(result.documents[0].locale, "en-US");
  assert.match(result.documents[0].body, /## Goal/);
});

test("preset validation fails closed on conflicts, cycles, and kernel version mismatch", async () => {
  const base = Schema.decodeUnknownSync(PresetManifestSchema)(await readFixture(presetManifestUrl));
  const conflicting: PresetManifest = {
    ...base,
    capabilityImports: [
      ...base.capabilityImports,
      {
        id: "schema-contracts",
        kind: "checker",
        version: "2",
        required: true
      }
    ]
  };
  const parent: PresetManifest = { ...base, id: "parent", extends: "child" };
  const child: PresetManifest = { ...base, id: "child", extends: "parent" };
  const incompatible: PresetManifest = {
    ...base,
    kernelVersionRange: {
      min: "2.0.0",
      maxExclusive: "3.0.0"
    }
  };

  const result = validatePresetManifests([conflicting, parent, child, incompatible], { kernelVersion: "1.0.0" });

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "duplicate_capability"), true);
  assert.equal(result.issues.some((issue) => issue.code === "preset_extends_cycle"), true);
  assert.equal(result.issues.some((issue) => issue.code === "incompatible_kernel"), true);
});

test("vertical validation rejects lifecycle status mapping ownership", async () => {
  const vertical = Schema.decodeUnknownSync(VerticalDefinitionSchema)(await readFixture(verticalDefinitionUrl));
  const contaminated: VerticalDefinition = {
    ...vertical,
    checkerProfile: `status${"Mapping"}`
  };
  const result = validateVerticalDefinition(contaminated);

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "status_mapping_forbidden"), true);
});

test("vertical validation accepts decision lifecycle and fact schema entity kinds", async () => {
  const vertical = Schema.decodeUnknownSync(VerticalDefinitionSchema)(await readFixture(verticalDefinitionUrl));
  const byId = new Map(vertical.entityKinds.map((entity) => [entity.id, entity]));

  assert.deepEqual([...byId.keys()], ["task", "decision", "fact"]);
  assert.equal(byId.get("decision")?.entityType, "lifecycle");
  assert.equal(byId.get("fact")?.entityType, "schema");
  assert.deepEqual(vertical.contractEntityKinds, ["task", "decision", "fact"]);
  assert.equal(validateVerticalDefinition(vertical).ok, true);
});

test("vertical schema rejects composite entity kinds in M3", async () => {
  const vertical = await readFixture(verticalDefinitionUrl) as Record<string, any>;
  vertical.entityKinds = [
    ...vertical.entityKinds,
    {
      id: "milestone",
      entityType: "composite",
      contractEntity: true
    }
  ];

  assert.throws(() => Schema.decodeUnknownSync(VerticalDefinitionSchema)(vertical));
});

test("vertical validation rejects schema entity package scaffolds", async () => {
  const vertical = Schema.decodeUnknownSync(VerticalDefinitionSchema)(await readFixture(verticalDefinitionUrl));
  const contaminated: VerticalDefinition = {
    ...vertical,
    packageScaffolds: [
      ...vertical.packageScaffolds,
      {
        entityKind: "fact",
        templateSelections: []
      }
    ]
  };
  const result = validateVerticalDefinition(contaminated);

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "vertical_schema_scaffold_forbidden"), true);
});

test("vertical validation rejects lifecycle entities without package scaffolds", async () => {
  const vertical = Schema.decodeUnknownSync(VerticalDefinitionSchema)(await readFixture(verticalDefinitionUrl));
  const contaminated: VerticalDefinition = {
    ...vertical,
    packageScaffolds: vertical.packageScaffolds.filter((scaffold) => scaffold.entityKind !== "decision")
  };
  const result = validateVerticalDefinition(contaminated);

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "vertical_lifecycle_scaffold_missing"), true);
});

test("vertical validation rejects contract entity declarations that are not contract-bearing", async () => {
  const vertical = Schema.decodeUnknownSync(VerticalDefinitionSchema)(await readFixture(verticalDefinitionUrl));
  const contaminated: VerticalDefinition = {
    ...vertical,
    entityKinds: vertical.entityKinds.map((entity) => entity.id === "decision" ? { ...entity, contractEntity: false } : entity)
  };
  const result = validateVerticalDefinition(contaminated);

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "vertical_contract_entity_disabled"), true);
});

async function readFixture(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}
