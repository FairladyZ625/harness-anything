export function antiEntropyVerificationKey(environment?: NodeJS.ProcessEnv): Buffer | null;
export function decodeReceiptToken(token: string): { readonly receipt: Readonly<Record<string, unknown>> | null; readonly errors: readonly string[] };
export function verifyReceipt(receipt: Readonly<Record<string, unknown>>, expectations?: {
  readonly key?: Buffer | null;
  readonly now?: Date | string | number;
  readonly scope?: string;
  readonly kind?: string;
  readonly verdict?: string;
  readonly headSha?: string;
}): { readonly ok: boolean; readonly errors: readonly string[] };
