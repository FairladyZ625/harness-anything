import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
  TemplateCatalogSchema,
  validateExtensionInputShape
} from "../../../../kernel/src/index.ts";
import { isPathInside } from "../../cli/path.ts";

export type TemplateCatalog = Schema.Schema.Type<typeof TemplateCatalogSchema>;

export function decodeTemplateCatalogFile(filePath: string): { readonly ok: true; readonly value: TemplateCatalog } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  const inputPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  const hydrated = hydrateTemplateCatalog(raw, inputPath);
  if (!hydrated.ok) return hydrated;
  const shape = validateExtensionInputShape("template-catalog", hydrated.value);
  if (!shape.ok) return { ok: false, issues: shape.issues };
  return { ok: true, value: Schema.decodeUnknownSync(TemplateCatalogSchema)(hydrated.value) };
}

export function readTemplateCatalogFile(filePath: string): TemplateCatalog {
  const decoded = decodeTemplateCatalogFile(filePath);
  if (decoded.ok) return decoded.value;
  throw new Error(`template catalog failed validation: ${decoded.issues.map(renderIssue).join(", ")}`);
}

function hydrateTemplateCatalog(input: unknown, inputPath: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly issues: ReadonlyArray<unknown> } {
  if (!isTemplateCatalogRecord(input) || input.schema !== "template-catalog/v2") {
    return { ok: true, value: input };
  }

  const catalogDir = path.dirname(inputPath);
  const issues: unknown[] = [];
  const documents = Array.isArray(input.documents)
    ? input.documents.map((document, documentIndex) => hydrateDocument(document, documentIndex, catalogDir, issues))
    : input.documents;

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      ...input,
      schema: "template-catalog/v1",
      documents
    }
  };
}

function hydrateDocument(document: unknown, documentIndex: number, catalogDir: string, issues: unknown[]): unknown {
  if (!isTemplateCatalogRecord(document) || !Array.isArray(document.locales)) return document;
  return {
    ...document,
    locales: document.locales.map((locale, localeIndex) => hydrateLocale(locale, documentIndex, localeIndex, catalogDir, issues))
  };
}

function hydrateLocale(locale: unknown, documentIndex: number, localeIndex: number, catalogDir: string, issues: unknown[]): unknown {
  if (!isTemplateCatalogRecord(locale)) return locale;
  const issuePath = `documents[${documentIndex}].locales[${localeIndex}].bodyPath`;
  if ("body" in locale) {
    issues.push(issue("template_body_inline_forbidden", "template-catalog/v2 locales must use bodyPath, not inline body.", `documents[${documentIndex}].locales[${localeIndex}].body`));
  }
  if (typeof locale.bodyPath !== "string") {
    issues.push(issue("template_body_path_missing", "template-catalog/v2 locale is missing bodyPath.", issuePath));
    return locale;
  }
  if (!isSafeBodyPath(locale.bodyPath)) {
    issues.push(issue("template_body_path_invalid", "Template bodyPath must be a safe relative .md path.", issuePath));
    return locale;
  }
  const resolved = path.resolve(catalogDir, locale.bodyPath);
  if (!isPathInside(catalogDir, resolved)) {
    issues.push(issue("template_body_path_invalid", "Template bodyPath must stay inside the catalog directory.", issuePath));
    return locale;
  }
  if (!existsSync(resolved)) {
    issues.push(issue("template_body_asset_missing", "Template bodyPath does not exist.", issuePath));
    return locale;
  }
  const { bodyPath: _bodyPath, ...rest } = locale;
  return {
    ...rest,
    body: readFileSync(resolved, "utf8")
  };
}

function isSafeBodyPath(value: string): boolean {
  if (path.isAbsolute(value) || value.includes("\\") || !value.endsWith(".md")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
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
