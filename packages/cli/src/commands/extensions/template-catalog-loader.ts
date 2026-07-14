import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
  type TemplateBodyResolver,
  TemplateCatalogSchema,
  validateExtensionInputShape
} from "../../../../kernel/src/index.ts";
import { isPathInside, isSafeBodyPath } from "../../cli/path.ts";

export type TemplateCatalog = Schema.Schema.Type<typeof TemplateCatalogSchema>;

const templateCatalogBodies = new WeakMap<TemplateCatalog, ReadonlyMap<string, string>>();

export function decodeTemplateCatalogFile(filePath: string): { readonly ok: true; readonly value: TemplateCatalog } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  const inputPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  const bodyAssets = readTemplateCatalogBodyAssets(raw, inputPath);
  if (!bodyAssets.ok) return bodyAssets;
  const shape = validateExtensionInputShape("template-catalog", raw);
  if (!shape.ok) return { ok: false, issues: shape.issues };
  const value = Schema.decodeUnknownSync(TemplateCatalogSchema)(raw);
  templateCatalogBodies.set(value, bodyAssets.value);
  return { ok: true, value };
}

export function readTemplateCatalogFile(filePath: string): TemplateCatalog {
  const decoded = decodeTemplateCatalogFile(filePath);
  if (decoded.ok) return decoded.value;
  throw new Error(`template catalog failed validation: ${decoded.issues.map(renderIssue).join(", ")}`);
}

export function resolveTemplateCatalogBody(catalog: TemplateCatalog): TemplateBodyResolver {
  return ({ locale }) => templateCatalogBodies.get(catalog)?.get(locale.bodyPath);
}

function readTemplateCatalogBodyAssets(input: unknown, inputPath: string): { readonly ok: true; readonly value: ReadonlyMap<string, string> } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  if (isTemplateCatalogRecord(input) && input.schema === "template-catalog/v1") {
    return {
      ok: false,
      issues: [issue("template_catalog_v1_unsupported", "template-catalog/v1 is no longer supported; upgrade locales from inline body to bodyPath.", "$.schema")]
    };
  }
  if (!isTemplateCatalogRecord(input) || input.schema !== "template-catalog/v2") {
    return { ok: true, value: new Map() };
  }

  const catalogDir = path.dirname(inputPath);
  const issues: unknown[] = [];
  const bodies = new Map<string, string>();
  if (Array.isArray(input.documents)) {
    for (const [documentIndex, document] of input.documents.entries()) {
      readDocumentBodyAssets(document, documentIndex, catalogDir, bodies, issues);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: bodies };
}

function readDocumentBodyAssets(document: unknown, documentIndex: number, catalogDir: string, bodies: Map<string, string>, issues: unknown[]): void {
  if (!isTemplateCatalogRecord(document) || !Array.isArray(document.locales)) return;
  for (const [localeIndex, locale] of document.locales.entries()) {
    readLocaleBodyAsset(locale, documentIndex, localeIndex, catalogDir, bodies, issues);
  }
}

function readLocaleBodyAsset(locale: unknown, documentIndex: number, localeIndex: number, catalogDir: string, bodies: Map<string, string>, issues: unknown[]): void {
  if (!isTemplateCatalogRecord(locale)) return;
  const issuePath = `documents[${documentIndex}].locales[${localeIndex}].bodyPath`;
  if ("body" in locale) {
    issues.push(issue("template_body_inline_forbidden", "template-catalog/v2 locales must use bodyPath, not inline body.", `documents[${documentIndex}].locales[${localeIndex}].body`));
  }
  if (typeof locale.bodyPath !== "string") {
    issues.push(issue("template_body_path_missing", "template-catalog/v2 locale is missing bodyPath.", issuePath));
    return;
  }
  if (!isSafeBodyPath(locale.bodyPath)) {
    issues.push(issue("template_body_path_invalid", "Template bodyPath must be a safe relative .md path.", issuePath));
    return;
  }
  const resolved = path.resolve(catalogDir, locale.bodyPath);
  if (!isPathInside(catalogDir, resolved)) {
    issues.push(issue("template_body_path_invalid", "Template bodyPath must stay inside the catalog directory.", issuePath));
    return;
  }
  if (!existsSync(resolved)) {
    issues.push(issue("template_body_asset_missing", "Template bodyPath does not exist.", issuePath));
    return;
  }
  bodies.set(locale.bodyPath, readFileSync(resolved, "utf8"));
}

function isTemplateCatalogRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: string, message: string, issuePath: string): unknown {
  return { code, message, path: issuePath };
}

function renderIssue(issueValue: unknown): string {
  if (isTemplateCatalogRecord(issueValue) && typeof issueValue.code === "string") return issueValue.code;
  return String(issueValue);
}
