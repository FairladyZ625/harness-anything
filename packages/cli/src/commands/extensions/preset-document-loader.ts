import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
  PresetDocumentFrontmatterSchema,
  readFrontmatter,
  type PresetDocumentFrontmatter
} from "../../../../kernel/src/index.ts";

export const presetDocumentFilename = "PRESET.md";

export interface PresetDocumentWarning {
  readonly code: "preset_document_missing" | "preset_document_invalid";
  readonly message: string;
  readonly path: typeof presetDocumentFilename;
}

export interface LoadedPresetDocument {
  readonly frontmatter?: PresetDocumentFrontmatter;
  readonly warnings: ReadonlyArray<PresetDocumentWarning>;
}

export function documentedPresetSource<Manifest>(
  manifest: Manifest,
  layer: "project" | "user" | "builtin",
  sourcePath: string
): {
  readonly manifest: Manifest;
  readonly layer: "project" | "user" | "builtin";
  readonly sourcePath: string;
  readonly documentation?: PresetDocumentFrontmatter;
  readonly warnings: ReadonlyArray<PresetDocumentWarning>;
} {
  const document = loadPresetDocument(sourcePath);
  return {
    manifest,
    layer,
    sourcePath,
    documentation: document.frontmatter,
    warnings: document.warnings
  };
}

const allowedFrontmatterFields = new Set(["schema", "description", "whenToUse", "inputs", "entrypoints"]);
const mapFrontmatterFields = new Set(["inputs", "entrypoints"]);

export function loadPresetDocument(manifestPath: string): LoadedPresetDocument {
  const documentPath = path.join(path.dirname(path.resolve(manifestPath)), presetDocumentFilename);
  if (!existsSync(documentPath)) {
    return warning(
      "preset_document_missing",
      `${presetDocumentFilename} is missing; using the preset title as its description.`
    );
  }

  try {
    const frontmatter = readFrontmatter(readFileSync(documentPath, "utf8"));
    if (frontmatter === null) {
      return warning(
        "preset_document_invalid",
        `${presetDocumentFilename} is missing YAML frontmatter; using the preset title as its description.`
      );
    }
    const decoded = Schema.decodeUnknownSync(PresetDocumentFrontmatterSchema)(parsePresetDocumentFrontmatter(frontmatter));
    return { frontmatter: decoded, warnings: [] };
  } catch (error) {
    return warning(
      "preset_document_invalid",
      `${presetDocumentFilename} frontmatter is invalid; using the preset title as its description. ${presetDocumentErrorMessage(error)}`
    );
  }
}

function parsePresetDocumentFrontmatter(frontmatter: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let activeMap: "inputs" | "entrypoints" | undefined;

  for (const [index, rawLine] of frontmatter.split("\n").entries()) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(rawLine)) {
      const match = rawLine.match(/^([A-Za-z][A-Za-z0-9]*):[ \t]*(.*)$/u);
      if (!match) throw new Error(`line ${index + 1} is not a supported top-level field`);
      const [, key, rawValue] = match;
      if (!key || !allowedFrontmatterFields.has(key)) throw new Error(`unknown field ${key ?? ""}`.trim());
      if (Object.hasOwn(result, key)) throw new Error(`duplicate field ${key}`);
      if (mapFrontmatterFields.has(key)) {
        if (rawValue?.trim()) throw new Error(`${key} must be an indented name-to-description map`);
        result[key] = {};
        activeMap = key as "inputs" | "entrypoints";
      } else {
        result[key] = parseScalar(rawValue ?? "", key);
        activeMap = undefined;
      }
      continue;
    }

    if (!activeMap) throw new Error(`line ${index + 1} is unexpectedly indented`);
    const match = rawLine.match(/^[ \t]+([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u);
    if (!match) throw new Error(`line ${index + 1} is not a supported ${activeMap} entry`);
    const [, key, rawValue] = match;
    const entries = result[activeMap] as Record<string, string>;
    if (!key) throw new Error(`line ${index + 1} is missing an entry name`);
    if (Object.hasOwn(entries, key)) throw new Error(`duplicate ${activeMap} entry ${key}`);
    entries[key] = parseScalar(rawValue ?? "", `${activeMap}.${key}`);
  }

  return result;
}

function parseScalar(rawValue: string, field: string): string {
  const value = rawValue.trim();
  if (!value) throw new Error(`${field} must not be empty`);
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string") throw new Error(`${field} must be a string`);
    return parsed;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error(`${field} has an unterminated quoted string`);
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

function warning(code: PresetDocumentWarning["code"], message: string): LoadedPresetDocument {
  return { warnings: [{ code, message, path: presetDocumentFilename }] };
}

function presetDocumentErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Frontmatter validation failed.";
}
