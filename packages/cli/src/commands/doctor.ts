import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";
import type { CliResult } from "../cli/types.ts";

export interface DoctorReport {
  readonly schema: "harness-doctor/v1";
  readonly readOnly: true;
  readonly node: {
    readonly version: string;
    readonly requiredMajor: 24;
    readonly ok: boolean;
  };
  readonly git: {
    readonly insideWorkTree: boolean;
  };
  readonly harness: {
    readonly authoredRoot: "harness";
    readonly authoredRootExists: boolean;
    readonly localRoot: ".harness";
    readonly localRootExists: boolean;
    readonly projectionCacheExists: boolean;
  };
  readonly cli: {
    readonly command: "harness doctor";
    readonly json: "CliResult/v1";
  };
  readonly recommendedCommands: readonly string[];
}

export function runDoctor(rootDir: string): CliResult {
  const report = collectDoctorReport(rootDir);
  return {
    ok: true,
    command: "doctor",
    report
  };
}

function collectDoctorReport(rootDir: string): DoctorReport {
  const layout = resolveHarnessLayout(rootDir);
  return {
    schema: "harness-doctor/v1",
    readOnly: true,
    node: {
      version: process.versions.node,
      requiredMajor: 24,
      ok: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 24
    },
    git: {
      insideWorkTree: isInsideGitWorkTree(rootDir)
    },
    harness: {
      authoredRoot: "harness",
      authoredRootExists: existsSync(layout.authoredRoot),
      localRoot: ".harness",
      localRootExists: existsSync(layout.localRoot),
      projectionCacheExists: existsSync(path.join(layout.cacheRoot, "projections.sqlite"))
    },
    cli: {
      command: "harness doctor",
      json: "CliResult/v1"
    },
    recommendedCommands: [
      "harness init",
      "harness status --json",
      "harness check --post-merge --json",
      "harness git-diff --json"
    ]
  };
}

function isInsideGitWorkTree(rootDir: string): boolean {
  try {
    const output = execFileSync("git", ["-C", rootDir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output === "true";
  } catch {
    return false;
  }
}
