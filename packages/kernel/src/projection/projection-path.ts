import path from "node:path";

export function isDeclaredEntityFile(authoredRoot: string, filePath: string): boolean {
  if (!isPathWithin(authoredRoot, filePath)) return false;
  const relative = path.relative(authoredRoot, filePath).split(path.sep).join("/");
  return /^sessions\/[^/]+\.md$/u.test(relative) ||
    /^tasks\/[^/]+\/(?:executions|consents|reviews)\/[^/]+\.md$/u.test(relative);
}

export function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
