// TypeScript source loading and workspace resolution for immutable gate inputs.
// Overlay Programs reuse unchanged syntax while obtaining their own checker.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { readWorkspacePackages } from "../public-workspaces.mjs";

/**
 * Workspace imports must resolve to the checkout under audit. A git worktree shares the canonical
 * install, so its node_modules workspace links point at the canonical packages; following them
 * would type-check the traced sources against another checkout while the kernel anchors are read
 * from this one, and the anchor lookup then reports the interface as missing. The workspaces this
 * checkout declares are therefore resolved to this checkout's own sources.
 */
function workspaceSourcePaths(sourceRoot, anchorRoot = sourceRoot) {
  const manifestRoot = fs.existsSync(path.join(sourceRoot, "package.json")) ? sourceRoot : anchorRoot;
  const manifestPath = path.join(manifestRoot, "package.json");
  if (!fs.existsSync(manifestPath)) return {};
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0) return {};
  const paths = {};
  for (const entry of readWorkspacePackages(manifestRoot)) {
    if (!fs.existsSync(path.join(sourceRoot, entry.directory))) continue;
    for (const [subpath, target] of Object.entries(entry.manifest.exports ?? {})) {
      const value = typeof target === "string" ? target : (target?.types ?? target?.default);
      if (typeof value !== "string" || !value.endsWith(".ts")) continue;
      paths[entry.manifest.name + (subpath === "." ? "" : subpath.slice(1))] = [
        path.posix.join(entry.directory, value.replace(/^\.\//u, "")),
      ];
    }
  }
  return paths;
}

export function createSourceProgram(rootDir, { anchorRoot, files, sourceFiles, sourceOverrides, oldProgram }) {
  const workspacePaths = workspaceSourcePaths(rootDir, anchorRoot),
    overrides = new Map([...sourceOverrides].map(([file, text]) => [path.resolve(rootDir, file), text])),
    options = {
      noEmit: true,
      allowJs: sourceFiles.some((file) => /\.[cm]?js$/u.test(file)),
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      // A shard may import a TSX type without declaring that file as a witness root.
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      types: [],
      ...(Object.keys(workspacePaths).length > 0 ? { baseUrl: rootDir, paths: workspacePaths } : {}),
    },
    host = ts.createCompilerHost(options),
    readSource = host.getSourceFile;
  host.readFile = (file) => overrides.get(path.resolve(file)) ?? ts.sys.readFile(file);
  host.fileExists = (file) => overrides.has(path.resolve(file)) || ts.sys.fileExists(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
    (!overrides.has(path.resolve(file)) && oldProgram?.getSourceFile(file)) ||
    readSource(file, languageVersion, onError, shouldCreateNewSourceFile);
  return ts.createProgram({ rootNames: files.map((file) => path.join(rootDir, file)), options, host, oldProgram });
}
