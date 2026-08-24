import { planTemplateMaterialization } from "../../kernel/src/index.ts";
import {
  isWithinPresetAssetRoot,
  presetFailure,
} from "./preset-resolver-common.ts";
import type {
  CatalogSource,
  ResolverScaffoldSelection,
} from "./preset-resolver-types.ts";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const reservedMaterializedPath =
  /^(?:(?:index|facts|progress)\.md|(?:task-contract|code-doc-anchors)\.json|(?:executions|reviews)(?:\/|$))$/iu;

export function materializeSelections(
  entries: readonly ResolverScaffoldSelection[],
  locale: "zh-CN" | "en-US",
) {
  const groups = new Map<CatalogSource, ResolverScaffoldSelection[]>(),
    plannedBySlot = new Map<
      string,
      ReturnType<typeof planTemplateMaterialization>["documents"][number]
    >();
  for (const item of entries)
    if (!item.project) {
      if (!item.source)
        throw presetFailure(
          "missing_template_catalog",
          `Template ${item.selection.templateRef} has no catalog source.`,
        );
      const group = groups.get(item.source) ?? [];
      group.push(item);
      groups.set(item.source, group);
    }
  for (const [source, selected] of groups) {
    const result = planTemplateMaterialization({
      catalog: source.catalog,
      selections: selected.map((item) => item.selection),
      locale,
      resolveBody: ({ locale: variant }) =>
        requiredRegularFile(
          safeTemplatePath(
            source.root,
            variant.bodyPath,
            source.catalog.package.id,
          ),
          "missing_template",
        ),
    });
    if (!result.ok)
      throw presetFailure(
        result.issues.some((item) => item.code === "missing_template")
          ? "missing_template"
          : "invalid_template_catalog",
        result.issues.map((item) => item.message).join("; "),
      );
    for (const document of result.documents)
      plannedBySlot.set(document.slot, document);
  }
  const usedPaths = new Set<string>();
  return entries.map((item) => {
    safeMaterializedPath(item.selection.materializeAs, usedPaths);
    if (item.project) {
      const requiredAnchors = item.requiredAnchors ?? [];
      for (const anchor of requiredAnchors)
        if (!item.project.body.includes(anchor))
          throw presetFailure(
            "required_anchor",
            `Template ${item.selection.templateRef} is missing required anchor ${anchor}.`,
          );
      return {
        ...item,
        body: item.project.body,
        mediaType: item.project.mediaType,
        locale: "project",
        requiredAnchors,
      };
    }
    const planned = plannedBySlot.get(item.selection.slot);
    if (!planned)
      throw presetFailure(
        "missing_template",
        `Template ${item.selection.templateRef} was not materialized.`,
      );
    return {
      ...item,
      body: planned.body,
      mediaType: catalogMediaType(
        item.source!,
        item.selection.templateRef,
        planned.locale,
      ),
      locale: planned.locale,
      requiredAnchors: planned.requiredAnchors,
    };
  });
}

export function catalogMediaType(
  source: CatalogSource,
  ref: string,
  locale: string,
): "text/markdown" | "text/plain" {
  const document = source.catalog.documents.find(
      (item) => `template://${item.id}@${item.version}` === ref,
    ),
    variant = document?.locales.find((item) => item.locale === locale),
    bodyPath = variant?.bodyPath;
  if (!bodyPath || !/\.(?:md|txt)$/u.test(bodyPath))
    throw presetFailure(
      "missing_template",
      `Template ${ref} is not task prose.`,
    );
  return document?.documentKind === "keep-file" || bodyPath.endsWith(".txt")
    ? "text/plain"
    : "text/markdown";
}

export function catalogAnchors(
  source: CatalogSource | undefined,
  ref: string,
  code = "invalid_task_scaffold",
): readonly string[] {
  const anchors = source?.catalog.documents.find(
    (item) => `template://${item.id}@${item.version}` === ref,
  )?.requiredAnchors;
  if (!anchors)
    throw presetFailure(code, `Base anchors for ${ref} are unavailable.`);
  return anchors;
}

export function taskOverlayPath(value: string): boolean {
  return !reservedMaterializedPath.test(value);
}

export function safeMaterializedPath(value: string, used: Set<string>): void {
  const normalized = value.normalize("NFC"),
    parts = value.split("/"),
    folded = normalized.toLocaleLowerCase("en-US");
  if (
    value !== normalized ||
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    /^(?:harness\/)?(?:events|objects)\//u.test(value) ||
    reservedMaterializedPath.test(value) ||
    used.has(folded)
  )
    throw presetFailure(
      "reserved_path",
      `Template path ${value} is unsafe or duplicated.`,
    );
  used.add(folded);
}

export function safeTemplatePath(
  root: string,
  value: string,
  ref: string,
): string {
  const target = path.resolve(root, value);
  if (!isWithinPresetAssetRoot(root, target))
    throw presetFailure(
      "missing_template",
      `Template ${ref} escapes the asset root.`,
    );
  return target;
}

export function requiredRegularFile(target: string, code: string): string {
  if (
    !existsSync(target) ||
    !lstatSync(target).isFile() ||
    lstatSync(target).isSymbolicLink()
  )
    throw presetFailure(
      code,
      `Required regular file ${target} is unavailable.`,
    );
  return readFileSync(target, "utf8");
}
