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
  assert.equal(cliPackage.exports?.["."], "./dist/cli/src/index.js");
  assert.equal(cliPackage.files?.includes("dist"), true);
  assert.equal(cliPackage.dependencies?.effect, "3.21.2");
  const cliEntry = path.resolve("packages/cli/src/index.ts");
  assert.equal(readFileSync(cliEntry, "utf8").startsWith("#!/usr/bin/env node"), true);
  assert.equal((statSync(cliEntry).mode & 0o111) !== 0, true);
});

test("bundled software coding assets have consistent template and process-preset surfaces", () => {
  const assetRoot = "packages/cli/src/commands/extensions/assets/software-coding";
  const catalog = JSON.parse(readFileSync(path.join(assetRoot, "template-catalog.json"), "utf8")) as {
    readonly documents: ReadonlyArray<{ readonly id: string; readonly materializeAs: string }>;
  };
  const vertical = JSON.parse(readFileSync(path.join(assetRoot, "vertical.json"), "utf8")) as {
    readonly templateSelections: ReadonlyArray<TemplateSelection>;
  };
  const index = JSON.parse(readFileSync(path.join(assetRoot, "presets/index.json"), "utf8")) as {
    readonly presets: ReadonlyArray<string>;
  };
  const catalogIds = new Set(catalog.documents.map((document) => document.id));
  const selectedMaterializedPaths = new Set<string>();
  const processPresetIds = new Set(["legacy-migration", "lesson-sedimentation", "milestone-closeout", "publish-standard", "release-closeout", "version-upgrade"]);
  const implementedProcessPresetIds = new Set(["legacy-migration", "milestone-closeout"]);

  for (const selection of vertical.templateSelections) {
    assertKnownTemplateRef(catalogIds, selection.templateRef);
    assert.equal(selectedMaterializedPaths.has(selection.materializeAs), false, `duplicate materialized path ${selection.materializeAs}`);
    selectedMaterializedPaths.add(selection.materializeAs);
  }

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
      assert.notEqual(Object.keys(manifest.entrypoints ?? {}).length, 0);
      for (const entrypoint of Object.values(manifest.entrypoints ?? {})) {
        const scriptEntrypoint = entrypoint as { readonly reads?: ReadonlyArray<string>; readonly writes?: ReadonlyArray<string> };
        assert.equal(scriptEntrypoint.reads?.includes("{{paths.rootDir}}/**") ?? false, false, `${presetId} declares repo-wide recursive reads`);
        assert.equal(scriptEntrypoint.writes?.includes("{{paths.rootDir}}/**") ?? false, false, `${presetId} declares repo-wide recursive writes`);
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
