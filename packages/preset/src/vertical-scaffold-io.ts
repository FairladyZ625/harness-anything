import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { presetFailure } from "./preset-resolver-common.ts";

export interface PlannedScaffoldFile {
  readonly relativePath: string;
  readonly body: string;
}

export interface ScaffoldWriteResult {
  readonly created: readonly string[];
  readonly overwritten: readonly string[];
}

/** Write planned vertical/preset declaration files inside a bounded repository directory. */
export function writeScaffoldFiles(input: {
  readonly rootDir: string;
  readonly targetDir: string;
  readonly files: readonly PlannedScaffoldFile[];
  readonly overwrite: boolean;
  readonly dryRun: boolean;
}): ScaffoldWriteResult {
  const resolvedRoot = path.resolve(input.rootDir),
    resolvedTarget = path.resolve(input.targetDir),
    relativeTarget = path.relative(resolvedRoot, resolvedTarget);
  if (relativeTarget === "" || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget))
    throw presetFailure("invalid_target", `Scaffold target ${input.targetDir} must remain inside ${resolvedRoot}.`);
  const conflicts: string[] = [],
    created: string[] = [],
    overwritten: string[] = [];
  for (const entry of input.files) {
    const absolute = path.resolve(resolvedTarget, entry.relativePath),
      relative = path.relative(resolvedTarget, absolute);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
      throw presetFailure("reserved_path", `Scaffold file ${entry.relativePath} escapes ${resolvedTarget}.`);
    const repoRelative = path.relative(resolvedRoot, absolute).split(path.sep).join("/");
    if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw presetFailure("reserved_path", `Existing scaffold target ${repoRelative} is not a regular file.`);
      if (!input.overwrite) conflicts.push(repoRelative);
      else overwritten.push(repoRelative);
    } else {
      created.push(repoRelative);
    }
  }
  if (conflicts.length > 0)
    throw presetFailure(
      "path_exists",
      `Refusing to overwrite existing scaffold files (${conflicts.slice(0, 5).join(", ")}${
        conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ""
      }). Pass --force to overwrite.`,
    );
  if (input.dryRun) return { created, overwritten };
  for (const entry of input.files) {
    const absolute = path.resolve(resolvedTarget, entry.relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, entry.body, "utf8");
  }
  return { created, overwritten };
}

/** Create an isolated temporary sandbox directory for zero-side-effect simulation runs. */
export function createSimulationSandbox(prefix = "ha-vertical-simulate-"): {
  readonly directory: string;
  readonly close: () => void;
} {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    directory,
    close: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
