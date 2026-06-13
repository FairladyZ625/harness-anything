import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultTaskProjectionPath, rebuildTaskProjection } from "../../../kernel/src/index.ts";
import { listTaskIndexPaths, resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";
import { relativePath } from "../cli/path.ts";
import type { CliResult, GovernanceRebuildMode } from "../cli/types.ts";

export function runGovernanceRebuild(rootDir: string, mode: GovernanceRebuildMode): CliResult {
  const projectionPath = defaultTaskProjectionPath(rootDir);
  const plannedRows = listTaskIndexPaths(rootDir).length;
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
        generatedViews: plannedGovernanceViews(rootDir)
      }
    };
  }

  const archivePath = mode === "archive" ? writeGovernanceArchive(rootDir, plannedRows) : null;
  const result = rebuildTaskProjection({ rootDir });
  const generated = writeGeneratedGovernanceViews(rootDir, result.rows.length);
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

function plannedGovernanceViews(rootDir: string): ReadonlyArray<string> {
  const layout = resolveHarnessLayout(rootDir);
  return [
    relativePath(rootDir, defaultTaskProjectionPath(rootDir)),
    relativePath(rootDir, path.join(layout.generatedRoot, "Harness-Ledger.md"))
  ];
}

function writeGeneratedGovernanceViews(rootDir: string, rows: number): ReadonlyArray<string> {
  const layout = resolveHarnessLayout(rootDir);
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

function writeGovernanceArchive(rootDir: string, plannedRows: number): string {
  const archivePath = path.join(resolveHarnessLayout(rootDir).localRoot, "archive", "governance", `${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  mkdirSync(path.dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, JSON.stringify({
    schema: "governance-archive/v1",
    archivedAt: new Date().toISOString(),
    plannedRows
  }, null, 2), "utf8");
  return relativePath(rootDir, archivePath);
}
