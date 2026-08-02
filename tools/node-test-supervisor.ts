const workerIdentity = Symbol("node-test-worker-identity");

export type WorkerRef<Id extends string> = Readonly<{
  id: Id;
  file: string;
  [workerIdentity]: (identity: Id) => Id;
}>;

export type ProofCounts = Readonly<{
  tests: number;
  failed: number;
  passed: number;
  cancelled: number;
  skipped: number;
  todo: number;
}>;

export type FlushedCompletionProof<Id extends string> = Readonly<{
  workerId: Id;
  success: boolean;
  counts: ProofCounts;
  [workerIdentity]: (identity: Id) => Id;
}>;

export type RunningState<Id extends string> = Readonly<{
  phase: "running";
  worker: WorkerRef<Id>;
}>;

export type ProofFlushedState<Id extends string> = Readonly<{
  phase: "proof-flushed";
  worker: WorkerRef<Id>;
  proof: FlushedCompletionProof<Id>;
}>;

export type ReapReason = Readonly<{
  kind:
    | "deadline-before-proof"
    | "post-proof-exit-wedge"
    | "invalid-structured-proof"
    | "parent-signal";
  detail?: string;
}>;

export type ClosingState<Id extends string> = Readonly<{
  phase: "closing";
  source: RunningState<Id> | ProofFlushedState<Id>;
}>;

export type ProoflessReapingState<Id extends string> = Readonly<{
  phase: "reaping";
  source: RunningState<Id>;
  reason: ReapReason;
}>;

export type ProofBackedReapingState<Id extends string> = Readonly<{
  phase: "reaping";
  source: ProofFlushedState<Id>;
  reason: ReapReason;
}>;

export type ReapingState<Id extends string> =
  | ProoflessReapingState<Id>
  | ProofBackedReapingState<Id>;

export type PreTerminalState<Id extends string> =
  | RunningState<Id>
  | ProofFlushedState<Id>;

export type TerminalState<Id extends string> =
  | ClosingState<Id>
  | ReapingState<Id>;

export type WorkerClose = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
}>;

export type WorkerFailure = Readonly<{
  name: string;
  kind: string;
  detail?: string;
}>;

export type SettledWorker<Id extends string> = Readonly<{
  phase: "settled";
  worker: WorkerRef<Id>;
  proof: FlushedCompletionProof<Id> | null;
  close: WorkerClose;
  outcome: "passed" | "passed-after-reap" | "failed" | "failed-after-reap";
  failure: WorkerFailure | null;
}>;

export function createRunningWorker<const Id extends string>(
  id: Id,
  file: string
): RunningState<Id> {
  const worker = {
    id,
    file,
    [workerIdentity]: (identity: Id) => identity
  };
  return { phase: "running", worker };
}

export function flushCompletionProof<Id extends string>(
  state: RunningState<Id>,
  input: Readonly<{ success: boolean; counts: ProofCounts }>
): ProofFlushedState<Id> {
  const proof = {
    workerId: state.worker.id,
    success: input.success,
    counts: input.counts,
    [workerIdentity]: (identity: Id) => identity
  };
  return {
    phase: "proof-flushed",
    worker: state.worker,
    proof
  };
}

export function beginClosing<Id extends string>(
  state: PreTerminalState<Id>
): ClosingState<Id> {
  return { phase: "closing", source: state };
}

export function beginReaping<Id extends string>(
  state: RunningState<Id>,
  reason: ReapReason
): ProoflessReapingState<Id>;
export function beginReaping<Id extends string>(
  state: ProofFlushedState<Id>,
  reason: ReapReason
): ProofBackedReapingState<Id>;
export function beginReaping<Id extends string>(
  state: PreTerminalState<Id>,
  reason: ReapReason
): ReapingState<Id> {
  if (state.phase === "running") {
    return { phase: "reaping", source: state, reason };
  }
  return { phase: "reaping", source: state, reason };
}

export function settleWorker<Id extends string>(
  state: TerminalState<Id>,
  close: WorkerClose,
  failureName?: string
): SettledWorker<Id> {
  switch (state.phase) {
    case "closing":
      return settleClosing(state, close, failureName);
    case "reaping":
      return settleReaping(state, close, failureName);
    default:
      return assertNever(state);
  }
}

function settleClosing<Id extends string>(
  state: ClosingState<Id>,
  close: WorkerClose,
  failureName?: string
): SettledWorker<Id> {
  switch (state.source.phase) {
    case "running":
      return failed(state.source.worker, null, close, {
        name: failureName ?? state.source.worker.file,
        kind: close.error === null ? "closed-before-proof" : "worker-spawn-error",
        ...(close.error === null ? {} : { detail: close.error })
      });
    case "proof-flushed":
      if (!state.source.proof.success) {
        return failed(state.source.worker, state.source.proof, close, {
          name: failureName ?? state.source.worker.file,
          kind: "test-failure"
        });
      }
      if (close.code === 0 && close.signal === null && close.error === null) {
        return passed(state.source.worker, state.source.proof, close);
      }
      return failed(state.source.worker, state.source.proof, close, {
        name: failureName ?? state.source.worker.file,
        kind: "unexpected-close-after-proof"
      });
    default:
      return assertNever(state.source);
  }
}

function settleReaping<Id extends string>(
  state: ReapingState<Id>,
  close: WorkerClose,
  failureName?: string
): SettledWorker<Id> {
  switch (state.source.phase) {
    case "running":
      return failed(state.source.worker, null, close, {
        name: failureName ?? state.source.worker.file,
        kind: state.reason.kind,
        ...(state.reason.detail === undefined ? {} : { detail: state.reason.detail })
      });
    case "proof-flushed":
      if (!state.source.proof.success) {
        return failedAfterReap(
          state.source.worker,
          state.source.proof,
          close,
          failureName
        );
      }
      if (state.reason.kind === "post-proof-exit-wedge") {
        return passedAfterForcedExit(state.source.worker, state.source.proof, close);
      }
      return failed(state.source.worker, state.source.proof, close, {
        name: failureName ?? state.source.worker.file,
        kind: state.reason.kind,
        ...(state.reason.detail === undefined ? {} : { detail: state.reason.detail })
      });
    default:
      return assertNever(state.source);
  }
}

function passed<Id extends string>(
  worker: WorkerRef<Id>,
  proof: FlushedCompletionProof<Id>,
  close: WorkerClose
): SettledWorker<Id> {
  return { phase: "settled", worker, proof, close, outcome: "passed", failure: null };
}

// This is the only constructor for the exceptional pass. The invariant Id is
// deliberately present in both arguments, and the proof itself has no public
// constructor: a proofless reaping state cannot call this at compile time.
function passedAfterForcedExit<Id extends string>(
  worker: WorkerRef<Id>,
  proof: FlushedCompletionProof<Id>,
  close: WorkerClose
): SettledWorker<Id> {
  if (proof.workerId !== worker.id) {
    throw new Error("completion proof does not belong to the reaped worker");
  }
  return {
    phase: "settled",
    worker,
    proof,
    close,
    outcome: "passed-after-reap",
    failure: null
  };
}

function failedAfterReap<Id extends string>(
  worker: WorkerRef<Id>,
  proof: FlushedCompletionProof<Id>,
  close: WorkerClose,
  failureName?: string
): SettledWorker<Id> {
  return {
    phase: "settled",
    worker,
    proof,
    close,
    outcome: "failed-after-reap",
    failure: { name: failureName ?? worker.file, kind: "test-failure" }
  };
}

function failed<Id extends string>(
  worker: WorkerRef<Id>,
  proof: FlushedCompletionProof<Id> | null,
  close: WorkerClose,
  failure: WorkerFailure
): SettledWorker<Id> {
  return { phase: "settled", worker, proof, close, outcome: "failed", failure };
}

function assertNever(value: never): never {
  throw new Error(`unhandled node test worker state: ${JSON.stringify(value)}`);
}
