import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { relativePath } from "../cli/path.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";

type GraphAction = Extract<ParsedCommand["action"], { readonly kind: "graph" }>;

interface GraphToolReport {
  readonly schema: "graph-panorama-report/v1";
  readonly outputPath: string;
  readonly projectionPath: string;
  readonly summary: {
    readonly edges: number;
    readonly activeEdges: number;
    readonly coverageRows: number;
    readonly uncoveredClaims: number;
    readonly islands: number;
    readonly focusIncoming?: number;
    readonly focusOutgoing?: number;
    readonly focusImpactedRefs?: number;
  };
  readonly statusCounts: Record<string, number>;
  readonly focus?: {
    readonly entityRef: string;
    readonly incoming: ReadonlyArray<unknown>;
    readonly outgoing: ReadonlyArray<unknown>;
    readonly impactedRefs: ReadonlyArray<string>;
  };
  readonly islands: ReadonlyArray<unknown>;
}

export function runGraphCommand(rootDir: string, action: GraphAction): CliResult {
  const toolPath = path.resolve("tools/graph-panorama.mjs");
  if (!existsSync(toolPath)) {
    return {
      ok: false,
      command: "graph",
      error: cliError(CliErrorCode.ProjectionCheckFailed, "Graph panorama tool is unavailable; expected tools/graph-panorama.mjs in the repository root.")
    };
  }
  try {
    const args = [toolPath, "--root", rootDir, "--json"];
    if (action.outputPath) args.push("--out", action.outputPath);
    if (action.focus) args.push("--focus", action.focus);
    if (action.projectionPath) args.push("--projection", action.projectionPath);
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8" });
    const report = normalizeReport(rootDir, JSON.parse(stdout) as GraphToolReport);
    return {
      ok: true,
      command: "graph",
      rows: report.summary.edges,
      path: report.outputPath,
      projectionPath: report.projectionPath,
      report
    };
  } catch (error) {
    return {
      ok: false,
      command: "graph",
      error: cliError(CliErrorCode.ProjectionCheckFailed, error instanceof Error ? error.message : String(error))
    };
  }
}

function normalizeReport(rootDir: string, report: GraphToolReport): GraphToolReport {
  return {
    ...report,
    outputPath: relativePath(rootDir, path.resolve(report.outputPath)),
    projectionPath: relativePath(rootDir, path.resolve(report.projectionPath))
  };
}
