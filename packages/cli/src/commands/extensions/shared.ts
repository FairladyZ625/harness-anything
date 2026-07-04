import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
  PresetManifestSchema,
  TemplateCatalogSchema,
  VerticalDefinitionSchema,
  validateExtensionInputShape
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode, type CliErrorCode as CliErrorCodeValue } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import { bundledTemplateCatalog, bundledVerticalDefinition } from "./bundled.ts";
import { decodeTemplateCatalogFile } from "./template-catalog-loader.ts";

export function decodeTemplateCatalog(catalogPath?: string): { readonly ok: true; readonly value: Schema.Schema.Type<typeof TemplateCatalogSchema> } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  const bundled = catalogPath ? bundledTemplateCatalog(catalogPath) : bundledTemplateCatalog();
  if (bundled) return { ok: true, value: bundled };
  if (!catalogPath) return { ok: false, issues: [{ code: "template_catalog_not_found", path: "$", message: "Bundled template catalog was not found." }] };
  return decodeTemplateCatalogFile(catalogPath);
}

export function decodeVerticalDefinition(definitionPath?: string): { readonly ok: true; readonly value: Schema.Schema.Type<typeof VerticalDefinitionSchema> } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  const bundled = definitionPath ? bundledVerticalDefinition(definitionPath) : bundledVerticalDefinition();
  if (bundled) return { ok: true, value: bundled };
  if (!definitionPath) return { ok: false, issues: [{ code: "vertical_definition_not_found", path: "$", message: "Bundled vertical definition was not found." }] };
  return decodeExtensionJsonFile("vertical-definition", definitionPath, VerticalDefinitionSchema);
}

export function decodePresetManifest(manifestPath: string): { readonly ok: true; readonly value: Schema.Schema.Type<typeof PresetManifestSchema> } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  return decodeExtensionJsonFile("preset-manifest", manifestPath, PresetManifestSchema);
}

export function decodeExtensionJsonFile<A, I>(
  kind: "template-catalog" | "preset-manifest" | "vertical-definition",
  filePath: string,
  schema: Schema.Schema<A, I, never>
): { readonly ok: true; readonly value: A } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  const inputPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  const shape = validateExtensionInputShape(kind, raw);
  if (!shape.ok) {
    return { ok: false, issues: shape.issues };
  }
  return { ok: true, value: Schema.decodeUnknownSync(schema)(raw) };
}

export function invalidExtensionResult(command: string, code: CliErrorCodeValue, hint: string, issues: ReadonlyArray<unknown>): CliResult {
  return {
    ok: false,
    command,
    issues,
    error: cliError(code, hint)
  };
}

export function invalidResolvedPresetResult(command: string, preset: { readonly id: string; readonly layer: string; readonly issues: ReadonlyArray<unknown> }): CliResult {
  return {
    ok: false,
    command,
    preset: {
      id: preset.id,
      layer: preset.layer,
      valid: false
    },
    issues: preset.issues,
    error: cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
  };
}

export function writeIfMissing(filePath: string, body: string): void {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}
