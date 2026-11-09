/**
 * The one judgment of the `Dependency-Change:` declaration G31 validates.
 *
 * `tools/gates/dependency-policy.mjs` supplies the Git reads and runs G31; the PR-body renderer
 * calls the same functions to write the declaration line. Keeping the predicate and the phrasing
 * here means the body and the gate can never disagree about what counts as a dependency change.
 */

const DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
const DECLARATION = /^Dependency-Change:[ \t]*(.*?)\s*$/gmu;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The dependency surface G31 judges; the renderer also selects the manifests it phrases. */
export function hasDependencyChange(paths: readonly string[]): boolean {
  return paths.some((filePath) => filePath === "package-lock.json" || /(?:^|\/)package\.json$/u.test(filePath));
}

/** Compare exports/conditions by JSON value, not by the object's insertion order. */
function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Node's exports sugar: a string/array/conditional map is the `.` subpath. */
function exportEntries(exportsField: unknown): ReadonlyMap<string, unknown> {
  if (!record(exportsField))
    return exportsField === undefined || exportsField === null ? new Map() : new Map([[".", exportsField]]);
  const subpaths = Object.keys(exportsField).filter((key) => key.startsWith("."));
  return subpaths.length > 0
    ? new Map(subpaths.map((key) => [key, exportsField[key]]))
    : new Map([[".", exportsField]]);
}

function exportChanges(before: unknown, after: unknown): readonly string[] {
  const previous = exportEntries(before),
    next = exportEntries(after),
    added = [...next.keys()].filter((key) => !previous.has(key)).sort(),
    removed = [...previous.keys()].filter((key) => !next.has(key)).sort(),
    changed = [...next.keys()]
      .filter((key) => previous.has(key) && stableValue(previous.get(key)) !== stableValue(next.get(key)))
      .sort();
  return [
    ...added.map((key) => `exports +${JSON.stringify(key)}`),
    ...removed.map((key) => `exports -${JSON.stringify(key)}`),
    ...changed.map((key) => `exports ${JSON.stringify(key)} changed`),
  ];
}

function dependencyChanges(section: string, before: unknown, after: unknown): readonly string[] {
  const previous = record(before) ? before : {},
    next = record(after) ? after : {},
    changes: string[] = [];
  for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (Object.hasOwn(next, name) && !Object.hasOwn(previous, name))
      changes.push(`${section}.${name} added ${JSON.stringify(next[name])}`);
    else if (Object.hasOwn(previous, name) && !Object.hasOwn(next, name))
      changes.push(`${section}.${name} removed ${JSON.stringify(previous[name])}`);
    else if (stableValue(previous[name]) !== stableValue(next[name]))
      changes.push(`${section}.${name} ${JSON.stringify(previous[name])} -> ${JSON.stringify(next[name])}`);
  }
  return changes.sort();
}

function manifestDescription(manifestPath: string, before: unknown, after: unknown): string {
  const changes: string[] = [];
  if (before === null) changes.push("added");
  if (after === null) changes.push("removed");
  const previous = before ?? {},
    next = after ?? {};
  changes.push(
    ...exportChanges(record(previous) ? previous.exports : undefined, record(next) ? next.exports : undefined),
  );
  for (const section of DEPENDENCY_SECTIONS)
    changes.push(
      ...dependencyChanges(
        section,
        record(previous) ? previous[section] : undefined,
        record(next) ? next[section] : undefined,
      ),
    );
  return `${manifestPath}: ${changes.length > 0 ? changes.join("; ") : "no exports or dependency range changes"}`;
}

/** The Git reads `describeDependencyChange` needs; the caller owns the IO. */
export interface DependencyManifestRead {
  readonly revisionExists: (revision: string) => boolean;
  /** The parsed manifest, or null when the path does not exist at that revision. */
  readonly readManifest: (revision: string, manifestPath: string) => unknown;
}

/**
 * One deterministic declaration description for the same diff G31 judges. The dependency-surface
 * predicate is hasDependencyChange itself; this function only phrases the manifests it selects.
 * Without a readable frozen base/head, the selected paths still produce a non-none declaration so
 * publication is never blocked on missing history.
 */
export function describeDependencyChange(input: {
  readonly paths: readonly string[];
  readonly base?: string | null | undefined;
  readonly head?: string | null | undefined;
  readonly read?: DependencyManifestRead | undefined;
}): string {
  if (!hasDependencyChange(input.paths)) return "none";
  const base = input.base,
    head = input.head,
    read = input.read,
    dependencyPaths = [...new Set(input.paths.filter((filePath) => hasDependencyChange([filePath])))].sort(),
    manifests = dependencyPaths.filter((filePath) => filePath !== "package-lock.json"),
    details: string[] = [],
    comparable =
      typeof base === "string" &&
      base.length > 0 &&
      typeof head === "string" &&
      head.length > 0 &&
      read !== undefined &&
      read.revisionExists(base) &&
      read.revisionExists(head);
  for (const manifestPath of manifests)
    details.push(
      comparable
        ? manifestDescription(
            manifestPath,
            read.readManifest(base, manifestPath),
            read.readManifest(head, manifestPath),
          )
        : `${manifestPath}: diff detail unavailable (frozen base or head is missing from this checkout)`,
    );
  if (dependencyPaths.includes("package-lock.json")) details.push("package-lock.json changed");
  return details.length > 0 ? details.join("; ") : "dependency surface changed";
}

/** The declaration line format G31 parses, shared with the renderer that writes it. */
export function readDependencyDeclarations(prBody: string): readonly string[] {
  return [...prBody.matchAll(DECLARATION)].map((match) => match[1] ?? "");
}

export function replaceDependencyDeclaration(prBody: string, description: string): string {
  return prBody.replace(DECLARATION, (declaration) => {
    // G31's line pattern tolerates whitespace after the value (including CRLF); keep it so
    // replacing the declaration never changes the body's line structure.
    const trailingWhitespace = /\s*$/u.exec(declaration)?.[0] ?? "";
    return `Dependency-Change: ${description}${trailingWhitespace}`;
  });
}

export function validateDependencyDeclaration(
  paths: readonly string[],
  prBody: string,
  declarationRequired = true,
): readonly string[] {
  if (!declarationRequired) return [];
  if (!hasDependencyChange(paths)) return [];
  const declarations = readDependencyDeclarations(prBody);
  if (declarations.length !== 1)
    return [
      `dependency changes require exactly one \`Dependency-Change: <description>\` line under ## Machine-Readable Declarations; found ${String(declarations.length)}`,
    ];
  const only = declarations[0] ?? "";
  if (only.length === 0 || /^(?:none|n\/a)$/iu.test(only))
    return [
      "Dependency-Change: must describe the deterministic dependency change; replace `none` with what changed (for example `bump effect to 2.0.0`)",
    ];
  return [];
}
