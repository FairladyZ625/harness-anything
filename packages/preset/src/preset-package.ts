import { decodeCatalog } from "./preset-assets.ts";
import {
  presetFailure,
  resolverContentHash,
} from "./preset-resolver-common.ts";
import type {
  DecodedPresetPackageV3,
  PresetPackageScript,
} from "./preset-resolver-types.ts";
import { validatePackagePolicy } from "./preset-validation.ts";
import {
  canonicalPresetBytes,
  parsePresetManifestV3,
  validatePresetDocumentV1,
} from "./preset.contract.ts";
import type { PresetDocumentV1 } from "./preset.contract.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function decodePresetPackageV3(root: string): DecodedPresetPackageV3 {
  return decodePackage(path.resolve(root), true);
}

export function decodePackage(
  root: string,
  requireLocalCatalog = false,
): DecodedPresetPackageV3 {
  const files = scan(root),
    manifestBody = file(files, "preset.json", "missing_manifest"),
    presetBody = file(files, "PRESET.md", "missing_preset_document"),
    manifest = parsePresetManifestV3(
      parsePresetJson(manifestBody, "invalid_manifest"),
    ),
    document = parseDocument(presetBody),
    task = manifest;
  for (const [name, entrypoint] of Object.entries(task?.entrypoints ?? {}))
    if (!files.has(entrypoint.command))
      throw presetFailure(
        "missing_script",
        `Entrypoint ${name} command ${entrypoint.command} is missing.`,
      );
  if (task?.policyPath)
    validatePackagePolicy(file(files, task.policyPath, "missing_policy"));
  const catalogBody = files.get("template-catalog.json"),
    hasSelections =
      task?.profiles.some((profile) => profile.templateSelections.length > 0) ??
      false;
  if (requireLocalCatalog && hasSelections && catalogBody === undefined)
    throw presetFailure(
      "missing_template_catalog",
      `User preset ${manifest.id} must provide template-catalog.json for its template selections.`,
    );
  if (catalogBody !== undefined) decodeCatalog(catalogBody, root);
  const digest = createHash("sha256");
  for (const [name, body] of [...files].sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    digest.update(`${name}\0${Buffer.byteLength(body)}\0`).update(body);
  return {
    manifest,
    document,
    root,
    packageDigest: digest.digest("hex"),
    manifestSha256: resolverContentHash(canonicalPresetBytes(manifest)),
  } as DecodedPresetPackageV3;
}

export function scan(root: string): Map<string, string> {
  if (
    !existsSync(root) ||
    !lstatSync(root).isDirectory() ||
    lstatSync(root).isSymbolicLink()
  )
    throw presetFailure(
      "invalid_package",
      `Preset package ${root} is not a regular directory.`,
    );
  const files = new Map<string, string>(),
    visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name),
          relative = path.relative(root, absolute).split(path.sep).join("/");
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
          throw presetFailure(
            "symlink_forbidden",
            `Preset package entry ${relative} is not regular.`,
          );
        if (entry.isDirectory()) visit(absolute);
        else files.set(relative, readFileSync(absolute, "utf8"));
      }
    };
  visit(root);
  return files;
}

export function presetPackageScripts(
  root: string,
): readonly PresetPackageScript[] {
  const directory = path.join(root, "scripts");
  if (!existsSync(directory)) return [];
  if (
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink()
  )
    throw presetFailure(
      "invalid_preset_scripts",
      `Preset package ${root} ships scripts as a non-directory node.`,
    );
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isFile())
        throw presetFailure(
          "invalid_preset_scripts",
          `Preset scripts entry scripts/${entry.name} is not a regular file; ` +
            "subdirectories and other node kinds are not materialized.",
        );
      return {
        name: entry.name,
        body: readFileSync(path.join(directory, entry.name), "utf8"),
      };
    });
}

export function parseDocument(body: string): PresetDocumentV1 {
  const value = presetDocumentValue(body),
    errors = validatePresetDocumentV1(value);
  if (errors.length)
    throw presetFailure("invalid_preset_document", errors.join("; "));
  if (!isPresetDocumentV1(value))
    throw presetFailure(
      "invalid_preset_document",
      "PRESET.md document is invalid.",
    );
  return value;
}

export function isPresetDocumentV1(value: unknown): value is PresetDocumentV1 {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schema?: unknown }).schema === "preset-document/v1" &&
    typeof (value as { description?: unknown }).description === "string" &&
    typeof (value as { whenToUse?: unknown }).whenToUse === "string" &&
    typeof (value as { body?: unknown }).body === "string"
  );
}

export function presetDocumentValue(
  body: string,
): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(body);
  if (!match) return null;
  return {
    ...Object.fromEntries(
      match[1]!.split(/\r?\n/u).flatMap((line) => {
        const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/u.exec(line);
        return field ? [[field[1]!, field[2]!]] : [];
      }),
    ),
    body: match[2]!,
  };
}

export function file(
  files: Map<string, string>,
  name: string,
  code: string,
): string {
  const body = files.get(name);
  if (body === undefined)
    throw presetFailure(code, `Preset package is missing ${name}.`);
  return body;
}

export function parsePresetJson(body: string, code: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw presetFailure(code, "JSON input is invalid.");
  }
}
