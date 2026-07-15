import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import type { CliGitCommitAuthor } from "../composition/actor-attribution.ts";
import { resolveHarnessLayout } from "../../../kernel/src/index.ts";
import { normalizeSlashes } from "../cli/path.ts";
import type { CliResult } from "../cli/types.ts";
import { resolveActiveVertical } from "./extensions/active-vertical.ts";
import { materializeRepositoryScaffold } from "./extensions/repository-scaffold.ts";

export function initializeHarness(rootInput: HarnessLayoutInput, addNpmScripts = false, projectName?: string, commitAuthor?: CliGitCommitAuthor): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const warnings: unknown[] = [];
  const resolvedProjectName = projectName ?? path.basename(rootDir);
  const activeVertical = resolveActiveVertical(rootInput, "init");
  if (!activeVertical.ok) return activeVertical.result;
  const vertical = activeVertical.definition.manifest;
  for (const directory of [
    layout.localRoot,
    layout.generatedRoot,
    layout.cacheRoot,
    layout.writeJournalRoot,
    layout.payloadsRoot,
    layout.locksRoot,
    // sessions is base infrastructure, not vertical-specific: every scenario gets it
    // regardless of the active vertical, so it is created unconditionally here rather
    // than via the vertical's repositoryScaffold.
    layout.sessionsRoot
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const harnessConfigPath = layout.configPath ?? path.join(layout.authoredRoot, "harness.yaml");
  writeHarnessYaml(harnessConfigPath, resolvedProjectName, projectName !== undefined);
  materializeRepositoryScaffold(rootInput, vertical);
  const isolation = ensureHarnessRepositoryIsolation(rootDir, layout.authoredRoot, commitAuthor);
  warnings.push(...isolation.warnings);
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
    generated: addNpmScripts ? ["package.json"] : [],
    report: {
      isolation: isolation.report
    },
    warnings
  };
}

interface HarnessIsolationResult {
  readonly report: HarnessIsolationReport;
  readonly warnings: ReadonlyArray<unknown>;
}

interface HarnessIsolationReport {
  readonly schema: "harness-isolation/v1";
  readonly authoredRoot: string;
  readonly innerGitDir: string;
  readonly outerGit: {
    readonly insideWorkTree: boolean;
  };
  readonly innerRepository: {
    readonly gitDirExists: boolean;
    readonly action: "initialized" | "skipped-existing" | "failed";
    readonly branch: string | null;
    readonly initialCommitCreated: boolean;
    readonly commitCount: number | null;
  };
  readonly outerGitignore: {
    readonly path: ".gitignore";
    readonly action: "updated" | "already-present" | "skipped-not-git" | "failed";
    readonly entries: readonly string[];
  };
  readonly boundary: string;
  readonly nextSteps: readonly string[];
}

function ensureHarnessRepositoryIsolation(rootDir: string, authoredRoot: string, commitAuthor?: CliGitCommitAuthor): HarnessIsolationResult {
  const warnings: unknown[] = [];
  const authoredRootRelative = initRelativeLayoutPath(rootDir, authoredRoot);
  const innerGitDir = path.join(authoredRoot, ".git");
  const outerGit = isInsideInitGitWorkTree(rootDir);
  const gitignore = ensureOuterGitignoreIsolation(rootDir, outerGit, authoredRootRelative);
  warnings.push(...gitignore.warnings);
  const innerRepository = ensureInnerGitRepository(authoredRoot, innerGitDir, commitAuthor);
  warnings.push(...innerRepository.warnings);

  return {
    warnings,
    report: {
      schema: "harness-isolation/v1",
      authoredRoot: authoredRootRelative,
      innerGitDir: `${authoredRootRelative}/.git`,
      outerGit: {
        insideWorkTree: outerGit
      },
      innerRepository: innerRepository.report,
      outerGitignore: gitignore.report,
      boundary: "Code PRs must not include harness/ changes; commit ledger changes inside harness/ as its own private git repository.",
      nextSteps: [
        `git -C ${authoredRootRelative} status`,
        `git -C ${authoredRootRelative} add . && git -C ${authoredRootRelative} commit`
      ]
    }
  };
}

function ensureOuterGitignoreIsolation(rootDir: string, outerGit: boolean, authoredRootRelative: string): {
  readonly report: HarnessIsolationReport["outerGitignore"];
  readonly warnings: ReadonlyArray<unknown>;
} {
  const entries = [".harness/", `${authoredRootRelative}/`];
  if (!outerGit) {
    return {
      warnings: [],
      report: {
        path: ".gitignore",
        action: "skipped-not-git",
        entries
      }
    };
  }

  const gitignorePath = path.join(rootDir, ".gitignore");
  try {
    const before = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    for (const entry of entries) ensureGitignoreEntry(gitignorePath, entry);
    const after = readFileSync(gitignorePath, "utf8");
    return {
      warnings: [],
      report: {
        path: ".gitignore",
        action: before === after ? "already-present" : "updated",
        entries
      }
    };
  } catch (error) {
    return {
      warnings: [isolationWarning("outer_gitignore_update_failed", error)],
      report: {
        path: ".gitignore",
        action: "failed",
        entries
      }
    };
  }
}

function ensureInnerGitRepository(authoredRoot: string, innerGitDir: string, commitAuthor?: CliGitCommitAuthor): {
  readonly report: HarnessIsolationReport["innerRepository"];
  readonly warnings: ReadonlyArray<unknown>;
} {
  if (existsSync(innerGitDir)) {
    return {
      warnings: [],
      report: {
        gitDirExists: true,
        action: "skipped-existing",
        branch: readGitText(authoredRoot, ["branch", "--show-current"]) || null,
        initialCommitCreated: false,
        commitCount: readCommitCount(authoredRoot)
      }
    };
  }

  try {
    try {
      runInitGit(authoredRoot, ["init", "--initial-branch=master"], commitAuthor);
    } catch {
      runInitGit(authoredRoot, ["init"], commitAuthor);
      runInitGit(authoredRoot, ["symbolic-ref", "HEAD", "refs/heads/master"], commitAuthor);
    }
    runInitGit(authoredRoot, ["add", "."], commitAuthor);
    runInitGit(authoredRoot, ["commit", "-m", "chore: initialize harness ledger"], commitAuthor);
    return {
      warnings: [],
      report: {
        gitDirExists: existsSync(innerGitDir),
        action: "initialized",
        branch: readGitText(authoredRoot, ["branch", "--show-current"]) || "master",
        initialCommitCreated: true,
        commitCount: readCommitCount(authoredRoot)
      }
    };
  } catch (error) {
    return {
      warnings: [isolationWarning("inner_git_init_failed", error)],
      report: {
        gitDirExists: existsSync(innerGitDir),
        action: "failed",
        branch: readGitText(authoredRoot, ["branch", "--show-current"]) || null,
        initialCommitCreated: false,
        commitCount: readCommitCount(authoredRoot)
      }
    };
  }
}

function isInsideInitGitWorkTree(rootDir: string): boolean {
  return readGitText(rootDir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

function readCommitCount(rootDir: string): number | null {
  const output = readGitText(rootDir, ["rev-list", "--count", "HEAD"]);
  return output ? Number.parseInt(output, 10) : null;
}

function readGitText(rootDir: string, args: ReadonlyArray<string>): string | undefined {
  try {
    return execFileSync("git", ["-C", rootDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
  } catch {
    return undefined;
  }
}

function runInitGit(rootDir: string, args: ReadonlyArray<string>, author?: CliGitCommitAuthor): void {
  execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      ...(author ? {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author.name,
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? author.email
      } : {})
    }
  });
}

function isolationWarning(code: string, error: unknown): Record<string, string> {
  return {
    source: "harness-isolation",
    severity: "warning",
    code,
    message: error instanceof Error ? error.message : String(error),
    repairHint: "Run harness-anything doctor --json, then rerun harness-anything init after fixing the reported git or filesystem issue."
  };
}

function initRelativeLayoutPath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function writeHarnessYaml(filePath: string, projectName: string, forceNameUpdate: boolean): void {
  const bodyLines = [
    "schema: harness-anything/v1",
    `name: ${projectName}`,
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    "tasks:",
    "  root: harness/tasks",
    "  idPolicy: random-ulid",
    "settings:",
    "  locale: zh-CN",
    "  defaultVertical: software/coding",
    "  defaultPreset: standard-task",
    "  defaultProfile: baseline",
    "  identity:",
    "    mode: local",
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
