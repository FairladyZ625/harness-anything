import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { PresetManifestSchema, VerticalDefinitionSchema } from "../../../../kernel/src/index.ts";
import { readTemplateCatalogFile, type TemplateCatalog } from "./template-catalog-loader.ts";

type VerticalDefinition = Schema.Schema.Type<typeof VerticalDefinitionSchema>;
type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;

const assetRoot = join(dirname(fileURLToPath(import.meta.url)), "assets", "software-coding");

export interface BundledPresetManifestEntry {
  readonly manifest: PresetManifest;
  readonly sourcePath: string;
}

export interface BundledVerticalDefinitionEntry {
  readonly manifest: VerticalDefinition;
  readonly sourcePath: string;
}

export function bundledTemplateCatalog(id?: string): TemplateCatalog | undefined {
  if (id && id !== "software/coding" && id !== "software-coding-core") return undefined;
  return readTemplateCatalogFile(assetPath("template-catalog.json"));
}

export function bundledVerticalDefinition(id?: string): VerticalDefinition | undefined {
  return bundledVerticalDefinitionEntry(id)?.manifest;
}

export function bundledVerticalDefinitionEntry(id?: string): BundledVerticalDefinitionEntry | undefined {
  if (id && id !== "software/coding") return undefined;
  const sourcePath = assetPath("vertical.json");
  return {
    manifest: readBundledJson("vertical.json", VerticalDefinitionSchema),
    sourcePath
  };
}

export function loadBundledPresetManifests(): ReadonlyArray<PresetManifest> {
  return loadBundledPresetManifestEntries().map((entry) => entry.manifest);
}

export function loadBundledPresetManifestEntries(): ReadonlyArray<BundledPresetManifestEntry> {
  const index = readJson("presets/index.json") as { readonly presets?: ReadonlyArray<string> };
  return (index.presets ?? []).map((presetId) => {
    const sourcePath = assetPath(`presets/${presetId}/preset.json`);
    return {
      manifest: readBundledJson(`presets/${presetId}/preset.json`, PresetManifestSchema),
      sourcePath
    };
  });
}

export function bundledTaskTemplateSelections(): VerticalDefinition["templateSelections"] {
  const vertical = bundledVerticalDefinition();
  return vertical?.packageScaffolds.find((scaffold) => scaffold.entityKind === "task")?.templateSelections
    ?? vertical?.templateSelections
    ?? [];
}

function readBundledJson<A, I>(relativePath: string, schema: Schema.Schema<A, I, never>): A {
  return Schema.decodeUnknownSync(schema)(readJson(relativePath));
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(assetPath(relativePath), "utf8")) as unknown;
}

function assetPath(relativePath: string): string {
  return join(assetRoot, relativePath);
}
