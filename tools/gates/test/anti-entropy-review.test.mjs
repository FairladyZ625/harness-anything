// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateAntiEntropyReview } from "../anti-entropy-review.mjs";
import gatesContract from "../contracts/gates.contract.mjs";
import { encodeReceiptToken, signReceipt } from "../receipt-verify.mjs";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const nextHeadSha = "1123456789abcdef0123456789abcdef01234567";
const now = new Date("2026-08-11T00:00:00Z");
const key = Buffer.from("anti-entropy-test-key", "utf8");

function signedReceipt(overrides = {}) {
  const unsigned = {
    scope: "replay:cli",
    kind: "anti-entropy-review",
    verdict: "approved",
    headSha,
    expiry: "2026-08-12T00:00:00Z",
    ...overrides
  };
  return { ...unsigned, signature: signReceipt(unsigned, key) };
}

function tokenLine(receipt = signedReceipt()) {
  return `Anti-Entropy-Token: ${encodeReceiptToken(receipt)}`;
}

function event(body, sha = headSha) {
  return { pull_request: { body, head: { sha } } };
}

function evaluate(body, options = {}) {
  return evaluateAntiEntropyReview({
    event: event(body, options.headSha),
    paths: ["packages/cli/src/index.ts"],
    now,
    key: options.key === undefined ? key : options.key
  });
}

function assertRed(result, errorPattern) {
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), errorPattern);
  assert.equal(typeof result.nextAction, "string");
  assert.match(`nextAction: ${result.nextAction}`, /nextAction: \S/u);
}

function workflowJob(source, name) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `workflow job not found: ${name}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^  [0-9A-Za-z_-]+:\s*$/mu);
  return next === -1 ? remainder : remainder.slice(0, next);
}

test("G35 accepts one approved inline token bound to replay scope and HEAD", () => {
  const result = evaluate(tokenLine());
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.status, "approved");
});

test("G35 negative verdict and trust-boundary cases fail with nextAction", async (suite) => {
  const tampered = signedReceipt();
  tampered.signature = `${tampered.signature.slice(0, -1)}${tampered.signature.endsWith("0") ? "1" : "0"}`;
  const duplicate = tokenLine();
  const cases = [
    ["missing token", "", {}, /exactly one valid Anti-Entropy-Token/u],
    ["pending verdict", tokenLine(signedReceipt({ verdict: "pending" })), {}, /verdict must be approved/u],
    ["rejected verdict", tokenLine(signedReceipt({ verdict: "rejected" })), {}, /verdict must be approved/u],
    ["tampered signature", tokenLine(tampered), {}, /signature does not match/u],
    ["wrong scope", tokenLine(signedReceipt({ scope: "replay:daemon" })), {}, /scope must be replay:cli/u],
    ["wrong headSha", tokenLine(signedReceipt({ headSha: "f".repeat(40) })), {}, /headSha must be/u],
    ["expired token", tokenLine(signedReceipt({ expiry: "2026-08-10T00:00:00Z" })), {}, /expired/u],
    ["expiry beyond 24 hours", tokenLine(signedReceipt({ expiry: "2026-08-12T00:00:01Z" })), {}, /maximum TTL/u],
    ["same token declared twice", `${duplicate}\n${duplicate}`, {}, /found 2/u],
    ["missing key", tokenLine(), { key: null }, /ANTI_ENTROPY_HMAC_KEY is missing/u]
  ];

  for (const [name, body, options, pattern] of cases) {
    await suite.test(name, () => assertRed(evaluate(body, options), pattern));
  }
});

test("G35 three-frame acceptance invalidates the old token after a new commit", () => {
  const missing = evaluate("");
  const currentHead = evaluate(tokenLine());
  const newCommit = evaluate(tokenLine(), { headSha: nextHeadSha });

  assertRed(missing, /exactly one valid Anti-Entropy-Token/u);
  assert.equal(currentHead.ok, true, currentHead.errors.join("\n"));
  assert.equal(currentHead.status, "approved");
  assertRed(newCommit, new RegExp(`headSha must be ${nextHeadSha}`, "u"));
});

test("G35 is N/A for non-production changes without requiring a token or key", () => {
  assert.deepEqual(evaluateAntiEntropyReview({ event: event(""), paths: ["docs/readme.md"], now, key: null }), {
    ok: true,
    status: "N/A",
    errors: [],
    scope: null
  });
});

test("G35 workflow matches the gate contract and executes the verifier from base with only the secret exposed", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/rebuild-gates.yml", import.meta.url), "utf8");
  const job = workflowJob(workflow, "anti-entropy-review");
  const gate = gatesContract.gates.find((candidate) => candidate.id === "G35");
  assert.notEqual(gate, undefined);
  assert.match(workflow, /^  pull_request_target:$/mu);
  for (const name of [
    "gate-contract-tests",
    "derived-contracts",
    "evidence-contract",
    "platform-smoke",
    "schema-closure",
    "test-selection",
    "clean-build",
    "dependency-policy",
    "line-budget",
    "production-delta",
    "lint"
  ]) {
    assert.match(workflowJob(workflow, name), /if: github\.event_name (?:!= 'pull_request_target'|== 'pull_request')/u);
  }
  assert.match(job, /if: github\.event_name == 'pull_request_target'/u);
  assert.equal(/continue-on-error: true/u.test(job), gate?.required === false,
    "workflow non-blocking mode must be the inverse of the G35 required contract");
  assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(job, /ANTI_ENTROPY_HMAC_KEY: \$\{\{ secrets\.ANTI_ENTROPY_HMAC_KEY \}\}/u);
  assert.doesNotMatch(job, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.doesNotMatch(job, /npm |packages\//u);
  assert.equal(workflow.match(/secrets\.ANTI_ENTROPY_HMAC_KEY/gu)?.length, 1);
});
