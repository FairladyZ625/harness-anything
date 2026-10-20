import { decodePresetPackageV3, parsePresetJson, scan } from "./preset-package.ts";
import { defaultBundled, isPresetResolutionRecord, presetFailure } from "./preset-resolver-common.ts";
import type { DecodedPresetPackageV3 } from "./preset-resolver-types.ts";
import { consumeKnownError } from "./preset.contract.ts";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { convertCompletionDeclaration, convertCompletionManifest } from "./completion-migration.ts";

export function seedPresetPackages(input: {
  readonly userRoot: string;
  readonly bundledRoot?: string;
  readonly dryRun?: boolean;
}) {
  const root = path.resolve(input.bundledRoot ?? defaultBundled),
    sources = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .map((entry) => path.join(root, entry.name))
          .sort()
      : [];
  const packages = sources
    .map((source) => decodePresetPackageV3(source))
    .map((decoded) =>
      installPresetPackage({
        source: decoded.root,
        userRoot: input.userRoot,
        dryRun: input.dryRun,
        decoded,
      }),
    );
  return {
    schema: "preset-seed-report/v1" as const,
    mode: input.dryRun ? ("dry-run" as const) : ("apply" as const),
    packageCount: packages.length,
    packages,
  };
}

export function installPresetPackage(input: {
  readonly source: string;
  readonly userRoot: string;
  readonly dryRun?: boolean;
  readonly killpoint?: (point: "after-object" | "after-pointer") => void;
  readonly decoded?: DecodedPresetPackageV3;
}) {
  const decoded = input.decoded ?? decodePresetPackageV3(input.source),
    userRoot = path.resolve(input.userRoot),
    objects = path.join(userRoot, "preset-objects"),
    active = path.join(userRoot, "active"),
    objectRoot = path.join(objects, decoded.packageDigest),
    temporaryObject = path.join(objects, `.install-${randomUUID()}`),
    pointer = path.join(active, `${decoded.manifest.id}.json`),
    temporaryPointer = path.join(active, `.${decoded.manifest.id}-${randomUUID()}.tmp`),
    changed = activeDigest(pointer) !== decoded.packageDigest,
    report = {
      presetId: decoded.manifest.id,
      digest: decoded.packageDigest,
      mode: input.dryRun ? ("dry-run" as const) : ("apply" as const),
      changed,
      source: decoded.root,
      issues: [],
    };
  if (input.dryRun) {
    for (const directory of [userRoot, objects, active]) assertInstallDirectory(directory);
    return report;
  }
  for (const directory of [userRoot, objects, active]) ensureInstallDirectory(directory);
  try {
    if (!existsSync(objectRoot)) {
      cpSync(decoded.root, temporaryObject, {
        recursive: true,
        errorOnExist: true,
      });
      const copied = decodePresetPackageV3(temporaryObject);
      if (copied.packageDigest !== decoded.packageDigest)
        throw presetFailure("digest_mismatch", "Copied preset package does not match its preflight digest.");
      renameSync(temporaryObject, objectRoot);
    } else if (decodePresetPackageV3(objectRoot).packageDigest !== decoded.packageDigest)
      throw presetFailure("digest_mismatch", "Immutable preset object does not match its directory digest.");
    input.killpoint?.("after-object");
    writeFileSync(
      temporaryPointer,
      `${JSON.stringify({
        schema: "preset-active-pointer/v1",
        presetId: decoded.manifest.id,
        verticalId: decoded.manifest.vertical,
        digest: decoded.packageDigest,
      })}\n`,
    );
    renameSync(temporaryPointer, pointer);
    input.killpoint?.("after-pointer");
    return report;
  } finally {
    if (existsSync(temporaryObject)) rmSync(temporaryObject, { recursive: true, force: true });
    if (existsSync(temporaryPointer)) rmSync(temporaryPointer, { force: true });
  }
}

export function uninstallPresetPackage(input: {
  readonly presetId: string;
  readonly userRoot: string;
  readonly dryRun?: boolean;
}): boolean {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(input.presetId))
    throw presetFailure("invalid_preset_id", "Preset id is invalid.");
  const pointer = path.join(path.resolve(input.userRoot), "active", `${input.presetId}.json`);
  if (!existsSync(pointer)) return false;
  if (!lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink())
    throw presetFailure("invalid_pointer", "Active pointer is not a regular file.");
  if (!input.dryRun) unlinkSync(pointer);
  return true;
}

export function ensureInstallDirectory(target: string): void {
  if (existsSync(target) && (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()))
    throw presetFailure("invalid_install_root", `Preset install directory ${target} is not regular.`);
  mkdirSync(target, { recursive: true });
}

export function assertInstallDirectory(target: string): void {
  if (existsSync(target) && (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()))
    throw presetFailure("invalid_install_root", `Preset install directory ${target} is not regular.`);
}

export function activeDigest(pointer: string): string | undefined {
  try {
    if (!existsSync(pointer) || !lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink()) return undefined;
    const value = parsePresetJson(readFileSync(pointer, "utf8"), "invalid_pointer");
    return isPresetResolutionRecord(value) && typeof value.digest === "string" ? value.digest : undefined;
  } catch (error) {
    consumeKnownError(error);
    return undefined;
  }
}

export function migrateCompletion(input: {
  readonly source: string;
  readonly destination?: string;
  readonly dryRun: boolean;
}) {
  const source = path.resolve(input.source),
    stat = lstatSync(source),
    json = (body: string) => parsePresetJson(body, "invalid_migration_input"),
    serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  if (stat.isSymbolicLink()) throw new Error("Migration source must be a regular file or package directory.");
  if (stat.isFile()) {
    const original = json(readFileSync(source, "utf8")),
      converted = convertCompletionDeclaration(original),
      changed = JSON.stringify(original) !== JSON.stringify(converted);
    if (!input.dryRun) {
      if (!input.destination) throw new Error("Declaration conversion requires --destination <new-file>.");
      writeFileSync(input.destination, serialize(converted), { flag: "wx" });
    }
    return {
      kind: "declaration",
      changed,
      next: "Review the candidate; place it at harness/vertical.json and run ha doc sync --submit --path harness/vertical.json. Reopen the repository before using it.",
    };
  }
  // Historical external input has not crossed the current package writer. Scan before copying;
  // validate the entire converted candidate before returning it for queued preset installation.
  const files = scan(source),
    original = json(files.get("preset.json") ?? "null"),
    manifest = convertCompletionManifest(original),
    changed = JSON.stringify(original) !== JSON.stringify(manifest),
    temporary = mkdtempSync(path.join(tmpdir(), "ha-completion-migration-"));
  try {
    const candidate = path.join(temporary, "package");
    cpSync(source, candidate, { recursive: true });
    writeFileSync(path.join(candidate, "preset.json"), changed ? serialize(manifest) : files.get("preset.json")!);
    decodePresetPackageV3(candidate);
    if (!input.dryRun) {
      if (!input.destination) throw new Error("Package conversion requires --destination <new-directory>.");
      // Node 24.22+ rejects cpSync into an existing directory even when it is empty and
      // errorOnExist only intends to protect files. Refuse an occupied destination here,
      // then let cpSync create it so the copy stays portable across Node 24 minors.
      if (existsSync(input.destination)) throw new Error(`Migration destination already exists: ${input.destination}`);
      cpSync(candidate, input.destination, { recursive: true, errorOnExist: true, force: false });
    }
    return {
      kind: "preset",
      changed,
      source,
      next: "Review the candidate; run ha preset install --source <candidate-directory> for the target repository. The center repository writer queues pin activation.",
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
