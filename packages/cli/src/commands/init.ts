import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "../../../kernel/src/layout/index.ts";
import { resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";
import { normalizeSlashes } from "../cli/path.ts";
import type { CliResult } from "../cli/types.ts";
import { bundledVerticalDefinition } from "./extensions/bundled.ts";
import { materializeRepositoryScaffold } from "./extensions/repository-scaffold.ts";

export function initializeHarness(rootInput: HarnessLayoutInput, addNpmScripts = false, projectName?: string): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const resolvedProjectName = projectName ?? path.basename(rootDir);
  const vertical = bundledVerticalDefinition();
  if (!vertical) throw new Error("bundled software/coding vertical definition missing");
  for (const directory of [
    layout.localRoot,
    layout.generatedRoot,
    layout.cacheRoot,
    layout.writeJournalRoot,
    layout.payloadsRoot,
    layout.locksRoot
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const harnessConfigPath = layout.configPath ?? path.join(layout.authoredRoot, "harness.yaml");
  writeHarnessYaml(harnessConfigPath, resolvedProjectName, projectName !== undefined);
  materializeRepositoryScaffold(rootInput, vertical);
  ensureGitignoreEntry(path.join(layout.rootDir, ".gitignore"), ".harness/");
  const packagePath = path.join(layout.rootDir, "package.json");
  if (addNpmScripts) {
    const packageJson = existsSync(packagePath)
      ? JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>
      : { private: true };
    const scripts = typeof packageJson.scripts === "object" && packageJson.scripts !== null && !Array.isArray(packageJson.scripts)
      ? packageJson.scripts as Record<string, unknown>
      : {};
    packageJson.scripts = {
      ...scripts,
      "harness-anything": scripts["harness-anything"] ?? "harness-anything",
      ha: scripts.ha ?? "ha",
      "harness-anything:check": scripts["harness-anything:check"] ?? "harness-anything check"
    };
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }

  return {
    ok: true,
    command: "init",
    path: normalizeSlashes(path.relative(rootDir, harnessConfigPath)),
    generated: addNpmScripts ? ["package.json"] : []
  };
}

function writeHarnessYaml(filePath: string, projectName: string, forceNameUpdate: boolean): void {
  const bodyLines = [
    "schema: harness-anything/v1",
    `name: ${projectName}`,
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    "tasks:",
    "  root: harness/planning/tasks",
    "  idPolicy: random-ulid",
    "settings:",
    "  locale: zh-CN",
    "  defaultVertical: software/coding",
    "  defaultPreset: standard-task",
    "  defaultProfile: baseline",
    "  customVerticals:",
    "    enabled: false",
    ""
  ];
  const body = bodyLines.join("\n");

  if (!existsSync(filePath)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, body, "utf8");
    return;
  }

  if (!forceNameUpdate) return;
  const existing = readFileSync(filePath, "utf8");
  const next = /^name:[ \t]*.*$/mu.test(existing)
    ? existing.replace(/^name:[ \t]*.*$/mu, `name: ${projectName}`)
    : existing.replace(/^(schema:[ \t]*.*)$/mu, `$1\nname: ${projectName}`);
  writeFileSync(filePath, next, "utf8");
}

function ensureGitignoreEntry(filePath: string, entry: string): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  if (existing.split(/\r?\n/u).includes(entry)) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(filePath, `${existing}${prefix}${entry}\n`, "utf8");
}
