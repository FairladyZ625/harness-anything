import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { CanonicalPublicationInspector } from "../../../application/src/index.ts";
import {
  encodeCanonicalCbor,
  entityRegistry,
  sha256Text,
  type PhysicalChangeV2,
  type SemanticMutationSetV2
} from "../../../kernel/src/index.ts";

export interface CanonicalPublicationEvidence {
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly parentCommits: ReadonlyArray<string>;
  readonly physicalChanges: ReadonlyArray<PhysicalChangeV2>;
  readonly pipelineGeneratedPaths: ReadonlyArray<string>;
  readonly contentAddressedPaths: ReadonlyArray<string>;
}

export interface GitCanonicalPublicationInspector extends CanonicalPublicationInspector {
  readonly inspectPublication: (
    expectedPreviousHead: string | null,
    expectedOpIds: ReadonlyArray<string>,
    expectedCommitSha?: string
  ) => Promise<CanonicalPublicationEvidence>;
  readonly findPublication: (expectedOpIds: ReadonlyArray<string>) => Promise<CanonicalPublicationEvidence>;
  readonly findPublicationForOperation: (opId: string) => Promise<CanonicalPublicationEvidence>;
  readonly scanFirstParentOperationAnchors: (input: {
    readonly exclusiveCommit?: string;
    readonly interestedOpIds: ReadonlySet<string>;
  }) => Promise<FirstParentOperationAnchorScan>;
}

export interface FirstParentOperationAnchor {
  readonly commitSha: string;
  readonly previousCommit: string;
  readonly opIds: ReadonlyArray<string>;
}

export interface FirstParentOperationAnchorScan {
  readonly headCommit: string | null;
  readonly scannedCommitCount: number;
  readonly anchors: ReadonlyArray<FirstParentOperationAnchor>;
}

export class AuthorityCanonicalPublicationNotFoundError extends Error {
  readonly opId: string;

  constructor(opId: string) {
    super(`AUTHORITY_CANONICAL_PUBLICATION_NOT_FOUND:expectedOpId=${opId}`);
    this.name = "AuthorityCanonicalPublicationNotFoundError";
    this.opId = opId;
  }
}

export class AuthorityRecoveryWatermarkInvalidError extends Error {
  constructor(commitSha: string) {
    super(`AUTHORITY_RECOVERY_WATERMARK_INVALID:commitSha=${commitSha}`);
    this.name = "AuthorityRecoveryWatermarkInvalidError";
  }
}

export function createGitCanonicalPublicationInspector(canonicalRoot: string): GitCanonicalPublicationInspector {
  const rootDir = path.resolve(canonicalRoot);
  const currentHead = async (): Promise<string | null> => gitOptional(rootDir, "rev-parse", "--verify", "HEAD");
  const scanFirstParentOperationAnchors = async (input: {
    readonly exclusiveCommit?: string;
    readonly interestedOpIds: ReadonlySet<string>;
  }): Promise<FirstParentOperationAnchorScan> => {
    const headCommit = await currentHead();
    if (!headCommit) return { headCommit: null, scannedCommitCount: 0, anchors: [] };
    let commits: string[];
    try {
      commits = input.exclusiveCommit === headCommit
        ? []
        : (await publicationGitTextAsync(
          rootDir,
          "rev-list",
          "--first-parent",
          input.exclusiveCommit ? `${input.exclusiveCommit}..${headCommit}` : headCommit
        )).split("\n").filter(Boolean);
    } catch (error) {
      if (input.exclusiveCommit) throw new AuthorityRecoveryWatermarkInvalidError(input.exclusiveCommit);
      throw error;
    }
    const recoveryWatermark = input.exclusiveCommit;
    if (recoveryWatermark && headCommit !== recoveryWatermark) {
      const oldest = commits.at(-1);
      const oldestParents = await (async () => {
        try {
          return oldest
            ? (await publicationGitTextAsync(rootDir, "rev-list", "--parents", "-n", "1", oldest)).split(" ").slice(1)
            : [];
        } catch {
          throw new AuthorityRecoveryWatermarkInvalidError(recoveryWatermark);
        }
      })();
      if (!oldest || oldestParents[0] !== recoveryWatermark) {
        throw new AuthorityRecoveryWatermarkInvalidError(recoveryWatermark);
      }
    }
    const anchors: FirstParentOperationAnchor[] = [];
    for (const commitSha of commits) {
      const parents = (await publicationGitTextAsync(rootDir, "rev-list", "--parents", "-n", "1", commitSha)).split(" ").slice(1);
      if (parents.length !== 2) continue;
      const sessionSubject = await publicationGitTextAsync(rootDir, "show", "-s", "--format=%s", parents[1]!);
      const opIds = commitSubjectOpIds(sessionSubject);
      if (!opIds.some((opId) => input.interestedOpIds.has(opId))) continue;
      anchors.push({ commitSha, previousCommit: parents[0]!, opIds });
    }
    return { headCommit, scannedCommitCount: commits.length, anchors };
  };
  const inspectPublication = async (
    expectedPreviousHead: string | null,
    expectedOpIds: ReadonlyArray<string>,
    expectedCommitSha?: string
  ): Promise<CanonicalPublicationEvidence> => {
    const head = expectedCommitSha ?? await currentHead();
    if (!head) throw new Error("AUTHORITY_CANONICAL_PUBLICATION_MISSING");
    const row = publicationGitText(rootDir, "rev-list", "--parents", "-n", "1", head).split(" ");
    const parentCommits = row.slice(1);
    const sessionCommit = parentCommits[1];
    const sessionParents = sessionCommit
      ? publicationGitText(rootDir, "rev-list", "--parents", "-n", "1", sessionCommit).split(" ").slice(1)
      : [];
    const mergeSubject = publicationGitText(rootDir, "show", "-s", "--format=%s", head);
    const sessionSubject = sessionCommit
      ? publicationGitText(rootDir, "show", "-s", "--format=%s", sessionCommit)
      : "";
    const expectedSessionSubjectSuffix = `[${expectedOpIds.join(",")}]`;
    const mergeTreeMatchesSession = sessionCommit
      ? gitExitCode(rootDir, "diff", "--quiet", head, sessionCommit) === 0
      : false;
    if (!expectedPreviousHead
      || parentCommits.length !== 2
      || parentCommits[0] !== expectedPreviousHead
      || sessionParents.length !== 1
      || sessionParents[0] !== expectedPreviousHead
      || !/^materializer: merge session [A-Za-z0-9][A-Za-z0-9._-]*$/u.test(mergeSubject)
      || !sessionSubject.endsWith(expectedSessionSubjectSuffix)
      || !mergeTreeMatchesSession) {
      throw publicationTopologyError({
        expectedPreviousHead,
        expectedOpIds,
        head,
        parentCommits,
        sessionParents,
        mergeSubject,
        sessionSubject,
        mergeTreeMatchesSession
      });
    }
    const changedPaths = readAuthorityGitBytes(rootDir, "diff", "--name-only", "-z", expectedPreviousHead, head)
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
    const pipelineGeneratedPaths = expectedOpIds.map((opId) => `attribution-events/${sha256Text(opId)}.jsonl`);
    const observedPipelinePaths = changedPaths.filter((changedPath) => changedPath.startsWith("attribution-events/"));
    if (observedPipelinePaths.length !== pipelineGeneratedPaths.length
      || observedPipelinePaths.some((changedPath) => !pipelineGeneratedPaths.includes(changedPath))) {
      throw new Error(
        `AUTHORITY_CANONICAL_PUBLICATION_PIPELINE_EVIDENCE_MISMATCH:expected=${pipelineGeneratedPaths.join(",") || "none"};actual=${observedPipelinePaths.join(",") || "none"};head=${head}`
      );
    }
    const contentAddressedPaths = physicalChanges.filter((change) => {
      const match = /^objects\/sha256\/([a-f0-9]{2})\/([a-f0-9]{62})$/u.exec(change.path);
      if (!match) return false;
      if (change.afterDigest !== `${match[1]}${match[2]}`) {
        throw new Error(`AUTHORITY_CANONICAL_PUBLICATION_CONTENT_ADDRESS_MISMATCH:path=${change.path};afterDigest=${change.afterDigest ?? "null"}`);
      }
      return true;
    }).map((change) => change.path);
    return {
      commitSha: head,
      previousCommit: expectedPreviousHead,
      parentCommits,
      physicalChanges,
      pipelineGeneratedPaths,
      contentAddressedPaths
    };
  };
  return {
    currentHead,
    inspectPublishedHead: async (expectedPreviousHead, expectedOpIds) => {
      const evidence = await inspectPublication(expectedPreviousHead, expectedOpIds);
      return { commitSha: evidence.commitSha, parentCommits: evidence.parentCommits };
    },
    inspectPublication,
    scanFirstParentOperationAnchors,
    findPublication: async (expectedOpIds) => {
      const expectedSessionSubjectSuffix = `[${expectedOpIds.join(",")}]`;
      const firstParentCommits = publicationGitText(rootDir, "rev-list", "--first-parent", "HEAD")
        .split("\n")
        .filter(Boolean);
      const matches: CanonicalPublicationEvidence[] = [];
      for (const commitSha of firstParentCommits) {
        const parents = publicationGitText(rootDir, "rev-list", "--parents", "-n", "1", commitSha).split(" ").slice(1);
        if (parents.length !== 2) continue;
        const sessionSubject = publicationGitText(rootDir, "show", "-s", "--format=%s", parents[1]!);
        if (!sessionSubject.endsWith(expectedSessionSubjectSuffix)) continue;
        matches.push(await inspectPublication(parents[0]!, expectedOpIds, commitSha));
      }
      if (matches.length !== 1) {
        throw new Error(
          `AUTHORITY_CANONICAL_PUBLICATION_NOT_UNIQUE:expectedOpIds=${expectedOpIds.join(",")};matches=${matches.map((entry) => entry.commitSha).join(",") || "none"}`
        );
      }
      return matches[0]!;
    },
    findPublicationForOperation: async (opId) => {
      const firstParentCommits = publicationGitText(rootDir, "rev-list", "--first-parent", "HEAD")
        .split("\n")
        .filter(Boolean);
      const matches: CanonicalPublicationEvidence[] = [];
      for (const commitSha of firstParentCommits) {
        const parents = publicationGitText(rootDir, "rev-list", "--parents", "-n", "1", commitSha).split(" ").slice(1);
        if (parents.length !== 2) continue;
        const sessionSubject = publicationGitText(rootDir, "show", "-s", "--format=%s", parents[1]!);
        const opIds = commitSubjectOpIds(sessionSubject);
        if (!opIds.includes(opId)) continue;
        matches.push(await inspectPublication(parents[0]!, opIds, commitSha));
      }
      if (matches.length === 0) throw new AuthorityCanonicalPublicationNotFoundError(opId);
      if (matches.length !== 1) {
        throw new Error(
          `AUTHORITY_CANONICAL_PUBLICATION_NOT_UNIQUE:expectedOpId=${opId};matches=${matches.map((entry) => entry.commitSha).join(",") || "none"}`
        );
      }
      return matches[0]!;
    }
  };
}

function commitSubjectOpIds(subject: string): ReadonlyArray<string> {
  const match = /\[([^\]]+)\]$/u.exec(subject);
  if (!match?.[1]) return [];
  return match[1].split(",").filter(Boolean);
}

function publicationTopologyError(input: {
  readonly expectedPreviousHead: string | null;
  readonly expectedOpIds: ReadonlyArray<string>;
  readonly head: string;
  readonly parentCommits: ReadonlyArray<string>;
  readonly sessionParents: ReadonlyArray<string>;
  readonly mergeSubject: string;
  readonly sessionSubject: string;
  readonly mergeTreeMatchesSession: boolean;
}): Error {
  return new Error([
    "AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR",
    `expectedPreviousHead=${input.expectedPreviousHead ?? "null"}`,
    `expectedOpIds=${input.expectedOpIds.join(",")}`,
    `head=${input.head}`,
    `actualParents=${input.parentCommits.join(",") || "none"}`,
    `actualSessionParents=${input.sessionParents.join(",") || "none"}`,
    `mergeSubject=${JSON.stringify(input.mergeSubject)}`,
    `sessionSubject=${JSON.stringify(input.sessionSubject)}`,
    `mergeTreeMatchesSession=${String(input.mergeTreeMatchesSession)}`
  ].join(";"));
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
    try {
      return registration.storageLocator.locator.locate(identity, {}).targets
        .filter((target): target is typeof target & { readonly path: string } => Boolean(target.path));
    } catch (error) {
      if (mutation.entity.entityKind === "relation"
        && error instanceof Error
        && error.message === "RELATION_STORAGE_SOURCE_REQUIRED") return [];
      throw error;
    }
  });
  const permitsContentAddressedBlob = mutationSet.mutations.some((mutation) => mutation.entity.entityKind === "session");
  const permitsTaskPackageAlias = targets.some((target) => target.path.startsWith("tasks/"));
  if (evidence.physicalChanges.length === 0) throw new Error("AUTHORITY_PUBLICATION_TREE_EMPTY");
  for (const change of evidence.physicalChanges) {
    if (evidence.pipelineGeneratedPaths.includes(change.path)) continue;
    if (permitsContentAddressedBlob && evidence.contentAddressedPaths.includes(change.path)) continue;
    if (!targets.some((target) => publicationChangeMatchesTarget(change.path, target, permitsTaskPackageAlias))) {
      throw publicationTreeMismatchError(change.path, targets, evidence.physicalChanges, permitsTaskPackageAlias);
    }
  }
  for (const target of targets) {
    const observed = evidence.physicalChanges.some((change) =>
      publicationChangeMatchesTarget(change.path, target, permitsTaskPackageAlias)
    );
    if (!observed) throw new Error(`AUTHORITY_PUBLICATION_DECLARED_PATH_MISSING:${target.path}`);
  }
}

function publicationChangeMatchesTarget(
  changedPath: string,
  target: { readonly path: string; readonly access: string },
  permitsTaskPackageAlias: boolean
): boolean {
  if (changedPath === target.path) return true;
  if (target.access !== "exact" && changedPath.startsWith(`${target.path}/`)) return true;
  if (!permitsTaskPackageAlias || !target.path.startsWith("tasks/")) return false;
  const targetMatch = /^(tasks\/[^/]+)(\/.*)?$/u.exec(target.path);
  const changedMatch = /^(tasks\/[^/]+)(\/.*)?$/u.exec(changedPath);
  if (!targetMatch?.[1] || !changedMatch?.[1]) return false;
  if (!changedMatch[1].startsWith(`${targetMatch[1]}-`)) return false;
  const slug = changedMatch[1].slice(targetMatch[1].length);
  if (!/^-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(slug)) return false;
  const targetSuffix = targetMatch[2] ?? "";
  const changedSuffix = changedMatch[2] ?? "";
  return target.access === "exact"
    ? changedSuffix === targetSuffix
    : changedSuffix === targetSuffix || changedSuffix.startsWith(`${targetSuffix}/`);
}

function publicationTreeMismatchError(
  changedPath: string,
  targets: ReadonlyArray<{ readonly path: string; readonly access: string }>,
  physicalChanges: ReadonlyArray<PhysicalChangeV2>,
  taskPackageAliasAllowed: boolean
): Error {
  return new Error([
    `AUTHORITY_PUBLICATION_TREE_MISMATCH:${changedPath}`,
    `expectedTargets=${targets.map((target) => `${target.access}:${target.path}`).join(",") || "none"}`,
    `observedPaths=${physicalChanges.map((change) => change.path).join(",") || "none"}`,
    `taskPackageAliasAllowed=${String(taskPackageAliasAllowed)}`
  ].join(";"));
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

const execFileAsync = promisify(execFile);

async function publicationGitTextAsync(rootDir: string, ...args: ReadonlyArray<string>): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout.trim();
}

function gitExitCode(rootDir: string, ...args: ReadonlyArray<string>): number {
  try {
    execFileSync("git", ["-C", rootDir, ...args], {
      stdio: "ignore",
      windowsHide: true
    });
    return 0;
  } catch (error) {
    return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 1;
  }
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
