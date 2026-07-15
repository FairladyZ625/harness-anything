import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { PresetManifestSchema, VerticalDefinitionSchema } from "../../../../kernel/src/index.ts";
import type { PresetDocumentFrontmatter } from "../../../../kernel/src/index.ts";
import { loadPresetDocument, type PresetDocumentWarning } from "./preset-document-loader.ts";
import { readTemplateCatalogFile, type TemplateCatalog } from "./template-catalog-loader.ts";

type VerticalDefinition = Schema.Schema.Type<typeof VerticalDefinitionSchema>;
type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;

interface BundledVerticalPackage {
  readonly id: string;
  readonly assetDirectory: string;
  readonly templateCatalogIds: ReadonlyArray<string>;
}

const bundledAssetsRoot = join(dirname(fileURLToPath(import.meta.url)), "assets");
const bundledVerticalPackages: ReadonlyArray<BundledVerticalPackage> = [{
  id: "software/coding",
  assetDirectory: "software-coding",
  templateCatalogIds: ["software-coding-core"]
}];
const defaultBundledVerticalId = "software/coding";

export interface BundledPresetManifestEntry {
  readonly manifest: PresetManifest;
  readonly sourcePath: string;
  readonly documentation?: PresetDocumentFrontmatter;
  readonly warnings: ReadonlyArray<PresetDocumentWarning>;
}

export interface BundledVerticalDefinitionEntry {
  readonly manifest: VerticalDefinition;
  readonly sourcePath: string;
}

export function bundledTemplateCatalog(id?: string): TemplateCatalog | undefined {
  const bundle = bundledVerticalPackages.find((candidate) => (
    candidate.id === (id ?? defaultBundledVerticalId) || candidate.templateCatalogIds.includes(id ?? "")
  ));
  return bundle ? readTemplateCatalogFile(assetPath(bundle, "template-catalog.json")) : undefined;
}

export function bundledVerticalDefinition(id?: string): VerticalDefinition | undefined {
  return bundledVerticalDefinitionEntry(id)?.manifest;
}

export function bundledVerticalDefinitionEntry(id?: string): BundledVerticalDefinitionEntry | undefined {
  const bundle = bundledVerticalPackages.find((candidate) => candidate.id === (id ?? defaultBundledVerticalId));
  if (!bundle) return undefined;
  const sourcePath = assetPath(bundle, "vertical.json");
  return {
    manifest: readBundledJson(bundle, "vertical.json", VerticalDefinitionSchema),
    sourcePath
  };
}

export function loadBundledPresetManifests(): ReadonlyArray<PresetManifest> {
  return loadBundledPresetManifestEntries().map((entry) => entry.manifest);
}

export function loadBundledPresetManifestEntries(): ReadonlyArray<BundledPresetManifestEntry> {
  return bundledVerticalPackages.flatMap((bundle) => {
    const index = readJson(bundle, "presets/index.json") as { readonly presets?: ReadonlyArray<string> };
    return (index.presets ?? []).map((presetId) => {
      const relativePath = `presets/${presetId}/preset.json`;
      const sourcePath = assetPath(bundle, relativePath);
      const document = loadPresetDocument(sourcePath);
      return {
        manifest: readBundledJson(bundle, relativePath, PresetManifestSchema),
        sourcePath,
        documentation: document.frontmatter,
        warnings: document.warnings
      };
    });
  });
}

export function bundledTaskTemplateSelections(): VerticalDefinition["templateSelections"] {
  const vertical = bundledVerticalDefinition();
  return vertical?.packageScaffolds.find((scaffold) => scaffold.entityKind === "task")?.templateSelections
    ?? vertical?.templateSelections
    ?? [];
}

function readBundledJson<A, I>(bundle: BundledVerticalPackage, relativePath: string, schema: Schema.Schema<A, I, never>): A {
  return Schema.decodeUnknownSync(schema)(readJson(bundle, relativePath));
}

function readJson(bundle: BundledVerticalPackage, relativePath: string): unknown {
  return JSON.parse(readFileSync(assetPath(bundle, relativePath), "utf8")) as unknown;
}

function assetPath(bundle: BundledVerticalPackage, relativePath: string): string {
  return join(bundledAssetsRoot, bundle.assetDirectory, relativePath);
}
