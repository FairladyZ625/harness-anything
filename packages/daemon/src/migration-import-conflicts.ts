import path from "node:path";
import { sha256Text } from "../../kernel/src/index.ts";
import { mergePeopleRosterDocuments } from "./identity/people-roster.ts";
import { authoredNode, destinationNode, nodeSummary, symlinkTarget, utf8File } from "./migration-import-legacy.ts";
import { migrationImportError } from "./migration-import-report.ts";
import { PEOPLE_REGISTRY_SURFACE, PEOPLE_ROSTER_PATH } from "./migration-import-run.ts";
import type { AuthoredClassification, AuthoredNode, ResolutionChoice } from "./migration-import-types.ts";

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
    const roster =
      sourcePath === PEOPLE_ROSTER_PATH && source.nodeKind === "file" && destination.nodeKind === "file"
        ? mergeRosterConflict(root, destinationRoot, sourcePath, destination)
        : null;
    if (roster && "surface" in roster) return roster;
    return {
      surface: sourcePath,
      disposition: "required",
      targetConflict: true,
      reason: [
        "destination content differs: ",
        `${details}`,
        "",
        `${roster ? `; the two rosters cannot be unioned: ${roster.refusal}` : ""}`,
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

// `people.yaml` states who exists and what they may do. Two rosters are two partial statements about one
// set of people, not two candidate values for one document, so neither side may be discarded: `ha init`
// always writes the destination roster with the local operator's own credential binding, and the source
// roster carries everyone the archived ledger knew. This unions them; only a genuine contradiction falls
// through to the explicit `--resolve` choice above.
export function mergeRosterConflict(
  root: string,
  destinationRoot: string,
  sourcePath: string,
  destination: AuthoredNode,
): AuthoredClassification | { readonly refusal: string } {
  const sourceBody = utf8File(root, sourcePath),
    destinationBody = utf8File(destinationRoot, sourcePath);
  if (sourceBody === null || destinationBody === null) return { refusal: "one side is not UTF-8 text" };
  const merged = mergePeopleRosterDocuments(sourceBody, destinationBody);
  if (!merged.ok) return { refusal: merged.reason };
  const { linkTarget: _linkTarget, ...destinationPreimage } = destination;
  return sha256Text(merged.body) === destinationPreimage.sha256
    ? {
        surface: PEOPLE_REGISTRY_SURFACE,
        disposition: "excluded",
        targetConflict: true,
        reason: `the destination roster already contains every source entry; union is ${merged.summary}`,
      }
    : {
        surface: PEOPLE_REGISTRY_SURFACE,
        disposition: "migrated",
        targetConflict: true,
        destinationPreimage,
        mergedBody: merged.body,
        reason: `unioned both rosters into the destination: ${merged.summary}`,
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
