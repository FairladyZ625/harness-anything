import path from "node:path";

const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const windowsForbiddenChars = /[<>:"|?*]/u;
declare const portableDocumentPathBrand: unique symbol;
export type PortableDocumentPath = string & { readonly [portableDocumentPathBrand]: true };

export interface PortablePathCollision {
  readonly canonicalPath: string;
  readonly paths: readonly string[];
}

export function normalizeRelativeDocumentPath(value: string): PortableDocumentPath {
  if (value.length === 0) throw new Error("document path must not be empty");
  if (value.includes("\0")) throw new Error(`document path contains NUL: ${value}`);
  if (value.includes("\\")) throw new Error(`document path must use POSIX separators: ${value}`);
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("//")
  ) {
    throw new Error(`absolute paths are not allowed: ${value}`);
  }

  const normalized = path.posix.normalize(value).normalize("NFC");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`path must stay inside task package: ${value}`);
  }

  for (const segment of normalized.split("/")) {
    assertPortablePathSegment(segment, value);
  }

  return normalized as PortableDocumentPath;
}

export function assertNoPortablePathCollisions(paths: readonly string[]): void {
  const collisions = findPortablePathCollisions(paths);
  if (collisions.length === 0) return;
  const first = collisions[0];
  throw new Error(`portable path collision: ${first.paths.join(", ")}`);
}

export function findPortablePathCollisions(paths: readonly string[]): readonly PortablePathCollision[] {
  const seen = new Map<string, string[]>();
  for (const rawPath of paths) {
    const normalized = normalizeRelativeDocumentPath(rawPath);
    const canonical = normalized.toLocaleLowerCase("en-US");
    const values = seen.get(canonical) ?? [];
    values.push(rawPath);
    seen.set(canonical, values);
  }

  return [...seen.entries()]
    .filter(([, values]) => new Set(values).size > 1)
    .map(([canonicalPath, values]) => ({
      canonicalPath,
      paths: [...new Set(values)].sort(),
    }));
}

function assertPortablePathSegment(segment: string, originalPath: string): void {
  if (segment.length === 0 || segment === "." || segment === "..") {
    throw new Error(`invalid document path segment: ${originalPath}`);
  }
  if (segment.endsWith(" ") || segment.endsWith(".")) {
    throw new Error(`document path segment is not portable on Windows: ${originalPath}`);
  }
  if (windowsReservedName.test(segment)) {
    throw new Error(`document path uses a Windows reserved name: ${originalPath}`);
  }
  if (windowsForbiddenChars.test(segment)) {
    throw new Error(`document path contains Windows-forbidden characters: ${originalPath}`);
  }
}
