import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rebuildTaskProjection } from "../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { listTaskIndexPaths, resolveHarnessLayout } from "../../../kernel/src/index.ts";
import { relativePath } from "../cli/path.ts";
import type { CliResult, GovernanceRebuildMode } from "../cli/types.ts";

export function runGovernanceRebuild(rootInput: HarnessLayoutInput, mode: GovernanceRebuildMode): CliResult {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const projectionPath = resolveHarnessLayout(rootInput).projectionPath;
  const plannedRows = listTaskIndexPaths(rootInput).length;
  if (mode === "dry-run") {
    return {
      ok: true,
      command: "governance-rebuild",
      mode,
      rows: plannedRows,
      projectionPath: relativePath(rootDir, projectionPath),
      report: {
        schema: "governance-rebuild-report/v1",
        mode,
        writes: [],
        generatedViews: plannedGovernanceViews(rootInput)
      }
    };
  }

  const archivePath = mode === "archive" ? writeGovernanceArchive(rootInput, plannedRows) : null;
  const result = rebuildTaskProjection({ rootDir, layoutOverrides: layoutOverridesFromInput(rootInput) });
  const generated = writeGeneratedGovernanceViews(rootInput, result.rows.length);
  return {
    ok: true,
    command: "governance-rebuild",
    mode,
    rows: result.rows.length,
    warnings: result.warnings,
    projectionPath: relativePath(rootDir, projectionPath),
    generated: archivePath ? [archivePath, ...generated] : generated,
    report: {
      schema: "governance-rebuild-report/v1",
      mode,
      writes: archivePath ? [archivePath, relativePath(rootDir, projectionPath), ...generated] : [relativePath(rootDir, projectionPath), ...generated],
      generatedViews: generated
    }
  };
}

function plannedGovernanceViews(rootInput: HarnessLayoutInput): ReadonlyArray<string> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  return [
    relativePath(rootDir, layout.projectionPath),
    relativePath(rootDir, path.join(layout.generatedRoot, "Harness-Ledger.md"))
  ];
}

function writeGeneratedGovernanceViews(rootInput: HarnessLayoutInput, rows: number): ReadonlyArray<string> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const ledgerPath = path.join(layout.generatedRoot, "Harness-Ledger.md");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, [
    "# Harness Ledger",
    "",
    "Generated projection. Authored task packages remain the source of truth.",
    "",
    `- Generated At: ${new Date().toISOString()}`,
    `- Task Rows: ${rows}`,
    ""
  ].join("\n"), "utf8");
  return [relativePath(rootDir, ledgerPath)];
}

function writeGovernanceArchive(rootInput: HarnessLayoutInput, plannedRows: number): string {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const archivePath = path.join(layout.localRoot, "archive", "governance", `${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  mkdirSync(path.dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, JSON.stringify({
    schema: "governance-archive/v1",
    archivedAt: new Date().toISOString(),
    plannedRows
  }, null, 2), "utf8");
  return relativePath(rootDir, archivePath);
}

function layoutOverridesFromInput(rootInput: HarnessLayoutInput) {
  return typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
}
