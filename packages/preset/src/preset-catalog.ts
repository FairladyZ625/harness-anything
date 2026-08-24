import { decodePackage, parsePresetJson } from "./preset-package.ts";
import { asFailure, key, presetFailure } from "./preset-resolver-common.ts";
import type { Candidate } from "./preset-resolver-types.ts";
import type { PresetLayer } from "./preset.contract.ts";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function effectiveCatalog(
  bundledRoot: string,
  userRoot: string,
): Map<string, Candidate> {
  const result = new Map<string, Candidate>();
  for (const item of enumerateBundled(bundledRoot))
    result.set(key(item.verticalId, item.id), item);
  for (const item of enumerateUser(userRoot)) {
    const targets =
      item.verticalId === "*"
        ? [...result]
            .filter(([, candidate]) => candidate.id === item.id)
            .map(([catalogKey]) => catalogKey)
        : [key(item.verticalId, item.id)];
    if (targets.length === 0) targets.push(key("*", item.id));
    for (const target of targets) {
      const shadowed = result.get(target);
      result.set(
        target,
        item.decoded
          ? item
          : {
              ...item,
              verticalId: shadowed?.verticalId ?? item.verticalId,
              ...(shadowed?.decoded
                ? { shadow: { title: shadowed.decoded.manifest.title } }
                : {}),
              error: presetFailure(
                "shadow_invalid",
                `${item.error?.message ?? "User package is invalid"}${
                  shadowed
                    ? `; bundled ${shadowed.id} remains blocked`
                    : ""
                }.`,
              ),
            },
      );
    }
  }
  return result;
}

export function enumerateBundled(root: string): Candidate[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) =>
      decodeCandidate(path.join(root, entry.name), "bundled", entry.name),
    );
}

export function enumerateUser(root: string): Candidate[] {
  const active = path.join(root, "active");
  if (!existsSync(active)) return [];
  if (!lstatSync(active).isDirectory() || lstatSync(active).isSymbolicLink())
    throw presetFailure(
      "invalid_pointer_root",
      "Active preset inventory is not a regular directory.",
    );
  return readdirSync(active, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => {
      const id = entry.name.slice(0, -5),
        source = path.join(active, entry.name);
      let verticalId = "*";
      try {
        if (entry.isSymbolicLink() || !entry.isFile())
          throw presetFailure(
            "invalid_pointer",
            `Active pointer ${id} is not a regular file.`,
          );
        const pointer = parsePresetJson(
          readFileSync(source, "utf8"),
          "invalid_pointer",
        ) as Record<string, unknown>;
        if (typeof pointer.verticalId === "string")
          verticalId = pointer.verticalId;
        if (
          Object.keys(pointer).length !== 4 ||
          pointer.schema !== "preset-active-pointer/v1" ||
          pointer.presetId !== id ||
          verticalId === "*" ||
          typeof pointer.digest !== "string" ||
          !/^[0-9a-f]{64}$/u.test(pointer.digest)
        )
          throw presetFailure(
            "invalid_pointer",
            `Active pointer ${id} is invalid.`,
          );
        return decodeCandidate(
          path.join(root, "preset-objects", pointer.digest),
          "user",
          id,
          verticalId,
          pointer.digest,
        );
      } catch (error) {
        return {
          id,
          verticalId,
          layer: "user",
          source,
          error: asFailure(error),
        };
      }
    });
}

export function decodeCandidate(
  root: string,
  layer: PresetLayer,
  directoryId: string,
  pointerVertical?: unknown,
  pointerDigest?: unknown,
): Candidate {
  try {
    const decoded = decodePackage(root, layer === "user");
    if (decoded.manifest.id !== directoryId)
      throw presetFailure(
        "path_id_mismatch",
        `Package directory ${directoryId} does not match ${decoded.manifest.id}.`,
      );
    if (
      pointerVertical !== undefined &&
      decoded.manifest.vertical !== pointerVertical
    )
      throw presetFailure(
        "invalid_pointer",
        `Pointer vertical does not match package ${directoryId}.`,
      );
    if (pointerDigest !== undefined && decoded.packageDigest !== pointerDigest)
      throw presetFailure(
        "digest_mismatch",
        `Pointer digest does not match package ${directoryId}.`,
      );
    return {
      id: decoded.manifest.id,
      verticalId: decoded.manifest.vertical,
      layer,
      source: decoded.root,
      decoded,
    };
  } catch (error) {
    return {
      id: directoryId,
      verticalId:
        typeof pointerVertical === "string"
          ? pointerVertical
          : "software/coding",
      layer,
      source: root,
      error: asFailure(error),
    };
  }
}
