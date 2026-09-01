// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../allowlist-path-existence.mjs";
import { captureGate, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("B13 ratchet accepts live paths and rejects an allowlist row for a missing file", () => {
  const repository = captureGate(() => main(["--root", repoRoot, "--mode", "ratchet"]));
  assert.equal(repository.code, 0, repository.stderr || repository.stdout);
  assert.match(repository.stdout, /checked path-accounting entries \([1-9]\d*\)/u);
  assert.match(repository.stdout, /findings \(0\)/u);

  const fixturePath = path.join(import.meta.dirname, "fixtures/allowlist-path-existence-missing.json");

  const positive = captureGate(() => main(["--root", repoRoot, "--fixture", fixturePath, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /findings \(1\)/u);
  assert.match(positive.stdout, /packages\/allowlist-positive-control-does-not-exist\.ts does not exist/u);
  assert.doesNotMatch(positive.stdout, /packages does not exist/u);

  const unclassifiedRoot = mkdtempSync(path.join(tmpdir(), "allowlist-path-unclassified-"));
  writeRepoFile(
    unclassifiedRoot,
    "tools/gate-allowlists/new-governance-list.json",
    '{"schema":"harness-anything/gate-allowlist/v1","gateId":"new-governance-list","entries":{}}\n',
  );
  const unclassified = captureGate(() => main(["--root", unclassifiedRoot, "--mode", "ratchet"]));
  assert.equal(unclassified.code, 1);
  assert.match(unclassified.stderr, /unclassified JSON allowlist\(s\): new-governance-list\.json/u);
});
