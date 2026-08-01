// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  authorityBatchIntegrityDomain,
  authorityBatchTrailerName,
  buildAuthorityBatchIntegrity,
  parseAuthorityBatchCommitMessage,
  parseAuthorityBatchIntegrityTrailer
} from "../../src/integrity/authority-batch-integrity.ts";

test("authority batch trailer anchors the ordered opId to mutation-digest vector with a domain-separated aggregate", () => {
  const entries = [
    { opId: "op-2", semanticMutationSetDigest: "22".repeat(32) },
    { opId: "op-1", semanticMutationSetDigest: "11".repeat(32) }
  ];
  const integrity = buildAuthorityBatchIntegrity(entries);
  const parsed = parseAuthorityBatchIntegrityTrailer(integrity.trailerValue);

  assert.equal(authorityBatchIntegrityDomain.endsWith("\0"), true);
  assert.deepEqual(parsed.entries, entries, "publication order is preserved rather than sorted");
  assert.match(parsed.aggregateDigest, /^[0-9a-f]{64}$/u);
  assert.throws(
    () => parseAuthorityBatchIntegrityTrailer(integrity.trailerValue.replace(/^v1:[0-9a-f]/u, "v1:f")),
    /aggregate mismatch/u
  );
});

test("authority batch commit messages bind the semantic subject to the ordered trailer entries", () => {
  const entries = [
    { opId: "op-2", semanticMutationSetDigest: "22".repeat(32) },
    { opId: "op-1", semanticMutationSetDigest: "11".repeat(32) }
  ];
  const integrity = buildAuthorityBatchIntegrity(entries);
  const message = `harness write: first; second [op-2,op-1]\n\n${authorityBatchTrailerName}: ${integrity.trailerValue}`;

  assert.deepEqual(parseAuthorityBatchCommitMessage(message), {
    subject: "harness write: first; second [op-2,op-1]",
    integrity
  });
  assert.throws(
    () => parseAuthorityBatchCommitMessage(message.replace("[op-2,op-1]", "[op-1,op-2]")),
    /subject and trailer operation ids differ/u
  );
  assert.throws(
    () => parseAuthorityBatchCommitMessage(`${message}\n\nextra`),
    /one final integrity trailer/u
  );
});
