import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, sha256Text } from "../../kernel/src/index.ts";
import {
  appleDesktopMetadata,
  installedDependencyTree,
  runtimeStateDirectory,
} from "./migration-import-authored-audit.ts";
import { decodeLegacyExecution, destinationLinkConflict, symlinkTarget, utf8File } from "./migration-import-legacy.ts";
import { isMigrationImportRecord, nonEmpty } from "./migration-import-report.ts";
import type { AuthoredDisposition, Prepared } from "./migration-import-types.ts";

export function classifyAuthored(
  root: string,
  destinationRoot: string,
  sourcePath: string,
  symlink: boolean,
  packageOwners: ReadonlyMap<string, string>,
): {
  readonly surface: string;
  readonly disposition: AuthoredDisposition;
  readonly reason: string;
} {
  const excluded = (surface: string, reason: string) => ({
      surface,
      disposition: "excluded" as const,
      reason,
    }),
    migrated = (surface: string, reason: string) => ({
      surface,
      disposition: "migrated" as const,
      reason,
    }),
    required = (surface: string, reason: string) => ({
      surface,
      disposition: "required" as const,
      reason,
    });
  if (sourcePath.endsWith("/**")) {
    const directory = path.join(root, sourcePath.slice(0, -3));
    if (runtimeStateDirectory(directory))
      return excluded(
        "runtime-state",
        "VCS, daemon, lock, journal, and browser-session state belongs to the source checkout, not the ledger",
      );
    if (installedDependencyTree(directory))
      return excluded(
        "installed-dependencies",
        "installed dependencies are reproducible from the migrated package manifests and lockfiles",
      );
  }
  if (sourcePath.startsWith("objects/"))
    return excluded("objects/**", "referenced CAS content is regenerated from claims carried by migrated events");
  if (sourcePath.startsWith("presets/"))
    return required(
      "presets/**",
      "legacy preset packages have a dedicated channel that this migration importer does not wire",
    );
  if (symlink) {
    const target = symlinkTarget(root, sourcePath);
    if (target === null)
      return required(
        "symbolic-link",
        "symbolic link target bytes are not UTF-8 and cannot use the text claim channel",
      );
    return (
      destinationLinkConflict(destinationRoot, sourcePath, target) ??
      migrated(
        "repo-document",
        "symbolic link target text is replayed without dereferencing through a typed repository node claim",
      )
    );
  }
  if (sourcePath.endsWith("/")) return excluded("empty-directory", "an empty directory has no ledger content to carry");
  if (appleDesktopMetadata(root, sourcePath))
    return excluded("os-metadata", "operating-system desktop metadata is not ledger content");
  if (sourcePath === "harness.yaml")
    return excluded(
      "workspace-config",
      [
        "the source workspace configuration describes the archived repository and ",
        "fresh init owns the destination configuration",
      ].join(""),
    );
  const task = /^(tasks\/[^/]+)\/(.+)$/u.exec(sourcePath);
  if (task) {
    const taskId = packageOwners.get(task[1]!),
      tail = task[2]!,
      surface = `task:${tail.includes("/") ? `${tail.split("/")[0]}/**` : tail}`;
    if (!taskId) return required(surface, "task package has no valid INDEX.md owner and cannot be replayed");
    if (tail === "INDEX.md") return migrated("task:INDEX.md", "task replay writes the native v2 package index");
    const taskBody = utf8File(root, sourcePath);
    if (taskBody === null)
      return excluded(
        "binary-attachment",
        [
          "owner decision: binary attachments do not enter the new ledger; the ",
          "archived source retains the original bytes",
        ].join(""),
      );
    if (tail.startsWith("executions/"))
      return /^executions\/[^/]+\.md$/u.test(tail) && decodeLegacyExecution(taskBody, taskId)
        ? migrated("task:executions/**", "legacy execution/v2 is replayed as a native archived-execution/v1 projection")
        : required("task:executions/**", "execution evidence does not satisfy the strict legacy execution/v2 contract");
    return migrated(surface, "UTF-8 task package content is replayed through a typed migration document claim");
  }
  if (/^decisions\/[^/]+\/decision\.md$/u.test(sourcePath))
    return migrated("decision:decision.md", "decision replay writes normalized frontmatter and preserved prose");
  if (/^decisions\/[^/]+\//u.test(sourcePath))
    return required(
      "decision:supporting/**",
      "supporting decision package documents need the dedicated decision channel",
    );
  if (sourcePath === "events/head.json")
    return excluded("events/head.json", "the destination event head is rebuilt from replayed migration events");
  if (sourcePath.startsWith("events/"))
    return required("events/**", "canonical source events require semantic replay or an explicit archival rule");
  const body = utf8File(root, sourcePath);
  if (body === null)
    return excluded(
      "binary-attachment",
      "owner decision: binary attachments do not enter the new ledger; the archived source retains the original bytes",
    );
  const schema = structuredSchema(body);
  if (schema === "attribution-event/v1")
    return excluded(
      "source-attribution",
      "source attribution is consumed as the principal for replayed migration events",
    );
  if (schema === "attribution-event/v2")
    return excluded(
      "source-authority-attribution",
      [
        "authority attribution records only witness mutations already represented ",
        "by replayed native entities and have no independent projection",
      ].join(""),
    );
  if (schema === "authority-key-registry/v1")
    return excluded(
      "source-authority-state",
      "an old authority trust root belongs to the source runtime and must not be activated in the destination",
    );
  const references = referencedContent(root, body);
  if ("error" in references) return required("repo-document", references.error);
  const conflict = destinationConflict(destinationRoot, sourcePath, body);
  return conflict ?? migrated("repo-document", "UTF-8 authored content uses the repository document migration channel");
}

export function structuredSchema(body: string): string | null {
  const parse = (value: string): unknown => {
      try {
        return JSON.parse(value);
      } catch (error) {
        consumeKnownError(error);
        return null;
      }
    },
    value = parse(body) ?? parse(body.split("\n").find((line) => line.trim()) ?? "");
  return isMigrationImportRecord(value) && typeof value.schema === "string" ? value.schema : null;
}

export function referencedContent(
  authoredRoot: string,
  documentBody: string,
): { readonly blobs: readonly Prepared["blobs"][number][] } | { readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(documentBody);
  } catch (error) {
    consumeKnownError(error);
    return { blobs: [] };
  }
  const references: Readonly<Record<string, unknown>>[] = [],
    visit = (candidate: unknown): void => {
      if (Array.isArray(candidate)) {
        for (const item of candidate) visit(item);
        return;
      }
      if (!isMigrationImportRecord(candidate)) return;
      if (candidate.store === "authored-cas/v1") references.push(candidate);
      for (const nested of Object.values(candidate)) visit(nested);
    };
  visit(value);
  const blobs = new Map<string, Prepared["blobs"][number]>();
  for (const reference of references) {
    if (
      !nonEmpty(reference.ref) ||
      !/^[0-9a-f]{64}$/u.test(String(reference.sha256)) ||
      !Number.isSafeInteger(reference.size) ||
      (reference.size as number) < 0 ||
      !nonEmpty(reference.mediaType)
    )
      return {
        error: "an authored-cas/v1 reference is malformed and cannot be migrated without guessing",
      };
    const hash = String(reference.sha256),
      match = /(?:^|\/)objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{62})$/u.exec(reference.ref);
    if (!match || `${match[1]}${match[2]}` !== hash)
      return {
        error: `CAS reference ${reference.ref} does not identify its declared sha256 ${hash}`,
      };
    const source = path.join(authoredRoot, "objects", "sha256", match[1]!, match[2]!);
    let bytes: Buffer;
    try {
      bytes = readFileSync(source);
    } catch (error) {
      consumeKnownError(error);
      return {
        error: `referenced CAS blob ${hash} is missing from the source repository`,
      };
    }
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      consumeKnownError(error);
      return {
        error: [
          "referenced CAS blob ",
          `${hash}`,
          " is not UTF-8; the canonical content store has no arbitrary-byte claim ",
          "channel",
        ].join(""),
      };
    }
    if (bytes.byteLength !== reference.size || sha256Text(body) !== hash)
      return {
        error: `referenced CAS blob ${hash} does not match its declared size and digest`,
      };
    const held = blobs.get(hash);
    if (held && (held.size !== reference.size || held.mediaType !== reference.mediaType))
      return {
        error: `referenced CAS blob ${hash} has conflicting claim metadata`,
      };
    blobs.set(hash, {
      sha256: hash,
      size: bytes.byteLength,
      mediaType: reference.mediaType,
      body,
    });
  }
  return { blobs: [...blobs.values()] };
}

export function destinationConflict(
  destinationRoot: string,
  sourcePath: string,
  sourceBody: string,
): {
  readonly surface: string;
  readonly disposition: "excluded" | "required";
  readonly reason: string;
  readonly targetConflict?: true;
} | null {
  const target = path.join(destinationRoot, sourcePath);
  let info;
  try {
    info = lstatSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  if (!info.isFile())
    return {
      surface: sourcePath,
      disposition: "required",
      targetConflict: true,
      reason: [
        "destination already contains a non-file at the same path; source sha256=",
        `${sha256Text(sourceBody)}`,
        ", source bytes=",
        `${Buffer.byteLength(sourceBody)}`,
        "",
      ].join(""),
    };
  const destinationBody = utf8File(destinationRoot, sourcePath);
  if (destinationBody === null)
    return {
      surface: sourcePath,
      disposition: "required",
      targetConflict: true,
      reason: [
        "destination already contains non-UTF-8 bytes at the same path; source ",
        "sha256=",
        `${sha256Text(sourceBody)}`,
        ", source bytes=",
        `${Buffer.byteLength(sourceBody)}`,
        ", destination bytes=",
        `${info.size}`,
        "",
      ].join(""),
    };
  const sourceHash = sha256Text(sourceBody),
    destinationHash = sha256Text(destinationBody);
  return sourceHash === destinationHash
    ? {
        surface: "already-present",
        disposition: "excluded",
        reason: `destination already contains identical content at ${sourcePath} (sha256=${sourceHash})`,
      }
    : {
        surface: sourcePath,
        disposition: "required",
        targetConflict: true,
        reason: [
          "destination content differs: source sha256=",
          `${sourceHash}`,
          ", source bytes=",
          `${Buffer.byteLength(sourceBody)}`,
          "; destination sha256=",
          `${destinationHash}`,
          ", destination bytes=",
          `${Buffer.byteLength(destinationBody)}`,
          "",
        ].join(""),
      };
}
