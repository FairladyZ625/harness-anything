export const commandReceiptEnvelope = "command-receipt/v2" as const;

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
  readonly next?: ReadonlyArray<{ readonly command: string; readonly description?: string }>;
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
  readonly error?: { readonly code: string; readonly hint: string };
  readonly warnings?: ReadonlyArray<unknown>;
  readonly details?: Record<string, unknown>;
  readonly meta: {
    readonly generatedAt: string;
    readonly compatibility: { readonly legacyReceipt?: string };
  };
}

export type CommandReceiptEnvelope<Command extends string = string> =
  | CommandReceipt<Command>
  | CommandFailureReceipt<Command>;
