import {
  createVisibleRetryBudget,
  type RetryBudgetSignal
} from "../../observability/visible-retry-budget.ts";
import {
  scanAuthorityBatchCommits,
  type AuthorityBatchCommitMetadata,
  type FirstParentPublicationMetadata
} from "./publication-history.ts";
import { AuthorityCanonicalPublicationNotFoundError } from "./publication-evidence-contract.ts";
import { publicationMessageShape } from "./publication-message-shape.ts";

export interface DurableSuccessorPublicationRetryOptions {
  readonly maxRetries?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

const defaultMaxRetries = 50;
const defaultInitialDelayMs = 10;
const defaultMaxDelayMs = 100;

export async function resolveDurableSuccessorPublication<Result>(input: {
  readonly rootDir: string;
  readonly opId: string;
  readonly expectedCommitSha: string;
  readonly observe: () => Promise<FirstParentPublicationMetadata | undefined>;
  readonly inspect: (
    previousCommit: string,
    opIds: ReadonlyArray<string>,
    publication: FirstParentPublicationMetadata
  ) => Promise<Result>;
  readonly readGitText: (...args: ReadonlyArray<string>) => string;
  readonly retry?: DurableSuccessorPublicationRetryOptions;
  readonly onRetryBudgetSignal?: (signal: RetryBudgetSignal) => void;
}): Promise<Result> {
  let publication: FirstParentPublicationMetadata;
  try {
    publication = await waitForDurableSuccessorPublication(input);
  } catch (error) {
    if (error instanceof AuthorityCanonicalPublicationVisibilityExhaustedError) {
      throw new AuthorityCanonicalPublicationNotFoundError(input.opId);
    }
    throw error;
  }
  const previousCommit = publication.parents[0];
  const sessionCommit = publication.parents[1];
  if (!previousCommit || !sessionCommit || publication.parents.length !== 2) {
    throw new AuthorityCanonicalPublicationNotFoundError(input.opId);
  }
  const sessionBase = input.readGitText("merge-base", previousCommit, sessionCommit);
  if (!sessionBase) {
    throw new AuthorityCanonicalPublicationNotFoundError(input.opId);
  }
  const commitShas = input.readGitText(
    "rev-list",
    "--reverse",
    "--first-parent",
    `${sessionBase}..${sessionCommit}`
  ).split("\n").filter(Boolean);
  const batches = await scanAuthorityBatchCommits({
    rootDir: input.rootDir,
    headCommit: sessionCommit,
    exclusiveCommit: sessionBase
  });
  const batchesByCommit = new Map(batches.map((batch) => [batch.commitSha, batch]));
  let parent = sessionBase;
  const orderedBatches: AuthorityBatchCommitMetadata[] = [];
  for (const commitSha of commitShas) {
    const parents = input.readGitText("rev-list", "--parents", "-n", "1", commitSha)
      .split(" ").slice(1).filter(Boolean);
    const batch = batchesByCommit.get(commitSha);
    if (parents.length !== 1 || parents[0] !== parent || !batch) {
      throw new Error(`AUTHORITY_CANONICAL_PUBLICATION_SUCCESSOR_SEQUENCE_INVALID:${commitSha}`);
    }
    orderedBatches.push(batch);
    parent = commitSha;
  }
  if (parent !== sessionCommit || orderedBatches.length !== batches.length) {
    throw new Error("AUTHORITY_CANONICAL_PUBLICATION_SUCCESSOR_SEQUENCE_INCOMPLETE");
  }
  const opIds = orderedBatches.flatMap((batch) => batch.opIds);
  if (!opIds.includes(input.opId) || new Set(opIds).size !== opIds.length) {
    throw new Error("AUTHORITY_CANONICAL_PUBLICATION_SUCCESSOR_OPERATION_GROUP_INVALID");
  }
  if (!durableSuccessorMessageShape(publication, opIds, orderedBatches.length)) {
    throw new AuthorityCanonicalPublicationNotFoundError(input.opId);
  }
  return input.inspect(previousCommit, opIds, publication);
}

function durableSuccessorMessageShape(
  publication: FirstParentPublicationMetadata,
  opIds: ReadonlyArray<string>,
  batchCount: number
): boolean {
  if (/^materializer: merge session [A-Za-z0-9][A-Za-z0-9._-]*$/u.test(publication.subject)) {
    return true;
  }
  if (batchCount !== 1 || !publication.sessionSubject || !publication.sessionMessage) return false;
  return publicationMessageShape({
    mergeSubject: publication.subject,
    sessionSubject: publication.sessionSubject,
    mergeMessage: publication.message,
    sessionMessage: publication.sessionMessage,
    expectedOpIds: opIds
  }).semanticSubjectShape;
}

async function waitForDurableSuccessorPublication(input: {
  readonly opId: string;
  readonly expectedCommitSha: string;
  readonly observe: () => Promise<FirstParentPublicationMetadata | undefined>;
  readonly retry?: DurableSuccessorPublicationRetryOptions;
  readonly onRetryBudgetSignal?: (signal: RetryBudgetSignal) => void;
}): Promise<FirstParentPublicationMetadata> {
  const retry = retryOptions(input.retry);
  const retryBudget = createVisibleRetryBudget({
    operation: "authority-durable-successor-publication-visibility",
    budget: { maxRetries: retry.maxRetries },
    reminderEveryFailures: 1,
    ...(input.onRetryBudgetSignal ? { signal: input.onRetryBudgetSignal } : {})
  });
  let delayMs = retry.initialDelayMs;
  for (;;) {
    const publication = await input.observe();
    if (publication) {
      retryBudget.recovered();
      return publication;
    }
    const pending = new AuthorityCanonicalPublicationPendingError(input.opId, input.expectedCommitSha);
    const decision = retryBudget.recordFailure(pending);
    if (decision.status === "budget-exhausted") {
      throw new AuthorityCanonicalPublicationVisibilityExhaustedError();
    }
    await retry.sleep(delayMs);
    delayMs = Math.min(retry.maxDelayMs, delayMs * 2);
  }
}

class AuthorityCanonicalPublicationVisibilityExhaustedError extends Error {
  constructor() {
    super("AUTHORITY_CANONICAL_PUBLICATION_VISIBILITY_EXHAUSTED");
    this.name = "AuthorityCanonicalPublicationVisibilityExhaustedError";
  }
}

class AuthorityCanonicalPublicationPendingError extends Error {
  constructor(opId: string, expectedCommitSha: string) {
    super(
      `AUTHORITY_CANONICAL_PUBLICATION_PENDING:expectedOpId=${opId};expectedCommitSha=${expectedCommitSha}`
    );
    this.name = "AuthorityCanonicalPublicationPendingError";
  }
}

function retryOptions(options: DurableSuccessorPublicationRetryOptions | undefined): {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly sleep: (delayMs: number) => Promise<void>;
} {
  const maxRetries = options?.maxRetries ?? defaultMaxRetries;
  const initialDelayMs = options?.initialDelayMs ?? defaultInitialDelayMs;
  const maxDelayMs = options?.maxDelayMs ?? defaultMaxDelayMs;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error("AUTHORITY_DURABLE_SUCCESSOR_RETRY_MAX_RETRIES_INVALID");
  }
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new Error("AUTHORITY_DURABLE_SUCCESSOR_RETRY_INITIAL_DELAY_INVALID");
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new Error("AUTHORITY_DURABLE_SUCCESSOR_RETRY_MAX_DELAY_INVALID");
  }
  return {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    sleep: options?.sleep ?? waitForRetry
  };
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
