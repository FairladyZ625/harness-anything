import type { WriteOp } from "../../ports/write-coordinator.ts";
import type { HarnessLayoutInput } from "../../layout/index.ts";
import type { OperationalActor, OwnedLock } from "./types.ts";
import { withGlobalRepoLock } from "./locks.ts";
import { transcriptConsentClaimsForWriteOp } from "./operations/consent-transcript-anchor.ts";

export function withTranscriptConsentReservationLock<T>(input: {
  readonly rootDir: string;
  readonly rootInput: HarnessLayoutInput;
  readonly journalPath: string;
  readonly actor: OperationalActor;
  readonly lockTtlMs: number;
  readonly heldGlobalLock?: OwnedLock;
  readonly op: WriteOp;
  readonly writeJournalRecord: () => T;
}): T {
  if (transcriptConsentClaimsForWriteOp(input.rootInput, input.op).length === 0) {
    return input.writeJournalRecord();
  }
  return withGlobalRepoLock(
    input.rootDir,
    input.rootInput,
    input.journalPath,
    input.actor,
    input.lockTtlMs,
    input.writeJournalRecord,
    { ...(input.heldGlobalLock ? { heldGlobalLock: input.heldGlobalLock } : {}) }
  );
}
