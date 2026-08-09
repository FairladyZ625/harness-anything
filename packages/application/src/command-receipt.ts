export const commandReceiptEnvelope = "command-receipt/v2" as const;

export interface CommandReceiptNextAction {
  readonly command: string;
  readonly description?: string;
}

export const commandReceiptSettlementEnvelope = "command-receipt-settlement/v1" as const;

export interface CommandReceiptSettlementStatusQuery {
  readonly method: "repo.write.receipt.status";
  readonly command: string;
  readonly receiptId: string;
}

export type CommandReceiptSettlement =
  | {
      readonly schema: typeof commandReceiptSettlementEnvelope;
      readonly receiptId: string;
      readonly durability: "session-durable";
      readonly canonicalVisibility: "pending";
      readonly acceptedAt: string;
      readonly sessionId: string;
      readonly acceptedCommitSha: string;
      readonly authorityOperationIds?: ReadonlyArray<string>;
      readonly statusQuery: CommandReceiptSettlementStatusQuery;
    }
  | {
      readonly schema: typeof commandReceiptSettlementEnvelope;
      readonly receiptId: string;
      readonly durability: "session-durable";
      readonly canonicalVisibility: "visible";
      readonly acceptedAt: string;
      readonly sessionId: string;
      readonly acceptedCommitSha: string;
      readonly authorityOperationIds?: ReadonlyArray<string>;
      readonly canonicalCommitSha: string;
      readonly settledAt: string;
      readonly statusQuery: CommandReceiptSettlementStatusQuery;
    }
  | {
      readonly schema: typeof commandReceiptSettlementEnvelope;
      readonly receiptId: string;
      readonly durability: "session-durable";
      readonly canonicalVisibility: "failed";
      readonly acceptedAt: string;
      readonly sessionId: string;
      readonly acceptedCommitSha: string;
      readonly authorityOperationIds?: ReadonlyArray<string>;
      readonly failedAt: string;
      readonly failure: {
        readonly stage: "materializer" | "publication-proof" | "evidence" | "integrity" | "unknown";
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
        readonly recoveryCommand: string;
      };
      readonly statusQuery: CommandReceiptSettlementStatusQuery;
    };

export interface CommandReceipt<Command extends string = string> {
  readonly ok: true;
  readonly schema: typeof commandReceiptEnvelope;
  readonly command: Command;
  readonly entity?: { readonly kind: string; readonly id?: string };
  readonly action: string;
  readonly summary: string;
  readonly rows?: number;
  readonly item?: unknown;
  readonly items?: ReadonlyArray<unknown>;
  readonly paths?: ReadonlyArray<{ readonly role: string; readonly path: string }>;
  readonly warnings?: ReadonlyArray<unknown>;
  /**
   * Additive settlement truth for writes acknowledged before canonical
   * publication. Absence means a legacy or synchronously-final receipt; it
   * must never be interpreted as either pending or canonical-visible.
   */
  readonly settlement?: CommandReceiptSettlement;
  readonly next: ReadonlyArray<CommandReceiptNextAction>;
  readonly details?: Record<string, unknown>;
  readonly meta: {
    readonly generatedAt: string;
    readonly compatibility: { readonly legacyReceipt?: string; readonly legacyReport?: string };
  };
}

export interface CommandFailureReceipt<Command extends string = string> {
  readonly ok: false;
  readonly schema: typeof commandReceiptEnvelope;
  readonly command: Command;
  readonly action: string;
  readonly summary: string;
  readonly error?: {
    readonly code: string;
    readonly hint: string;
    readonly context?: Readonly<Record<string, unknown>>;
  };
  readonly warnings?: ReadonlyArray<unknown>;
  /** Present when one or more command writes were durably accepted before the command failed. */
  readonly settlement?: CommandReceiptSettlement;
  readonly next?: ReadonlyArray<CommandReceiptNextAction>;
  readonly details?: Record<string, unknown>;
  readonly meta: {
    readonly generatedAt: string;
    readonly compatibility: { readonly legacyReceipt?: string };
  };
}

export type CommandReceiptEnvelope<Command extends string = string> =
  | CommandReceipt<Command>
  | CommandFailureReceipt<Command>;

export function failureReceiptNextActions(
  code: string | undefined,
  details: Readonly<Record<string, unknown>> = {}
): ReadonlyArray<CommandReceiptNextAction> | undefined {
  const data = receiptRecord(details.data);
  if (code === "task_lease_required") {
    const taskId = receiptString(details.taskId) ?? receiptString(data?.taskId);
    return taskId ? [{
      command: `ha task start ${shellArgument(taskId)}`,
      description: "Start the task and acquire its lease, then retry the original command."
    }] : undefined;
  }
  if (code === "daemon_build_stale" || code === "daemon_build_identity_unavailable") {
    return [{
      command: "ha daemon restart",
      description: "Restart the daemon on the current dist build, then retry the original write."
    }];
  }
  if (code !== "repo_unavailable" && code !== "repo_lock_held") return undefined;

  const repo = receiptRecord(details.repo) ?? receiptRecord(data?.repo);
  const repoId = receiptString(repo?.repoId);
  if (!repoId) return undefined;
  const canonicalRoot = receiptString(repo?.canonicalRoot);
  if (code === "repo_lock_held") {
    const lockPath = receiptString(repo?.lockPath) ?? "the reported writer lock";
    const lockOwner = receiptString(repo?.lockOwnerToken) ?? receiptString(repo?.lastError) ?? "unknown";
    return [{
      command: `ha --repo ${shellArgument(repoId)} daemon status --json`,
      description: `The repo writer lock is held at ${lockPath} (owner: ${lockOwner}). Wait for the current writer to release it, then rerun this status command before retrying. Do not register, purge, stop, or restart the repo while the lock is held.`
    }];
  }
  return [{
    command: `ha --repo ${shellArgument(repoId)} daemon status --json`,
    description: "Inspect this repo's daemon attachment and recovery state before choosing a repair."
  }, ...(canonicalRoot ? [{
    command: `ha daemon repo register --repo-id ${shellArgument(repoId)} --root ${shellArgument(canonicalRoot)}`,
    description: "Register or re-enable this repo only if status reports that it is missing or disabled, then retry the original command."
  }] : [])];
}

function receiptRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function receiptString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}
