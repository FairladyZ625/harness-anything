import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "@harness-anything/kernel";
import type { VcsCommitAuthor } from "@harness-anything/kernel";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { ensureProjectPeopleRoster, resolveCanonicalHarnessRootResolution } from "@harness-anything/daemon";
import { normalizeSlashes } from "../cli/path.ts";
import type { CliResult } from "../cli/types.ts";
import { resolveActiveVertical } from "./extensions/active-vertical.ts";
import { materializeRepositoryScaffold } from "./extensions/repository-scaffold.ts";

const DEFAULT_INIT_GIT_TIMEOUT_MS = 10_000;

export interface InitGitRuntime {
  readonly executable?: string;
  readonly prefixArgs?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly killSignal?: NodeJS.Signals;
}

export function initializeHarness(
  rootInput: HarnessLayoutInput,
  addNpmScripts = false,
  projectName?: string,
  commitAuthor?: VcsCommitAuthor,
  gitRuntime: InitGitRuntime = {},
  bootstrapAuthority = false
): CliResult {
  const initializationInput = canonicalInitializationInput(rootInput);
  const layout = resolveHarnessLayout(initializationInput);
  const rootDir = layout.rootDir;
  const warnings: unknown[] = [];
  const resolvedProjectName = projectName ?? path.basename(rootDir);
  const activeVertical = resolveActiveVertical(initializationInput, "init");
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
  materializeRepositoryScaffold(initializationInput, vertical);
  if (bootstrapAuthority && commitAuthor) ensureProjectPeopleRoster(layout.authoredRoot, commitAuthor);
  const isolation = ensureHarnessRepositoryIsolation(rootDir, layout.authoredRoot, commitAuthor, gitRuntime);
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
    readonly action: "initialized" | "skipped-existing" | "failed";
    readonly initialCommitCreated: boolean;
    readonly commitCount: number | null;
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

function ensureHarnessRepositoryIsolation(
  rootDir: string,
  authoredRoot: string,
  commitAuthor: VcsCommitAuthor | undefined,
  gitRuntime: InitGitRuntime
): HarnessIsolationResult {
  const warnings: unknown[] = [];
  const authoredRootRelative = initRelativeLayoutPath(rootDir, authoredRoot);
  const innerGitDir = path.join(authoredRoot, ".git");
  const outerRepository = ensureOuterGitRepository(rootDir, commitAuthor, gitRuntime);
  warnings.push(...outerRepository.warnings);
  const outerGit = isInsideInitGitWorkTree(rootDir, gitRuntime);
  const gitignore = ensureOuterGitignoreIsolation(rootDir, outerGit, authoredRootRelative);
  warnings.push(...gitignore.warnings);
  const innerRepository = ensureInnerGitRepository(authoredRoot, innerGitDir, commitAuthor, gitRuntime);
  warnings.push(...innerRepository.warnings);
  const completedOuterRepository = completeOuterGitRepository(rootDir, outerRepository.report, commitAuthor, gitRuntime);
  warnings.push(...completedOuterRepository.warnings);

  return {
    warnings,
    report: {
      schema: "harness-isolation/v1",
      authoredRoot: authoredRootRelative,
      innerGitDir: `${authoredRootRelative}/.git`,
      outerGit: {
        insideWorkTree: outerGit,
        ...completedOuterRepository.report
      },
      innerRepository: innerRepository.report,
      outerGitignore: gitignore.report,
      boundary: "Code PRs must not include harness/ changes; commit ledger changes inside harness/ as its own private git repository.",
      nextSteps: [
        `ha daemon repo register --root ${initShellArgument(rootDir)}`,
        `ha --root ${initShellArgument(rootDir)} doctor --json`,
        "git status",
        `git -C ${authoredRootRelative} status`,
        `git -C ${authoredRootRelative} add . && git -C ${authoredRootRelative} commit`
      ]
    }
  };
}

function canonicalInitializationInput(input: HarnessLayoutInput): HarnessLayoutInput {
  const resolution = resolveCanonicalHarnessRootResolution(input);
  if (resolution.source === "local-layout") return input;
  return typeof input === "string"
    ? resolution.canonicalRoot
    : { ...input, rootDir: resolution.canonicalRoot };
}

function initShellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function ensureOuterGitRepository(
  rootDir: string,
  commitAuthor: VcsCommitAuthor | undefined,
  gitRuntime: InitGitRuntime
): {
  readonly report: Omit<HarnessIsolationReport["outerGit"], "insideWorkTree">;
  readonly warnings: ReadonlyArray<unknown>;
} {
  if (isInsideInitGitWorkTree(rootDir, gitRuntime)) {
    return {
      warnings: [],
      report: {
        action: "skipped-existing",
        initialCommitCreated: false,
        commitCount: readCommitCount(rootDir, gitRuntime)
      }
    };
  }
  try {
    try {
      runInitGit(rootDir, ["init", "--initial-branch=main"], commitAuthor, gitRuntime);
    } catch (error) {
      if (isGitTimeoutError(error)) throw error;
      runInitGit(rootDir, ["init"], commitAuthor, gitRuntime);
    }
    return {
      warnings: [],
      report: {
        action: "initialized",
        initialCommitCreated: false,
        commitCount: null
      }
    };
  } catch (error) {
    return {
      warnings: [isolationWarning("outer_git_init_failed", error)],
      report: {
        action: "failed",
        initialCommitCreated: false,
        commitCount: null
      }
    };
  }
}

function completeOuterGitRepository(
  rootDir: string,
  report: Omit<HarnessIsolationReport["outerGit"], "insideWorkTree">,
  commitAuthor: VcsCommitAuthor | undefined,
  gitRuntime: InitGitRuntime
): {
  readonly report: Omit<HarnessIsolationReport["outerGit"], "insideWorkTree">;
  readonly warnings: ReadonlyArray<unknown>;
} {
  if (report.action !== "initialized") return { report, warnings: [] };
  try {
    runInitGit(rootDir, ["commit", "--no-gpg-sign", "--allow-empty", "-m", "chore: initialize harness workspace"], commitAuthor, gitRuntime);
    return {
      warnings: [],
      report: {
        action: "initialized",
        initialCommitCreated: true,
        commitCount: readCommitCount(rootDir, gitRuntime)
      }
    };
  } catch (error) {
    return {
      warnings: [isolationWarning("outer_git_initial_commit_failed", error)],
      report: {
        action: "failed",
        initialCommitCreated: false,
        commitCount: readCommitCount(rootDir, gitRuntime)
      }
    };
  }
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

function ensureInnerGitRepository(
  authoredRoot: string,
  innerGitDir: string,
  commitAuthor: VcsCommitAuthor | undefined,
  gitRuntime: InitGitRuntime
): {
  readonly report: HarnessIsolationReport["innerRepository"];
  readonly warnings: ReadonlyArray<unknown>;
} {
  if (existsSync(innerGitDir)) {
    return {
      warnings: [],
      report: {
        gitDirExists: true,
        action: "skipped-existing",
        branch: readGitText(authoredRoot, ["branch", "--show-current"], gitRuntime) || null,
        initialCommitCreated: false,
        commitCount: readCommitCount(authoredRoot, gitRuntime)
      }
    };
  }

  try {
    // Finder metadata is intentionally ignored by the inner ledger repository.
    // Authority read-down still applies the same structural safety validator to
    // already-tracked metadata, so this only prevents new accidental tracking.
    ensureGitignoreEntry(path.join(authoredRoot, ".gitignore"), ".DS_Store");
    try {
      runInitGit(authoredRoot, ["init", "--initial-branch=master"], commitAuthor, gitRuntime);
    } catch (error) {
      if (isGitTimeoutError(error)) throw error;
      runInitGit(authoredRoot, ["init"], commitAuthor, gitRuntime);
      runInitGit(authoredRoot, ["symbolic-ref", "HEAD", "refs/heads/master"], commitAuthor, gitRuntime);
    }
    runInitGit(authoredRoot, ["add", "."], commitAuthor, gitRuntime);
    runInitGit(authoredRoot, ["commit", "--no-gpg-sign", "-m", "chore: initialize harness ledger"], commitAuthor, gitRuntime);
    return {
      warnings: [],
      report: {
        gitDirExists: existsSync(innerGitDir),
        action: "initialized",
        branch: readGitText(authoredRoot, ["branch", "--show-current"], gitRuntime) || "master",
        initialCommitCreated: true,
        commitCount: readCommitCount(authoredRoot, gitRuntime)
      }
    };
  } catch (error) {
    return {
      warnings: [isolationWarning("inner_git_init_failed", error)],
      report: {
        gitDirExists: existsSync(innerGitDir),
        action: "failed",
        branch: readGitText(authoredRoot, ["branch", "--show-current"], gitRuntime) || null,
        initialCommitCreated: false,
        commitCount: readCommitCount(authoredRoot, gitRuntime)
      }
    };
  }
}

function isInsideInitGitWorkTree(rootDir: string, gitRuntime: InitGitRuntime): boolean {
  return readGitText(rootDir, ["rev-parse", "--is-inside-work-tree"], gitRuntime) === "true";
}

function readCommitCount(rootDir: string, gitRuntime: InitGitRuntime): number | null {
  const output = readGitText(rootDir, ["rev-list", "--count", "HEAD"], gitRuntime);
  return output ? Number.parseInt(output, 10) : null;
}

function readGitText(rootDir: string, args: ReadonlyArray<string>, gitRuntime: InitGitRuntime): string | undefined {
  try {
    return execFileSync(gitRuntime.executable ?? "git", [...(gitRuntime.prefixArgs ?? []), "-C", rootDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: gitRuntime.timeoutMs ?? DEFAULT_INIT_GIT_TIMEOUT_MS,
      killSignal: gitRuntime.killSignal ?? "SIGKILL"
    }).trim();
  } catch {
    return undefined;
  }
}

function runInitGit(
  rootDir: string,
  args: ReadonlyArray<string>,
  author: VcsCommitAuthor | undefined,
  gitRuntime: InitGitRuntime
): void {
  execFileSync(gitRuntime.executable ?? "git", [...(gitRuntime.prefixArgs ?? []), "-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: gitRuntime.timeoutMs ?? DEFAULT_INIT_GIT_TIMEOUT_MS,
    killSignal: gitRuntime.killSignal ?? "SIGKILL",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(author ? {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author.name,
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? author.email
      } : {})
    }
  });
}

function isGitTimeoutError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ETIMEDOUT";
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
    "  tasks:",
    "    wipLimit: 30",
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
