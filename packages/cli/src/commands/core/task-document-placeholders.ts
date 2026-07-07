import type { TaskDocumentPlaceholderPolicy } from "../../../../application/src/index.ts";
import { bundledTemplateCatalog } from "../extensions/bundled.ts";
import { resolveTemplateCatalogBody, type TemplateCatalog } from "../extensions/template-catalog-loader.ts";

export function bundledTaskDocumentPlaceholderPolicy(): TaskDocumentPlaceholderPolicy {
  const catalog = bundledTemplateCatalog();
  return {
    closeoutPlaceholderFingerprints: closeoutPlaceholderFingerprints(catalog)
  };
}

function closeoutPlaceholderFingerprints(catalog: TemplateCatalog | undefined): ReadonlyArray<string> {
  const closeout = catalog?.documents?.find((document) => document.id === "planning/closeout");
  if (!catalog || !closeout) return [];
  const anchors = closeout.requiredAnchors ?? [];
  const fingerprints = new Set<string>();
  const resolveBody = resolveTemplateCatalogBody(catalog);
  const documentIndex = catalog.documents.indexOf(closeout);
  for (const [localeIndex, locale] of closeout.locales.entries()) {
    const body = resolveBody({ document: closeout, locale, documentIndex, localeIndex }) ?? "";
    for (const anchor of anchors) {
      const section = extractSection(body, anchor);
      if (section.length > 0) fingerprints.add(section);
    }
  }
  return [...fingerprints].sort();
}

function extractSection(markdown: string, anchor: string): string {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === anchor);
  if (start < 0) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/u.test(line.trim())) break;
    if (line.trim().length > 0) body.push(line.trim());
  }
  return body.join("\n").trim();
}
