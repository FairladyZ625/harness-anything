// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeTestStallPolicy } from "./node-test-stall-policy.mjs";

function createPolicy() {
  return createNodeTestStallPolicy({
    diagnosticIntervalMs: 250,
    abortWindows: 2,
    testTimeoutMs: 1_000,
    startedAt: 0
  });
}

test("ordinary output resets aggregate silence", () => {
  const policy = createPolicy();

  policy.noteOutput("real test progress\n", 200);
  assert.deepEqual(policy.tick({ at: 400 }), { diagnostic: null, abort: null });
  assert.deepEqual(policy.tick({ at: 500 }), {
    diagnostic: { silentForMs: 300, silentWindows: 1 },
    abort: null
  });
});

test("stable isolation evidence aborts even when another test keeps producing output", () => {
  const policy = createPolicy();
  const candidate = {
    pid: 42,
    files: ["tools/test-fixtures/runner-stall/wedged-module.test.mjs"]
  };

  assert.equal(policy.tick({ at: 250, isolationCandidates: [candidate] }).abort, null);
  policy.noteOutput("runner chatter 1\n", 400);
  assert.equal(policy.tick({ at: 500, isolationCandidates: [candidate] }).abort, null);
  policy.noteOutput("runner chatter 2\n", 650);

  assert.deepEqual(policy.tick({ at: 750, isolationCandidates: [candidate] }), {
    diagnostic: null,
    abort: {
      kind: "isolation-wedge",
      isolationChildPid: 42,
      files: ["tools/test-fixtures/runner-stall/wedged-module.test.mjs"],
      silentMs: 500,
      silentWindows: 2
    }
  });
});

test("aggregate silence wins when Linux exposes the isolation signature too late", () => {
  const policy = createPolicy();
  const lateCandidate = {
    pid: 43,
    files: ["tools/test-fixtures/runner-stall/failing-then-wedge.test.mjs"]
  };

  for (const at of [250, 500, 750]) {
    assert.equal(policy.tick({ at }).abort, null);
  }
  assert.equal(policy.tick({ at: 1_000, isolationCandidates: [lateCandidate] }).abort, null);

  assert.deepEqual(policy.tick({ at: 1_250, isolationCandidates: [lateCandidate] }).abort, {
    kind: "aggregate-silence",
    silentMs: 1_250,
    silentWindows: 5
  });
});

test("a delayed scheduler cannot postpone the aggregate silence bound", () => {
  const policy = createPolicy();

  assert.deepEqual(policy.tick({ at: 1_375 }), {
    diagnostic: { silentForMs: 1_375, silentWindows: 5 },
    abort: {
      kind: "aggregate-silence",
      silentMs: 1_375,
      silentWindows: 5
    }
  });
});

test("changed or missing isolation candidates reset their observation window", () => {
  const policy = createPolicy();
  const first = { pid: 44, files: ["tools/first.test.mjs"] };
  const changed = { pid: 44, files: ["tools/second.test.mjs"] };

  assert.equal(policy.tick({ at: 250, isolationCandidates: [first] }).abort, null);
  assert.equal(policy.tick({ at: 500, isolationCandidates: [] }).abort, null);
  assert.equal(policy.tick({ at: 750, isolationCandidates: [changed] }).abort, null);
  assert.equal(policy.tick({ at: 1_000, isolationCandidates: [changed] }).abort, null);
});

test("a chosen abort is emitted once", () => {
  const policy = createPolicy();
  for (const at of [250, 500, 750, 1_000]) {
    assert.equal(policy.tick({ at }).abort, null);
  }
  assert.equal(policy.tick({ at: 1_250 }).abort?.kind, "aggregate-silence");
  assert.deepEqual(policy.tick({ at: 1_500 }), { diagnostic: null, abort: null });
});
