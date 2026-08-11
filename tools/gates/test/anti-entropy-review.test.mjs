// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAntiEntropyReview } from "../anti-entropy-review.mjs";
import { signReceipt } from "../receipt-verify.mjs";
import { makeRepo, writeRepoFile } from "./helpers.mjs";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const now = new Date("2026-08-11T00:00:00Z");

function signedReceipt(overrides = {}) {
  const unsigned = {
    scope: "replay:cli",
    kind: "anti-entropy-review",
    verdict: "approved",
    headSha,
    expiry: "2026-08-12T00:00:00Z",
    ...overrides
  };
  return { ...unsigned, signature: signReceipt(unsigned) };
}

function event(body) {
  return { pull_request: { body, head: { sha: headSha } } };
}

test("G35 accepts an approved receipt bound to replay scope and HEAD", () => {
  const { rootDir } = makeRepo({ "README.md": "fixture\n" });
  writeRepoFile(rootDir, "tools/gates/receipts/review.json", `${JSON.stringify(signedReceipt())}\n`);
  const result = evaluateAntiEntropyReview({
    rootDir,
    event: event("Anti-Entropy-Receipt: tools/gates/receipts/review.json"),
    paths: ["packages/cli/src/index.ts"],
    now
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.status, "approved");
});
test("G35 rejects missing, pending, and HEAD-mismatched receipts", () => {
  const { rootDir } = makeRepo({ "README.md": "fixture\n" });
  const missing = evaluateAntiEntropyReview({ rootDir, event: event(""), paths: ["packages/cli/src/index.ts"], now });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "pending");

  writeRepoFile(rootDir, "tools/gates/receipts/review.json", `${JSON.stringify(signedReceipt({ verdict: "pending" }))}\n`);
  const pending = evaluateAntiEntropyReview({ rootDir, event: event("Anti-Entropy-Receipt: tools/gates/receipts/review.json"), paths: ["packages/cli/src/index.ts"], now });
  assert.equal(pending.ok, false);
  assert.match(pending.errors.join("\n"), /verdict must be approved/u);

  writeRepoFile(rootDir, "tools/gates/receipts/review.json", `${JSON.stringify(signedReceipt({ headSha: "f".repeat(40) }))}\n`);
  const mismatch = evaluateAntiEntropyReview({ rootDir, event: event("Anti-Entropy-Receipt: tools/gates/receipts/review.json"), paths: ["packages/cli/src/index.ts"], now });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.errors.join("\n"), /headSha must be/u);
});

test("G35 is N/A for non-production changes", () => {
  const { rootDir } = makeRepo({ "README.md": "fixture\n" });
  assert.deepEqual(evaluateAntiEntropyReview({ rootDir, event: event(""), paths: ["docs/readme.md"], now }), {
    ok: true,
    status: "N/A",
    errors: [],
    scope: null
  });
});
