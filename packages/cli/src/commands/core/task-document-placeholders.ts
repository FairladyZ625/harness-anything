import type { TaskDocumentPlaceholderPolicy } from "../../../../application/src/index.ts";
import { bundledTemplateCatalog } from "../extensions/bundled.ts";

interface TemplateCatalogDocument {
  readonly id: string;
  readonly requiredAnchors?: ReadonlyArray<string>;
  readonly locales?: ReadonlyArray<{
    readonly body?: string;
  }>;
}

interface TemplateCatalogLike {
  readonly documents?: ReadonlyArray<TemplateCatalogDocument>;
}

export function bundledTaskDocumentPlaceholderPolicy(): TaskDocumentPlaceholderPolicy {
  const catalog = bundledTemplateCatalog() as TemplateCatalogLike | undefined;
  return {
    closeoutPlaceholderFingerprints: closeoutPlaceholderFingerprints(catalog)
  };
}

function closeoutPlaceholderFingerprints(catalog: TemplateCatalogLike | undefined): ReadonlyArray<string> {
  const closeout = catalog?.documents?.find((document) => document.id === "planning/closeout");
  if (!closeout) return [];
  const anchors = closeout.requiredAnchors ?? [];
  const fingerprints = new Set<string>();
  for (const locale of closeout.locales ?? []) {
    for (const anchor of anchors) {
      const section = extractSection(locale.body ?? "", anchor);
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
