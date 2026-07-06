import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../kernel/src/index.ts";
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
    readonly authoredRoot: string;
    readonly authoredRootExists: boolean;
    readonly localRoot: string;
    readonly localRootExists: boolean;
    readonly projectionCacheExists: boolean;
  };
  readonly cli: {
    readonly command: "harness-anything doctor";
    readonly json: "command-receipt/v2";
  };
  readonly recommendedCommands: readonly string[];
}

export function runDoctor(rootInput: HarnessLayoutInput): CliResult {
  const report = collectDoctorReport(rootInput);
  return {
    ok: true,
    command: "doctor",
    report
  };
}

function collectDoctorReport(rootInput: HarnessLayoutInput): DoctorReport {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
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
      authoredRoot: relativeLayoutPath(rootDir, layout.authoredRoot),
      authoredRootExists: existsSync(layout.authoredRoot),
      localRoot: relativeLayoutPath(rootDir, layout.localRoot),
      localRootExists: existsSync(layout.localRoot),
      projectionCacheExists: existsSync(path.join(layout.cacheRoot, "projections.sqlite"))
    },
    cli: {
      command: "harness-anything doctor",
      json: "command-receipt/v2"
    },
    recommendedCommands: [
      "harness-anything init",
      "harness-anything status --json",
      "harness-anything check --post-merge --json",
      "harness-anything git-diff --json"
    ]
  };
}

function relativeLayoutPath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
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
