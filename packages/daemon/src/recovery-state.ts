export type RecoveryCauseClass = "data-shape" | "infrastructure";
export interface RecoveryCommandPolicy { readonly causes: readonly RecoveryCauseClass[]; readonly settlesLatch: boolean }

const recoveryCommands: Readonly<Record<string, RecoveryCommandPolicy>> = Object.freeze({
  "ledger-migrate": Object.freeze({ causes: Object.freeze(["data-shape"] as const), settlesLatch: true }),
  "receipt-show": Object.freeze({ causes: Object.freeze(["data-shape", "infrastructure"] as const), settlesLatch: false })
});

export function recoveryCommandPolicy(kind: string, cause: RecoveryCauseClass | null): RecoveryCommandPolicy | null {
  const policy = recoveryCommands[kind as keyof typeof recoveryCommands];
  return cause !== null && policy?.causes.includes(cause) ? policy : null;
}

export function makeRecoveryProbe(throttleMs: number): { readonly latch: () => void; readonly begin: (nowMs: number) => boolean; readonly clear: () => void } {
  let lastProbeMs: number | null = null;
  return {
    latch: () => { lastProbeMs = null; },
    begin: (nowMs) => { if (lastProbeMs !== null && nowMs - lastProbeMs < throttleMs) return false; lastProbeMs = nowMs; return true; },
    clear: () => { lastProbeMs = null; }
  };
}
