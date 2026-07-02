import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VerticalDefinition } from "../../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/layout/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";
import { isPathInside } from "../../cli/path.ts";

export function materializeRepositoryScaffold(rootInput: HarnessLayoutInput, vertical: VerticalDefinition): void {
  const layout = resolveHarnessLayout(rootInput);
  for (const root of vertical.repositoryScaffold.entityRoots) {
    if (root.create === "init") mkdirSync(resolveScaffoldPath(root.path, layout), { recursive: true });
  }
  for (const directory of vertical.repositoryScaffold.dirs) {
    if (directory.create === "init") mkdirSync(resolveScaffoldPath(directory.path, layout), { recursive: true });
  }
  for (const document of vertical.repositoryScaffold.seededDocs) {
    const filePath = resolveScaffoldPath(document.path, layout);
    if (!document.overwrite && existsSync(filePath)) continue;
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
    .replaceAll("{{paths.planningRoot}}", layout.planningRoot)
    .replaceAll("{{paths.tasksRoot}}", layout.tasksRoot);
  if (resolved.includes("{{") || resolved.includes("}}")) {
    throw new Error(`unsupported repository scaffold path: ${template}`);
  }
  const absolute = path.resolve(resolved);
  if (!isPathInside(layout.rootDir, absolute)) {
    throw new Error(`repository scaffold path escapes project root: ${template}`);
  }
  return absolute;
}
