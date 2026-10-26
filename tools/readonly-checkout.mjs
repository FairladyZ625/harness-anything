#!/usr/bin/env node
// Read a historical commit's tree without sharing this checkout's mutable state.
//
// The 2026-10-27 incident: a worker needed a baseline checkout, ran `git worktree add` under /tmp, linked its
// node_modules at the canonical store, and re-pointed the workspace links "at itself". The links it rewrote were
// canonical's own, because a link's parent directory is resolved before the link is replaced; deleting the scratch
// checkout then broke `ha` for the machine.
//
// This is the one supported way to materialize a historical tree. It extracts a `git archive` into a plain
// directory: the result is not a Git worktree, so it registers nothing in the repository's `.git/worktrees` and
// cannot be pushed or committed by accident, and it carries no `node_modules` unless `--deps` asks for one — the
// default reads committed bytes and touches nothing shared. `--deps` runs the same `mirrorNodeModules` the task
// worktree setup runs, which copies workspace links relative so they resolve inside the new tree.
//
//   node tools/readonly-checkout.mjs --rev <sha> [--out <dir>] [--deps]
//   node tools/readonly-checkout.mjs --rev <sha> --show <path>   (no extraction at all)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mirrorNodeModules } from "../packages/daemon/src/worktree-node-modules-mirror.ts";
import { renderToolHelp, readonlyCheckoutCommand, parseToolOptions, toolValue } from "./tool-command-contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The commit a revision names, or a typed refusal: a branch is not a pinned baseline. */
export function resolveRevision(rootDir, revision) {
  const result = spawnSync("git", ["-C", rootDir, "rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return { ok: false, detail: `revision ${revision} does not name a commit in ${rootDir}` };
  return { ok: true, commit: result.stdout.trim() };
}

/** Extracts one commit's tree into `destination`. Never writes inside `rootDir`. */
export function extractTree(rootDir, commit, destination) {
  mkdirSync(destination, { recursive: true });
  const archive = spawnSync("git", ["-C", rootDir, "archive", "--format=tar", commit], {
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.status !== 0)
    return { ok: false, detail: `git archive ${commit} failed: ${String(archive.stderr ?? "").trim()}` };
  const extract = spawnSync("tar", ["-xf", "-", "-C", destination], {
    input: archive.stdout,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (extract.status !== 0)
    return { ok: false, detail: `tar extraction failed: ${String(extract.stderr ?? "").trim()}` };
  return { ok: true, files: readdirSync(destination).length };
}

/** One path's bytes at a commit, for the read that needs no tree at all. */
export function showPath(rootDir, commit, logicalPath) {
  const result = spawnSync("git", ["-C", rootDir, "show", `${commit}:${logicalPath}`], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) return { ok: false, detail: `${logicalPath} is not in commit ${commit}` };
  return { ok: true, body: result.stdout };
}

/**
 * Extracts the tree and, when asked, mirrors the root store into it. The mirror is the only step that reads
 * anything outside the commit, and it copies the workspace links rather than sharing them.
 */
export function materialize(options) {
  const resolved = resolveRevision(options.rootDir, options.revision);
  if (!resolved.ok) return resolved;
  const destination = path.resolve(options.out ?? mkdtempSync(path.join(tmpdir(), "ha-baseline-")));
  const extracted = extractTree(options.rootDir, resolved.commit, destination);
  if (!extracted.ok) return extracted;
  if (!options.deps) return { ok: true, commit: resolved.commit, destination, dependencies: false };
  const store = path.join(options.rootDir, "node_modules");
  if (!existsSync(store)) return { ok: false, detail: `${store} does not exist; run npm ci in the repository first` };
  mirrorNodeModules(options.rootDir, destination);
  return { ok: true, commit: resolved.commit, destination, dependencies: true };
}

export function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseToolOptions(readonlyCheckoutCommand, argv);
  } catch (error) {
    console.error(`readonly-checkout: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (parsed.help) {
    console.log(renderToolHelp(readonlyCheckoutCommand));
    return 0;
  }
  const revision = toolValue(parsed, "--rev"),
    shown = toolValue(parsed, "--show"),
    resolved = resolveRevision(repoRoot, revision);
  if (!resolved.ok) {
    console.error(`readonly-checkout: ${resolved.detail}`);
    return 1;
  }
  if (shown !== undefined) {
    const read = showPath(repoRoot, resolved.commit, shown);
    if (!read.ok) {
      console.error(`readonly-checkout: ${read.detail}`);
      return 1;
    }
    process.stdout.write(read.body);
    return 0;
  }
  const result = materialize({
    rootDir: repoRoot,
    revision,
    out: toolValue(parsed, "--out"),
    deps: parsed.booleans.has("--deps"),
  });
  if (!result.ok) {
    console.error(`readonly-checkout: ${result.detail}`);
    return 1;
  }
  console.log(
    JSON.stringify({
      schema: "harness-anything/readonly-checkout/v1",
      commit: result.commit,
      destination: result.destination,
      dependencies: result.dependencies,
    }),
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = main();
