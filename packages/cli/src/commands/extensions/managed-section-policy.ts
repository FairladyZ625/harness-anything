import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  readFrontmatter,
  readScalar,
  markdownHeadingSections,
  resolveHarnessLayout,
  type HarnessLayoutInput,
  type SemanticDiffDocumentPolicy
} from "@harness-anything/kernel";
import { bundledTemplateCatalog } from "./bundled.ts";
import { materializePresetTaskDocuments, resolvePresetEntry } from "./state.ts";

export function resolveManagedSectionPolicy(
  rootInput: HarnessLayoutInput,
  documentPath: string
): SemanticDiffDocumentPolicy | null {
  const normalized = documentPath.split(path.sep).join("/");
  if (/^decisions\/decision-[^/]+\/decision\.md$/u.test(normalized)) {
    const declaration = bundledTemplateCatalog("software/coding")?.documents.find((document) => document.id === "entity/decision-body");
    return declaration ? { path: normalized, sections: declaration.sectionPermissions } : null;
  }
  const taskMatch = /^(tasks\/[^/]+)\/(.+)$/u.exec(normalized);
  if (!taskMatch?.[1] || !taskMatch[2] || taskMatch[2] === "INDEX.md") return null;
  const layout = resolveHarnessLayout(rootInput);
  const indexPath = path.join(layout.authoredRoot, taskMatch[1], "INDEX.md");
  if (!existsSync(indexPath)) return null;
  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  if (!frontmatter) return null;
  const vertical = readScalar(frontmatter, "vertical") || "software/coding";
  const presetId = readScalar(frontmatter, "preset");
  if (!presetId) return null;
  const preset = resolvePresetEntry(rootInput, presetId, vertical);
  if (preset && !("issues" in preset)) {
    const materialized = materializePresetTaskDocuments(preset.manifest, {
      profileId: readScalar(frontmatter, "profile") || undefined,
      locale: "zh-CN"
    });
    const declaration = materialized.ok
      ? materialized.documents.find((document) => document.materializeAs === taskMatch[2])
      : undefined;
    if (declaration) return taskDocumentPolicy(normalized, declaration.sectionPermissions);
  }
  const documentAbsolutePath = path.join(layout.authoredRoot, normalized);
  if (!existsSync(documentAbsolutePath)) return null;
  const documentBody = readFileSync(documentAbsolutePath, "utf8");
  const headings = markdownHeadingSections(documentBody).map((section) => section.anchor);
  const matches = (bundledTemplateCatalog("software/coding")?.documents ?? [])
    .filter((document) => document.materializeAs === taskMatch[2])
    .filter((document) => undeclaredSectionsForTaskDocument(document.sectionPermissions) === "allow"
      ? document.sectionPermissions.every((permission) => headings.includes(permission.anchor))
      : headings.every((heading) => document.sectionPermissions.some((permission) => permission.anchor === heading)))
    .sort((left, right) => left.sectionPermissions.length - right.sectionPermissions.length || left.id.localeCompare(right.id));
  if (!matches[0] || (matches[1] && matches[1].sectionPermissions.length === matches[0].sectionPermissions.length)) return null;
  return taskDocumentPolicy(normalized, matches[0].sectionPermissions);
}

export function undeclaredSectionsForTaskDocument(
  sections: SemanticDiffDocumentPolicy["sections"]
): "allow" | "reject" {
  return sections.length > 0 && sections.every((section) =>
    section.writeMode === "free-prose" && section.semanticClass === "host-prose-only")
    ? "allow"
    : "reject";
}

function taskDocumentPolicy(
  documentPath: string,
  sections: SemanticDiffDocumentPolicy["sections"]
): SemanticDiffDocumentPolicy {
  return {
    path: documentPath,
    sections,
    undeclaredSections: undeclaredSectionsForTaskDocument(sections)
  };
}
