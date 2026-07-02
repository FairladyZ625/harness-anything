import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { planTemplateMaterialization, type VerticalDefinition } from "../../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/layout/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";
import { isPathInside } from "../../cli/path.ts";
import { readProjectHarnessSettings } from "../settings.ts";
import { bundledTemplateCatalog } from "./bundled.ts";

export function materializeRepositoryScaffold(rootInput: HarnessLayoutInput, vertical: VerticalDefinition): void {
  const layout = resolveHarnessLayout(rootInput);
  const settings = readProjectHarnessSettings(rootInput, "init");
  const locale = settings.ok
    ? settings.settings.locale ?? "zh-CN"
    : "zh-CN";
  for (const root of vertical.repositoryScaffold.entityRoots) {
    if (root.create === "init") mkdirSync(resolveScaffoldPath(root.path, layout), { recursive: true });
  }
  for (const directory of vertical.repositoryScaffold.dirs) {
    if (directory.create === "init") mkdirSync(resolveScaffoldPath(directory.path, layout), { recursive: true });
  }
  const catalog = bundledTemplateCatalog();
  if (!catalog) throw new Error("bundled software/coding template catalog missing");
  const materialized = planTemplateMaterialization({
    catalog,
    locale,
    selections: vertical.repositoryScaffold.seededDocs
  });
  if (!materialized.ok) {
    throw new Error(`repository scaffold templates failed: ${materialized.issues.map((issue) => issue.code).join(", ")}`);
  }
  for (const [index, document] of materialized.documents.entries()) {
    const selection = vertical.repositoryScaffold.seededDocs[index];
    const filePath = resolveScaffoldPath(document.materializeAs, layout);
    if (!selection) continue;
    if (!selection.overwrite && existsSync(filePath)) continue;
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, document.body.endsWith("\n") ? document.body : `${document.body}\n`, "utf8");
  }
}

function resolveScaffoldPath(template: string, layout: ReturnType<typeof resolveHarnessLayout>): string {
  const resolved = template
    .replaceAll("{{paths.rootDir}}", layout.rootDir)
    .replaceAll("{{paths.authoredRoot}}", layout.authoredRoot)
    .replaceAll("{{paths.standardsRoot}}", layout.standardsRoot)
    .replaceAll("{{paths.contextRoot}}", layout.contextRoot)
    .replaceAll("{{paths.tasksRoot}}", layout.tasksRoot)
    .replaceAll("{{paths.decisionsRoot}}", layout.decisionsRoot)
    .replaceAll("{{paths.sessionsRoot}}", layout.sessionsRoot)
    .replaceAll("{{paths.adrRoot}}", layout.adrRoot);
  if (resolved.includes("{{") || resolved.includes("}}")) {
    throw new Error(`unsupported repository scaffold path: ${template}`);
  }
  const absolute = path.resolve(resolved);
  if (!isPathInside(layout.rootDir, absolute)) {
    throw new Error(`repository scaffold path escapes project root: ${template}`);
  }
  return absolute;
}
