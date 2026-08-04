import path from "node:path";

export function isLocalProjectionPath(rootPath: string, filePath: string): boolean {
  const relativePath = path.relative(rootPath, filePath);
  return relativePath.length === 0
    || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}
