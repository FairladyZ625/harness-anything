// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readReviewTriageRecords, reviewTriageStorePath } from "../src/review-finding-triage.ts";

/**
 * dec_6A77D43B8523823ABA1F5E4D3C CH5: the center's triage journal is the one writer of
 * `ReviewFindingTriageV1`, and the closeout judgment is its reader. A read must be total — a fresh
 * repository and a corrupt journal both mean "no records yet", which the settlement treats as an
 * unresolved finding rather than an approved one.
 */

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-triage-store-"));
  return root;
}

function writeJournal(rootDir: string, body: string): void {
  const file = reviewTriageStorePath(rootDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

const record = {
  schema: "review-finding-triage/v1",
  reviewId: "review-1",
  findingId: "finding-1",
  targetDigest: `sha256:${"a".repeat(64)}`,
  selected: "non_blocking",
  probabilities: { blocker: 0.05, non_blocking: 0.9, nit: 0.03, pre_existing: 0.01, false_positive: 0.01 },
  model: "reviewer-model",
  bindingDigest: `sha256:${"a".repeat(64)}`,
  decidedAt: "2026-10-26T00:00:00.000Z",
  target: { kind: "task", id: "task_1", digest: `sha256:${"a".repeat(64)}` },
  thresholds: {},
  rulesVersion: "rules-v1",
  inputDigest: `sha256:${"b".repeat(64)}`,
} as const;

test("a repository with no journal has no triage records", () => {
  const root = repository();
  try {
    assert.deepEqual(readReviewTriageRecords(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a written record is read back for its own cut", () => {
  const root = repository();
  try {
    writeJournal(root, JSON.stringify({ schema: "review-finding-triage-store/v1", records: [record] }));
    const records = readReviewTriageRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.findingId, "finding-1");
    assert.equal(records[0]?.target.digest, record.targetDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt journal reports its parse error", () => {
  const root = repository();
  try {
    writeJournal(root, "{not json");
    assert.throws(() => readReviewTriageRecords(root), SyntaxError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a journal of another schema is not mistaken for triage records", () => {
  const root = repository();
  try {
    writeJournal(root, JSON.stringify({ schema: "something-else/v1", records: [record] }));
    assert.deepEqual(readReviewTriageRecords(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
