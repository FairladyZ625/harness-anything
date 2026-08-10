import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { DaemonLogService } from "@harness-anything/application";
import {
  encodeCanonicalCbor,
  sha256Text,
  type PhysicalChangeV2
} from "@harness-anything/kernel";
import {
  scanFirstParentPublicationMetadata,
  type AuthorityBatchCommitMetadata,
  type FirstParentPublicationMetadata
} from "./publication-history.ts";
import {
  assertNoUnanchoredAuthorityBatchPrefix,
  unanchoredAuthorityBatchesForPublications,
  unanchoredBatchError
} from "./publication-unanchored-batches.ts";
import {
  orderedOperationIdsEqual,
  publicationMessageShape,
  publicationMetadataOperationIds,
  publicationTopologyError
} from "./publication-message-shape.ts";
import { historicalPublicationEvidence } from "./historical-publication-evidence.ts";
import { findUniquePublication } from "./publication-operation-lookup.ts";
import { publicationGitExitCode } from "./publication-git-observation.ts";
import { AuthorityImmutablePublicationProofError } from "./publication-proof-error.ts";
import { publicationGitBlobDigest } from "./publication-object-digest.ts";
import {
  publicationReaderOwner,
  readPublicationGitObject,
  shutdownPublicationGitObjectReader
} from "./publication-object-reader.ts";
import type { RetryBudgetSignal } from "../../observability/visible-retry-budget.ts";
import { createDaemonRetryBudgetSignalSink } from "../../observability/daemon-retry-budget-log.ts";
import {
  resolveDurableSuccessorPublication,
  type DurableSuccessorPublicationRetryOptions
} from "./durable-successor-publication.ts";
import {
  AuthorityCanonicalPublicationNotFoundError,
  AuthorityRecoveryWatermarkInvalidError,
  type CanonicalPublicationEvidence,
  type FirstParentOperationAnchor,
  type FirstParentOperationAnchorScan,
  type FirstParentOperationAnchorScanProgress,
  type GitCanonicalPublicationInspector
} from "./publication-evidence-contract.ts";

export { assertPublicationMatchesMutationSet } from "./publication-mutation-proof.ts";
export * from "./publication-evidence-contract.ts";
export { createGitAuthorityAttributionEvidenceCommitterV2 } from "./publication-evidence-committer.ts";

export function publicationRetryOptions(
  logs: DaemonLogService | undefined,
  repo: { readonly repoId: string; readonly canonicalRoot: string }
): { readonly onRetryBudgetSignal?: (signal: RetryBudgetSignal) => void } {
  return logs
    ? { onRetryBudgetSignal: createDaemonRetryBudgetSignalSink(logs, { repo }) }
    : {};
}

interface GitCanonicalPublicationInspectorOptions {
  readonly onRetryBudgetSignal?: (signal: RetryBudgetSignal) => void;
  readonly durableSuccessorRetry?: DurableSuccessorPublicationRetryOptions;
}
export function createGitCanonicalPublicationInspector(
  canonicalRoot: string,
  options: GitCanonicalPublicationInspectorOptions = {}
): GitCanonicalPublicationInspector {
  const rootDir = path.resolve(canonicalRoot);
  const readerOwner = publicationReaderOwner();
  const readerOptions = readerOwner === undefined
    ? options
    : { ...options, owner: readerOwner };
  const currentHead = async (): Promise<string | null> =>
    gitOptionalAsync(rootDir, "rev-parse", "--verify", "HEAD");
  let indexedHistoryCache: {
    readonly headCommit: string;
    readonly value: Promise<{
      readonly commits: Awaited<ReturnType<typeof scanFirstParentPublicationMetadata>>;
      readonly byOperationId: ReadonlyMap<string, ReadonlyArray<{
        readonly commitSha: string;
        readonly previousCommit: string;
        readonly opIds: ReadonlyArray<string>;
        readonly metadata: FirstParentPublicationMetadata;
      }>>;
      readonly unanchoredByOperationId: ReadonlyMap<string, ReadonlyArray<AuthorityBatchCommitMetadata>>;
    }>;
  } | undefined;
  const indexedHistory = async () => {
    const headCommit = await currentHead();
    if (!headCommit) return null;
    if (indexedHistoryCache?.headCommit === headCommit) return indexedHistoryCache.value;
    const value = (async () => {
      const commits = await scanFirstParentPublicationMetadata({ rootDir, headCommit });
      const byOperationId = new Map<string, Array<{
        readonly commitSha: string;
        readonly previousCommit: string;
        readonly opIds: ReadonlyArray<string>;
        readonly metadata: typeof commits[number];
      }>>();
      for (const commit of commits) {
        if (commit.parents.length !== 2) continue;
        const opIds = publicationMetadataOperationIds(commit);
        const anchor = {
          commitSha: commit.commitSha,
          previousCommit: commit.parents[0]!,
          opIds,
          metadata: commit
        };
        for (const opId of opIds) {
          const known = byOperationId.get(opId) ?? [];
          known.push(anchor);
          byOperationId.set(opId, known);
        }
      }
      const unanchoredByOperationId = new Map<string, AuthorityBatchCommitMetadata[]>();
      for (const batch of await unanchoredAuthorityBatchesForPublications({ rootDir, publications: commits })) {
        for (const opId of batch.opIds) {
          const known = unanchoredByOperationId.get(opId) ?? [];
          known.push(batch);
          unanchoredByOperationId.set(opId, known);
        }
      }
      return { commits, byOperationId, unanchoredByOperationId };
    })();
    indexedHistoryCache = { headCommit, value };
    return value;
  };
  const scanFirstParentOperationAnchors = async (input: {
    readonly exclusiveCommit?: string;
    readonly interestedOpIds: ReadonlySet<string>;
    readonly progressBatchSize?: number;
    readonly onProgress?: (progress: FirstParentOperationAnchorScanProgress) => Promise<void>;
  }): Promise<FirstParentOperationAnchorScan> => {
    const headCommit = await currentHead();
    if (!headCommit) {
      return { headCommit: null, scannedCommitCount: 0, anchors: [], unanchoredOperationIds: [] };
    }
    let commits: Awaited<ReturnType<typeof scanFirstParentPublicationMetadata>>;
    try {
      commits = input.exclusiveCommit === headCommit
        ? []
        : await scanFirstParentPublicationMetadata({
          rootDir,
          headCommit,
          ...(input.exclusiveCommit ? { exclusiveCommit: input.exclusiveCommit } : {})
        });
    } catch (error) {
      if (input.exclusiveCommit) throw new AuthorityRecoveryWatermarkInvalidError(input.exclusiveCommit);
      throw error;
    }
    const recoveryWatermark = input.exclusiveCommit;
    if (recoveryWatermark && headCommit !== recoveryWatermark) {
      const oldest = commits.at(-1);
      if (!oldest || oldest.parents[0] !== recoveryWatermark) {
        throw new AuthorityRecoveryWatermarkInvalidError(recoveryWatermark);
      }
    }
    const progressBatchSize = input.progressBatchSize ?? 128;
    if (!Number.isInteger(progressBatchSize) || progressBatchSize <= 0) {
      throw new Error("AUTHORITY_RECOVERY_PROGRESS_BATCH_SIZE_INVALID");
    }
    const unanchoredOperationIds = new Set<string>();
    const anchors: FirstParentOperationAnchor[] = [];
    let batchAnchors: FirstParentOperationAnchor[] = [];
    let scannedCommitCount = 0;
    // A watermark may advance only from the old boundary toward HEAD. Scanning
    // oldest-to-newest makes every reported commit a complete prefix.
    for (const commit of [...commits].reverse()) {
      const expectedPreviousHead = commit.parents[0];
      const publicationBase = commit.sessionParents?.[0];
      if (expectedPreviousHead && publicationBase && expectedPreviousHead !== publicationBase) {
        for (const batch of await unanchoredAuthorityBatchesForPublications({
          rootDir,
          publications: [commit]
        })) {
          for (const opId of batch.opIds) {
            if (input.interestedOpIds.has(opId)) unanchoredOperationIds.add(opId);
          }
        }
      }
      if (commit.parents.length === 2) {
        const opIds = publicationMetadataOperationIds(commit);
        if (opIds.some((opId) => input.interestedOpIds.has(opId))) {
          const anchor = {
            commitSha: commit.commitSha,
            previousCommit: commit.parents[0]!,
            opIds
          };
          anchors.push(anchor);
          batchAnchors.push(anchor);
        }
      }
      scannedCommitCount += 1;
      if (scannedCommitCount % progressBatchSize === 0 || scannedCommitCount === commits.length) {
        if (input.onProgress) {
          await input.onProgress({
            commitSha: commit.commitSha,
            scannedCommitCount,
            anchors: batchAnchors,
            unanchoredOperationIds: [...unanchoredOperationIds]
          });
          batchAnchors = [];
        }
        await yieldToEventLoop();
      }
    }
    return {
      headCommit,
      scannedCommitCount,
      anchors,
      unanchoredOperationIds: [...unanchoredOperationIds]
    };
  };
  const inspectPublication = async (
    expectedPreviousHead: string | null,
    expectedOpIds: ReadonlyArray<string>,
    expectedCommitSha?: string,
    indexedMetadata?: FirstParentPublicationMetadata,
    allowAuthorityBatchSequence = false,
    includePhysicalEvidence = true
  ): Promise<CanonicalPublicationEvidence> => {
    const head = expectedCommitSha ?? await currentHead();
    if (!head) throw new Error("AUTHORITY_CANONICAL_PUBLICATION_MISSING");
    const metadata = indexedMetadata?.commitSha === head ? indexedMetadata : undefined;
    const parentCommits = metadata?.parents
      ?? publicationGitText(rootDir, "rev-list", "--parents", "-n", "1", head).split(" ").slice(1);
    const sessionCommit = parentCommits[1];
    const sessionParents = sessionCommit
      ? metadata?.sessionParents
        ?? publicationGitText(rootDir, "rev-list", "--parents", "-n", "1", sessionCommit).split(" ").slice(1)
      : [];
    const mergeSubject = metadata?.subject
      ?? publicationGitText(rootDir, "show", "-s", "--format=%s", head);
    const sessionSubject = sessionCommit
      ? metadata?.sessionSubject
        ?? publicationGitText(rootDir, "show", "-s", "--format=%s", sessionCommit)
      : "";
    const mergeMessage = metadata?.message
      ?? publicationGitText(rootDir, "show", "-s", "--format=%B", head);
    const sessionMessage = sessionCommit
      ? metadata?.sessionMessage
        ?? publicationGitText(rootDir, "show", "-s", "--format=%B", sessionCommit)
      : "";
    const {
      mergeMessageMatchesSession,
      legacySubjectShape,
      semanticSubjectShape
    } = publicationMessageShape({
      mergeSubject,
      sessionSubject,
      mergeMessage,
      sessionMessage,
      expectedOpIds
    });
    const mergeTreeMatchesSessionExactly = sessionCommit
      ? metadata?.treeSha && metadata.sessionTreeSha
        ? metadata.treeSha === metadata.sessionTreeSha
        : publicationGitExitCode(rootDir, "diff", "--quiet", head, sessionCommit) === 0
      : false;
    const sessionBase = sessionParents[0];
    const mergeTreeMatchesSession = mergeTreeMatchesSessionExactly || Boolean(
      sessionCommit
      && sessionBase
      && expectedPreviousHead
      && publicationGitExitCode(rootDir, "merge-base", "--is-ancestor", sessionBase, expectedPreviousHead) === 0
      && readAuthorityGitBytes(rootDir, "diff", "--raw", "--no-renames", "-z", sessionBase, sessionCommit)
        .equals(readAuthorityGitBytes(rootDir, "diff", "--raw", "--no-renames", "-z", expectedPreviousHead, head))
    );
    if (!expectedPreviousHead
      || parentCommits.length !== 2
      || parentCommits[0] !== expectedPreviousHead
      || sessionParents.length !== 1
      || (!allowAuthorityBatchSequence && !legacySubjectShape && !semanticSubjectShape)
      || !mergeTreeMatchesSession) {
      throw publicationTopologyError({
        expectedPreviousHead,
        expectedOpIds,
        head,
        parentCommits,
        sessionParents,
        mergeSubject,
        sessionSubject,
        mergeMessageMatchesSession,
        legacySubjectShape,
        semanticSubjectShape,
        mergeTreeMatchesSession
      });
    }
    const publicationBase = allowAuthorityBatchSequence
      ? expectedPreviousHead
      : sessionBase!;
    if (!allowAuthorityBatchSequence) {
      await assertNoUnanchoredAuthorityBatchPrefix({
        rootDir,
        expectedPreviousHead,
        publicationBase
      });
    }
    if (!includePhysicalEvidence) {
      return {
        opIds: [...expectedOpIds],
        commitSha: head,
        previousCommit: expectedPreviousHead,
        parentCommits,
        physicalChanges: [],
        pipelineGeneratedPaths: [],
        contentAddressedPaths: []
      };
    }
    const changedPaths = readAuthorityGitBytes(rootDir, "diff", "--name-only", "-z", publicationBase, head)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map(canonicalGitPath)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const physicalChanges: PhysicalChangeV2[] = [];
    for (const changedPath of changedPaths) {
      physicalChanges.push({
        path: changedPath,
        beforeDigest: await publicationGitBlobDigest(rootDir, publicationBase, changedPath, readerOptions),
        afterDigest: await publicationGitBlobDigest(rootDir, head, changedPath, readerOptions)
      });
    }
    physicalChanges.sort((left, right) => Buffer.compare(
      Buffer.from(encodeCanonicalCbor({ ...left })),
      Buffer.from(encodeCanonicalCbor({ ...right }))
    ));
    const pipelineGeneratedPaths = expectedOpIds.map((opId) => `attribution-events/${sha256Text(opId)}.jsonl`);
    const observedPipelinePaths = changedPaths.filter((changedPath) => changedPath.startsWith("attribution-events/"));
    if (observedPipelinePaths.length !== pipelineGeneratedPaths.length
      || observedPipelinePaths.some((changedPath) => !pipelineGeneratedPaths.includes(changedPath))) {
      throw new AuthorityImmutablePublicationProofError(
        "AUTHORITY_CANONICAL_PUBLICATION_PIPELINE_EVIDENCE_MISMATCH",
        `expected=${pipelineGeneratedPaths.join(",") || "none"};actual=${observedPipelinePaths.join(",") || "none"};head=${head}`
      );
    }
    const contentAddressedPaths = physicalChanges.filter((change) => {
      const match = /^objects\/sha256\/([a-f0-9]{2})\/([a-f0-9]{62})$/u.exec(change.path);
      if (!match) return false;
      if (change.afterDigest !== `${match[1]}${match[2]}`) {
        throw new AuthorityImmutablePublicationProofError(
          "AUTHORITY_CANONICAL_PUBLICATION_CONTENT_ADDRESS_MISMATCH",
          `path=${change.path};afterDigest=${change.afterDigest ?? "null"}`
        );
      }
      return true;
    }).map((change) => change.path);
    return {
      opIds: [...expectedOpIds],
      commitSha: head,
      previousCommit: expectedPreviousHead,
      parentCommits,
      physicalChanges,
      pipelineGeneratedPaths,
      contentAddressedPaths
    };
  };
  const findPublicationForOperationWithMode = async (
    opId: string,
    includePhysicalEvidence: boolean
  ): Promise<CanonicalPublicationEvidence> => {
    const history = await indexedHistory();
    const unanchored = history?.unanchoredByOperationId.get(opId) ?? [];
    if (unanchored.length > 0) throw unanchoredBatchError(unanchored);
    return findUniquePublication(opId, history?.byOperationId.get(opId) ?? [], {
      inspect: (anchor) => inspectPublication(
        anchor.previousCommit,
        anchor.opIds,
        anchor.commitSha,
        anchor.metadata,
        false,
        includePhysicalEvidence
      ),
      notFound: (expectedOpId) => new AuthorityCanonicalPublicationNotFoundError(expectedOpId)
    });
  };
  const findPublicationForOperation = (opId: string): Promise<CanonicalPublicationEvidence> =>
    findPublicationForOperationWithMode(opId, true);
  const findPublicationTopologyForOperation = (opId: string): Promise<CanonicalPublicationEvidence> =>
    findPublicationForOperationWithMode(opId, false);
  const findDurableSuccessorPublicationForOperationWithMode = async (
    opId: string,
    expectedCommitSha: string,
    includePhysicalEvidence: boolean
  ): Promise<CanonicalPublicationEvidence> => resolveDurableSuccessorPublication({
    rootDir,
    opId,
    expectedCommitSha,
    observe: async () => {
      const history = await indexedHistory();
      return history?.commits.find((commit) => commit.commitSha === expectedCommitSha);
    },
    inspect: (previousCommit, opIds, publication) => inspectPublication(
      previousCommit,
      opIds,
      expectedCommitSha,
      publication,
      true,
      includePhysicalEvidence
    ),
    readGitText: (...args) => publicationGitText(rootDir, ...args),
    ...(options.durableSuccessorRetry ? { retry: options.durableSuccessorRetry } : {}),
    ...(options.onRetryBudgetSignal ? { onRetryBudgetSignal: options.onRetryBudgetSignal } : {})
  });
  const findDurableSuccessorPublicationForOperation = (
    opId: string,
    expectedCommitSha: string
  ): Promise<CanonicalPublicationEvidence> => findDurableSuccessorPublicationForOperationWithMode(
    opId,
    expectedCommitSha,
    true
  );
  const findDurableSuccessorTopologyForOperation = (
    opId: string,
    expectedCommitSha: string
  ): Promise<CanonicalPublicationEvidence> => findDurableSuccessorPublicationForOperationWithMode(
    opId,
    expectedCommitSha,
    false
  );
  return {
    currentHead,
    inspectPublishedHead: (expectedPreviousHead, expectedOpIds) =>
      inspectPublication(expectedPreviousHead, expectedOpIds, undefined, undefined, false, false),
    inspectPublication,
    scanFirstParentOperationAnchors,
    findPublication: async (expectedOpIds) => {
      const history = await indexedHistory();
      if (!history) throw new Error("AUTHORITY_CANONICAL_PUBLICATION_MISSING");
      const matches: CanonicalPublicationEvidence[] = [];
      for (const commit of history.commits) {
        if (commit.parents.length !== 2
          || !orderedOperationIdsEqual(publicationMetadataOperationIds(commit), expectedOpIds)) continue;
        matches.push(await inspectPublication(
          commit.parents[0]!,
          expectedOpIds,
          commit.commitSha,
          commit
        ));
      }
      if (matches.length !== 1) {
        throw new Error(
          `AUTHORITY_CANONICAL_PUBLICATION_NOT_UNIQUE:expectedOpIds=${expectedOpIds.join(",")};matches=${matches.map((entry) => entry.commitSha).join(",") || "none"}`
        );
      }
      return matches[0]!;
    },
    findPublicationForOperation,
    findPublicationTopologyForOperation,
    findDurableSuccessorPublicationForOperation,
    findDurableSuccessorTopologyForOperation,
    shutdown: () => shutdownPublicationGitObjectReader(rootDir),
    findHistoricalPublicationForOperation: async (opId) => {
      const publication = await findPublicationForOperation(opId);
      return historicalPublicationEvidence({
        opId,
        publication,
        readAtCommit: (commitSha, eventPath) =>
          readPublicationGitObject(rootDir, `${commitSha}:${eventPath}`, readerOptions)
      });
    }
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function canonicalGitPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("AUTHORITY_PUBLICATION_PATH_INVALID");
  }
  return normalized;
}

async function gitOptionalAsync(rootDir: string, ...args: ReadonlyArray<string>): Promise<string | null> {
  try {
    return await publicationGitTextAsync(rootDir, ...args);
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
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000,
    killSignal: "SIGKILL"
  });
  return stdout.trim();
}

/** Read-only Git observation shared by authority publication and cutover scanners. */
export function readAuthorityGitBytes(rootDir: string, ...args: ReadonlyArray<string>): Buffer {
  return readAuthorityGitBatchBytes(rootDir, args, Buffer.alloc(0));
}

export function readAuthorityGitBatchBytes(
  rootDir: string,
  args: ReadonlyArray<string>,
  input: Buffer
): Buffer {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "buffer",
    ...(input.length > 0
      ? { input, stdio: ["pipe", "pipe", "pipe"] as const }
      : { stdio: ["ignore", "pipe", "pipe"] as const }),
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000,
    killSignal: "SIGKILL"
  });
}
