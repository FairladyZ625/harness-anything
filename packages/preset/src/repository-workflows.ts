import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { settingValuePattern } from "../../kernel/src/index.ts";

/** Enumerate the CI workflow names a repository can point `settings.ci.workflows`
 * at: `*.yml` basenames under `.github/workflows`, without the extension. The
 * observation path appends `.yml` itself and the settings schema rejects
 * suffixed, duplicated, or pattern-illegal names, so only extension-less
 * basenames that satisfy the settings value pattern are offered — a selector can
 * offer real files instead of asking for hand-typed names (same judgment as
 * `listGovernanceScaffoldOverlays`). A repository without the directory simply
 * yields no names: the only expressible value is the legal empty set. */
export function listRepositoryWorkflowNames(rootDir: string): readonly string[] {
  const workflowsRoot = path.join(rootDir, ".github", "workflows");
  if (!existsSync(workflowsRoot)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(workflowsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) continue;
    const name = entry.name.slice(0, -".yml".length);
    if (new RegExp(settingValuePattern, "u").test(name)) names.push(name);
  }
  return names.sort((left, right) => left.localeCompare(right));
}
