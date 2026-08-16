export function verifyReceipt(receipt: Readonly<Record<string, unknown>>, expectations?: {
  readonly key?: Buffer | null;
  readonly now?: Date | string | number;
  readonly scope?: string;
  readonly kind?: string;
  readonly decisionId?: string;
  readonly limit?: number | string;
  readonly minimumLimit?: number;
  readonly maximumTtlMs?: number;
}): { readonly ok: boolean; readonly errors: readonly string[] };
