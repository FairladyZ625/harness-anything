// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditAllowlistRefReachability, main } from "../allowlist-path-existence.mjs";
import { EVIDENCE_INDEX } from "../evidence-index.mjs";
import { captureGate, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("B13 ratchet accepts live paths and rejects an allowlist row for a missing file", (t) => {
  const repository = captureGate(() => main(["--root", repoRoot, "--mode", "ratchet"]));
  assert.equal(repository.code, 0, repository.stderr || repository.stdout);
  assert.match(repository.stdout, /checked path-accounting entries \([1-9]\d*\)/u);
  assert.match(repository.stdout, /checked ref-accounting entries \([1-9]\d*\)/u);
  assert.match(repository.stdout, /findings \(0\)/u);

  const fixturePath = path.join(import.meta.dirname, "fixtures/allowlist-path-existence-missing.json");

  const positive = captureGate(() => main(["--root", repoRoot, "--fixture", fixturePath, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /findings \(1\)/u);
  assert.match(positive.stdout, /packages\/allowlist-positive-control-does-not-exist\.ts does not exist/u);
  assert.doesNotMatch(positive.stdout, /packages does not exist/u);

  const unclassifiedRoot = mkdtempSync(path.join(tmpdir(), "allowlist-path-unclassified-"));
  t.after(() => rmSync(unclassifiedRoot, { recursive: true, force: true }));
  writeRepoFile(
    unclassifiedRoot,
    "tools/gate-allowlists/new-governance-list.json",
    '{"schema":"harness-anything/gate-allowlist/v1","gateId":"new-governance-list","entries":{}}\n',
  );
  const unclassified = captureGate(() => main(["--root", unclassifiedRoot, "--mode", "ratchet"]));
  assert.equal(unclassified.code, 1);
  assert.match(unclassified.stderr, /unclassified JSON allowlist\(s\): new-governance-list\.json/u);
});

test("B13 ref audit accepts reachable citations and blocks dangling or malformed segments", () => {
  const index = {
    tasks: ["task_aceaabaedfedcf9cb062ccf883"],
    decisions: ["dec_B1F5FF7648436C985F38F14226"],
    adrs: { "ADR-0022": ["D3", "D6"] },
    documents: ["harness/contracts/41-port-discipline-contracts.md#1"],
  };

  const reachable = auditAllowlistRefReachability(index, [
    { source: "f:entries.paths[0].ref", ref: "task_aceaabaedfedcf9cb062ccf883" },
    { source: "f:entries.paths[1].ref", ref: "dec_B1F5FF7648436C985F38F14226; task_aceaabaedfedcf9cb062ccf883" },
    { source: "f:entries.paths[2].ref", ref: "ADR-0022" },
    { source: "f:entries.paths[3].ref", ref: "ADR-0022#D6; harness/contracts/41-port-discipline-contracts.md#1" },
    { source: "f:entries.paths[4].ref", ref: "ADR-0022;" },
  ]);
  assert.equal(reachable.checked, 5);
  assert.deepEqual(reachable.findings, []);

  const blocked = auditAllowlistRefReachability(index, [
    { source: "f[0].ref", ref: "task_00000000000000000000000000" },
    { source: "f[1].ref", ref: "dec_B284A85A" },
    { source: "f[2].ref", ref: "ADR-9999" },
    { source: "f[3].ref", ref: "ADR-0022#D9" },
    { source: "f[4].ref", ref: "harness/contracts/missing-ledger-doc.md#1" },
    { source: "f[5].ref", ref: "PR-1234" },
    { source: "f[6].ref", ref: "ADR-0022#D6; dec_DOES_NOT_EXIST" },
  ]);
  assert.equal(blocked.checked, 7);
  assert.deepEqual(
    blocked.findings.map((finding) => finding.replace(/^f\[\d\]\.ref: /u, "")),
    [
      '"task_00000000000000000000000000" is not reachable in the evidence index',
      '"dec_B284A85A" is not reachable in the evidence index',
      '"ADR-9999" is not reachable in the evidence index',
      '"ADR-0022#D9" is not reachable in the evidence index',
      '"harness/contracts/missing-ledger-doc.md#1" is not reachable in the evidence index',
      '"PR-1234" is not a task, decision, ADR, or ledger document citation',
      '"dec_DOES_NOT_EXIST" is not reachable in the evidence index',
    ],
  );
});

test("B13 ratchet audits fixture refs against the evidence index end to end", () => {
  const fixturePath = path.join(import.meta.dirname, "fixtures/allowlist-ref-reachability-missing.json");
  const result = captureGate(() => main(["--root", repoRoot, "--fixture", fixturePath, "--mode", "ratchet"]));
  assert.equal(result.code, 1);
  assert.match(result.stdout, /checked ref-accounting entries \(2\)/u);
  assert.match(result.stdout, /task_00000000000000000000000000" is not reachable in the evidence index/u);
  assert.doesNotMatch(result.stdout, /ADR-0022/u);
});

test("B13 accepts the action-catalog null allowlist and its decision citations resolve", () => {
  // The live audit above fails closed when a JSON allowlist is unclassified; this pins the
  // file's non-path classification and the evidence-index row that makes its refs reachable.
  const allowlist = JSON.parse(
    readFileSync(path.join(repoRoot, "tools/gate-allowlists/action-catalog-null.json"), "utf8"),
  );
  const refs = allowlist.entries.catalogNulls.map((entry, index) => ({
    source: `action-catalog-null.json:entries.catalogNulls[${index}].ref`,
    ref: entry.ref,
  }));
  // dec_2446BC2F8C68630F71AE3E3BD7 CH3 authorizes the convergence batches: 63 → 27 → 8.
  // dec_2BF45FF7 CH1 keeps repo-read out of the gate set because it is a read-only admission.
  // The second batch removes the 19 doc-sync, migration/script, runtime and vertical rows; the
  // remaining 8 are the dynamic-artifact and pin roads owned by their own follow-up tasks.
  assert.equal(refs.length, 8);
  assert.equal(
    allowlist.entries.catalogNulls.some(({ value }) => value === "repository-read"),
    false,
    "repository-read is a read-only admission outside the action-catalog-null gate set",
  );
  assert.deepEqual(auditAllowlistRefReachability(EVIDENCE_INDEX, refs).findings, []);
});
