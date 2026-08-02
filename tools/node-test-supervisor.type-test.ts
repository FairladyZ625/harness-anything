import {
  beginReaping,
  createRunningWorker,
  flushCompletionProof,
  settleWorker,
  type ProofBackedReapingState,
  type ProofFlushedState
} from "./node-test-supervisor.ts";

const counts = { tests: 1, failed: 0, passed: 1, cancelled: 0, skipped: 0, todo: 0 };
const workerA = createRunningWorker("worker-a", "a.test.ts");
const workerB = createRunningWorker("worker-b", "b.test.ts");
const proofA = flushCompletionProof(workerA, { success: true, counts });
const proofB = flushCompletionProof(workerB, { success: true, counts });
const proofBackedReapA = beginReaping(proofA, { kind: "post-proof-exit-wedge" });

settleWorker(proofBackedReapA, { code: null, signal: "SIGKILL", error: null });

// @ts-expect-error worker identity is invariant, so worker A's proof cannot be rebound to worker B.
const mismatchedProof: ProofFlushedState<"worker-b"> = proofA;
void mismatchedProof;
void proofB;

// @ts-expect-error a proofless reaping state cannot enter the exceptional-pass constructor path.
const impossiblePassState: ProofBackedReapingState<"worker-a"> = beginReaping(
  workerA,
  { kind: "deadline-before-proof" }
);
void impossiblePassState;

// @ts-expect-error running is not a terminal state and cannot be settled directly.
settleWorker(workerA, { code: 0, signal: null, error: null });
