import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function discoverWorkspacePackages(root) {
  const rootPackage = readJson(path.join(root, "package.json"));
  const workspacePatterns = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;
  if (!Array.isArray(workspacePatterns) || workspacePatterns.length === 0) {
    throw new Error("root package must declare at least one workspace pattern");
  }

  const packageRoots = new Set();
  for (const pattern of workspacePatterns) {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      throw new Error(`workspace pattern must be a non-empty string: ${JSON.stringify(pattern)}`);
    }
    for (const absoluteRoot of expandSegments(root, pattern.split("/"))) {
      if (existsSync(path.join(absoluteRoot, "package.json"))) {
        packageRoots.add(toRelative(root, absoluteRoot));
      }
    }
  }

  return [...packageRoots].sort().map((relativeRoot) => {
    const manifestPath = `${relativeRoot}/package.json`;
    const sourceRoot = `${relativeRoot}/src`;
    return {
      manifest: readJson(path.join(root, manifestPath)),
      manifestPath,
      relativeRoot,
      sourceRoot: existsSync(path.join(root, sourceRoot)) ? sourceRoot : null
    };
  });
}

export function discoverWorkspaceSourceRoots(root) {
  return discoverWorkspacePackages(root)
    .map((workspacePackage) => workspacePackage.sourceRoot)
    .filter((sourceRoot) => sourceRoot !== null);
}

function expandSegments(base, segments) {
  if (segments.length === 0) return [base];
  const [segment, ...rest] = segments;
  if (segment === "*") {
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => expandSegments(path.join(base, entry.name), rest));
  }
  if (segment.includes("*")) {
    throw new Error(`unsupported workspace glob segment ${JSON.stringify(segment)}; only whole-segment * is supported`);
  }
  return expandSegments(path.join(base, segment), rest);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function toRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}
