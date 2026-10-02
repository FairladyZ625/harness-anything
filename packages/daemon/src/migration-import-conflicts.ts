import path from "node:path";
import { authoredNode, destinationNode, nodeSummary, symlinkTarget, utf8File } from "./migration-import-legacy.ts";
import { migrationImportError } from "./migration-import-report.ts";
import type { AuthoredClassification, ResolutionChoice } from "./migration-import-types.ts";

export function resolveAuthoredConflict(
  base: AuthoredClassification,
  sourceRoot: string,
  root: string,
  destinationRoot: string,
  sourcePath: string,
  symlink: boolean,
  resolutions: ReadonlyMap<string, ResolutionChoice>,
): AuthoredClassification {
  const sourceTarget = symlink ? symlinkTarget(root, sourcePath) : null,
    source = symlink
      ? sourceTarget === null
        ? null
        : authoredNode("symbolic-link", Buffer.from(sourceTarget), sourceTarget)
      : (() => {
          const body = utf8File(root, sourcePath);
          return body === null ? null : authoredNode("file", Buffer.from(body));
        })(),
    destination = destinationNode(destinationRoot, sourcePath);
  if (
    !source ||
    !destination ||
    !(base.targetConflict || (base.disposition === "migrated" && base.surface === "repo-document")) ||
    (source.nodeKind === destination.nodeKind && "sha256" in destination && source.sha256 === destination.sha256)
  )
    return base;
  const repoPath = portableMigrationPath(path.relative(sourceRoot, path.join(root, sourcePath))),
    choice = resolutions.get(sourcePath),
    details = `${nodeSummary("source", source)}; ${nodeSummary("destination", destination)}`;
  if (!choice) {
    return {
      surface: sourcePath,
      disposition: "required",
      targetConflict: true,
      reason: [
        "destination content differs: ",
        `${details}`,
        "",
        "; resolve with --resolve ",
        `${repoPath}`,
        "=destination|source",
      ].join(""),
    };
  }
  if (choice === "destination")
    return {
      surface: sourcePath,
      disposition: "excluded",
      targetConflict: true,
      resolution: choice,
      reason: [
        "resolved: destination; discarded ",
        `${nodeSummary("source", source)}`,
        "; kept ",
        `${nodeSummary("destination", destination)}`,
        "",
      ].join(""),
    };
  if (destination.nodeKind === "directory")
    throw migrationImportError(
      "invalid_migration_resolution",
      [
        "Destination ",
        `${repoPath}`,
        " is a directory; =source cannot replace a directory node. Handle that ",
        "path manually, then rerun --dry-run.",
      ].join(""),
    );
  const { linkTarget: _target, ...destinationPreimage } = destination;
  return {
    surface: "repo-document",
    disposition: "migrated",
    targetConflict: true,
    resolution: choice,
    destinationPreimage,
    reason: [
      "resolved: source; kept ",
      `${nodeSummary("source", source)}`,
      "; replacing ",
      `${nodeSummary("destination", destination)}`,
      "",
    ].join(""),
  };
}

export function mediaType(target: string): string {
  const extension = path.posix.extname(target).toLowerCase();
  return (
    (
      {
        ".css": "text/css",
        ".csv": "text/csv",
        ".htm": "text/html",
        ".html": "text/html",
        ".json": "application/json",
        ".md": "text/markdown",
        ".svg": "image/svg+xml",
        ".txt": "text/plain",
        ".xml": "application/xml",
        ".yaml": "application/yaml",
        ".yml": "application/yaml",
      } as Readonly<Record<string, string>>
    )[extension] ?? "text/plain"
  );
}

export function portableMigrationPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
