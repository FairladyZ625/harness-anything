import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const cliPackage = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
  readonly name: string;
  readonly private: boolean;
  readonly scripts?: Record<string, string>;
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, string>;
  readonly files?: readonly string[];
  readonly dependencies?: Record<string, string>;
  readonly publishConfig?: unknown;
};

test("CLI package exposes the harness-anything package artifact surface without publish config", () => {
  assert.equal(cliPackage.name, "@harness-anything/cli");
  assert.equal(cliPackage.private, true);
  assert.equal(cliPackage.publishConfig, undefined);
  assert.equal(cliPackage.scripts?.build, "tsc -p tsconfig.build.json && node scripts/copy-assets.mjs");
  assert.equal(cliPackage.bin?.["harness-anything"], "./dist/cli/src/index.js");
  assert.equal(cliPackage.bin?.ha, "./dist/cli/src/index.js");
  assert.equal(cliPackage.exports?.["."], "./dist/cli/src/index.js");
  assert.equal(cliPackage.files?.includes("dist"), true);
  assert.equal(cliPackage.dependencies?.["@effect/platform"], "0.96.2");
  assert.equal(cliPackage.dependencies?.effect, "3.21.4");
  const cliEntry = path.resolve("packages/cli/src/index.ts");
  assert.equal(readFileSync(cliEntry, "utf8").startsWith("#!/usr/bin/env node"), true);
  if (process.platform !== "win32") {
    assert.equal((statSync(cliEntry).mode & 0o111) !== 0, true);
  }
});

test("bundled software coding assets have consistent template and process-preset surfaces", () => {
  const assetRoot = "packages/cli/src/commands/extensions/assets/software-coding";
  const catalog = JSON.parse(readFileSync(path.join(assetRoot, "template-catalog.json"), "utf8")) as {
    readonly schema: string;
    readonly documents: ReadonlyArray<{
      readonly id: string;
      readonly materializeAs: string;
      readonly locales: ReadonlyArray<{ readonly locale: string; readonly body?: unknown; readonly bodyPath?: unknown }>;
    }>;
  };
  const vertical = JSON.parse(readFileSync(path.join(assetRoot, "vertical.json"), "utf8")) as {
    readonly templateSelections: ReadonlyArray<TemplateSelection>;
    readonly packageScaffolds: ReadonlyArray<{
      readonly entityKind: string;
      readonly templateSelections: ReadonlyArray<TemplateSelection>;
    }>;
    readonly repositoryScaffold: {
      readonly seededDocs: ReadonlyArray<TemplateSelection & { readonly body?: unknown; readonly path?: unknown }>;
    };
    readonly scripts: ReadonlyArray<{
      readonly id: string;
      readonly metadata: { readonly purpose: string };
    }>;
  };
  const index = JSON.parse(readFileSync(path.join(assetRoot, "presets/index.json"), "utf8")) as {
    readonly presets: ReadonlyArray<string>;
  };
  const catalogIds = new Set(catalog.documents.map((document) => document.id));
  const selectedMaterializedPaths = new Set<string>();
  const processPresetIds = new Set([
    "doc-canon-sync",
    "dogfood-utilization-audit",
    "legacy-migration",
    "lesson-sedimentation",
    "milestone-closeout",
    "milestone-dossier",
    "publish-standard",
    "release-closeout",
    "subtask-expansion",
    "version-upgrade"
  ]);
  const implementedProcessPresetIds = new Set([
    "doc-canon-sync",
    "dogfood-utilization-audit",
    "legacy-migration",
    "milestone-closeout",
    "milestone-dossier",
    "subtask-expansion"
  ]);

  assert.equal(catalog.schema, "template-catalog/v2");
  for (const document of catalog.documents) {
    for (const locale of document.locales) {
      assert.equal(locale.body, undefined, `${document.id} ${locale.locale} must not inline template body`);
      assert.equal(typeof locale.bodyPath, "string", `${document.id} ${locale.locale} must reference bodyPath`);
      assert.equal(statSync(path.join(assetRoot, String(locale.bodyPath))).isFile(), true, `${document.id} ${locale.locale} bodyPath must exist`);
    }
  }

  assert.equal(vertical.templateSelections.length, 0, "vertical top-level templateSelections stay deduplicated");
  const taskScaffoldSelections = vertical.packageScaffolds.find((scaffold) => scaffold.entityKind === "task")?.templateSelections ?? [];

  for (const selection of taskScaffoldSelections) {
    assertKnownTemplateRef(catalogIds, selection.templateRef);
    assert.equal(selectedMaterializedPaths.has(selection.materializeAs), false, `duplicate materialized path ${selection.materializeAs}`);
    selectedMaterializedPaths.add(selection.materializeAs);
  }

  for (const selection of vertical.repositoryScaffold.seededDocs) {
    assertKnownTemplateRef(catalogIds, selection.templateRef);
    assert.equal(selection.body, undefined, `${selection.templateRef} must not inline seeded doc body`);
    assert.equal(selection.path, undefined, `${selection.templateRef} must use materializeAs instead of path`);
  }
  assert.equal(vertical.scripts.some((script) => script.id === "vertical:software-coding:adr-seed" && script.metadata.purpose === "scaffold"), true);

  for (const presetId of index.presets) {
    const manifest = JSON.parse(readFileSync(path.join(assetRoot, "presets", presetId, "preset.json"), "utf8")) as PresetAsset;
    for (const profile of manifest.profiles) {
      const profilePaths = new Set<string>();
      for (const selection of profile.templateSelections) {
        assertKnownTemplateRef(catalogIds, selection.templateRef);
        assert.equal(profilePaths.has(selection.materializeAs), false, `duplicate ${presetId} materialized path ${selection.materializeAs}`);
        profilePaths.add(selection.materializeAs);
      }
    }
    if (processPresetIds.has(presetId)) {
      assert.equal(manifest.kind, "process-action");
      if (!implementedProcessPresetIds.has(presetId)) {
        assert.match(manifest.title, /Capability Smoke/u);
      }
    }
    if (manifest.kind === "process-action") {
      assert.notEqual(Object.keys(manifest.entrypoints ?? {}).length, 0);
      for (const entrypoint of Object.values(manifest.entrypoints ?? {})) {
        const scriptEntrypoint = entrypoint as { readonly command?: string; readonly reads?: ReadonlyArray<string>; readonly writes?: ReadonlyArray<string> };
        assert.equal(scriptEntrypoint.reads?.includes("{{paths.rootDir}}/**") ?? false, false, `${presetId} declares repo-wide recursive reads`);
        assert.equal(scriptEntrypoint.writes?.includes("{{paths.rootDir}}/**") ?? false, false, `${presetId} declares repo-wide recursive writes`);
        if (typeof scriptEntrypoint.command === "string") {
          assertPresetScriptImportsStayInsidePackage(path.join(assetRoot, "presets", presetId), scriptEntrypoint.command);
        }
      }
    }
  }
});

interface TemplateSelection {
  readonly templateRef: string;
  readonly materializeAs: string;
}

interface PresetAsset {
  readonly title: string;
  readonly kind?: string;
  readonly entrypoints?: Record<string, unknown>;
  readonly profiles: ReadonlyArray<{
    readonly templateSelections: ReadonlyArray<TemplateSelection>;
  }>;
}

function assertKnownTemplateRef(catalogIds: ReadonlySet<string>, templateRef: string): void {
  const match = /^template:\/\/(.+)@\d+$/u.exec(templateRef);
  assert.notEqual(match, null, `malformed template ref ${templateRef}`);
  assert.equal(catalogIds.has(match[1]), true, `unknown template ref ${templateRef}`);
}

function assertPresetScriptImportsStayInsidePackage(presetRoot: string, command: string): void {
  const scriptPath = path.resolve(presetRoot, command);
  const source = readFileSync(scriptPath, "utf8");
  const relativeImports = [...source.matchAll(/^\s*import\s+(?:[^"']+\s+from\s+)?["'](\.{1,2}\/[^"']+)["'];?/gmu)]
    .map((match) => match[1]);
  for (const specifier of relativeImports) {
    const target = path.resolve(path.dirname(scriptPath), specifier);
    const relative = path.relative(path.resolve(presetRoot), target);
    assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false, `${command} imports outside preset package: ${specifier}`);
  }
}
