import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CanonicalPublicationInspector } from "../../../application/src/index.ts";
import {
  encodeCanonicalCbor,
  entityRegistry,
  type PhysicalChangeV2,
  type SemanticMutationSetV2
} from "../../../kernel/src/index.ts";

export interface CanonicalPublicationEvidence {
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly parentCommits: ReadonlyArray<string>;
  readonly physicalChanges: ReadonlyArray<PhysicalChangeV2>;
}

export interface GitCanonicalPublicationInspector extends CanonicalPublicationInspector {
  readonly inspectPublication: (expectedPreviousHead: string | null) => Promise<CanonicalPublicationEvidence>;
}

export function createGitCanonicalPublicationInspector(canonicalRoot: string): GitCanonicalPublicationInspector {
  const rootDir = path.resolve(canonicalRoot);
  const currentHead = async (): Promise<string | null> => gitOptional(rootDir, "rev-parse", "--verify", "HEAD");
  const inspectPublication = async (expectedPreviousHead: string | null): Promise<CanonicalPublicationEvidence> => {
    const head = await currentHead();
    if (!head) throw new Error("AUTHORITY_CANONICAL_PUBLICATION_MISSING");
    const row = publicationGitText(rootDir, "rev-list", "--parents", "-n", "1", head).split(" ");
    const parentCommits = row.slice(1);
    if (parentCommits.length !== (expectedPreviousHead ? 1 : 0)
      || (expectedPreviousHead && parentCommits[0] !== expectedPreviousHead)) {
      throw new Error("AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR");
    }
    const changedPaths = readAuthorityGitBytes(rootDir, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", head)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map(canonicalGitPath)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const physicalChanges = changedPaths.map((changedPath) => ({
      path: changedPath,
      beforeDigest: expectedPreviousHead ? blobDigest(rootDir, expectedPreviousHead, changedPath) : null,
      afterDigest: blobDigest(rootDir, head, changedPath)
    })).sort((left, right) => Buffer.compare(
      Buffer.from(encodeCanonicalCbor(left)),
      Buffer.from(encodeCanonicalCbor(right))
    ));
    return {
      commitSha: head,
      previousCommit: expectedPreviousHead,
      parentCommits,
      physicalChanges
    };
  };
  return {
    currentHead,
    inspectPublishedHead: async (expectedPreviousHead) => {
      const evidence = await inspectPublication(expectedPreviousHead);
      return { commitSha: evidence.commitSha, parentCommits: evidence.parentCommits };
    },
    inspectPublication
  };
}

/** Fail closed unless every observed tree change is covered by the canonical registry mutation set. */
export function assertPublicationMatchesMutationSet(
  evidence: CanonicalPublicationEvidence,
  mutationSet: SemanticMutationSetV2
): void {
  const targets = mutationSet.mutations.flatMap((mutation) => {
    const registration = entityRegistry[mutation.entity.entityKind as keyof typeof entityRegistry];
    if (!registration || registration.projectionFacet.status !== "ready" || registration.storageLocator.status !== "ready") {
      throw new Error(`AUTHORITY_PUBLICATION_ENTITY_UNAVAILABLE:${mutation.entity.entityKind}`);
    }
    const identity = registration.projectionFacet.resolveCanonicalRef(mutation.entity.canonicalRef);
    return registration.storageLocator.locator.locate(identity, {}).targets
      .filter((target): target is typeof target & { readonly path: string } => Boolean(target.path));
  });
  if (evidence.physicalChanges.length === 0) throw new Error("AUTHORITY_PUBLICATION_TREE_EMPTY");
  for (const change of evidence.physicalChanges) {
    if (!targets.some((target) => target.access === "exact"
      ? change.path === target.path
      : change.path === target.path || change.path.startsWith(`${target.path}/`))) {
      throw new Error(`AUTHORITY_PUBLICATION_TREE_MISMATCH:${change.path}`);
    }
  }
  for (const target of targets) {
    const observed = evidence.physicalChanges.some((change) => target.access === "exact"
      ? change.path === target.path
      : change.path === target.path || change.path.startsWith(`${target.path}/`));
    if (!observed) throw new Error(`AUTHORITY_PUBLICATION_DECLARED_PATH_MISSING:${target.path}`);
  }
}

function blobDigest(rootDir: string, revision: string, changedPath: string): string | null {
  try {
    return createHash("sha256").update(readAuthorityGitBytes(rootDir, "show", `${revision}:${changedPath}`)).digest("hex");
  } catch {
    return null;
  }
}

function canonicalGitPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("AUTHORITY_PUBLICATION_PATH_INVALID");
  }
  return normalized;
}

function gitOptional(rootDir: string, ...args: ReadonlyArray<string>): string | null {
  try {
    return publicationGitText(rootDir, ...args);
  } catch {
    return null;
  }
}

function publicationGitText(rootDir: string, ...args: ReadonlyArray<string>): string {
  return readAuthorityGitBytes(rootDir, ...args).toString("utf8").trim();
}

/** Read-only Git observation shared by authority publication and cutover scanners. */
export function readAuthorityGitBytes(rootDir: string, ...args: ReadonlyArray<string>): Buffer {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
}
