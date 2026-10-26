// harness-test-tier: fast
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { allowlistJsonPolicies, main } from "../allowlist-path-existence.mjs";
import { captureGate } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const allowlistRoot = path.join(repoRoot, "tools/gate-allowlists");

// check-schema-field-coverage used to derive its expected field lists from
// entityFieldContracts itself, so the gate had no allowlist at all. It now reads
// an external list (dec_F5B2CBF8B45042B6DA2824A7FA/CH2b), whose values are
// schema entity kinds and field names — never checkout paths. If B13 audited
// them as paths, every entity kind would be reported as a missing directory.
test("B13 classifies the schema field coverage allowlist as non-path", () => {
  const policy = allowlistJsonPolicies["check-schema-field-coverage.json"];
  assert.ok(policy, "the new external expected list must be classified, not left unclassified");
  assert.deepEqual(policy.pathSections, {});
  assert.deepEqual(policy.nonPathSections, ["expectedFields"]);
});

test("B13 classification covers every allowlist file on disk and no phantom file", () => {
  const onDisk = readdirSync(allowlistRoot)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepEqual(Object.keys(allowlistJsonPolicies).sort(), onDisk);
});

test("B13 never classifies a section as both path and non-path", () => {
  for (const [fileName, policy] of Object.entries(allowlistJsonPolicies)) {
    const overlap = Object.keys(policy.pathSections).filter((section) => policy.nonPathSections.includes(section));
    assert.deepEqual(overlap, [], `${fileName} classifies ${overlap.join(", ")} as both path and non-path`);
  }
});

test("B13 records the retired integrity single-source allowlist as gone", () => {
  // The six-symbol hand-maintained allowlist is replaced by @canonical-substrate
  // markers (ADR-0022 D6). A stale policy row for a deleted file would make the
  // classification loop throw on a missing read.
  assert.equal(Object.hasOwn(allowlistJsonPolicies, "check-integrity-single-source.json"), false);
  assert.equal(
    readdirSync(allowlistRoot).includes("check-integrity-single-source.json"),
    false,
    "the retired allowlist file must not come back",
  );
});

test("B13 classifies each live expectedFields entry so no entity kind is audited as a path", () => {
  const parsed = JSON.parse(readFileSync(path.join(allowlistRoot, "check-schema-field-coverage.json"), "utf8"));
  const sectionNames = Object.keys(parsed.entries);
  assert.deepEqual(sectionNames, ["expectedFields"]);
  for (const [index, entry] of parsed.entries.expectedFields.entries()) {
    assert.equal(typeof entry.entityKind, "string", `entries.expectedFields[${index}] must name an entity kind`);
    assert.ok(Array.isArray(entry.fields), `entries.expectedFields[${index}] must list field names`);
  }
});

test("B13 ratchet accepts the live tree with the reclassified allowlists", () => {
  const result = captureGate(() => main(["--root", repoRoot, "--mode", "ratchet"]));
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /checked path-accounting entries \([1-9]\d*\)/u);
  assert.match(result.stdout, /checked ref-accounting entries \([1-9]\d*\)/u);
  assert.match(result.stdout, /findings \(0\)/u);
});
