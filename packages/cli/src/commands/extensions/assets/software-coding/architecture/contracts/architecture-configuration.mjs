import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { digestJson, digestText } from "./architecture-digests.mjs";
import { validateArchitectureManifest } from "./architecture-manifest.mjs";
import {
  architectureRootPathIssue,
  filesystemKind,
  pathComponentIssue,
  portableSiblingAliases,
  sameOrInside
} from "./architecture-filesystem-boundary.mjs";
import { compareArchitectureText, findPortableCollisions, portablePathKey } from "./architecture-portable-path.mjs";

export function inspectArchitectureConfiguration(options) {
  const architectureRoot = path.join(options.authoredRoot, "context", "architecture");
  const manifestPath = path.join(architectureRoot, "architecture-manifest.json");
  const manifestRelativePath = repositoryRelative(options.projectRoot, manifestPath);
  const architectureRootIssue = architectureRootPathIssue(options, architectureRoot);
  if (architectureRootIssue?.kind === "missing") {
    return {
      configured: false,
      architectureRoot,
      manifest: { path: manifestRelativePath, present: false, valid: false, digest: null },
      issues: []
    };
  }
  if (architectureRootIssue) {
    return invalidConfiguration(architectureRoot, manifestRelativePath, [{
      code: architectureRootIssue.kind === "portable-alias"
        ? "architecture_root_path_collision"
        : architectureRootIssue.kind === "symlink" ? "architecture_root_symlink" : "architecture_root_invalid",
      path: repositoryRelative(options.projectRoot, architectureRootIssue.path),
      message: "Architecture root path components must be exact, regular repository directories."
    }], null, false);
  }
  const manifestAliases = portableSiblingAliases(architectureRoot, path.basename(manifestPath));
  if (manifestAliases.length > 0) {
    return invalidConfiguration(architectureRoot, manifestRelativePath, [{
      code: "architecture_manifest_path_collision",
      path: repositoryRelative(options.projectRoot, path.join(architectureRoot, manifestAliases[0])),
      message: "Architecture manifest paths must use the exact canonical spelling without portable aliases."
    }], null, false);
  }
  const manifestKind = filesystemKind(manifestPath);
  if (manifestKind === "missing") {
    return {
      configured: false,
      architectureRoot,
      manifest: { path: manifestRelativePath, present: false, valid: false, digest: null },
      issues: []
    };
  }
  if (manifestKind !== "file") {
    return invalidConfiguration(architectureRoot, manifestRelativePath, [{
      code: manifestKind === "symlink" ? "architecture_manifest_symlink" : "architecture_manifest_not_file",
      path: manifestRelativePath,
      message: "Architecture manifest must be a regular file."
    }]);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return invalidConfiguration(architectureRoot, manifestRelativePath, [{
      code: "architecture_manifest_invalid_json",
      path: manifestRelativePath,
      message: "Architecture manifest must be valid JSON."
    }]);
  }

  const validation = validateArchitectureManifest(manifest);
  if (!validation.ok) {
    return invalidConfiguration(architectureRoot, manifestRelativePath, validation.issues.map((issue) => ({
      code: issue.code,
      path: issue.path,
      message: issue.message
    })));
  }

  const manifestDigest = digestJson(manifest);
  const modelRoot = path.resolve(architectureRoot, manifest.modelRoot);
  if (!sameOrInside(architectureRoot, modelRoot)) {
    return invalidConfiguration(architectureRoot, manifestRelativePath, [{
      code: "architecture_model_root_escape",
      path: manifest.modelRoot,
      message: "Architecture modelRoot must stay inside the architecture directory."
    }], manifestDigest);
  }
  const modelRootIssue = pathComponentIssue(architectureRoot, modelRoot, "directory");
  if (modelRootIssue) {
    return invalidConfiguration(architectureRoot, manifestRelativePath, [{
      code: modelRootIssue.kind === "portable-alias"
        ? "architecture_model_path_collision"
        : modelRootIssue.kind === "symlink" ? "architecture_model_root_symlink" : "architecture_model_root_missing",
      path: repositoryRelative(options.projectRoot, modelRootIssue.path),
      message: "Architecture modelRoot components must use exact spelling and regular repository directories."
    }], manifestDigest);
  }

  const providerConfigPath = path.resolve(modelRoot, manifest.provider.config);
  const requiredPaths = [
    providerConfigPath,
    ...manifest.views.map((view) => path.resolve(modelRoot, view.path))
  ];
  const issues = [];
  for (const requiredPath of requiredPaths) {
    if (!sameOrInside(modelRoot, requiredPath)) {
      issues.push({
        code: "architecture_model_path_escape",
        path: repositoryRelative(options.projectRoot, requiredPath),
        message: "Architecture provider and view paths must stay inside modelRoot."
      });
      continue;
    }
    const requiredPathIssue = pathComponentIssue(modelRoot, requiredPath, "file");
    if (requiredPathIssue) {
      issues.push({
        code: requiredPathIssue.kind === "portable-alias"
          ? "architecture_model_path_collision"
          : requiredPathIssue.kind === "symlink" ? "architecture_model_symlink" : "architecture_model_file_missing",
        path: repositoryRelative(options.projectRoot, requiredPathIssue.path),
        message: requiredPathIssue.kind === "portable-alias"
          ? "Architecture model inputs must use the exact manifest path spelling."
          : requiredPathIssue.kind === "symlink" ? "Architecture model inputs must not be symbolic links." : "A declared architecture model input is missing or is not a regular file."
      });
    }
  }

  const declaredModelPathKeys = new Set([manifest.provider.config, ...manifest.views.map((view) => view.path)].map(portablePathKey));
  const modelFiles = collectModelFiles(modelRoot, options.projectRoot, issues, declaredModelPathKeys);
  const portableCollisions = findPortableCollisions(modelFiles.map((entry) => entry.relativePath));
  for (const collision of portableCollisions) {
    issues.push({
      code: "architecture_model_path_collision",
      path: collision.paths.join(", "),
      message: "Architecture model paths collide after NFC normalization and case folding."
    });
  }

  const c4Files = modelFiles.filter((entry) => entry.relativePath.endsWith(".c4"));
  for (const file of c4Files) {
    if (/\bplaceholder\s+true\b/u.test(file.body)) {
      issues.push({
        code: "architecture_placeholder_remaining",
        path: file.relativePath,
        message: "Draft placeholder metadata must be replaced before snapshot or check."
      });
    }
  }

  const digestInputs = modelFiles.map(({ relativePath, body }) => ({
    path: relativePath,
    digest: digestText(body)
  }));
  const modelDigest = digestJson({ manifest, files: digestInputs });
  return {
    configured: true,
    architectureRoot,
    manifest: {
      path: manifestRelativePath,
      present: true,
      valid: issues.length === 0,
      digest: manifestDigest
    },
    manifestValue: manifest,
    modelRoot,
    modelDigest,
    modelFiles: digestInputs,
    issues
  };
}

function invalidConfiguration(architectureRoot, manifestPath, issues, digest = null, manifestPresent = true) {
  return { configured: true, architectureRoot, manifest: { path: manifestPath, present: manifestPresent, valid: false, digest: manifestPresent ? digest : null }, issues };
}

function collectModelFiles(modelRoot, projectRoot, issues, additionalPathKeys) {
  if (filesystemKind(modelRoot) !== "directory") {
    issues.push({
      code: "architecture_model_root_missing",
      path: repositoryRelative(projectRoot, modelRoot),
      message: "Architecture modelRoot must be an existing directory."
    });
    return [];
  }
  const files = [];
  walk(modelRoot);
  return files.sort((left, right) => compareArchitectureText(left.relativePath, right.relativePath));

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareArchitectureText(left.name, right.name))) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = repositoryRelative(projectRoot, entryPath);
      const modelRelativePath = repositoryRelative(modelRoot, entryPath);
      if (entry.isSymbolicLink()) {
        issues.push({ code: "architecture_model_symlink", path: relativePath, message: "Architecture model inputs must not be symbolic links." });
      } else if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && (entry.name.endsWith(".c4") || additionalPathKeys.has(portablePathKey(modelRelativePath)))) {
        files.push({ relativePath, body: readFileSync(entryPath, "utf8") });
      }
    }
  }
}

function repositoryRelative(root, target) { return path.relative(root, target).split(path.sep).join("/"); }
