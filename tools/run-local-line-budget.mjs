#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { git, repoRoot } from "./gates/git.mjs";

const CANONICAL_REPOSITORY = "github.com/fairladyz625/harness-anything";
const CANONICAL_REMOTE_URL = "https://github.com/FairladyZ625/harness-anything.git";
export const FETCH_TIMEOUT_MS = 15_000;

function normalizedRepository(url) {
  const trimmed = url.trim().replace(/\.git\/?$/u, "");
  const scpLike = trimmed.includes("://") ? null : /^(?:[^@]+@)?([^:]+):(.+)$/u.exec(trimmed);
  if (scpLike) return `${scpLike[1]}/${scpLike[2]}`.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}/${parsed.pathname.replace(/^\/+|\/+$/gu, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

export function findCanonicalRemote(rootDir) {
  const remotes = git(rootDir, ["remote"]).split(/\r?\n/u).filter(Boolean);
  return remotes.find((remote) => {
    const url = git(rootDir, ["config", "--get", `remote.${remote}.url`]).trim();
    return normalizedRepository(url) === CANONICAL_REPOSITORY;
  }) ?? null;
}

function resolutionError(step, nextAction, detail = "") {
  return new Error([
    step,
    "G32 needs network access to fetch canonical main because a stale or fork base can produce a false pass.",
    `Next action: ${nextAction}`,
    detail
  ].filter(Boolean).join("\n"));
}

export function resolveLocalLineBudgetBase(rootDir, fetchTimeoutMs = FETCH_TIMEOUT_MS) {
  const remote = findCanonicalRemote(rootDir);
  if (remote === null) {
    throw resolutionError(
      "no configured remote points to github.com/FairladyZ625/harness-anything.",
      `run \`git remote add upstream ${CANONICAL_REMOTE_URL}\`, then re-run \`npm run check:local\`.`
    );
  }

  const fetchResult = spawnSync(
    "git",
    ["fetch", "--quiet", "--no-tags", remote, `refs/heads/main:refs/remotes/${remote}/main`],
    { cwd: rootDir, encoding: "utf8", timeout: fetchTimeoutMs }
  );
  if (fetchResult.error?.code === "ETIMEDOUT") {
    throw resolutionError(
      `fetching canonical main from remote "${remote}" timed out after ${fetchTimeoutMs}ms.`,
      `check network access, run \`git fetch ${remote} main\`, then re-run \`npm run check:local\`.`
    );
  }
  if (fetchResult.error || fetchResult.status !== 0) {
    const detail = fetchResult.stderr?.trim() || fetchResult.error?.message || "git fetch exited without an error message";
    throw resolutionError(
      `fetching canonical main from remote "${remote}" failed.`,
      `check network access and Git credentials, run \`git fetch ${remote} main\`, then re-run \`npm run check:local\`.`,
      `Git reported: ${detail}`
    );
  }

  let base;
  try {
    base = git(rootDir, ["rev-parse", `refs/remotes/${remote}/main^{commit}`]).trim();
  } catch (error) {
    throw resolutionError(
      `fetched canonical main from remote "${remote}", but its commit could not be resolved.`,
      `run \`git fetch ${remote} main\`, inspect \`${remote}/main\`, then re-run \`npm run check:local\`.`,
      error instanceof Error ? error.message : String(error)
    );
  }

  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", base, "HEAD"], {
    cwd: rootDir,
    encoding: "utf8"
  });
  if (ancestry.status === 1) {
    throw resolutionError(
      `HEAD is not a descendant of the latest canonical main (${remote}/main ${base}).`,
      `first rebase onto latest main with \`git rebase ${remote}/main\`, then re-run \`npm run check:local\`.`
    );
  }
  if (ancestry.error || ancestry.status !== 0) {
    const detail = ancestry.stderr?.trim() || ancestry.error?.message || "git merge-base exited without an error message";
    throw resolutionError(
      `could not verify whether HEAD descends from ${remote}/main ${base}.`,
      `inspect \`git merge-base --is-ancestor ${remote}/main HEAD\`, repair the branch, then re-run \`npm run check:local\`.`,
      `Git reported: ${detail}`
    );
  }
  return { base, remote };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    console.error("Local line-budget base resolution failed: this command accepts no arguments; its base must come from freshly fetched canonical main.");
    return 1;
  }

  const rootDir = repoRoot();
  let resolved;
  try {
    resolved = resolveLocalLineBudgetBase(rootDir);
  } catch (error) {
    console.error(`Local line-budget base resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(`Local line-budget base: ${resolved.remote}/main ${resolved.base}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "gates/line-budget.mjs"), "--base", resolved.base], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    console.error(`Local line-budget failed to launch G32: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
