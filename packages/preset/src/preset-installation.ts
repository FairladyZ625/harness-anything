import { decodePresetPackageV3, parsePresetJson } from "./preset-package.ts";
import {
  defaultBundled,
  isPresetResolutionRecord,
  presetFailure,
} from "./preset-resolver-common.ts";
import { consumeKnownError } from "./preset.contract.ts";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

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
  sources.forEach(decodePresetPackageV3);
  const packages = sources.map((source) =>
    installPresetPackage({
      source,
      userRoot: input.userRoot,
      dryRun: input.dryRun,
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
}) {
  const decoded = decodePresetPackageV3(input.source),
    userRoot = path.resolve(input.userRoot),
    objects = path.join(userRoot, "preset-objects"),
    active = path.join(userRoot, "active"),
    objectRoot = path.join(objects, decoded.packageDigest),
    temporaryObject = path.join(objects, `.install-${randomUUID()}`),
    pointer = path.join(active, `${decoded.manifest.id}.json`),
    temporaryPointer = path.join(
      active,
      `.${decoded.manifest.id}-${randomUUID()}.tmp`,
    ),
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
    for (const directory of [userRoot, objects, active])
      assertInstallDirectory(directory);
    return report;
  }
  for (const directory of [userRoot, objects, active])
    ensureInstallDirectory(directory);
  try {
    if (!existsSync(objectRoot)) {
      cpSync(decoded.root, temporaryObject, {
        recursive: true,
        errorOnExist: true,
      });
      const copied = decodePresetPackageV3(temporaryObject);
      if (copied.packageDigest !== decoded.packageDigest)
        throw presetFailure(
          "digest_mismatch",
          "Copied preset package does not match its preflight digest.",
        );
      renameSync(temporaryObject, objectRoot);
    } else if (
      decodePresetPackageV3(objectRoot).packageDigest !== decoded.packageDigest
    )
      throw presetFailure(
        "digest_mismatch",
        "Immutable preset object does not match its directory digest.",
      );
    input.killpoint?.("after-object");
    writeFileSync(
      temporaryPointer,
      `${JSON.stringify({ schema: "preset-active-pointer/v1", presetId: decoded.manifest.id, verticalId: decoded.manifest.vertical, digest: decoded.packageDigest })}\n`,
    );
    renameSync(temporaryPointer, pointer);
    input.killpoint?.("after-pointer");
    return report;
  } finally {
    if (existsSync(temporaryObject))
      rmSync(temporaryObject, { recursive: true, force: true });
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
  const pointer = path.join(
    path.resolve(input.userRoot),
    "active",
    `${input.presetId}.json`,
  );
  if (!existsSync(pointer)) return false;
  if (!lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink())
    throw presetFailure(
      "invalid_pointer",
      "Active pointer is not a regular file.",
    );
  if (!input.dryRun) unlinkSync(pointer);
  return true;
}

export function ensureInstallDirectory(target: string): void {
  if (
    existsSync(target) &&
    (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink())
  )
    throw presetFailure(
      "invalid_install_root",
      `Preset install directory ${target} is not regular.`,
    );
  mkdirSync(target, { recursive: true });
}

export function assertInstallDirectory(target: string): void {
  if (
    existsSync(target) &&
    (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink())
  )
    throw presetFailure(
      "invalid_install_root",
      `Preset install directory ${target} is not regular.`,
    );
}

export function activeDigest(pointer: string): string | undefined {
  try {
    if (
      !existsSync(pointer) ||
      !lstatSync(pointer).isFile() ||
      lstatSync(pointer).isSymbolicLink()
    )
      return undefined;
    const value = parsePresetJson(
      readFileSync(pointer, "utf8"),
      "invalid_pointer",
    );
    return isPresetResolutionRecord(value) && typeof value.digest === "string"
      ? value.digest
      : undefined;
  } catch (error) {
    consumeKnownError(error);
    return undefined;
  }
}
