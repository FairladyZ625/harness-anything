export const commandReceiptEnvelope = "command-receipt/v2" as const;

export interface CommandReceiptNextAction {
  readonly command: string;
  readonly description?: string;
}

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
  readonly next?: ReadonlyArray<CommandReceiptNextAction>;
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
      command: `ha task claim ${shellArgument(taskId)}`,
      description: "Claim the task lease, then retry the original command."
    }] : undefined;
  }
  if (code !== "repo_unavailable" && code !== "repo_lock_held") return undefined;

  const repo = receiptRecord(details.repo) ?? receiptRecord(data?.repo);
  const repoId = receiptString(repo?.repoId);
  if (!repoId) return undefined;
  const canonicalRoot = receiptString(repo?.canonicalRoot);
  return [{
    command: `ha --repo ${shellArgument(repoId)} daemon status --json`,
    description: "Inspect this repo's daemon attachment state; unavailable repos are retried automatically."
  }, ...(canonicalRoot ? [{
    command: `ha daemon repo register --repo-id ${shellArgument(repoId)} --root ${shellArgument(canonicalRoot)}`,
    description: "Register or re-enable this repo if it is missing or disabled, then retry the original command."
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
