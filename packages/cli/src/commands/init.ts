import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";
import type { CliResult } from "../cli/types.ts";

export function initializeHarness(rootDir: string, addNpmScripts = false, projectName?: string): CliResult {
  const layout = resolveHarnessLayout(rootDir);
  const resolvedProjectName = projectName ?? path.basename(rootDir);
  for (const directory of [
    layout.authoredRoot,
    layout.standardsRoot,
    layout.contextRoot,
    path.join(layout.contextRoot, "architecture"),
    layout.planningRoot,
    layout.tasksRoot,
    layout.localRoot,
    layout.generatedRoot,
    layout.cacheRoot,
    layout.writeJournalRoot,
    layout.payloadsRoot,
    layout.locksRoot
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  writeHarnessYaml(path.join(layout.authoredRoot, "harness.yaml"), resolvedProjectName, projectName !== undefined);
  writeIfMissing(path.join(layout.standardsRoot, "repo-governance.md"), [
    "# Repository Governance",
    "",
    "- Authored shared state lives under `harness/`.",
    "- Generated local state lives under `.harness/` and must remain untracked.",
    "- Task identities use random `task_<ULID>` values; titles and slugs are display metadata.",
    ""
  ].join("\n"));
  writeIfMissing(path.join(layout.rootDir, "AGENTS.md"), [
    "# Harness Agent Entry",
    "",
    "Read `harness/harness.yaml` and `harness/standards/repo-governance.md` before changing task state.",
    "",
    "Generated state under `.harness/` is local-only and must not be committed.",
    ""
  ].join("\n"));
  writeIfMissing(path.join(layout.rootDir, "CLAUDE.md"), [
    "# Claude Harness Entry",
    "",
    "Follow `AGENTS.md` and the shared authored harness under `harness/`.",
    ""
  ].join("\n"));
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
    path: "harness/harness.yaml",
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

function writeIfMissing(filePath: string, body: string): void {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function ensureGitignoreEntry(filePath: string, entry: string): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  if (existing.split(/\r?\n/u).includes(entry)) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(filePath, `${existing}${prefix}${entry}\n`, "utf8");
}
