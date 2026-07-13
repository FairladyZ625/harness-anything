import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
    readonly authoredRootGitExists: boolean;
    readonly localRoot: string;
    readonly localRootExists: boolean;
    readonly projectionCacheExists: boolean;
    readonly isolation: {
      readonly ok: boolean;
      readonly findings: ReadonlyArray<{
        readonly code: "harness_git_missing" | "outer_gitignore_missing";
        readonly severity: "warning";
        readonly message: string;
        readonly repairCommand: string;
      }>;
      readonly nextSteps: readonly string[];
    };
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
  const gitInsideWorkTree = isInsideDoctorGitWorkTree(rootDir);
  const harnessIsolation = inspectHarnessIsolation(rootDir, doctorRelativeLayoutPath(rootDir, layout.authoredRoot), gitInsideWorkTree);
  return {
    schema: "harness-doctor/v1",
    readOnly: true,
    node: {
      version: process.versions.node,
      requiredMajor: 24,
      ok: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 24
    },
    git: {
      insideWorkTree: gitInsideWorkTree
    },
    harness: {
      authoredRoot: doctorRelativeLayoutPath(rootDir, layout.authoredRoot),
      authoredRootExists: existsSync(layout.authoredRoot),
      authoredRootGitExists: existsSync(path.join(layout.authoredRoot, ".git")),
      localRoot: doctorRelativeLayoutPath(rootDir, layout.localRoot),
      localRootExists: existsSync(layout.localRoot),
      projectionCacheExists: existsSync(path.join(layout.cacheRoot, "projections.sqlite")),
      isolation: harnessIsolation
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

function inspectHarnessIsolation(
  rootDir: string,
  authoredRoot: string,
  outerGitInsideWorkTree: boolean
): DoctorReport["harness"]["isolation"] {
  const findings: Array<DoctorReport["harness"]["isolation"]["findings"][number]> = [];
  const authoredRootPath = path.join(rootDir, authoredRoot);
  if (existsSync(authoredRootPath) && !existsSync(path.join(authoredRootPath, ".git"))) {
    findings.push({
      code: "harness_git_missing",
      severity: "warning",
      message: `${authoredRoot}/ exists but is not an independent git repository.`,
      repairCommand: "harness-anything init"
    });
  }
  if (existsSync(authoredRootPath) && outerGitInsideWorkTree && !gitignoreContainsHarness(rootDir, authoredRoot)) {
    findings.push({
      code: "outer_gitignore_missing",
      severity: "warning",
      message: `.gitignore does not isolate ${authoredRoot}/ from the outer code repository.`,
      repairCommand: "harness-anything init"
    });
  }
  return {
    ok: findings.length === 0,
    findings,
    nextSteps: findings.length === 0
      ? []
      : [
        "harness-anything init",
        `git -C ${authoredRoot} status`
      ]
  };
}

function gitignoreContainsHarness(rootDir: string, authoredRoot: string): boolean {
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (!existsSync(gitignorePath)) return false;
  const entries = readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return entries.some((entry) => entry === `${authoredRoot}/` || entry === `/${authoredRoot}/`);
}

function doctorRelativeLayoutPath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function isInsideDoctorGitWorkTree(rootDir: string): boolean {
  try {
    const output = execFileSync("git", ["-C", rootDir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    return output === "true";
  } catch {
    return false;
  }
}
