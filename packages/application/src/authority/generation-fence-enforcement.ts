import type {
  AuthorityFenceWitness,
  DaemonGenerationWriteRejectionV1,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityIndeterminateReceipt,
  AuthorityRetryableReceipt
} from "./types.ts";
import type { PreparedAuthoritySubmission } from "./service-admission-types.ts";
import type { PersistAuthorityTerminal } from "./operation-record-persistence.ts";

export async function persistTerminalOrRejectGeneration(
  persist: PersistAuthorityTerminal,
  args: Parameters<PersistAuthorityTerminal>
): Promise<AuthorityOperationReceipt> {
  try {
    return await persist(...args);
  } catch (error) {
    if (!isDaemonGenerationFenced(error)) throw error;
    return args[2] === "INDETERMINATE"
      ? generationFencedIndeterminateReceipt(
        args[0],
        args[1],
        error,
        "commitSha" in args[3] ? args[3].commitSha : undefined
      )
      : generationFencedReceipt(args[0], args[1], error);
  }
}

export async function rejectStaleGeneration(
  witness: AuthorityFenceWitness | undefined,
  identity: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  semanticDigest: string
): Promise<AuthorityRetryableReceipt | undefined> {
  try {
    await witness?.assertHeld("before-prepare", identity);
    return undefined;
  } catch (error) {
    if (!isDaemonGenerationFenced(error)) throw error;
    return generationFencedReceipt(identity, semanticDigest, error);
  }
}

export async function rejectGenerationFencedBatch(
  witness: AuthorityFenceWitness | undefined,
  entries: ReadonlyArray<PreparedAuthoritySubmission>,
  receipts: Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>
): Promise<boolean> {
  let lost = false;
  let rejection: Parameters<typeof generationFencedReceipt>[2] | undefined;
  for (const entry of entries) {
    try {
      await witness?.assertHeld("before-canonical-publish", entry);
    } catch (error) {
      if (!isDaemonGenerationFenced(error)) throw error;
      lost = true;
      rejection = error;
      receipts.set(entry, generationFencedReceipt(entry, entry.semanticDigest, error));
    }
  }
  if (!lost) return false;
  for (const entry of entries) {
    if (!receipts.has(entry)) {
      receipts.set(entry, generationFencedReceipt(entry, entry.semanticDigest, rejection!));
    }
  }
  return true;
}

export function isDaemonGenerationFenced(
  error: unknown
): error is Error & {
  readonly code: "DAEMON_GENERATION_FENCED";
  readonly context: DaemonGenerationWriteRejectionV1;
} {
  return error instanceof Error
    && "code" in error && error.code === "DAEMON_GENERATION_FENCED"
    && "context" in error && validGenerationRejectionContext(error.context);
}

export function daemonGenerationFenceReason(error: Error): string {
  return error.message;
}

export function generationFencedReceipt(
  identity: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  semanticDigest: string,
  error: Error & {
    readonly code: "DAEMON_GENERATION_FENCED";
    readonly context: DaemonGenerationWriteRejectionV1;
  }
): AuthorityRetryableReceipt {
  return {
    tag: "RETRYABLE_NOT_COMMITTED",
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest,
    reason: daemonGenerationFenceReason(error),
    errorCode: error.code,
    errorContext: { ...error.context, workspaceId: identity.workspaceId, opId: identity.opId }
  };
}

export function generationFencedIndeterminateReceipt(
  identity: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  semanticDigest: string,
  error: Error & {
    readonly code: "DAEMON_GENERATION_FENCED";
    readonly context: DaemonGenerationWriteRejectionV1;
  },
  commitSha?: string
): AuthorityIndeterminateReceipt {
  return {
    tag: "INDETERMINATE",
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest,
    reason: `${daemonGenerationFenceReason(error)} Canonical outcome requires current-generation reconciliation.`,
    ...(commitSha ? { commitSha } : {}),
    errorCode: error.code,
    errorContext: { ...error.context, workspaceId: identity.workspaceId, opId: identity.opId }
  };
}

function validGenerationRejectionContext(value: unknown): value is DaemonGenerationWriteRejectionV1 {
  return typeof value === "object" && value !== null
    && "schema" in value && value.schema === "daemon-generation-write-rejection/v1"
    && "machineId" in value && typeof value.machineId === "string" && value.machineId.length > 0
    && "attemptedDaemonGeneration" in value && Number.isSafeInteger(value.attemptedDaemonGeneration)
    && "workspaceId" in value && typeof value.workspaceId === "string" && value.workspaceId.length > 0
    && "stage" in value && typeof value.stage === "string";
}
