import { extractMarkdownSection, type TaskDocumentPlaceholderPolicy, type TaskDocumentPlaceholderSectionFingerprint } from "../../../../application/src/index.ts";
import { bundledTemplateCatalog } from "../extensions/bundled.ts";
import { resolveTemplateCatalogBody, type TemplateCatalog } from "../extensions/template-catalog-loader.ts";

export function bundledTaskDocumentPlaceholderPolicy(): TaskDocumentPlaceholderPolicy {
  const catalog = bundledTemplateCatalog();
  return {
    closeoutPlaceholderFingerprints: documentPlaceholderFingerprintSets(catalog, "planning/closeout").flat().map((fingerprint) => fingerprint.body),
    taskPlanPlaceholderFingerprintSets: documentPlaceholderFingerprintSets(catalog, "planning/task-plan"),
    visualMapPlaceholderFingerprintSets: documentPlaceholderFingerprintSets(catalog, "planning/visual-map"),
    lessonCandidatesPlaceholderFingerprintSets: documentPlaceholderFingerprintSets(catalog, "planning/lesson-candidates")
  };
}

function documentPlaceholderFingerprintSets(
  catalog: TemplateCatalog | undefined,
  documentId: string
): ReadonlyArray<ReadonlyArray<TaskDocumentPlaceholderSectionFingerprint>> {
  const document = catalog?.documents?.find((candidate) => candidate.id === documentId);
  if (!catalog || !document) return [];
  const anchors = document.requiredAnchors ?? [];
  const fingerprintSets: TaskDocumentPlaceholderSectionFingerprint[][] = [];
  const resolveBody = resolveTemplateCatalogBody(catalog);
  const documentIndex = catalog.documents.indexOf(document);
  for (const [localeIndex, locale] of document.locales.entries()) {
    const body = resolveBody({ document, locale, documentIndex, localeIndex }) ?? "";
    const fingerprints: TaskDocumentPlaceholderSectionFingerprint[] = [];
    for (const anchor of anchors) {
      const section = extractMarkdownSection(body, anchor);
      if (section.length > 0) fingerprints.push({ anchor, body: section });
    }
    if (fingerprints.length > 0) fingerprintSets.push(fingerprints.sort((left, right) => left.anchor.localeCompare(right.anchor)));
  }
  return fingerprintSets.sort((left, right) => left[0]!.body.localeCompare(right[0]!.body));
}
