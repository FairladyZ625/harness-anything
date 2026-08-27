// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { checkMergifyQueuePolicy } from "./check-mergify-queue-policy.mjs";

function validMergifyPolicy() {
  return [
    "queue_rules:",
    "  - name: default",
    "    merge_method: merge",
    "    branch_protection_injection_mode: queue",
    "    queue_conditions:",
    "      - base = main",
    "      - label = merge-queue",
    '      - "#check-failure = 0"',
    "    merge_conditions: []",
    "",
    "pull_request_rules:",
    "  - name: initial queue",
    "    conditions:",
    "      - label = merge-queue",
    "    actions:",
    "      queue:",
    "        name: default",
    "",
    "  - name: recover dequeued pull requests attempt 1",
    "    conditions:",
    "      - base = main",
    "      - label = merge-queue",
    "      - label = dequeued",
    '      - "-label = merge-queue-requeue-1"',
    '      - "#check-failure = 0"',
    '      - "#check-pending = 0"',
    "    actions:",
    "      label:",
    "        add:",
    "          - merge-queue-requeue-1",
    "        remove:",
    "          - dequeued",
    "      queue:",
    "        name: default",
    "",
    "  - name: recover dequeued pull requests attempt 2",
    "    conditions:",
    "      - base = main",
    "      - label = merge-queue",
    "      - label = dequeued",
    "      - label = merge-queue-requeue-1",
    '      - "-label = merge-queue-requeue-2"',
    '      - "#check-failure = 0"',
    '      - "#check-pending = 0"',
    "    actions:",
    "      label:",
    "        add:",
    "          - merge-queue-requeue-2",
    "        remove:",
    "          - dequeued",
    "      queue:",
    "        name: default",
  ].join("\n");
}

test("repository Mergify policy derives required checks and automatically requeues", () => {
  const result = checkMergifyQueuePolicy();
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.queueRule, "default");
  assert.deepEqual(result.requeueRules, [
    "requeue dequeued pull requests after checks recover attempt 1",
    "requeue dequeued pull requests after checks recover attempt 2",
  ]);
});

test("Mergify queue policy accepts a derived-check automatic requeue rule", () => {
  const result = checkMergifyQueuePolicy({ mergifyText: validMergifyPolicy() });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("Mergify queue policy rejects hard-coded required check names", () => {
  const mergifyText = validMergifyPolicy().replace(
    '      - "#check-failure = 0"\n    merge_conditions:',
    '      - "#check-failure = 0"\n      - check-success = boundaries\n    merge_conditions:',
  );
  const result = checkMergifyQueuePolicy({ mergifyText });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must not hard-code.*boundaries/u);
});

test("Mergify queue policy rejects disabled branch-protection derivation", () => {
  const mergifyText = validMergifyPolicy().replace(
    "branch_protection_injection_mode: queue",
    "branch_protection_injection_mode: none",
  );
  const result = checkMergifyQueuePolicy({ mergifyText });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /branch_protection_injection_mode: queue/u);
});

test("Mergify queue policy rejects non-empty merge conditions", () => {
  const mergifyText = validMergifyPolicy().replace(
    "    merge_conditions: []",
    "    merge_conditions:\n      - check-success = boundaries",
  );
  const result = checkMergifyQueuePolicy({ mergifyText });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /merge_conditions: \[\]/u);
});

test("Mergify queue policy rejects an unbounded automatic requeue rule", () => {
  const mergifyText = validMergifyPolicy().replace('      - "-label = merge-queue-requeue-1"\n', "");
  const result = checkMergifyQueuePolicy({ mergifyText });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /negative attempt-label condition/u);
});

test("Mergify queue policy rejects an attempt marker that is never added", () => {
  const mergifyText = validMergifyPolicy().replace("          - merge-queue-requeue-1", "          - other-label");
  const result = checkMergifyQueuePolicy({ mergifyText });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must add one of its negative attempt labels/u);
});

test("Mergify queue policy rejects requeueing while checks are pending", () => {
  const mergifyText = validMergifyPolicy().replace('      - "#check-pending = 0"\n', "");
  const result = checkMergifyQueuePolicy({ mergifyText });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /#check-pending = 0/u);
});

test("Mergify queue policy rejects an unquoted check-count YAML comment", () => {
  const mergifyText = validMergifyPolicy().replace('      - "#check-pending = 0"', "      - #check-pending = 0");
  const result = checkMergifyQueuePolicy({ mergifyText });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /#check-pending = 0/u);
});

test("Mergify queue policy rejects a requeue rule that keeps dequeued", () => {
  const mergifyText = validMergifyPolicy().replace("          - dequeued", "          - queued");
  const result = checkMergifyQueuePolicy({ mergifyText });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must remove the dequeued label/u);
});
