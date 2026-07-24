const reservedFoldedSegments = new Set([
  ".git", ".gitmodules", ".hg", ".svn", ".ha", ".ha-state",
  ".harness-state", ".staging", ".quarantine", ".tombstones",
  ".conflicts", ".ds_store", "desktop.ini", "thumbs.db"
]);

/**
 * Validates an immutable Git fact before read-down materialization. Unlike
 * authoring admission, historical paths may contain non-ASCII UTF-8; disk
 * escape, reserved metadata names, and filesystem-unsafe structure remain
 * fail-closed.
 */
export function validateReadDownManagedPath(managedPath: string): void {
  if (managedPath.length === 0
    || managedPath.startsWith("/")
    || /^[A-Za-z]:/u.test(managedPath)
    || managedPath.startsWith("\\")) {
    unsafe(managedPath);
  }
  if (managedPath.includes("\\")
    || managedPath.includes(":")
    || /[\u0000-\u001f\u007f]/u.test(managedPath)) {
    unsafe(managedPath);
  }
  const segments = managedPath.split("/");
  for (const segment of segments) {
    if (!segment
      || segment === "."
      || segment === "..") {
      unsafe(managedPath);
    }
    const folded = foldAscii(segment);
    if (reservedFoldedSegments.has(folded)
      || folded.startsWith(".ha-")) {
      unsafe(managedPath);
    }
  }
}

function foldAscii(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function unsafe(managedPath: string): never {
  throw new Error(`RESYNC_REQUIRED:GIT_PATH_NOT_SAFE:${managedPath}`);
}
